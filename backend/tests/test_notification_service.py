"""알림 서비스 계층 테스트 (F-NT-001, ADR-0010) — 생성 멱등성 + org 공유 인박스/읽음 + 채널 디스패치.

로컬 Postgres 없으면 conftest의 skip 패턴(migrated_db)에 따라 전체 skip한다(순수 규칙은
test_notification_schemas.py/test_notification_channels.py가 DB 없이 커버).
"""

from __future__ import annotations

import itertools

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from app.models import (
    Event,
    EventScheduleSettings,
    Member,
    Notification,
    NotificationDispatch,
    Organization,
)
from app.notifications import service
from app.notifications.channels import build_channels
from app.notifications.email import FakeEmailSender
from tests.conftest import set_participant_email

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
        set_participant_email(db, ev.id, True)  # 메일 발송을 검증한다(기본은 꺼짐)
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
        set_participant_email(db, ev.id, True)  # 메일 발송을 검증한다(기본은 꺼짐)
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
        set_participant_email(db, ev.id, True)  # 메일 발송을 검증한다(기본은 꺼짐)
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


def _set_participant_menu(db, event_id: str, value: str) -> None:
    """행사 설정 행의 참가자 메뉴를 정한다(없으면 만든다) — 어드민 PATCH가 하는 일을 DB에 직접."""
    row = db.execute(
        select(EventScheduleSettings).where(EventScheduleSettings.event_id == event_id)
    ).scalar_one_or_none()
    if row is None:
        db.add(EventScheduleSettings(event_id=event_id, participant_menu=value))
    else:
        row.participant_menu = value
    db.commit()


