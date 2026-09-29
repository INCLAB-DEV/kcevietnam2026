"""review-provenance-binding 외부 동작 테스트 — 원자성·결합·대조군 분류(PRD).

- 미팅 발생 시점 matching_type/ai_score 가 보존되고, 리뷰 저장 시 Fit 이 결합된다.
- AI 매칭: (ai_score, fit) 페어가 측정 가능하게 남는다.
- Open/On-site: ai_score 없이 대조군으로 분류된다.
- AI 매칭인데 ai_score 가 없으면(사후 소급 불가) 불변식 위반으로 실패.
"""

import pytest

from app.domain.review_capture import FitRating
from app.domain.review_provenance_binding import (
    AnalysisGroup,
    MatchingType,
    MeetingProvenance,
    ProvenanceError,
    bind_fit,
    classify,
)


class TestProvenanceInvariants:
    def test_ai_requires_score(self):
        with pytest.raises(ProvenanceError):
            MeetingProvenance(matching_type=MatchingType.AI, ai_score=None)

    def test_control_cannot_have_score(self):
        with pytest.raises(ProvenanceError):
            MeetingProvenance(matching_type=MatchingType.OPEN, ai_score=0.8)

    def test_ai_with_score_ok(self):
        p = MeetingProvenance(
            matching_type=MatchingType.AI, ai_score=0.87, ai_score_reasons=["제품 적합성"]
        )
        assert p.ai_score == 0.87


class TestClassification:
    def test_ai_is_measured_group(self):
        p = MeetingProvenance(matching_type=MatchingType.AI, ai_score=0.9)
        assert classify(p) is AnalysisGroup.AI_MEASURED

    @pytest.mark.parametrize(
        "mt", [MatchingType.OPEN, MatchingType.FORCED, MatchingType.ON_SITE]
    )
    def test_non_ai_is_control(self, mt):
        p = MeetingProvenance(matching_type=mt)
        assert classify(p) is AnalysisGroup.CONTROL


class TestBinding:
    def test_ai_fit_pair_is_measurable(self):
        p = MeetingProvenance(matching_type=MatchingType.AI, ai_score=0.91)
        bound = bind_fit(p, FitRating.GOOD)
        assert bound.analysis_group is AnalysisGroup.AI_MEASURED
        assert bound.ai_score == 0.91
        assert bound.fit_rating is FitRating.GOOD
        assert bound.is_measurable_pair is True

    def test_control_records_fit_without_score(self):
        p = MeetingProvenance(matching_type=MatchingType.ON_SITE)
        bound = bind_fit(p, FitRating.NORMAL)
        assert bound.analysis_group is AnalysisGroup.CONTROL
        assert bound.ai_score is None
        assert bound.fit_rating is FitRating.NORMAL
        assert bound.is_measurable_pair is False  # 대조군은 precision 페어 아님

    def test_noshow_no_fit_still_binds_but_not_measurable(self):
        p = MeetingProvenance(matching_type=MatchingType.AI, ai_score=0.5)
        bound = bind_fit(p, None)
        assert bound.is_measurable_pair is False
