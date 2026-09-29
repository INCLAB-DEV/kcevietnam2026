"""10분 리마인더 스케줄러 테스트 (ADR-0010) — due 미팅 양측 발화 + 멱등 + 자격 필터.

로컬 Postgres 없으면 conftest의 skip 패턴(migrated_db)에 따라 전체 skip.
"""

from __future__ import annotations

import itertools
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import create_engine
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import sessionmaker

from app.models import Event, Meeting, Organization
from app.notifications import scheduler
from app.notifications.channels import build_channels
from app.notifications.email import FakeEmailSender

_seq = itertools.count(1)


@pytest.fixture()
def db_factory(migrated_db: str):
    engine = create_engine(migrated_db, future=True)
    TestSession = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)
    yield TestSession
    engine.dispose()


@pytest.fixture()
def db(db_factory):
    session = db_factory()
    yield session
    session.close()


def _seed_meeting(db, *, scheduled_start, status="accepted"):
    n = next(_seq)
    ev = Event(name="DX Korea 2026", slug=f"nt-sch-{n}")
    org_a = Organization(name_ko="셀러기업")
    org_b = Organization(name_ko="바이어기업")
    db.add_all([ev, org_a, org_b])
    db.flush()
    meeting = Meeting(
        event_id=ev.id,
        exhibitor_org_id=org_a.id,
        buyer_org_id=org_b.id,
        matching_type="open",
        status=status,
        scheduled_start=scheduled_start,
        scheduled_end=scheduled_start + timedelta(minutes=30),
    )
    db.add(meeting)
    db.commit()
    return meeting


def test_due_meeting_gets_reminder_for_both_sides(db):
    now = datetime.now(timezone.utc)
    meeting = _seed_meeting(db, scheduled_start=now + timedelta(minutes=5))
    channels = build_channels(FakeEmailSender())

    created = scheduler.run_reminder_tick(db, now, channels=channels)

    assert len(created) == 2
    assert {n.recipient_org_id for n in created} == {meeting.exhibitor_org_id, meeting.buyer_org_id}
    assert all(n.type == "meeting_reminder" for n in created)
    assert all(n.meeting_id == meeting.id for n in created)


def test_not_yet_due_meeting_is_skipped(db):
    now = datetime.now(timezone.utc)
    _seed_meeting(db, scheduled_start=now + timedelta(minutes=30))

    created = scheduler.run_reminder_tick(db, now)

    assert created == []


def test_non_accepted_meeting_is_excluded(db):
    now = datetime.now(timezone.utc)
    _seed_meeting(db, scheduled_start=now + timedelta(minutes=5), status="cancelled")

    created = scheduler.run_reminder_tick(db, now)

    assert created == []


def test_second_tick_is_idempotent(db):
    now = datetime.now(timezone.utc)
    _seed_meeting(db, scheduled_start=now + timedelta(minutes=5))
    channels = build_channels(FakeEmailSender())

    first = scheduler.run_reminder_tick(db, now, channels=channels)
    second = scheduler.run_reminder_tick(db, now, channels=channels)

    assert len(first) == 2
    assert second == []


def test_accepted_without_scheduled_end_is_rejected_by_db(db):
    """"scheduled_start/end 둘 다 있어야 한다"는 규칙이 이제 **DB 제약**이다(mt001meet01).

    예전엔 이걸 스케줄러 tick의 방어적 필터로만 지켰다. 지금은 ``meetings_accepted_requires_
    schedule_check``가 그런 행의 존재 자체를 막으므로, 검증 대상이 "tick이 걸러낸다"에서 "애초에
    만들어지지 않는다"로 올라갔다 — 더 강한 보장이라 tick 필터는 이중 방어로 남는다.
    """
    now = datetime.now(timezone.utc)
    n = next(_seq)
    ev = Event(name="DX Korea 2026", slug=f"nt-sch-noend-{n}")
    org_a = Organization(name_ko="셀러기업")
    org_b = Organization(name_ko="바이어기업")
    db.add_all([ev, org_a, org_b])
    db.flush()
    db.add(
        Meeting(
            event_id=ev.id, exhibitor_org_id=org_a.id, buyer_org_id=org_b.id,
            matching_type="open", status="accepted",
            scheduled_start=now + timedelta(minutes=5), scheduled_end=None,
        )
    )
    with pytest.raises(IntegrityError, match="meetings_accepted_requires_schedule_check"):
        db.commit()
    db.rollback()

    assert scheduler.run_reminder_tick(db, now) == []