class TestEmailFollowsParticipantMenu:
    """알림 메일의 "어디서 확인하라" 안내는 행사의 참가자 메뉴를 따른다(nv001menu0001).

    채널은 DB를 모르므로(channels.py) 봉투를 만드는 이 계층이 행사 설정에서 값을 읽어 싣는다.
    기본은 미팅만이다 — 설정을 건드리지 않은 행사의 메일은 미팅 화면을 가리킨다.
    """

    def _requested(self, db, event_id, org_id, channels, **extra):
        return service.notify_meeting_requested(
            db, event_id=event_id, meeting_id=None, recipient_org_id=org_id,
            counterpart_org_name="바이어기업", requested_by_role="buyer", channels=channels, **extra,
        )

    def test_event_without_settings_row_points_to_meetings_screen(
        self, db, participant_email_forced_on
    ):
        # "설정 행이 없는 행사"가 전제라 행을 만들어 메일 스위치를 켤 수 없다 — 스위치 읽기만 켜짐으로 둔다
        # (participant_email_forced_on, conftest). 메뉴 기본값·설정 행 미생성 단언은 그대로다.
        ev, org_a, _org_b = _seed_event_and_orgs(db)
        _seed_member(db, org_a, email="default@nabi.test")
        channels, sender = _fake_channels()

        self._requested(db, ev.id, org_a.id, channels)

        body = sender.sent[0].body
        assert "미팅 화면에서 자세히 확인하세요" in body
        assert "알림함" not in body
        # 메뉴를 읽으려고 설정 행을 만들지 않는다 — 알림 경로는 설정 테이블에 쓰지 않는다.
        assert db.execute(
            select(EventScheduleSettings).where(EventScheduleSettings.event_id == ev.id)
        ).scalar_one_or_none() is None

    def test_full_menu_event_keeps_the_original_inbox_wording(self, db):
        ev, org_a, _org_b = _seed_event_and_orgs(db)
        _seed_member(db, org_a, email="full@nabi.test")
        set_participant_email(db, ev.id, True)  # 메일 발송을 검증한다(기본은 꺼짐)
        _set_participant_menu(db, ev.id, "full")
        channels, sender = _fake_channels()

        self._requested(db, ev.id, org_a.id, channels)

        body = sender.sent[0].body
        assert "알림함에서 자세히 확인하세요" in body
        assert "미팅 화면" not in body

    def test_approval_mail_follows_the_menu_too(self, db):
        ev, org_a, org_b = _seed_event_and_orgs(db)
        _seed_member(db, org_a, email="approved-default@nabi.test")
        _seed_member(db, org_b, email="approved-full@nabi.test")
        set_participant_email(db, ev.id, True)  # 메일 발송을 검증한다(기본은 꺼짐)
        channels, sender = _fake_channels()

        service.notify_application_approved(
            db, event_id=ev.id, recipient_org_id=org_a.id,
            org_name="셀러기업", role="exhibitor", channels=channels,
        )
        _set_participant_menu(db, ev.id, "full")
        service.notify_application_approved(
            db, event_id=ev.id, recipient_org_id=org_b.id,
            org_name="바이어기업", role="buyer", channels=channels,
        )

        assert "미팅 화면에서 일정을 확인할 수 있어요" in sender.sent[0].body
        assert "탐색" not in sender.sent[0].body
        assert "탐색하고 미팅을 신청할 수 있어요" in sender.sent[1].body

    def test_menu_is_read_from_the_notifications_own_event(self, db):
        # 같은 기업이 두 행사에 걸쳐 있어도 메일은 알림이 속한 행사의 설정을 따른다.
        ev_full, org_a, _org_b = _seed_event_and_orgs(db)
        ev_default, _x, _y = _seed_event_and_orgs(db)
        _seed_member(db, org_a, email="two-events@nabi.test")
        _set_participant_menu(db, ev_full.id, "full")
        set_participant_email(db, ev_full.id, True)  # 메일 발송을 검증한다(기본은 꺼짐)
        set_participant_email(db, ev_default.id, True)
        channels, sender = _fake_channels()

        self._requested(db, ev_full.id, org_a.id, channels)
        service.notify_review_prompt(
            db, event_id=ev_default.id, meeting_id=None, recipient_org_id=org_a.id,
            counterpart_org_name="바이어기업", channels=channels,
        )

        assert "알림함에서 자세히 확인하세요" in sender.sent[0].body
        assert "미팅 화면에서 자세히 확인하세요" in sender.sent[1].body

    def test_resend_follows_the_current_setting_not_the_one_at_creation(self, db):
        ev, org_a, _org_b = _seed_event_and_orgs(db)
        _seed_member(db, org_a, email="resend@nabi.test")
        set_participant_email(db, ev.id, True)  # 메일 발송을 검증한다(기본은 꺼짐)
        channels, sender = _fake_channels()
        notification = self._requested(db, ev.id, org_a.id, channels)
        assert "미팅 화면" in sender.sent[0].body
        email_dispatch = db.execute(
            select(NotificationDispatch).where(
                NotificationDispatch.notification_id == notification.id,
                NotificationDispatch.channel == "email",
            )
        ).scalar_one()

        _set_participant_menu(db, ev.id, "full")
        outcome = service.resend_dispatch(db, email_dispatch.id, channels=channels)

        assert outcome is not None and outcome.status == "sent"
        assert "알림함에서 자세히 확인하세요" in sender.sent[1].body
        assert "미팅 화면" not in sender.sent[1].body


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


# =============================================================================
# 참가자 알림 메일 스위치(nt004mail0001) — 꺼진 행사의 자동 알림은 인앱만 남고 메일은 0통
# =============================================================================
def _dispatch_rows(db, notification_id: str) -> list[tuple[str, str, str, str | None]]:
    """(member_id, channel, status, error) — 정렬해서 돌려준다."""
    rows = db.execute(
        select(
            NotificationDispatch.member_id,
            NotificationDispatch.channel,
            NotificationDispatch.status,
            NotificationDispatch.error,
        ).where(NotificationDispatch.notification_id == notification_id)
    ).all()
    return sorted((str(m), c, s, e) for m, c, s, e in rows)


