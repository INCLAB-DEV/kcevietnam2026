"""시간성 알림 폴링 스케줄러 (ADR-0010) — 10분 리마인더 + 종료 미팅 완료 처리.

두 tick 모두 호출 가능한 **순수 함수 스타일**이다 — 세션과 now(주입, 결정적 테스트)를 받아
할 일을 하고 결과를 돌려준다. FastAPI lifespan은 SCHEDULER_ENABLED 플래그 아래 asyncio 태스크로
1분 주기 호출할 뿐, 스케줄링 로직 자체는 여기 있다 — lifespan 유무와 무관하게 테스트가 tick을
직접 호출할 수 있다.

호출 순서는 **reminder → completion**이다. 뒤집으면 방금 completed로 넘긴 미팅에 리마인더를
보낼 일은 없지만(리마인더는 accepted만 본다), 시작 시각이 지난 미팅이 같은 tick에서 리마인더와
완료를 동시에 맞는 경계가 생긴다. 리마인더를 먼저 돌려 "아직 살아있는 미팅"만 통지한다.

멱등: notifications 유니크(type, meeting_id, recipient_org_id, due_at)가 중복 생성을 막는다 —
매 tick이 같은 대상을 다시 찾아도 두 번째부터는 no-op(재디스패치도 안 한다).

같은 루프에서 **하루 한 번** 회의록 텍스트 보존기간 정리도 돈다(``run_daily_text_retention`` —
app.services.meeting_text_retention). 1분마다 전체를 다시 훑지 않게 프로세스 안 표식(UTC 날짜)으로 거른다.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from contextlib import asynccontextmanager
from datetime import date, datetime, timedelta, timezone
from typing import Sequence

from sqlalchemy import select, update
from sqlalchemy.orm import Session

from app.config import settings
from app.db import SessionLocal
from app.models import Meeting
from app.notifications import service
from app.notifications.channels import NotificationChannel
from app.services.meeting_text_retention import RetentionResult, purge_expired_meeting_text

REMINDER_LEAD_MINUTES = 10
TICK_INTERVAL_SECONDS = 60
# 회의록 텍스트 정리가 실패하면(DB 일시 장애 등) 다음 tick(1분)마다 다시 두드리지 않고 이만큼 쉬었다가 다시 한다.
TEXT_RETENTION_RETRY_SECONDS = 3600

logger = logging.getLogger(__name__)


def run_reminder_tick(
    db: Session, now: datetime, *, channels: Sequence[NotificationChannel] | None = None
) -> list:
    """due(now <= scheduled_start <= now + 10분)이고 여전히 accepted인 미팅에 양측 리마인더를 발화한다.

    scheduled_start/end 둘 다 있어야 enqueue(ADR-0010 스케줄러 정확성 규칙) — 취소된 미팅은
    status 필터에서 자동 제외된다.

    **하한(``scheduled_start >= now``)이 중요하다.** 없으면 (1) 이미 시작한(혹은 몇 시간 전에
    끝난) 미팅에 "곧 시작합니다" 리마인더가 나가고, (2) completion tick이 늦게 도는 사이 과거
    미팅 전체가 매 tick마다 다시 스캔된다 — 알림은 멱등해서 중복 생성은 안 되지만 스캔 비용이
    행사 기간 내내 단조 증가한다.
    """
    due_before = now + timedelta(minutes=REMINDER_LEAD_MINUTES)
    meetings = db.execute(
        select(Meeting).where(
            Meeting.status == "accepted",
            Meeting.scheduled_start.isnot(None),
            Meeting.scheduled_end.isnot(None),
            Meeting.scheduled_start >= now,
            Meeting.scheduled_start <= due_before,
        )
    ).scalars().all()

    created = []
    for meeting in meetings:
        exhibitor_name = service.org_display_name(db, meeting.exhibitor_org_id)
        buyer_name = service.org_display_name(db, meeting.buyer_org_id)
        label = service.venue_label(db, meeting.venue_id)

        for recipient_org_id, counterpart_name in (
            (meeting.exhibitor_org_id, buyer_name),
            (meeting.buyer_org_id, exhibitor_name),
        ):
            n = service.notify_meeting_reminder(
                db,
                event_id=meeting.event_id,
                meeting_id=meeting.id,
                recipient_org_id=recipient_org_id,
                counterpart_org_name=counterpart_name,
                scheduled_start=meeting.scheduled_start,
                due_at=meeting.scheduled_start,
                venue_label=label,
                channels=channels,
            )
            if n is not None:
                created.append(n)
    return created


def run_completion_tick(
    db: Session, now: datetime, *, channels: Sequence[NotificationChannel] | None = None
) -> list[Meeting]:
    """끝난 시각이 지난 확정 미팅을 ``completed``로 넘기고 양측에 리뷰 안내를 발화한다.

    상태 전이는 **한 번의 조건부 UPDATE ... RETURNING**으로 한다 — SELECT 후 UPDATE로 나누면
    두 워커가 같은 미팅을 각각 집어 리뷰 안내를 두 번 만들 수 있다(알림 유니크가 막긴 하지만,
    그건 방어선이지 설계가 아니다). ``status='accepted'`` 조건이 UPDATE 자체에 있으므로 경합에서
    한 트랜잭션만 행을 가져간다.

    ``due_at``에는 ``scheduled_end``를 넣는다. 알림 멱등 키가 (type, meeting_id, recipient_org_id,
    due_at)이므로, **끝난 시각**을 키에 실으면 미팅이 리스케줄돼 다시 끝날 때 새 안내가 나간다 —
    NULL로 두면 최초 한 번만 나가고 재조정된 미팅의 리뷰 안내가 영영 안 간다.

    Returns:
        이번 tick에서 completed로 넘어간 미팅들.
    """
    completed_ids = db.execute(
        update(Meeting)
        .where(
            Meeting.status == "accepted",
            Meeting.scheduled_end.isnot(None),
            Meeting.scheduled_end <= now,
        )
        .values(status="completed", updated_at=now)
        .returning(Meeting.id)
    ).scalars().all()
    db.commit()
    if not completed_ids:
        return []

    meetings = db.execute(
        select(Meeting).where(Meeting.id.in_([str(i) for i in completed_ids]))
    ).scalars().all()
    for meeting in meetings:
        exhibitor_name = service.org_display_name(db, meeting.exhibitor_org_id)
        buyer_name = service.org_display_name(db, meeting.buyer_org_id)
        for recipient_org_id, counterpart_name in (
            (meeting.exhibitor_org_id, buyer_name),
            (meeting.buyer_org_id, exhibitor_name),
        ):
            service.notify_after_commit(
                db,
                lambda org=recipient_org_id, name=counterpart_name, m=meeting: service.notify_review_prompt(
                    db,
                    event_id=m.event_id,
                    meeting_id=m.id,
                    recipient_org_id=org,
                    counterpart_org_name=name,
                    due_at=m.scheduled_end,
                    channels=channels,
                ),
                description=f"review_prompt (meeting_id={meeting.id}, org={recipient_org_id})",
            )
    return list(meetings)


# =============================================================================
# 회의록 텍스트 보존기간 정리 — 하루 한 번(프로세스 안 표식), 알림 tick과 같은 루프·같은 스레드에서.
# =============================================================================
# 마지막으로 정리에 **성공한** 날(UTC)과, 실패했을 때 다음에 다시 해 볼 시각. 루프가 tick을 하나씩 순서대로 스레드에
# 넘기므로(동시에 두 tick이 돌지 않는다) 잠금 없이 모듈 전역으로 둔다. 프로세스가 새로 뜨면 첫 tick에서 한 번 돈다
# (정리는 멱등이라 재시작마다 돌아도 같은 결과다).
_text_retention_done_on: date | None = None
_text_retention_retry_at: datetime | None = None


def reset_text_retention_gate() -> None:
    """하루 한 번 표식을 비운다 — 테스트가 처음 상태에서 검증할 때 쓴다."""
    global _text_retention_done_on, _text_retention_retry_at
    _text_retention_done_on = None
    _text_retention_retry_at = None


def run_daily_text_retention(db: Session, now: datetime) -> RetentionResult | None:
    """오늘(UTC) 아직 안 했으면 회의록 텍스트 보존기간 정리를 한 번 돌린다. 안 돌렸으면 None.

    표식 확인은 메모리에서만 한다 — 이미 한 날의 tick은 DB를 전혀 건드리지 않는다. 정리 자체의 예외는 여기서 삼키고
    (알림 tick에 번지지 않게) ``TEXT_RETENTION_RETRY_SECONDS`` 뒤에 다시 해 본다. 로그에는 건수만 남긴다.
    """
    global _text_retention_done_on, _text_retention_retry_at
    today = now.astimezone(timezone.utc).date()
    if _text_retention_done_on == today:
        return None
    if _text_retention_retry_at is not None and now < _text_retention_retry_at:
        return None
    try:
        # 앞선 알림 tick이 예외로 끝나 트랜잭션이 깨져 있을 수 있다 — 깨끗한 상태에서 시작한다(tick들은 각자
        # 커밋하므로 정상 경로에선 되돌릴 것이 없다).
        db.rollback()
        result = purge_expired_meeting_text(
            db, now, retention_days=settings.meeting_text_retention_days_after_event
        )
    except Exception:  # noqa: BLE001 - 정리 실패가 알림 스케줄러를 멈추지 않는다(나중에 다시 한다)
        # 연결 자체가 끊긴 경우 롤백도 실패할 수 있다 — 그 예외가 알림 tick의 원래 예외를 덮지 않게 삼킨다.
        with contextlib.suppress(Exception):
            db.rollback()
        _text_retention_retry_at = now + timedelta(seconds=TEXT_RETENTION_RETRY_SECONDS)
        logger.exception("회의록 텍스트 보존기간 정리 실패 — %d초 뒤 다시 시도", TEXT_RETENTION_RETRY_SECONDS)
        return None
    _text_retention_done_on = today
    _text_retention_retry_at = None
    if result.changed or result.skipped_invalid_timezone:
        logger.warning(
            "회의록 텍스트 보존기간 정리 — 대상 행사 %d개, 리뷰 %d건·전사 초안 %d건의 텍스트를 지웠다"
            " (타임존을 해석할 수 없어 건너뛴 행사 %d개)",
            result.eligible_events,
            result.reviews_purged,
            result.drafts_purged,
            result.skipped_invalid_timezone,
        )
    return result


# =============================================================================
# FastAPI lifespan 게이트 — SCHEDULER_ENABLED(기본 false)일 때만 1분 주기로 tick을 돈다.
# =============================================================================
def _run_ticks_once() -> None:
    """한 tick의 동기 작업 전부(DB 조회·알림 생성·리마인더 SMTP 발송 + 하루 한 번 텍스트 정리). 이벤트 루프 밖
    스레드에서 돈다 — 세션도 그 스레드 안에서 열고 닫는다(세션을 스레드 간에 넘기지 않는다)."""
    with SessionLocal() as db:
        now = datetime.now(timezone.utc)
        try:
            # 순서 고정: 리마인더(아직 살아있는 미팅) → 완료 처리(끝난 미팅).
            run_reminder_tick(db, now)
            run_completion_tick(db, now)
        finally:
            # 알림 tick이 실패해도 보존기간 정리는 따로 돈다(자체 예외 처리) — 알림 쪽 장애가 텍스트 삭제를
            # 무기한 미루지 않게. 알림 tick의 예외는 그대로 루프로 올라가 기존처럼 로그된다.
            run_daily_text_retention(db, now)


async def _reminder_loop() -> None:
    while True:
        try:
            # 예전엔 tick을 이벤트 루프 위에서 그대로 돌렸다 — 미팅이 몰린 시각엔 리마인더 수십 통의 SMTP
            # 발송까지 끝날 때까지 서버 전체(요청 수락·모든 async 경로)가 멈췄다. 스레드로 넘겨 루프를 비운다.
            # 멱등(알림 유니크 키)과 완료 전이의 조건부 UPDATE는 tick 함수가 그대로 지킨다.
            await asyncio.to_thread(_run_ticks_once)
        except Exception:  # noqa: BLE001 - 한 tick 실패가 스케줄러 자체를 죽이지 않는다(다음 tick 재시도)
            logger.exception("알림 스케줄러 tick 실패")
        await asyncio.sleep(TICK_INTERVAL_SECONDS)


@asynccontextmanager
async def reminder_scheduler_lifespan(app):
    """FastAPI(lifespan=...)에 그대로 넘긴다. SCHEDULER_ENABLED=false(기본)면 아무 태스크도 안 돈다.

    꺼진 채로 뜨면 시작할 때 경고를 한 줄 남긴다 — 이 루프가 유일한 실행 경로인 일들(리마인더·종료 미팅 완료 처리·
    회의록 텍스트 보존기간 정리)이 조용히 안 도는 걸 운영 로그에서 바로 알아보게. 동작은 그대로다(로그만 남긴다).
    """
    task: asyncio.Task | None = None
    if settings.scheduler_enabled:
        task = asyncio.create_task(_reminder_loop())
    else:
        logger.warning(
            "SCHEDULER_ENABLED=false — 이 프로세스에서는 미팅 리마인더, 종료된 미팅의 자동 완료 처리(리뷰 안내 포함), "
            "회의록 텍스트 보존기간 정리(행사 종료 %d일 뒤)가 돌지 않는다",
            settings.meeting_text_retention_days_after_event,
        )
    try:
        yield
    finally:
        if task is not None:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task
