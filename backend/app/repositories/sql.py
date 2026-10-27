"""SQLAlchemy 리포지토리 — 실 RDS(ADR-0008). provenance 결합을 한 트랜잭션으로 저장.

InMemoryRepository 와 동일 인터페이스. DB 미설정 환경(순수 슬라이스 테스트)에서는 사용되지 않으며,
deps.get_repository 가 database_url 설정 시 이걸 고른다. PK/FK 는 main 모델대로 문자열 UUID.
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import select

from app.db import SessionLocal
from app.domain.love_call_signal import LoveCall
from app.domain.review_capture import FitRating, FollowUpIntent, MeetingProceeded, NormalizedReview
from app.domain.review_provenance_binding import MatchingType
from app.models import LoveCall as LoveCallRow
from app.models import Meeting, PostMeetingReview
from app.repositories.base import LoveCallRecord, MeetingView, StoredReview


def _to_meeting_view(m: Meeting) -> MeetingView:
    return MeetingView(
        meeting_id=str(m.id),
        event_id=str(m.event_id),
        exhibitor_org_id=str(m.exhibitor_org_id),
        buyer_org_id=str(m.buyer_org_id),
        matching_type=MatchingType(m.matching_type),
        ai_score=float(m.ai_score) if m.ai_score is not None else None,
        ai_score_reasons=m.ai_score_reasons,
    )


def _to_love_call_record(r: LoveCallRow) -> LoveCallRecord:
    return LoveCallRecord(
        meeting_id=str(r.meeting_id),
        from_org_id=str(r.from_org_id),
        to_org_id=str(r.to_org_id),
        email_subject=r.email_subject,
        email_body=r.email_body,
        email_recipient_count=r.email_recipient_count,
        email_sent_at=r.email_sent_at,
    )


def _to_stored(r: PostMeetingReview) -> StoredReview:
    return StoredReview(
        meeting_id=str(r.meeting_id),
        reviewer_org_id=str(r.reviewer_org_id),
        # ⚠ counterpart_noshow만 보면 "내가 불참"(self_noshow)이 불참 아님으로 되돌아간다(회귀
        # 버그였음) — 둘 중 하나라도 True면 노쇼.
        is_noshow=bool(r.counterpart_noshow) or bool(r.self_noshow),
        counterpart_noshow=r.counterpart_noshow,
        satisfaction=r.satisfaction_rating,
        follow_up_intent=FollowUpIntent(r.follow_up_intent) if r.follow_up_intent else None,
        love_call=False,  # Love Call 은 love_calls 테이블에서 별도 조회.
        report=r.report_sections,
        fit_rating=FitRating(r.fit_rating) if r.fit_rating else None,
        fit_reason=r.fit_reason or "",
        fit_reason_tags=r.fit_reason_tags or [],
        transcript=r.transcript,
        transcript_turns=r.transcript_turns or [],
        audio_s3_key=r.audio_s3_key,
        report_confirmed=r.report_confirmed_at is not None,
    )


class SqlAlchemyRepository:
    def get_meeting(self, meeting_id: str) -> MeetingView | None:
        with SessionLocal() as db:
            m = db.get(Meeting, meeting_id)
            return _to_meeting_view(m) if m else None

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
        from sqlalchemy import func

        report = None
        if review.report is not None:
            report = {
                "discussion": review.report.discussion,
                "agreements": review.report.agreements,
                "actions": review.report.actions,
            }
        with SessionLocal() as db:
            row = db.execute(
                select(PostMeetingReview).where(
                    PostMeetingReview.meeting_id == meeting_id,
                    PostMeetingReview.reviewer_org_id == reviewer_org_id,
                )
            ).scalar_one_or_none()
            if row is None:
                row = PostMeetingReview(meeting_id=meeting_id, reviewer_org_id=reviewer_org_id)
                db.add(row)
            row.counterpart_noshow = review.counterpart_noshow
            row.self_noshow = review.proceeded is MeetingProceeded.SELF_NOSHOW
            row.satisfaction_rating = review.satisfaction
            row.follow_up_intent = review.follow_up_intent.value if review.follow_up_intent else None
            row.fit_rating = review.fit_rating.value if review.fit_rating else None
            row.fit_reason = review.fit_reason or None
            row.fit_reason_tags = fit_reason_tags or None
            row.report_sections = report
            row.transcript = transcript
            row.transcript_turns = transcript_turns or None
            row.audio_s3_key = audio_s3_key
            row.report_confirmed_at = func.now() if review.report_confirmed else None
            db.commit()
            db.refresh(row)
            return _to_stored(row)

    def get_review(self, meeting_id: str, reviewer_org_id: str) -> StoredReview | None:
        with SessionLocal() as db:
            row = db.execute(
                select(PostMeetingReview).where(
                    PostMeetingReview.meeting_id == meeting_id,
                    PostMeetingReview.reviewer_org_id == reviewer_org_id,
                )
            ).scalar_one_or_none()
            return _to_stored(row) if row else None

    def add_love_call(self, love_call: LoveCall) -> None:
        with SessionLocal() as db:
            meeting = db.get(Meeting, love_call.meeting_id)
            if meeting is None:
                return
            exists = db.execute(
                select(LoveCallRow).where(
                    LoveCallRow.meeting_id == love_call.meeting_id,
                    LoveCallRow.from_org_id == love_call.from_org_id,
                    LoveCallRow.to_org_id == love_call.to_org_id,
                )
            ).scalar_one_or_none()
            if exists:
                return
            db.add(
                LoveCallRow(
                    meeting_id=love_call.meeting_id,
                    event_id=meeting.event_id,
                    from_org_id=love_call.from_org_id,
                    to_org_id=love_call.to_org_id,
                )
            )
            db.commit()

    def list_love_calls(self, meeting_id: str) -> list[LoveCall]:
        with SessionLocal() as db:
            rows = db.execute(
                select(LoveCallRow).where(LoveCallRow.meeting_id == meeting_id)
            ).scalars().all()
            return [
                LoveCall(
                    meeting_id=str(r.meeting_id),
                    from_org_id=str(r.from_org_id),
                    to_org_id=str(r.to_org_id),
                )
                for r in rows
            ]

    def get_love_call(
        self, meeting_id: str, from_org_id: str, to_org_id: str
    ) -> LoveCallRecord | None:
        with SessionLocal() as db:
            row = self._find_love_call(db, meeting_id, from_org_id, to_org_id)
            return _to_love_call_record(row) if row else None

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
        """메일 발송이 **성공한 뒤에만** 호출된다 — 신호 행이 없으면 만들고 메일 이력을 채운다.

        Step1 의 Love Call 토글이 이미 신호 행을 만들어 뒀을 수 있어 insert 가 아니라 upsert 다
        (UNIQUE(meeting_id, from_org_id, to_org_id) 충돌 회피).
        """
        with SessionLocal() as db:
            row = self._find_love_call(db, meeting_id, from_org_id, to_org_id)
            if row is None:
                meeting = db.get(Meeting, meeting_id)
                if meeting is None:
                    raise ValueError(f"미팅 없음: {meeting_id}")
                row = LoveCallRow(
                    meeting_id=meeting_id,
                    event_id=meeting.event_id,
                    from_org_id=from_org_id,
                    to_org_id=to_org_id,
                )
                db.add(row)
            row.email_subject = subject
            row.email_body = body
            row.email_recipient_count = recipient_count
            row.email_sent_at = sent_at
            db.commit()
            db.refresh(row)
            return _to_love_call_record(row)

    @staticmethod
    def _find_love_call(db, meeting_id: str, from_org_id: str, to_org_id: str):
        return db.execute(
            select(LoveCallRow).where(
                LoveCallRow.meeting_id == meeting_id,
                LoveCallRow.from_org_id == from_org_id,
                LoveCallRow.to_org_id == to_org_id,
            )
        ).scalar_one_or_none()