def _emit_all_eight(db, event_id: str, org_id: str, channels) -> list:
    """알림 서비스의 자동 알림 8종을 한 번씩 — 타입이 달라 멱등 키가 겹치지 않는다(meeting_id=None)."""
    common = dict(event_id=event_id, recipient_org_id=org_id, channels=channels)
    return [
        service.notify_meeting_requested(
            db, meeting_id=None, counterpart_org_name="B", requested_by_role="buyer", **common
        ),
        service.notify_meeting_accepted(
            db, meeting_id=None, counterpart_org_name="B",
            scheduled_start="2026-10-20T10:00:00+07:00", **common,
        ),
        service.notify_meeting_cancelled(
            db, meeting_id=None, counterpart_org_name="B", cancelled_by_role="organizer", **common
        ),
        service.notify_meeting_rejected(db, meeting_id=None, counterpart_org_name="B", **common),
        service.notify_meeting_reminder(
            db, meeting_id=None, counterpart_org_name="B",
            scheduled_start="2026-10-20T10:00:00+07:00", due_at=None, **common,
        ),
        service.notify_review_prompt(db, meeting_id=None, counterpart_org_name="B", **common),
        service.notify_review_ready(db, meeting_id=None, counterpart_org_name="B", **common),
        service.notify_application_approved(db, org_name="A", role="buyer", **common),
    ]


