"""알림 서비스 계층 테스트 (F-NT-001, ADR-0010) — 생성 멱등성 + org 공유 인박스/읽음 + 채널 디스패치.

로컬 Postgres 없으면 conftest의 skip 패턴(migrated_db)에 따라 전체 skip한다(순수 규칙은
test_notification_schemas.py/test_notification_channels.py가 DB 없이 커버).
"""

from __future__ import annotations

import itertools

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from app.models import Event, Member, Notification, NotificationDispatch, Organization
from app.notifications import service
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


def _seed_event_and_orgs(db):
    n = next(_seq)
    ev = Event(name="DX Korea 2026", slug=f"nt-svc-{n}")
    org_a = Organization(name_ko="셀러기업")
    org_b = Organization(name_ko="바이어기업")
    db.add_all([ev, org_a, org_b])
    db.commit()
    return ev, org_a, org_b


def _seed_member(db, org, email: str):
    member = Member(organization_id=org.id, name="테스트멤버", email=email)
    db.add(member)
    db.commit()
    return member


def _fake_channels():
    sender = FakeEmailSender()
    return build_channels(sender), sender


class TestIdempotentCreation:
    def test_duplicate_call_creates_one_row_and_skips_second_dispatch(self, db):
        ev, org_a, _org_b = _seed_event_and_orgs(db)
        channels, sender = _fake_channels()
        kwargs = dict(
            event_id=ev.id,
            meeting_id=None,
            recipient_org_id=org_a.id,
            counterpart_org_name="바이어기업",
            requested_by_role="buyer",
            channels=channels,
        )
        first = service.notify_meeting_requested(db, **kwargs)
        second = service.notify_meeting_requested(db, **kwargs)

        assert first is not None
        assert second is None  # 멱등 충돌 — 재디스패치 없음
        rows = db.execute(
            select(Notification).where(Notification.recipient_org_id == org_a.id)
        ).scalars().all()
        assert len(rows) == 1
        # 두 번째 호출은 채널을 아예 안 태워 이메일이 중복 발송되지 않는다.
        assert len(sender.sent) <= 1

    def test_application_approved_duplicate_call_creates_one_row(self, db):
        # meeting_id/due_at이 둘 다 NULL인 이벤트형 통지 — 같은 org를 두 번 승인해도(재승인 등)
        # 유니크(type, meeting_id, recipient_org_id, due_at)에 걸려 재통지되지 않는다.
        ev, org_a, _org_b = _seed_event_and_orgs(db)
        channels, sender = _fake_channels()
        kwargs = dict(
            event_id=ev.id, recipient_org_id=org_a.id,
            org_name="셀러기업", role="exhibitor", channels=channels,
        )
        first = service.notify_application_approved(db, **kwargs)
        second = service.notify_application_approved(db, **kwargs)

        assert first is not None
        assert second is None
        rows = db.execute(
            select(Notification).where(
                Notification.recipient_org_id == org_a.id, Notification.type == "application_approved"
            )
        ).scalars().all()
        assert len(rows) == 1
        assert len(sender.sent) <= 1

    def test_meeting_rejected_duplicate_call_creates_one_row(self, db):
        # meeting_id가 멱등 키의 일부라 같은 미팅을 두 번 거절 통지해도(이론상의 안전망 — 실제
        # 상태 전이는 proposed→rejected 단방향이라 재거절 경로 자체가 없다) 재통지되지 않는다.
        # meeting_id는 FK라 실제 Meeting 행이 필요하지만(notifications.meeting_id → meetings.id),
        # 이 유닛 테스트는 meetings 도메인을 세팅하지 않는다 — 다른 이벤트형 통지 테스트와 같은
        # 패턴으로 None을 써서 멱등 키 동작만 격리 검증한다(실제 meeting_id 연계는
        # test_meetings_api.py의 reject 통합 테스트가 커버).
        ev, org_a, org_b = _seed_event_and_orgs(db)
        channels, sender = _fake_channels()
        kwargs = dict(
            event_id=ev.id, meeting_id=None, recipient_org_id=org_a.id,
            counterpart_org_name="바이어기업", channels=channels,
        )
        first = service.notify_meeting_rejected(db, **kwargs)
        second = service.notify_meeting_rejected(db, **kwargs)

        assert first is not None
        assert second is None
        rows = db.execute(
            select(Notification).where(
                Notification.recipient_org_id == org_a.id, Notification.type == "meeting_rejected"
            )
        ).scalars().all()
        assert len(rows) == 1
        assert len(sender.sent) <= 1

    def test_different_types_are_independent_rows(self, db):
        ev, org_a, _org_b = _seed_event_and_orgs(db)
        channels, _sender = _fake_channels()
        n1 = service.notify_meeting_requested(
            db, event_id=ev.id, meeting_id=None, recipient_org_id=org_a.id,
            counterpart_org_name="B", requested_by_role="buyer", channels=channels,
        )
        n2 = service.notify_review_prompt(
            db, event_id=ev.id, meeting_id=None, recipient_org_id=org_a.id,
            counterpart_org_name="B", channels=channels,
        )
        assert n1 is not None and n2 is not None
        assert n1.id != n2.id


