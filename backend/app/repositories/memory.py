"""인메모리 리포지토리 — 테스트·로컬·데모. provenance 결합을 단일 단위로 저장한다."""

from __future__ import annotations

from datetime import datetime

from app.domain.love_call_signal import LoveCall
from app.domain.review_capture import NormalizedReview
from app.repositories.base import LoveCallRecord, MeetingView, StoredReview


class InMemoryRepository:
    def __init__(self) -> None:
        self._meetings: dict[str, MeetingView] = {}
        self._reviews: dict[tuple[str, str], StoredReview] = {}
        # (meeting_id, from_org_id, to_org_id) → 행 1개. DB 의 UNIQUE 와 같은 키다.
        self._love_calls: dict[tuple[str, str, str], LoveCallRecord] = {}

    # --- 시드(테스트/데모) ---
    def add_meeting(self, meeting: MeetingView) -> None:
        self._meetings[meeting.meeting_id] = meeting

    # --- Repository ---
    def get_meeting(self, meeting_id: str) -> MeetingView | None:
        return self._meetings.get(meeting_id)

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
    ) -> StoredReview:
        report = None
        if review.report is not None:
            report = {
                "discussion": review.report.discussion,
                "agreements": review.report.agreements,
                "actions": review.report.actions,
            }
        stored = StoredReview(
            meeting_id=meeting_id,
            reviewer_org_id=reviewer_org_id,
            is_noshow=review.is_noshow,
            counterpart_noshow=review.counterpart_noshow,
            satisfaction=review.satisfaction,
            follow_up_intent=review.follow_up_intent,
            love_call=review.love_call,
            report=report,
            fit_rating=review.fit_rating,
            fit_reason=review.fit_reason,
            fit_reason_tags=fit_reason_tags or [],
            transcript=transcript,
            transcript_turns=transcript_turns or [],
            audio_s3_key=audio_s3_key,
            report_confirmed=review.report_confirmed,
        )
        self._reviews[(meeting_id, reviewer_org_id)] = stored
        return stored

    def get_review(self, meeting_id: str, reviewer_org_id: str) -> StoredReview | None:
        return self._reviews.get((meeting_id, reviewer_org_id))

    def add_love_call(self, love_call: LoveCall) -> None:
        key = (love_call.meeting_id, love_call.from_org_id, love_call.to_org_id)
        if key not in self._love_calls:  # UNIQUE (meeting, from, to)
            self._love_calls[key] = LoveCallRecord(
                meeting_id=love_call.meeting_id,
                from_org_id=love_call.from_org_id,
                to_org_id=love_call.to_org_id,
            )

    def list_love_calls(self, meeting_id: str) -> list[LoveCall]:
        return [
            LoveCall(
                meeting_id=r.meeting_id, from_org_id=r.from_org_id, to_org_id=r.to_org_id
            )
            for r in self._love_calls.values()
            if r.meeting_id == meeting_id
        ]

    def get_love_call(
        self, meeting_id: str, from_org_id: str, to_org_id: str
    ) -> LoveCallRecord | None:
        return self._love_calls.get((meeting_id, from_org_id, to_org_id))

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
    ) -> LoveCallRecord:
        """발송 성공 뒤에만 호출된다 — 행이 없으면 만들고, 있으면 메일 이력을 채운다(upsert)."""
        key = (meeting_id, from_org_id, to_org_id)
        record = LoveCallRecord(
            meeting_id=meeting_id,
            from_org_id=from_org_id,
            to_org_id=to_org_id,
            email_subject=subject,
            email_body=body,
            email_recipient_count=recipient_count,
            email_sent_at=sent_at,
        )
        self._love_calls[key] = record
        return record
