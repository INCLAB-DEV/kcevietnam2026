"""미팅 완료 처리 tick + 리마인더 하한 테스트 (F-MT-001 × ADR-0010).

두 가지를 잠근다:

1. **completion tick** — 끝난 시각이 지난 확정 미팅을 ``completed``로 넘기고 양측에 리뷰 안내를
   발화한다. ``due_at``에 ``scheduled_end``를 실어 **리스케줄되면 다시 안내**되게 한다(NULL로
   두면 멱등 키가 미팅당 1회로 고정돼 재조정된 미팅의 안내가 영영 안 나간다).
2. **리마인더 하한** — ``scheduled_start >= now``. 없으면 몇 시간 전에 끝난 미팅에 "곧
   시작합니다"가 나가고, 과거 미팅이 매 tick마다 다시 스캔된다.

기존 `test_notification_scheduler.py`는 리마인더의 due/멱등을 다루고, 이 파일은 이번 슬라이스에서
새로 생긴 경계(완료 전이·하한)를 다룬다.
"""

from __future__ import annotations

import itertools
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from app.models import Event, Meeting, Notification, Organization
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


def _channels():
    """빈 이메일 채널 — 발송 부작용 없이 notifications 행 생성만 관찰한다."""
    return build_channels(FakeEmailSender())


def _seed_meeting(db, *, start, minutes=30, status="accepted") -> Meeting:
    n = next(_seq)
    event = Event(name="DX Korea 2026", slug=f"mt-sch-{n}")
    exhibitor = Organization(name_ko="셀러기업")
    buyer = Organization(name_ko="바이어기업")
    db.add_all([event, exhibitor, buyer])
    db.flush()
    meeting = Meeting(
        event_id=event.id,
        exhibitor_org_id=exhibitor.id,
        buyer_org_id=buyer.id,
        matching_type="open",
        status=status,
        scheduled_start=start,
        scheduled_end=start + timedelta(minutes=minutes),
    )
    db.add(meeting)
    db.commit()
    return meeting


def _for(notifications, meeting: Meeting) -> list[Notification]:
    """이 테스트가 만든 미팅의 알림만 추린다.

    ``migrated_db``는 세션 스코프라 앞선 테스트가 커밋한 미팅이 그대로 남는다 — tick은 DB 전체를
    훑으므로 "전체 결과 == 내 미팅"으로 단언하면 실행 순서에 묶인 테스트가 된다.
    """
    return [n for n in notifications if str(n.meeting_id) == str(meeting.id)]


def _prompts(db, meeting_id: str) -> list[Notification]:
    return list(
        db.execute(
            select(Notification).where(
                Notification.meeting_id == meeting_id, Notification.type == "review_prompt"
            )
        ).scalars().all()
    )


# =============================================================================
# completion tick
# =============================================================================
def test_finished_meeting_becomes_completed_and_prompts_both_sides(db):
    now = datetime.now(timezone.utc)
    meeting = _seed_meeting(db, start=now - timedelta(hours=1))

    completed = scheduler.run_completion_tick(db, now, channels=_channels())

    # The tick scans all events; other test modules can leave additional due meetings.
    assert str(meeting.id) in {str(m.id) for m in completed}
    db.refresh(meeting)
    assert meeting.status == "completed"
    assert meeting.updated_at is not None

    prompts = _prompts(db, meeting.id)
    assert {str(n.recipient_org_id) for n in prompts} == {
        str(meeting.exhibitor_org_id),
        str(meeting.buyer_org_id),
    }
    # due_at = 끝난 시각 — 리스케줄 시 새 안내가 나갈 수 있게 하는 멱등 키의 축.
    assert all(n.due_at == meeting.scheduled_end for n in prompts)


def test_meeting_still_running_is_untouched(db):
    now = datetime.now(timezone.utc)
    meeting = _seed_meeting(db, start=now - timedelta(minutes=10))  # 끝나기 전

    assert scheduler.run_completion_tick(db, now, channels=_channels()) == []
    db.refresh(meeting)
    assert meeting.status == "accepted"


