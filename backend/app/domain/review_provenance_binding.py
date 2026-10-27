"""review-provenance-binding — 매칭 출처 보존 + 리뷰 저장 시 Fit 결합.

PRD F-MY-002 D11~D12 / ADR-0004:
- 모든 미팅 레코드에 발생 시점의 출처 메타(matching_type / ai_score / ai_score_reasons)를
  **영구 보존**한다. 점수는 사후 소급 불가 → 발생 시점에 박아야 한다.
- 리뷰 저장 시 Fit Assessment 를 그 미팅 레코드에 **원자적으로 결합**한다.
- AI 매칭: (ai_score, fit) 페어로 precision 측정. Open/On-site: ai_score 없음 → **대조군**.

이 모듈은 불변식(invariant)을 검증한다. 실제 원자성(트랜잭션)은 호출하는 리포지토리가
보장하지만, 결합 가능 여부·분석 분류는 여기서 순수하게 판정한다.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum

from .review_capture import FitRating


class MatchingType(str, Enum):
    """매칭 출처(누가 만들었나). AI 만 ai_score 를 가진다(ADR-0004/0005)."""

    AI = "ai"
    OPEN = "open"
    FORCED = "forced"
    ON_SITE = "on_site"


class AnalysisGroup(str, Enum):
    """성과 분석 축 — AI 추천군 vs 자율 발생 대조군(준실험)."""

    AI_MEASURED = "ai_measured"  # (ai_score, fit) 페어 측정 가능
    CONTROL = "control"  # ai_score 없음 — open/forced/on_site


class ProvenanceError(ValueError):
    """출처 메타 불변식 위반(AI 매칭인데 ai_score 부재, 사후 소급 시도 등)."""


@dataclass(frozen=True)
class MeetingProvenance:
    """미팅 발생 시점에 박힌 출처 메타 (불변)."""

    matching_type: MatchingType
    ai_score: float | None = None
    ai_score_reasons: list | dict | None = None

    def __post_init__(self) -> None:
        if self.matching_type is MatchingType.AI:
            if self.ai_score is None:
                raise ProvenanceError("AI 매칭은 발생 시점 ai_score 가 반드시 있어야 합니다")
        else:
            if self.ai_score is not None:
                raise ProvenanceError(
                    "Open/Forced/On-site 는 대조군 — ai_score 를 가질 수 없습니다"
                )


@dataclass(frozen=True)
class BoundReview:
    """출처 메타에 Fit 을 결합한 분석 레코드."""

    matching_type: MatchingType
    ai_score: float | None
    fit_rating: FitRating | None
    analysis_group: AnalysisGroup

    @property
    def is_measurable_pair(self) -> bool:
        """precision 측정에 쓸 수 있는 (ai_score, fit) 페어인가."""
        return (
            self.analysis_group is AnalysisGroup.AI_MEASURED
            and self.ai_score is not None
            and self.fit_rating is not None
        )


def classify(provenance: MeetingProvenance) -> AnalysisGroup:
    """출처로 분석군을 정한다. AI=측정군, 그 외=대조군."""
    if provenance.matching_type is MatchingType.AI:
        return AnalysisGroup.AI_MEASURED
    return AnalysisGroup.CONTROL


def bind_fit(provenance: MeetingProvenance, fit_rating: FitRating | None) -> BoundReview:
    """리뷰 저장 시 Fit 을 출처 메타에 결합한다.

    provenance 는 이미 발생 시점에 존재해야 한다(__post_init__ 가 불변식 보장).
    noshow 등으로 fit 이 없으면 결합은 되지만 측정 페어는 성립하지 않는다.
    """
    return BoundReview(
        matching_type=provenance.matching_type,
        ai_score=provenance.ai_score,
        fit_rating=fit_rating,
        analysis_group=classify(provenance),
    )
