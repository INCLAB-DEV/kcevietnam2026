"""review-capture — 미팅 후 2-step 리뷰의 진행 상태를 캡슐화하는 deep module.

PRD F-MY-002 D1~D4 / Testing Decisions 의 외부 동작을 결정한다:
- Step 1(intake): 진행 여부 · 만족도(비공개) · Follow-up Intent(비공개) · Love Call(공개 토글)
- Q1에서 "불참" 선택 → noshow 플래그, 만족도/Follow-up/Love Call/Fit/보고문서를 모두 건너뛰고 저장
- Step 2: "진행됨"일 때만. AI 구조화 보고문서 + Fit Assessment(AI 제안→사용자 검수, 비공개)
- 재진입 시 작성 내용을 다시 불러와 수정

이 모듈은 DB·AI·HTTP를 모른다. 입력 dataclass를 받아 검증·정규화하고, 어떤 단계가
열려 있는지(step2_available)와 저장 가능한 정규형(NormalizedReview)을 돌려준다.
권한·노출 규칙은 love_call_signal, 출처 결합은 review_provenance_binding 이 담당한다.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum


class MeetingProceeded(str, Enum):
    """Q1 — 리뷰어 관점의 미팅 진행 여부. 한쪽이라도 '상대방 불참'이면 noshow(ADR-0004 보정)."""

    PROCEEDED = "proceeded"  # 진행됨 → Step2 진입 가능
    COUNTERPART_NOSHOW = "counterpart_noshow"  # 상대방 불참 → noshow
    SELF_NOSHOW = "self_noshow"  # 내가 불참 → noshow


class FollowUpIntent(str, Enum):
    """후속 진행 의향 (비공개, 매칭 효과 측정 핵심 KPI)."""

    NONE = "none"
    REVIEWING = "reviewing"
    YES = "yes"


class FitRating(str, Enum):
    """Fit Assessment 3점 (비공개). AI가 추론·제안하고 사용자가 검수한다."""

    GOOD = "good"  # 잘맞음
    NORMAL = "normal"  # 보통
    BAD = "bad"  # 안맞음


class ReviewValidationError(ValueError):
    """리뷰 입력이 단계 규칙을 위반했을 때."""


@dataclass(frozen=True)
class Step1Intake:
    """Step 1 입력. proceeded 만 필수. noshow면 나머지는 정규화 과정에서 비워진다."""

    proceeded: MeetingProceeded
    satisfaction: int | None = None  # 1~5 별점 (비공개)
    follow_up_intent: FollowUpIntent | None = None  # 비공개
    love_call: bool = False  # 공개 단방향 신호 토글


@dataclass(frozen=True)
class ReportSections:
    """AI가 raw 입력을 구조화한 보고문서 본문. 내보내기 대상(공개 가능)."""

    discussion: list[str] = field(default_factory=list)  # 핵심 논의사항
    agreements: list[str] = field(default_factory=list)  # 합의 사항
    actions: list[str] = field(default_factory=list)  # 후속 액션

    def is_empty(self) -> bool:
        return not (self.discussion or self.agreements or self.actions)


@dataclass(frozen=True)
class Step2Compose:
    """Step 2 입력 — AI 보고문서(검수·수정 후) + Fit Assessment(검수 후)."""

    report: ReportSections
    fit_rating: FitRating | None = None  # AI 제안을 사용자가 검수/수정
    fit_reason: str = ""  # 자유 입력 (비공개)


@dataclass(frozen=True)
class NormalizedReview:
    """저장 가능한 정규형. noshow면 비공개·Step2 필드가 모두 비어 있음이 보장된다."""

    proceeded: MeetingProceeded
    is_noshow: bool
    counterpart_noshow: bool  # 스키마 post_meeting_reviews.counterpart_noshow
    satisfaction: int | None
    follow_up_intent: FollowUpIntent | None
    love_call: bool
    report: ReportSections | None
    fit_rating: FitRating | None
    fit_reason: str
    report_confirmed: bool  # Step2 저장 완료 = 보고문서 확정


def is_noshow(intake: Step1Intake) -> bool:
    """리뷰어가 불참(상대/본인)을 선택했으면 noshow."""
    return intake.proceeded is not MeetingProceeded.PROCEEDED


def step2_available(intake: Step1Intake) -> bool:
    """Step 2(AI 보고문서 + Fit)는 '진행됨'일 때만 열린다."""
    return intake.proceeded is MeetingProceeded.PROCEEDED


def _validate_satisfaction(value: int | None) -> None:
    if value is None:
        return
    if not isinstance(value, int) or not (1 <= value <= 5):
        raise ReviewValidationError("만족도는 1~5 사이 정수여야 합니다")


def normalize_intake(intake: Step1Intake) -> Step1Intake:
    """noshow면 만족도/Follow-up/Love Call 을 모두 비운다 (D1: '나머지 건너뛰고 저장').

    진행됨이면 입력값을 그대로 두되 만족도 범위만 검증한다.
    """
    if is_noshow(intake):
        return Step1Intake(proceeded=intake.proceeded)
    _validate_satisfaction(intake.satisfaction)
    return intake


def build_review(
    intake: Step1Intake,
    compose: Step2Compose | None = None,
    *,
    finalize_step2: bool = False,
) -> NormalizedReview:
    """Step1(+선택적 Step2)을 저장 가능한 정규형으로 합친다.

    - noshow면 Step2(compose)는 허용되지 않는다(미도달). compose가 와도 무시한다.
    - 진행됨 + finalize_step2면 보고문서가 비어 있지 않아야 한다(AI 정리 선행).
    - 진행됨 + compose 없음이면 Step1만 저장된 미완료 상태(재진입해 Step2 작성 가능).
    """
    norm = normalize_intake(intake)

    if is_noshow(norm):
        # noshow: Step2 미도달. 보고문서/Fit 전부 없음.
        return NormalizedReview(
            proceeded=norm.proceeded,
            is_noshow=True,
            counterpart_noshow=(norm.proceeded is MeetingProceeded.COUNTERPART_NOSHOW),
            satisfaction=None,
            follow_up_intent=None,
            love_call=False,
            report=None,
            fit_rating=None,
            fit_reason="",
            report_confirmed=False,
        )

    report: ReportSections | None = None
    fit_rating: FitRating | None = None
    fit_reason = ""
    confirmed = False

    if compose is not None:
        report = compose.report
        fit_rating = compose.fit_rating
        fit_reason = (compose.fit_reason or "").strip()
        if finalize_step2:
            if report is None or report.is_empty():
                # AI 구조화는 보조 수단일 뿐 필수 관문이 아니다(QA C1) — 직접 입력한 내용으로도
                # report 가 비어 있지만 않으면 확정 가능. 여기선 정말 아무 내용도 없을 때만 막는다.
                raise ReviewValidationError(
                    "보고문서가 비어 있습니다 — 내용을 입력하거나 AI로 정리하세요"
                )
            confirmed = True
    elif finalize_step2:
        raise ReviewValidationError("Step2 확정에는 보고문서·Fit 입력(compose)이 필요합니다")

    return NormalizedReview(
        proceeded=norm.proceeded,
        is_noshow=False,
        counterpart_noshow=False,
        satisfaction=norm.satisfaction,
        follow_up_intent=norm.follow_up_intent,
        love_call=norm.love_call,
        report=report,
        fit_rating=fit_rating,
        fit_reason=fit_reason,
        report_confirmed=confirmed,
    )


def apply_fit_review(
    suggested: FitRating | None,
    user_choice: FitRating | None,
) -> FitRating | None:
    """AI 제안 Fit 을 사용자가 검수한 결과를 반영한다.

    사용자가 명시적으로 고른 값이 있으면 그것이 우선(수정 가능). 사용자가 손대지 않았으면
    AI 제안을 그대로 채택. 둘 다 없으면 미선택(None).
    """
    return user_choice if user_choice is not None else suggested
