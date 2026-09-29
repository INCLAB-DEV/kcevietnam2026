"""리포지토리 인터페이스 + 저장 DTO."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Protocol

from app.domain.love_call_signal import LoveCall
from app.domain.review_capture import FitRating, FollowUpIntent, NormalizedReview
from app.domain.review_provenance_binding import MatchingType, MeetingProvenance


@dataclass(frozen=True)
class MeetingView:
    """미팅 + 발생 시점 provenance(ADR-0004). 권한검사·결합의 전제."""

    meeting_id: str
    event_id: str
    exhibitor_org_id: str
    buyer_org_id: str
    matching_type: MatchingType
    ai_score: float | None = None
    ai_score_reasons: list | dict | None = None

    def participants(self) -> tuple[str, str]:
        return (self.exhibitor_org_id, self.buyer_org_id)

    def is_participant(self, org_id: str) -> bool:
        return org_id in self.participants()

    def counterpart_of(self, org_id: str) -> str:
        return self.buyer_org_id if org_id == self.exhibitor_org_id else self.exhibitor_org_id

    def provenance(self) -> MeetingProvenance:
        return MeetingProvenance(
            matching_type=self.matching_type,
            ai_score=self.ai_score,
            ai_score_reasons=self.ai_score_reasons,
        )


@dataclass
class StoredReview:
    """저장된 리뷰 1행. to_dict() 가 직렬화 어댑터(노출 규칙)로 들어가는 평탄 dict 를 만든다."""

    meeting_id: str
    reviewer_org_id: str
    is_noshow: bool
    counterpart_noshow: bool
    satisfaction: int | None
    follow_up_intent: FollowUpIntent | None
    love_call: bool
    report: dict | None  # {discussion, agreements, actions}
    fit_rating: FitRating | None
    fit_reason: str
    fit_reason_tags: list[str] = field(default_factory=list)
    transcript: str | None = None
    transcript_turns: list[dict] = field(default_factory=list)  # [{who, text}] 비공개(업로더 전용)
    audio_s3_key: str | None = None
    report_confirmed: bool = False

    def to_dict(self) -> dict:
        """전체 필드(비공개 포함) 평탄 dict. 상대 노출 시 love_call_signal 이 비공개를 제거한다."""
        return {
            "meeting_id": self.meeting_id,
            "reviewer_org_id": self.reviewer_org_id,
            "is_noshow": self.is_noshow,
            "counterpart_noshow": self.counterpart_noshow,
            "satisfaction": self.satisfaction,
            "follow_up_intent": self.follow_up_intent.value if self.follow_up_intent else None,
            "love_call": self.love_call,
            "report_sections": self.report,
            "fit_rating": self.fit_rating.value if self.fit_rating else None,
            "fit_reason": self.fit_reason,
            "fit_reason_tags": self.fit_reason_tags,
            "transcript": self.transcript,
            "transcript_turns": self.transcript_turns,
            "audio_s3_key": self.audio_s3_key,
            "report_confirmed": self.report_confirmed,
        }


@dataclass(frozen=True)
class LoveCallRecord:
    """love_calls 한 행 — 공개 신호(존재 자체) + 러브콜 **메일** 발송 이력(#13).

    신호와 메일은 다른 사건이다: Step1 의 Love Call 토글은 행만 만들고(메일 없음), 회의록 화면의
    러브콜 메일 발송이 같은 행에 본문·발송시각을 채운다. 그래서 "행이 있다" != "메일을 보냈다" 이고,
    중복 발송 판정은 반드시 ``email_sent``(=email_sent_at IS NOT NULL)로 한다.
    """

    meeting_id: str
    from_org_id: str
    to_org_id: str
    email_subject: str | None = None
    email_body: str | None = None
    email_recipient_count: int | None = None
    email_sent_at: datetime | None = None

    @property
    def email_sent(self) -> bool:
        return self.email_sent_at is not None


class Repository(Protocol):
    def get_meeting(self, meeting_id: str) -> MeetingView | None: ...

    def save_review(
        self,
        meeting_id: str,
        reviewer_org_id: str,
        review: NormalizedReview,
        *,
        fit_reason_tags: list[str] | None = None,
        transcript: str | None = None,
        transcript_turns: list[dict] | None = None,
        audio_s3_key: str | None = None,
    ) -> StoredReview: ...

    def get_review(self, meeting_id: str, reviewer_org_id: str) -> StoredReview | None: ...

    def add_love_call(self, love_call: LoveCall) -> None: ...

    def list_love_calls(self, meeting_id: str) -> list[LoveCall]: ...

    def get_love_call(
        self, meeting_id: str, from_org_id: str, to_org_id: str
    ) -> LoveCallRecord | None: ...

    def record_love_call_email(
        self,
        meeting_id: str,
        from_org_id: str,
        to_org_id: str,
        *,
        subject: str,
        body: str,
        recipient_count: int,
        sent_at: datetime,
    ) -> LoveCallRecord: ...