def test_boundary_end_equal_to_now_is_completed(db):
    """``scheduled_end <= now`` — 끝나는 순간 tick이 돌면 완료로 본다(경계 포함)."""
    now = datetime.now(timezone.utc)
    meeting = _seed_meeting(db, start=now - timedelta(minutes=30))
    assert meeting.scheduled_end == now  # start + 30분 = now

    assert len(scheduler.run_completion_tick(db, now, channels=_channels())) == 1


@pytest.mark.parametrize("status", ["proposed", "cancelled", "rejected", "completed"])
def test_non_accepted_meetings_are_not_completed(db, status):
    """확정된 미팅만 완료로 간다 — 제안 상태로 시간이 지났다고 '진행됐다'가 되진 않는다."""
    now = datetime.now(timezone.utc)
    meeting = _seed_meeting(db, start=now - timedelta(hours=1), status=status)

    assert scheduler.run_completion_tick(db, now, channels=_channels()) == []
    db.refresh(meeting)
    assert meeting.status == status


def test_second_tick_is_idempotent(db):
    """이미 completed면 UPDATE 조건에 안 걸리고, 알림도 유니크 키로 한 번만 만들어진다."""
    now = datetime.now(timezone.utc)
    meeting = _seed_meeting(db, start=now - timedelta(hours=1))

    first = scheduler.run_completion_tick(db, now, channels=_channels())
    second = scheduler.run_completion_tick(db, now + timedelta(minutes=1), channels=_channels())

    assert len(first) == 1
    assert second == []
    assert len(_prompts(db, meeting.id)) == 2  # 양측 각 1행, 중복 없음


def test_review_prompt_is_idempotent_across_reruns(db):
    """같은 due_at으로는 재발화되지 않는다 — notifications 유니크(type, meeting, org, due_at)."""
    now = datetime.now(timezone.utc)
    meeting = _seed_meeting(db, start=now - timedelta(hours=1))
    scheduler.run_completion_tick(db, now, channels=_channels())

    # 상태를 되돌려 tick을 다시 태워도 같은 due_at이면 알림은 늘지 않는다.
    db.refresh(meeting)
    meeting.status = "accepted"
    db.commit()
    scheduler.run_completion_tick(db, now, channels=_channels())

    assert len(_prompts(db, meeting.id)) == 2


def test_rescheduled_meeting_gets_a_new_prompt(db):
    """끝난 시각이 바뀌면 새 안내가 나간다 — due_at을 NULL로 뒀다면 불가능한 동작."""
    now = datetime.now(timezone.utc)
    meeting = _seed_meeting(db, start=now - timedelta(hours=3))
    scheduler.run_completion_tick(db, now, channels=_channels())
    assert len(_prompts(db, meeting.id)) == 2

    db.refresh(meeting)
    meeting.status = "accepted"
    meeting.scheduled_start = now - timedelta(hours=1)
    meeting.scheduled_end = now - timedelta(minutes=30)
    db.commit()

    scheduler.run_completion_tick(db, now, channels=_channels())
    assert len(_prompts(db, meeting.id)) == 4  # 새 due_at으로 양측 각 1행 추가


def test_completion_processes_multiple_meetings_in_one_tick(db):
    now = datetime.now(timezone.utc)
    first = _seed_meeting(db, start=now - timedelta(hours=2))
    second = _seed_meeting(db, start=now - timedelta(hours=1))

    completed = scheduler.run_completion_tick(db, now, channels=_channels())
    assert {str(first.id), str(second.id)} <= {str(m.id) for m in completed}


# =============================================================================
# 리마인더 하한
# =============================================================================
def test_already_started_meeting_gets_no_reminder(db):
    """이미 시작한 미팅에 "10분 뒤 시작"을 보내지 않는다 — 하한(now)이 하는 일."""
    now = datetime.now(timezone.utc)
    meeting = _seed_meeting(db, start=now - timedelta(minutes=5))

    assert _for(scheduler.run_reminder_tick(db, now, channels=_channels()), meeting) == []