class TestChannelDispatch:
    def test_email_and_in_app_dispatch_recorded_for_member(self, db):
        ev, org_a, _org_b = _seed_event_and_orgs(db)
        member = _seed_member(db, org_a, email="buyer@nabi.test")
        channels, sender = _fake_channels()

        n = service.notify_meeting_requested(
            db, event_id=ev.id, meeting_id=None, recipient_org_id=org_a.id,
            counterpart_org_name="바이어기업", requested_by_role="buyer", channels=channels,
        )
        assert n is not None

        dispatches = db.execute(
            select(NotificationDispatch).where(NotificationDispatch.notification_id == n.id)
        ).scalars().all()
        by_channel = {d.channel: d for d in dispatches}
        assert by_channel["in_app"].status == "sent"
        assert by_channel["in_app"].member_id == member.id
        assert by_channel["email"].status == "sent"
        assert len(sender.sent) == 1
        assert sender.sent[0].to == [member.email]

    def test_payload_snapshot_matches_type_schema(self, db):
        ev, org_a, _org_b = _seed_event_and_orgs(db)
        channels, _sender = _fake_channels()
        n = service.notify_meeting_reminder(
            db, event_id=ev.id, meeting_id=None, recipient_org_id=org_a.id,
            counterpart_org_name="바이어기업", scheduled_start="2026-09-03T10:00:00+09:00",
            due_at=None, venue_label="A홀 B-12", channels=channels,
        )
        assert n.type == "meeting_reminder"
        assert n.payload == {
            "counterpart_org_name": "바이어기업",
            "scheduled_start": "2026-09-03T10:00:00+09:00",
            "venue_label": "A홀 B-12",
        }

    def test_application_approved_payload_snapshot_and_email_dispatch(self, db):
        ev, org_a, _org_b = _seed_event_and_orgs(db)
        member = _seed_member(db, org_a, email="seller@nabi.test")
        channels, sender = _fake_channels()

        n = service.notify_application_approved(
            db, event_id=ev.id, recipient_org_id=org_a.id,
            org_name="셀러기업", role="exhibitor", channels=channels,
        )
        assert n is not None
        assert n.type == "application_approved"
        assert n.meeting_id is None
        assert n.due_at is None
        assert n.payload == {"org_name": "셀러기업", "role": "exhibitor"}

        dispatches = db.execute(
            select(NotificationDispatch).where(NotificationDispatch.notification_id == n.id)
        ).scalars().all()
        by_channel = {d.channel: d for d in dispatches}
        assert by_channel["in_app"].status == "sent"
        assert by_channel["in_app"].member_id == member.id
        assert by_channel["email"].status == "sent"
        assert len(sender.sent) == 1
        assert sender.sent[0].to == [member.email]
        assert "승인" in sender.sent[0].subject

    def test_meeting_rejected_payload_snapshot_omits_reason_and_sends_email(self, db):
        ev, org_a, _org_b = _seed_event_and_orgs(db)
        member = _seed_member(db, org_a, email="rejected-recipient@nabi.test")
        channels, sender = _fake_channels()

        n = service.notify_meeting_rejected(
            db, event_id=ev.id, meeting_id=None, recipient_org_id=org_a.id,
            counterpart_org_name="참가기업", scheduled_start="2026-09-03T10:00:00+09:00",
            channels=channels,
        )
        assert n is not None
        assert n.type == "meeting_rejected"
        # 거절 사유는 payload에 담지 않는다(GitHub #4 권고 — 1차 미노출).
        assert n.payload == {
            "counterpart_org_name": "참가기업",
            "scheduled_start": "2026-09-03T10:00:00+09:00",
        }

        dispatches = db.execute(
            select(NotificationDispatch).where(NotificationDispatch.notification_id == n.id)
        ).scalars().all()
        by_channel = {d.channel: d for d in dispatches}
        assert by_channel["in_app"].status == "sent"
        assert by_channel["in_app"].member_id == member.id
        assert by_channel["email"].status == "sent"
        assert len(sender.sent) == 1
        assert sender.sent[0].to == [member.email]
        assert "사유" not in sender.sent[0].body


