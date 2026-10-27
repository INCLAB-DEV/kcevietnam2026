"""회의록 텍스트 보존기간 정리 — 행사 종료일 + N일(기본 30)이 지난 행사의 회의록 **자유 텍스트**를 지운다.

발주사 결정(2026-10-02): 회의록 텍스트도 녹음 원본과 같은 원칙으로 행사 종료 30일 뒤 지운다(녹음 원본은 행사별
S3 수명주기 규칙 — 접두사 ``meetings/{event_id}/``). 효과 입증에 쓰는 정형 결과(만족도·후속의향·Fit 등급·노쇼·
보고서 확정 시각·미팅 상태·러브콜 여부)는 남긴다 — 지우는 건 사람이 쓴 문장과 AI가 쓴 문장뿐이다.

컬럼별 결정(지우는 것 / 남기는 것):

- ``post_meeting_reviews`` — 텍스트만 담긴 칸은 행을 지우지 않고 NULL로 비운다.
  - 지움: ``transcript``(전사 원문, 또는 '직접 입력' 메모), ``fit_reason``(적합도 사유 — 자유 입력),
    ``transcript_turns``(JSONB ``[{who, text}]`` 화자별 전사 — ``who``는 지운 문장에 붙은 화자 표시라 홀로 의미가
    없어 칸째 비운다), ``report_sections``(JSONB ``{discussion, agreements, actions}`` — 키는 고정 섹션명이고 값이
    전부 문장이라 칸째 비운다).
  - 남김: ``satisfaction_rating``·``follow_up_intent``·``fit_rating``·``fit_reason_tags``(카테고리 태그)·
    ``counterpart_noshow``·``self_noshow``·``report_confirmed_at``·``created_at``·``audio_s3_key``(녹음 원본 위치 —
    원본 자체는 S3 수명주기 규칙이 지운다).
- ``transcription_jobs.draft`` — JSONB 하나에 문장과 정형 값이 섞여 있다(AI 초안). **문장 키만** 빈 값으로 덮는다:
  ``report`` → 빈 3섹션, ``transcript`` → ``""``, ``transcript_turns`` → ``[]``, ``fit_reason_seed`` → ``""``.
  ``fit_suggestion``(AI가 제안한 등급 — 사용자 확정값과 비교할 수 있다)·``fit_reason_tags``·``audio_s3_key``는 남는다.
  빈 값으로 덮는 이유: 폴링 응답 스키마(StructureDraftResponse)가 그 키들을 필수로 요구한다 — 지우면 오래된 작업을
  조회할 때 응답 검증이 깨진다. 행·status·시각도 남긴다(녹음 업로드 건수·성공률 집계).

적격 판정은 행사마다 그 행사의 ``exhibition_end``(날짜)와 ``timezone``(IANA)으로 한다: 그 행사 현지 날짜가
``exhibition_end + N일``을 넘겼을 때(= 현지 기준 ``exhibition_end + N + 1``일 0시부터). 종료일이 없거나 타임존이
잘못된 행사는 건너뛴다. 행사 날짜를 코드에 박지 않는다(멀티 행사, ADR-0012).

멱등: 텍스트가 남아 있는 행만 조건에 걸리므로, 이미 지운 행은 다시 쓰지 않는다(매일 돌려도 결과가 같다). 정리
뒤에 누가 그 행사의 회의록을 다시 저장하면 다음 실행에서 다시 지운다. 지우는 범위는 적격 행사의 미팅으로만 한정한다.
로그에는 건수만 남긴다(지운 문장은 어디에도 남기지 않는다).
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date, datetime, timedelta

from sqlalchemy import func, literal, null, or_, select, update
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Session

from app.matching.slot_grid import SlotError, resolve_zone
from app.models import Event, Meeting, PostMeetingReview, TranscriptionJob

# transcription_jobs.draft(StructureDraftResponse 직렬화)의 문장 키를 덮을 빈 값 — jsonb ``||``(최상위 키 병합)로
# 이 키들만 바꾸고 나머지 키(fit_suggestion·fit_reason_tags·audio_s3_key)는 그대로 둔다.
DRAFT_TEXT_BLANKS: dict = {
    "report": {"discussion": [], "agreements": [], "actions": []},
    "transcript": "",
    "transcript_turns": [],
    "fit_reason_seed": "",
}


@dataclass(frozen=True)
class EligibleEvents:
    event_ids: list[str]
    skipped_invalid_timezone: int = 0


@dataclass(frozen=True)
class RetentionResult:
    """한 번 정리한 결과(건수만) — 로그·테스트용."""

    eligible_events: int
    reviews_purged: int
    drafts_purged: int
    skipped_invalid_timezone: int = 0

    @property
    def changed(self) -> bool:
        return bool(self.reviews_purged or self.drafts_purged)


def is_text_expired(
    exhibition_end: date | None, timezone_name: str, now: datetime, retention_days: int
) -> bool:
    """행사 현지 날짜(now 기준)가 ``exhibition_end + retention_days``를 넘겼는가. 종료일이 없으면 False.

    타임존 문자열이 잘못됐으면 ``SlotError``(조용히 UTC로 가정하지 않는다 — 호출부가 그 행사를 건너뛴다).
    """
    if exhibition_end is None:
        return False
    if now.tzinfo is None:
        raise ValueError("now는 tz-aware여야 한다")
    local_today = now.astimezone(resolve_zone(timezone_name)).date()
    return local_today > exhibition_end + timedelta(days=retention_days)


def find_expired_events(db: Session, now: datetime, *, retention_days: int) -> EligibleEvents:
    """텍스트 보존기간이 끝난 행사 ID들. 행사 수만큼만 읽는다(가벼운 조회)."""
    rows = db.execute(
        select(Event.id, Event.exhibition_end, Event.timezone).where(Event.exhibition_end.isnot(None))
    ).all()
    eligible: list[str] = []
    skipped = 0
    for event_id, exhibition_end, timezone_name in rows:
        try:
            if is_text_expired(exhibition_end, timezone_name, now, retention_days):
                eligible.append(str(event_id))
        except SlotError:
            skipped += 1
    return EligibleEvents(event_ids=eligible, skipped_invalid_timezone=skipped)


def _has_json_value(column):
    """JSONB 칸에 실제 값이 있는가 — SQL NULL도, JSON ``null``도 아닌 경우.

    ORM이 JSONB 칸에 None을 넣으면 SQL NULL이 아니라 JSON ``null``이 저장될 수 있다(SQLAlchemy JSON 기본 동작).
    ``IS NOT NULL``만 보면 그런 행이 매번 '지울 것'으로 잡혀 멱등이 깨진다.
    """
    return func.coalesce(func.jsonb_typeof(column), "null") != "null"


def purge_event_meeting_text(db: Session, event_ids: Sequence[str]) -> tuple[int, int]:
    """주어진 행사들의 미팅에 달린 회의록 자유 텍스트를 지운다(커밋까지). 반환: (리뷰 행 수, 초안 행 수).

    텍스트가 아직 남아 있는 행만 바꾸므로 반환 건수는 '이번에 실제로 지운 행 수'다.
    """
    if not event_ids:
        return 0, 0
    meetings = select(Meeting.id).where(Meeting.event_id.in_(list(event_ids)))

    reviews = db.execute(
        update(PostMeetingReview)
        .where(
            PostMeetingReview.meeting_id.in_(meetings),
            or_(
                PostMeetingReview.transcript.isnot(None),
                PostMeetingReview.fit_reason.isnot(None),
                _has_json_value(PostMeetingReview.transcript_turns),
                _has_json_value(PostMeetingReview.report_sections),
            ),
        )
        # JSONB 칸은 null()로 — None을 넘기면 JSON null이 저장된다(_has_json_value 참고).
        .values(transcript=None, fit_reason=None, transcript_turns=null(), report_sections=null())
        .execution_options(synchronize_session=False)
    ).rowcount

    blanked = TranscriptionJob.draft.op("||")(literal(DRAFT_TEXT_BLANKS, type_=JSONB))
    drafts = db.execute(
        update(TranscriptionJob)
        .where(
            TranscriptionJob.meeting_id.in_(meetings),
            func.jsonb_typeof(TranscriptionJob.draft) == "object",
            TranscriptionJob.draft != blanked,  # 이미 비운 초안은 다시 쓰지 않는다(멱등)
        )
        .values(draft=blanked)
        .execution_options(synchronize_session=False)
    ).rowcount
    db.commit()
    return reviews or 0, drafts or 0


def purge_expired_meeting_text(db: Session, now: datetime, *, retention_days: int) -> RetentionResult:
    """보존기간이 끝난 모든 행사의 회의록 텍스트를 지운다 — 스케줄러가 하루 한 번 부른다."""
    expired = find_expired_events(db, now, retention_days=retention_days)
    if not expired.event_ids:
        db.rollback()  # 읽기 트랜잭션만 끝낸다(커넥션 반납)
        return RetentionResult(0, 0, 0, expired.skipped_invalid_timezone)
    reviews, drafts = purge_event_meeting_text(db, expired.event_ids)
    return RetentionResult(len(expired.event_ids), reviews, drafts, expired.skipped_invalid_timezone)