def test_long_past_meeting_is_not_rescanned(db):
    """완료 처리가 늦어도 과거 미팅이 리마인더 스캔에 다시 걸리지 않는다(스캔 비용 단조 증가 방지)."""
    now = datetime.now(timezone.utc)
    meeting = _seed_meeting(db, start=now - timedelta(days=2))

    assert _for(scheduler.run_reminder_tick(db, now, channels=_channels()), meeting) == []


def test_meeting_starting_exactly_now_is_included(db):
    """하한은 ``>= now`` — 정확히 지금 시작하는 미팅은 아직 '앞으로 시작'이다."""
    now = datetime.now(timezone.utc)
    meeting = _seed_meeting(db, start=now)

    created = _for(scheduler.run_reminder_tick(db, now, channels=_channels()), meeting)
    assert len(created) == 2


def test_upcoming_meeting_within_lead_time_still_gets_reminder(db):
    """하한을 넣었다고 정상 동작이 죽지 않는다 — 10분 이내 시작은 그대로 발화."""
    now = datetime.now(timezone.utc)
    meeting = _seed_meeting(db, start=now + timedelta(minutes=5))

    assert len(_for(scheduler.run_reminder_tick(db, now, channels=_channels()), meeting)) == 2


def test_reminder_then_completion_order_within_one_pass(db):
    """lifespan 루프 순서(리마인더 → 완료)를 그대로 재현 — 살아있는 미팅만 통지받는다."""
    now = datetime.now(timezone.utc)
    upcoming = _seed_meeting(db, start=now + timedelta(minutes=5))
    finished = _seed_meeting(db, start=now - timedelta(hours=1))

    reminders = scheduler.run_reminder_tick(db, now, channels=_channels())
    completed = scheduler.run_completion_tick(db, now, channels=_channels())

    reminded = {str(n.meeting_id) for n in reminders}
    assert str(upcoming.id) in reminded
    assert str(finished.id) not in reminded  # 이미 끝난 미팅엔 리마인더가 가지 않는다
    assert str(finished.id) in {str(m.id) for m in completed}


def test_completion_review_prompt_sends_no_mail_for_an_event_with_participant_email_off(db):
    """참가자 알림 메일(nt004mail0001)이 꺼진 행사 — 완료 전이·양측 리뷰 안내(인앱)는 그대로, 메일은 0통."""
    from app.models import EventScheduleSettings, Member, NotificationDispatch

    now = datetime.now(timezone.utc)
    meeting = _seed_meeting(db, start=now - timedelta(hours=1))
    n = next(_seq)
    emails = {f"prompt-off-exh-{n}@example.com", f"prompt-off-buy-{n}@example.com"}
    exh_email, buy_email = sorted(emails)
    db.add_all(
        [
            Member(organization_id=meeting.exhibitor_org_id, name="셀러담당", email=exh_email),
            Member(organization_id=meeting.buyer_org_id, name="바이어담당", email=buy_email),
            EventScheduleSettings(event_id=meeting.event_id, participant_email_enabled=False),
        ]
    )
    db.commit()
    sender = FakeEmailSender()

    completed = scheduler.run_completion_tick(db, now, channels=build_channels(sender))

    assert str(meeting.id) in {str(m.id) for m in completed}
    prompts = _prompts(db, meeting.id)
    assert len(prompts) == 2
    # tick은 DB 전체를 훑는다 — 이 행사 수신자에게 간 메일만 본다.
    assert [m for m in sender.sent if set(m.to) & emails] == []
    rows = db.execute(
        select(NotificationDispatch.channel, NotificationDispatch.status, NotificationDispatch.error)
        .where(NotificationDispatch.notification_id.in_([p.id for p in prompts]))
    ).all()
    assert sorted(rows) == sorted(
        [("in_app", "sent", None)] * 2 + [("email", "skipped", "event_email_disabled")] * 2
    )