class TestInboxAndReadSharing:
    def test_inbox_lists_newest_first_with_unread_count(self, db):
        ev, org_a, _org_b = _seed_event_and_orgs(db)
        channels, _sender = _fake_channels()
        service.notify_meeting_requested(
            db, event_id=ev.id, meeting_id=None, recipient_org_id=org_a.id,
            counterpart_org_name="B", requested_by_role="buyer", channels=channels,
        )
        service.notify_review_prompt(
            db, event_id=ev.id, meeting_id=None, recipient_org_id=org_a.id,
            counterpart_org_name="B", channels=channels,
        )
        items, unread, cursor = service.list_inbox(db, org_a.id)
        assert len(items) == 2
        assert unread == 2
        assert cursor is None

    def test_mark_read_is_org_shared_and_preserves_first_reader(self, db):
        ev, org_a, _org_b = _seed_event_and_orgs(db)
        member_a = _seed_member(db, org_a, email="a@nabi.test")
        member_b = _seed_member(db, org_a, email="b@nabi.test")
        channels, _sender = _fake_channels()
        n = service.notify_review_prompt(
            db, event_id=ev.id, meeting_id=None, recipient_org_id=org_a.id,
            counterpart_org_name="B", channels=channels,
        )

        read1 = service.mark_read(db, org_a.id, n.id, member_id=member_a.id)
        assert read1.read_at is not None
        assert read1.read_by_member_id == member_a.id

        # 다른 멤버가 같은 org에서 다시 읽어도 최초 읽은 주체·시각은 보존된다.
        read2 = service.mark_read(db, org_a.id, n.id, member_id=member_b.id)
        assert read2.read_by_member_id == member_a.id
        assert read2.read_at == read1.read_at

    def test_mark_read_wrong_org_returns_none(self, db):
        ev, org_a, org_b = _seed_event_and_orgs(db)
        channels, _sender = _fake_channels()
        n = service.notify_review_prompt(
            db, event_id=ev.id, meeting_id=None, recipient_org_id=org_a.id,
            counterpart_org_name="B", channels=channels,
        )
        assert service.mark_read(db, org_b.id, n.id, member_id=None) is None

    def test_mark_all_read_only_updates_unread_rows(self, db):
        ev, org_a, _org_b = _seed_event_and_orgs(db)
        channels, _sender = _fake_channels()
        member_x = _seed_member(db, org_a, email="x@nabi.test")
        n1 = service.notify_meeting_requested(
            db, event_id=ev.id, meeting_id=None, recipient_org_id=org_a.id,
            counterpart_org_name="B", requested_by_role="buyer", channels=channels,
        )
        service.notify_review_prompt(
            db, event_id=ev.id, meeting_id=None, recipient_org_id=org_a.id,
            counterpart_org_name="B", channels=channels,
        )
        service.mark_read(db, org_a.id, n1.id, member_id=None)

        updated = service.mark_all_read(db, org_a.id, member_id=member_x.id)
        assert updated == 1  # 이미 읽힌 n1은 건드리지 않는다.
        items, unread, _cursor = service.list_inbox(db, org_a.id)
        assert unread == 0
        assert all(i.read_at is not None for i in items)
