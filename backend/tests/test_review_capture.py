"""review-capture 외부 동작 테스트 (PRD Testing Decisions).

구현 세부가 아니라 관찰 가능한 결과만 본다:
- Q1 '상대방 불참' → 만족도/Follow-up/Love Call/Fit/보고문서가 모두 스킵되고 noshow 로 저장.
- '진행됨' → Step2 가 열리고 보고문서+Fit 저장.
- 재진입 수정 / AI 제안 Fit 검수 후 저장.
"""

import pytest

from app.domain.review_capture import (
    FitRating,
    FollowUpIntent,
    MeetingProceeded,
    ReportSections,
    ReviewValidationError,
    Step1Intake,
    Step2Compose,
    apply_fit_review,
    build_review,
    is_noshow,
    normalize_intake,
    step2_available,
)


def _report() -> ReportSections:
    return ReportSections(
        discussion=["155mm 정밀유도탄 사거리 60km 연장 요구"],
        agreements=["8월 중순까지 기술제안서 송부"],
        actions=["8월 말 소요검토 회신", "2차 실무미팅 일정 조율"],
    )


class TestNoshowBranch:
    def test_counterpart_noshow_skips_all_followups(self):
        intake = Step1Intake(
            proceeded=MeetingProceeded.COUNTERPART_NOSHOW,
            satisfaction=5,
            follow_up_intent=FollowUpIntent.YES,
            love_call=True,
        )
        review = build_review(intake)

        assert review.is_noshow is True
        assert review.counterpart_noshow is True
        # 불참 → 입력했던 후속 항목이 전부 비워진다.
        assert review.satisfaction is None
        assert review.follow_up_intent is None
        assert review.love_call is False
        assert review.report is None
        assert review.fit_rating is None

    def test_self_noshow_is_noshow_but_not_counterpart(self):
        review = build_review(Step1Intake(proceeded=MeetingProceeded.SELF_NOSHOW))
        assert review.is_noshow is True
        assert review.counterpart_noshow is False

    def test_step2_not_available_on_noshow(self):
        intake = Step1Intake(proceeded=MeetingProceeded.COUNTERPART_NOSHOW)
        assert step2_available(intake) is False
        assert is_noshow(intake) is True

    def test_compose_ignored_when_noshow(self):
        # noshow 인데 Step2 가 실수로 넘어와도 미도달 → 무시.
        intake = Step1Intake(proceeded=MeetingProceeded.COUNTERPART_NOSHOW)
        review = build_review(intake, Step2Compose(report=_report(), fit_rating=FitRating.GOOD))
        assert review.report is None
        assert review.fit_rating is None


class TestProceededFlow:
    def test_step2_available_when_proceeded(self):
        intake = Step1Intake(proceeded=MeetingProceeded.PROCEEDED, satisfaction=4)
        assert step2_available(intake) is True
        assert is_noshow(intake) is False

    def test_step1_only_save_is_incomplete(self):
        intake = Step1Intake(
            proceeded=MeetingProceeded.PROCEEDED,
            satisfaction=4,
            follow_up_intent=FollowUpIntent.REVIEWING,
            love_call=False,
        )
        review = build_review(intake)
        assert review.is_noshow is False
        assert review.satisfaction == 4
        assert review.follow_up_intent is FollowUpIntent.REVIEWING
        assert review.report is None
        assert review.report_confirmed is False

    def test_finalize_step2_saves_report_and_fit(self):
        intake = Step1Intake(
            proceeded=MeetingProceeded.PROCEEDED,
            satisfaction=5,
            follow_up_intent=FollowUpIntent.YES,
            love_call=True,
        )
        compose = Step2Compose(
            report=_report(), fit_rating=FitRating.GOOD, fit_reason="기술 성숙도 높고 일정 합의"
        )
        review = build_review(intake, compose, finalize_step2=True)

        assert review.report_confirmed is True
        assert review.report.actions == ["8월 말 소요검토 회신", "2차 실무미팅 일정 조율"]
        assert review.fit_rating is FitRating.GOOD
        assert review.fit_reason == "기술 성숙도 높고 일정 합의"
        assert review.love_call is True

    def test_finalize_with_empty_report_rejected(self):
        intake = Step1Intake(proceeded=MeetingProceeded.PROCEEDED, satisfaction=3)
        compose = Step2Compose(report=ReportSections(), fit_rating=FitRating.NORMAL)
        with pytest.raises(ReviewValidationError):
            build_review(intake, compose, finalize_step2=True)

    def test_finalize_without_compose_rejected(self):
        intake = Step1Intake(proceeded=MeetingProceeded.PROCEEDED, satisfaction=3)
        with pytest.raises(ReviewValidationError):
            build_review(intake, None, finalize_step2=True)


class TestValidationAndReentry:
    @pytest.mark.parametrize("bad", [0, 6, -1, 99])
    def test_satisfaction_out_of_range_rejected(self, bad):
        with pytest.raises(ReviewValidationError):
            normalize_intake(Step1Intake(proceeded=MeetingProceeded.PROCEEDED, satisfaction=bad))

    def test_reentry_edit_overwrites_prior_fit(self):
        # 재진입: 이전 저장본을 다시 만들고 fit_reason 을 수정해 재저장.
        intake = Step1Intake(proceeded=MeetingProceeded.PROCEEDED, satisfaction=4)
        first = build_review(
            intake, Step2Compose(report=_report(), fit_rating=FitRating.NORMAL, fit_reason="보통"),
            finalize_step2=True,
        )
        assert first.fit_rating is FitRating.NORMAL

        edited = build_review(
            intake,
            Step2Compose(report=_report(), fit_rating=FitRating.GOOD, fit_reason="재검토 후 상향"),
            finalize_step2=True,
        )
        assert edited.fit_rating is FitRating.GOOD
        assert edited.fit_reason == "재검토 후 상향"


class TestFitReview:
    def test_user_choice_overrides_ai_suggestion(self):
        assert apply_fit_review(FitRating.GOOD, FitRating.BAD) is FitRating.BAD

    def test_ai_suggestion_kept_when_user_untouched(self):
        assert apply_fit_review(FitRating.GOOD, None) is FitRating.GOOD

    def test_none_when_neither(self):
        assert apply_fit_review(None, None) is None