class TestParticipantEmailSwitch:
    """``event_schedule_settings.participant_email_enabled`` — 알림 생성 코어(_emit_notification)·재발송이
    같은 값을 본다. 켜짐(기본)은 이 설정이 생기기 전과 같다(기존 테스트가 그대로 지킨다)."""

    def test_off_sends_no_mail_keeps_in_app_and_records_skipped_per_recipient(self, db):
        # 주소 없는 수신자(members.email은 NOT NULL·UNIQUE라 DB로는 만들기 어렵다)의 모양은
        # test_notification_channels.py의 suppressed_dispatch_results 단위 테스트가 잠근다.
        ev, org_a, _org_b = _seed_event_and_orgs(db)
        first = _seed_member(db, org_a, email="switch-off-1@nabi.test")
        second = _seed_member(db, org_a, email="switch-off-2@nabi.test")
        set_participant_email(db, ev.id, False)
        channels, sender = _fake_channels()

        n = service.notify_meeting_accepted(
            db, event_id=ev.id, meeting_id=None, recipient_org_id=org_a.id,
            counterpart_org_name="바이어기업", scheduled_start="2026-10-20T10:00:00+07:00",
            channels=channels,
        )

        assert n is not None  # 인앱 알림 행은 생긴다(인박스에 뜬다)
        assert sender.sent == []  # 메일은 0통
        assert _dispatch_rows(db, n.id) == sorted(
            [
                (str(first.id), "in_app", "sent", None),
                (str(second.id), "in_app", "sent", None),
                # 보냈을 수신자마다 — 보내지 않았고, 사유 코드가 남는다.
                (str(first.id), "email", "skipped", "event_email_disabled"),
                (str(second.id), "email", "skipped", "event_email_disabled"),
            ]
        )

    def test_all_eight_automatic_types_are_suppressed_when_off(self, db):
        ev, org_a, _org_b = _seed_event_and_orgs(db)
        member = _seed_member(db, org_a, email="eight-types@nabi.test")
        set_participant_email(db, ev.id, False)
        channels, sender = _fake_channels()

        created = _emit_all_eight(db, ev.id, org_a.id, channels)

        assert all(n is not None for n in created)
        assert sorted(n.type for n in created) == sorted(
            [
                "meeting_requested", "meeting_accepted", "meeting_cancelled", "meeting_rejected",
                "meeting_reminder", "review_prompt", "review_ready", "application_approved",
            ]
        )
        assert sender.sent == []
        for n in created:
            assert _dispatch_rows(db, n.id) == sorted(
                [
                    (str(member.id), "in_app", "sent", None),
                    (str(member.id), "email", "skipped", "event_email_disabled"),
                ]
            )

    def test_on_explicitly_behaves_like_before(self, db):
        ev, org_a, _org_b = _seed_event_and_orgs(db)
        member = _seed_member(db, org_a, email="switch-on@nabi.test")
        set_participant_email(db, ev.id, True)
        channels, sender = _fake_channels()

        created = _emit_all_eight(db, ev.id, org_a.id, channels)

        assert len(sender.sent) == 8
        for n in created:
            assert _dispatch_rows(db, n.id) == sorted(
                [(str(member.id), "in_app", "sent", None), (str(member.id), "email", "sent", None)]
            )

    def test_default_is_off_event_without_settings_row_sends_no_mail_and_creates_no_row(self, db):
        """기본값은 꺼짐(2026-10-16 발주사 결정) — 설정 행이 없는 행사도 메일 0통, 인앱은 그대로."""
        from app.models import DEFAULT_PARTICIPANT_EMAIL_ENABLED

        ev, org_a, _org_b = _seed_event_and_orgs(db)
        member = _seed_member(db, org_a, email="no-settings-row@nabi.test")
        channels, sender = _fake_channels()

        assert DEFAULT_PARTICIPANT_EMAIL_ENABLED is False
        assert service.participant_email_enabled_for_event(db, ev.id) is False
        n = service.notify_review_prompt(
            db, event_id=ev.id, meeting_id=None, recipient_org_id=org_a.id,
            counterpart_org_name="B", channels=channels,
        )

        assert sender.sent == []
        assert _dispatch_rows(db, n.id) == sorted(
            [
                (str(member.id), "in_app", "sent", None),
                (str(member.id), "email", "skipped", "event_email_disabled"),
            ]
        )
        # 스위치를 읽으려고 설정 행을 만들지 않는다 — 알림 경로는 설정 테이블에 쓰지 않는다.
        assert db.execute(
            select(EventScheduleSettings).where(EventScheduleSettings.event_id == ev.id)
        ).scalar_one_or_none() is None

    def test_mail_goes_out_once_the_master_turns_it_on(self, db):
        """기본 꺼짐인 행사에서 켜면 그 뒤의 자동 알림은 메일로도 나간다."""
        ev, org_a, _org_b = _seed_event_and_orgs(db)
        member = _seed_member(db, org_a, email="turned-on@nabi.test")
        channels, sender = _fake_channels()
        before = service.notify_review_prompt(
            db, event_id=ev.id, meeting_id=None, recipient_org_id=org_a.id,
            counterpart_org_name="B", channels=channels,
        )
        assert sender.sent == []

        set_participant_email(db, ev.id, True)
        after = service.notify_meeting_requested(
            db, event_id=ev.id, meeting_id=None, recipient_org_id=org_a.id,
            counterpart_org_name="B", requested_by_role="buyer", channels=channels,
        )

        assert [m.to for m in sender.sent] == [[member.email]]
        assert (str(member.id), "email", "sent", None) in _dispatch_rows(db, after.id)
        # 켜기 전의 알림은 그대로 보내지 않음(백필 없음).
        assert (str(member.id), "email", "skipped", "event_email_disabled") in _dispatch_rows(
            db, before.id
        )

    def test_event_a_off_and_event_b_on_do_not_affect_each_other(self, db):
        # 같은 기업·같은 담당자가 두 행사에 걸쳐 있어도 메일은 알림이 속한 행사의 스위치를 따른다.
        ev_off, org_a, _x = _seed_event_and_orgs(db)
        ev_on, _y, _z = _seed_event_and_orgs(db)
        member = _seed_member(db, org_a, email="two-events-switch@nabi.test")
        set_participant_email(db, ev_off.id, False)
        set_participant_email(db, ev_on.id, True)
        channels, sender = _fake_channels()

        off = service.notify_review_prompt(
            db, event_id=ev_off.id, meeting_id=None, recipient_org_id=org_a.id,
            counterpart_org_name="B", channels=channels,
        )
        on = service.notify_meeting_requested(
            db, event_id=ev_on.id, meeting_id=None, recipient_org_id=org_a.id,
            counterpart_org_name="B", requested_by_role="buyer", channels=channels,
        )

        assert [m.to for m in sender.sent] == [[member.email]]  # 켜진 행사(B) 것 1통만
        assert "미팅 신청" in sender.sent[0].subject
        assert (str(member.id), "email", "skipped", "event_email_disabled") in _dispatch_rows(
            db, off.id
        )
        assert (str(member.id), "email", "sent", None) in _dispatch_rows(db, on.id)

    def test_turning_back_on_does_not_backfill_but_resend_works(self, db):
        ev, org_a, _org_b = _seed_event_and_orgs(db)
        member = _seed_member(db, org_a, email="backfill@nabi.test")
        set_participant_email(db, ev.id, False)
        channels, sender = _fake_channels()
        muted = service.notify_review_prompt(
            db, event_id=ev.id, meeting_id=None, recipient_org_id=org_a.id,
            counterpart_org_name="B", channels=channels,
        )

        set_participant_email(db, ev.id, True)
        # 다시 켜는 것만으로는 아무것도 나가지 않는다(백필 없음).
        assert sender.sent == []
        assert (str(member.id), "email", "skipped", "event_email_disabled") in _dispatch_rows(
            db, muted.id
        )

        # 켠 뒤의 새 알림은 나간다.
        service.notify_meeting_requested(
            db, event_id=ev.id, meeting_id=None, recipient_org_id=org_a.id,
            counterpart_org_name="B", requested_by_role="buyer", channels=channels,
        )
        assert len(sender.sent) == 1

        # 꺼져 있던 동안의 알림은 개별 재발송으로 보낼 수 있다 — 그 행이 sent로 바뀐다.
        email_dispatch = db.execute(
            select(NotificationDispatch).where(
                NotificationDispatch.notification_id == muted.id,
                NotificationDispatch.channel == "email",
            )
        ).scalar_one()
        outcome = service.resend_dispatch(db, email_dispatch.id, channels=channels)
        assert outcome is not None and outcome.status == "sent" and outcome.error is None
        assert len(sender.sent) == 2
        assert (str(member.id), "email", "sent", None) in _dispatch_rows(db, muted.id)

    def test_resend_of_email_is_refused_when_off_and_the_row_is_untouched(self, db):
        ev, org_a, _org_b = _seed_event_and_orgs(db)
        _seed_member(db, org_a, email="resend-refused@nabi.test")
        set_participant_email(db, ev.id, True)  # 처음엔 켜져 있어 메일이 나갔다
        channels, sender = _fake_channels()
        n = service.notify_meeting_requested(
            db, event_id=ev.id, meeting_id=None, recipient_org_id=org_a.id,
            counterpart_org_name="B", requested_by_role="buyer", channels=channels,
        )
        assert len(sender.sent) == 1
        email_dispatch = db.execute(
            select(NotificationDispatch).where(
                NotificationDispatch.notification_id == n.id, NotificationDispatch.channel == "email"
            )
        ).scalar_one()
        before = (email_dispatch.status, email_dispatch.sent_at, email_dispatch.error)
        dispatch_id = email_dispatch.id

        set_participant_email(db, ev.id, False)
        with pytest.raises(
            service.ParticipantEmailDisabledError, match="참가자 알림 메일이 꺼져 있습니다"
        ):
            service.resend_dispatch(db, dispatch_id, channels=channels)

        assert len(sender.sent) == 1  # 아무것도 보내지 않았다
        db.rollback()
        row = db.get(NotificationDispatch, dispatch_id)
        db.refresh(row)
        assert (row.status, row.sent_at, row.error) == before

    def test_in_app_resend_still_works_when_off(self, db):
        ev, org_a, _org_b = _seed_event_and_orgs(db)
        _seed_member(db, org_a, email="in-app-resend@nabi.test")
        set_participant_email(db, ev.id, False)
        channels, sender = _fake_channels()
        n = service.notify_review_prompt(
            db, event_id=ev.id, meeting_id=None, recipient_org_id=org_a.id,
            counterpart_org_name="B", channels=channels,
        )
        in_app = db.execute(
            select(NotificationDispatch).where(
                NotificationDispatch.notification_id == n.id, NotificationDispatch.channel == "in_app"
            )
        ).scalar_one()

        outcome = service.resend_dispatch(db, in_app.id, channels=channels)

        assert outcome is not None and outcome.status == "sent"
        assert sender.sent == []

    def test_admin_log_exposes_the_skip_reason_only_for_switch_skips(self, db):
        ev, org_a, _org_b = _seed_event_and_orgs(db)
        member = _seed_member(db, org_a, email="log-reason@nabi.test")
        set_participant_email(db, ev.id, True)  # 첫 알림은 켜진 상태에서 전달된다
        channels, _sender = _fake_channels()
        sent = service.notify_meeting_requested(
            db, event_id=ev.id, meeting_id=None, recipient_org_id=org_a.id,
            counterpart_org_name="B", requested_by_role="buyer", channels=channels,
        )
        set_participant_email(db, ev.id, False)
        muted = service.notify_review_prompt(
            db, event_id=ev.id, meeting_id=None, recipient_org_id=org_a.id,
            counterpart_org_name="B", channels=channels,
        )
        # 실패 행의 error(예: SMTP 원문)는 skip_reason으로 새지 않는다.
        db.add(
            NotificationDispatch(
                notification_id=muted.id, member_id=member.id, channel="sms",
                status="failed", error="smtp down",
            )
        )
        db.commit()

        rows = service.list_admin_logs(db, ev.id)

        by_key = {(r.type, r.channel): r for r in rows}
        assert by_key[("meeting_requested", "email")].skip_reason is None  # 전달된 행
        assert by_key[("meeting_requested", "in_app")].skip_reason is None
        assert by_key[("review_prompt", "in_app")].skip_reason is None
        assert by_key[("review_prompt", "email")].delivered is False
        assert by_key[("review_prompt", "email")].skip_reason == "event_email_disabled"
        assert by_key[("review_prompt", "sms")].skip_reason is None
        assert sent is not None


