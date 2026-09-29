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
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from typing import Sequence

from sqlalchemy import select, update
from sqlalchemy.orm import Session

from app.config import settings
from app.db import SessionLocal
from app.models import Meeting
from app.notifications import service
from app.notifications.channels import NotificationChannel

REMINDER_LEAD_MINUTES = 10
TICK_INTERVAL_SECONDS = 60

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
# FastAPI lifespan 게이트 — SCHEDULER_ENABLED(기본 false)일 때만 1분 주기로 tick을 돈다.
# =============================================================================
async def _reminder_loop() -> None:
    while True:
        try:
            with SessionLocal() as db:
                now = datetime.now(timezone.utc)
                # 순서 고정: 리마인더(아직 살아있는 미팅) → 완료 처리(끝난 미팅).
                run_reminder_tick(db, now)
                run_completion_tick(db, now)
        except Exception:  # noqa: BLE001 - 한 tick 실패가 스케줄러 자체를 죽이지 않는다(다음 tick 재시도)
            logger.exception("알림 스케줄러 tick 실패")
        await asyncio.sleep(TICK_INTERVAL_SECONDS)


@asynccontextmanager
async def reminder_scheduler_lifespan(app):
    """FastAPI(lifespan=...)에 그대로 넘긴다. SCHEDULER_ENABLED=false(기본)면 아무 태스크도 안 돈다."""
    task: asyncio.Task | None = None
    if settings.scheduler_enabled:
        task = asyncio.create_task(_reminder_loop())
    try:
        yield
    finally:
        if task is not None:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task