class TestParticipantEmailSwitchWithBrokenMailConfig:
    """꺼진 행사는 메일 채널(SMTP sender)을 만들지 않는다 — 메일 설정이 깨져 채널 구성이 실패해도 인앱 알림은 남는다."""

    def _broken(self, monkeypatch):
        def _boom():
            raise RuntimeError("SMTP 설정 없음")

        monkeypatch.setattr(service, "_default_channels", _boom)

    def test_off_event_keeps_in_app_and_skipped_rows_without_building_mail_channels(
        self, db, monkeypatch
    ):
        self._broken(monkeypatch)
        ev, org_a, _org_b = _seed_event_and_orgs(db)  # 설정 행 없음 = 기본(꺼짐)
        member = _seed_member(db, org_a, email="broken-config-off@nabi.test")

        n = service.notify_after_commit(
            db,
            lambda: service.notify_meeting_requested(
                db, event_id=ev.id, meeting_id=None, recipient_org_id=org_a.id,
                counterpart_org_name="B", requested_by_role="buyer",
            ),
            description="broken-config-off",
        )

        assert n is not None  # 예외 없이 알림 행이 남았다(롤백되지 않았다)
        assert _dispatch_rows(db, n.id) == sorted(
            [
                (str(member.id), "in_app", "sent", None),
                (str(member.id), "email", "skipped", "event_email_disabled"),
            ]
        )

    def test_on_event_with_broken_mail_config_fails_like_before(self, db, monkeypatch):
        """켜진 행사의 채널 구성 실패는 예전 그대로 예외 → notify_after_commit이 삼키고 알림은 남지 않는다."""
        self._broken(monkeypatch)
        ev, org_a, _org_b = _seed_event_and_orgs(db)
        _seed_member(db, org_a, email="broken-config-on@nabi.test")
        set_participant_email(db, ev.id, True)

        n = service.notify_after_commit(
            db,
            lambda: service.notify_meeting_requested(
                db, event_id=ev.id, meeting_id=None, recipient_org_id=org_a.id,
                counterpart_org_name="B", requested_by_role="buyer",
            ),
            description="broken-config-on",
        )

        assert n is None
        assert db.execute(
            select(Notification).where(Notification.recipient_org_id == org_a.id)
        ).scalars().all() == []

    def test_registry_external_channel_names_match_build_channels(self):
        from app.notifications.channels import DEFAULT_EXTERNAL_CHANNEL_NAMES

        built = [c.name for c in build_channels(FakeEmailSender()) if c.name != "in_app"]
        assert list(DEFAULT_EXTERNAL_CHANNEL_NAMES) == built


class TestParticipantEmailSwitchDeferredBatch:
    """포화 배정 확정의 지연 발송(bulk_dispatch) — 꺼져 있으면 대기열에 담지 않고, 담긴 뒤 꺼지면 보내기
    직전에 멈춘다."""

    def _batch(self):
        from app.notifications.bulk_dispatch import DeferredEmailBatch
        from app.notifications.channels import EmailChannel, InAppChannel

        sender = FakeEmailSender()
        return DeferredEmailBatch([InAppChannel(), EmailChannel(sender)]), sender

    def _accepted(self, db, event_id, org_id, channels):
        return service.notify_meeting_accepted(
            db, event_id=event_id, meeting_id=None, recipient_org_id=org_id,
            counterpart_org_name="B", scheduled_start="2026-10-20T10:00:00+07:00",
            channels=channels,
        )

    def test_off_event_is_not_queued_and_records_skipped_in_the_request(self, db, db_factory):
        ev, org_a, _org_b = _seed_event_and_orgs(db)
        member = _seed_member(db, org_a, email="deferred-off@nabi.test")
        set_participant_email(db, ev.id, False)
        batch, sender = self._batch()

        n = self._accepted(db, ev.id, org_a.id, batch.channels)

        assert batch.pending_messages == 0  # 대기열에 담기지 않았다
        assert batch.send_in_background(db_factory) is None  # 보낼 것이 없다
        assert sender.sent == []
        assert _dispatch_rows(db, n.id) == sorted(
            [
                (str(member.id), "in_app", "sent", None),
                (str(member.id), "email", "skipped", "event_email_disabled"),
            ]
        )

    def test_switch_turned_off_after_queueing_stops_the_remaining_mail(self, db, db_factory):
        ev, org_a, _org_b = _seed_event_and_orgs(db)
        member = _seed_member(db, org_a, email="deferred-race@nabi.test")
        set_participant_email(db, ev.id, True)
        batch, sender = self._batch()  # 켜진 상태에서 담는다
        n = self._accepted(db, ev.id, org_a.id, batch.channels)
        assert batch.pending_messages == 1

        set_participant_email(db, ev.id, False)  # 발송 스레드가 돌기 전에 운영자가 끈다
        batch.send_in_background(db_factory).result(timeout=10)

        assert sender.sent == []
        assert _dispatch_rows(db, n.id) == sorted(
            [
                (str(member.id), "in_app", "sent", None),
                (str(member.id), "email", "skipped", "event_email_disabled"),
            ]
        )

    def test_queued_mail_is_sent_when_the_switch_stays_on(self, db, db_factory):
        ev, org_a, _org_b = _seed_event_and_orgs(db)
        member = _seed_member(db, org_a, email="deferred-on@nabi.test")
        set_participant_email(db, ev.id, True)
        batch, sender = self._batch()
        n = self._accepted(db, ev.id, org_a.id, batch.channels)

        batch.send_in_background(db_factory).result(timeout=10)

        assert [m.to for m in sender.sent] == [[member.email]]
        assert (str(member.id), "email", "sent", None) in _dispatch_rows(db, n.id)

    def test_unreadable_switch_at_send_time_sends_nothing_and_records_failed(
        self, db, db_factory, monkeypatch
    ):
        """발송 직전에 스위치를 못 읽으면 보내지 않는다(fail-closed) — '꺼짐'으로 적지 않고 실패로 남겨
        알림 콘솔의 재발송 대상이 되게 한다."""
        ev, org_a, _org_b = _seed_event_and_orgs(db)
        member = _seed_member(db, org_a, email="deferred-unreadable@nabi.test")
        set_participant_email(db, ev.id, True)  # 담길 때는 켜져 있었다
        batch, sender = self._batch()
        n = self._accepted(db, ev.id, org_a.id, batch.channels)

        def _unreadable(_db, _event_id):
            raise RuntimeError("DB 일시 장애")

        monkeypatch.setattr(service, "participant_email_enabled_for_event", _unreadable)
        batch.send_in_background(db_factory).result(timeout=10)

        assert sender.sent == []
        assert _dispatch_rows(db, n.id) == sorted(
            [
                (str(member.id), "in_app", "sent", None),
                (
                    str(member.id),
                    "email",
                    "failed",
                    "참가자 알림 메일 설정을 확인하지 못해 보내지 않음",
                ),
            ]
        )
