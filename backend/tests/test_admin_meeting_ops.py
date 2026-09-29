"""운영자 미팅 운영 개선 테스트 (#OP × F-MT-001) — 취소 가드·사유·알림 + 목록 필드 + 행사 설정.

이번 슬라이스에서 고친 것들:

- **취소 가드** — 예전엔 상태를 보지 않고 무조건 ``cancelled``로 덮었다. 이미 진행돼 회의록까지
  쓴 미팅(completed)이 "취소됨"으로 둔갑할 수 있었다. 이제 상태 전이표를 통과해야 한다.
- **취소 사유 기록** — ``cancelled_by='organizer'``, ``cancelled_by_org_id=NULL``(운영자는 org가
  아니다) + 사유 코드/자유서술.
- **양측 알림** — 참가자 취소는 "취소 안 한 쪽" 1곳이지만, 운영자 취소는 둘 다가 그 쪽이다.
- **목록 필드** — 장소 표기·취소 맥락·updated_at. 기존 필드는 유지(FE 어댑터 호환).
- **행사 설정** — 운영시간/점심/최소보장 슬롯을 읽고 쓴다(참가자 슬롯 그리드의 나머지 축).

가드는 기존 `test_admin_api.py`와 같은 방식으로 override한다 — 여기서 검증하려는 건 권한이
아니라 미팅 운영 동작이다.
"""

from __future__ import annotations

import itertools
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from app.admin.guard import EventOperatorPrincipal, require_event_operator
from app.auth.organizer_guard import EventMasterPrincipal, require_event_master
from app.db import get_session
from app.main import app
from app.models import (
    Event,
    EventScheduleSettings,
    Meeting,
    MeetingVenue,
    Member,
    Notification,
    Organization,
)

_seq = itertools.count(1)


@pytest.fixture()
def db_factory(migrated_db: str):
    engine = create_engine(migrated_db, future=True)
    TestSession = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)
    yield TestSession
    engine.dispose()


@pytest.fixture()
def client(db_factory):
    def _override_session():
        db = db_factory()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_session] = _override_session
    yield TestClient(app, raise_server_exceptions=False)
    app.dependency_overrides.clear()


def _as_master(event_id: str) -> None:
    app.dependency_overrides[require_event_master] = lambda: EventMasterPrincipal(
        member_id="mbr-org-01", event_id=event_id
    )
    app.dependency_overrides[require_event_operator] = lambda: EventOperatorPrincipal(
        member_id="mbr-org-01",
        event_id=event_id,
        permission_level="master",  # is_master는 이 값에서 파생되는 프로퍼티
        organizer_id=str(uuid.uuid4()),
    )


def _seed(db_factory, *, status: str = "accepted", with_venue: bool = True) -> dict:
    n = next(_seq)
    db = db_factory()
    try:
        event = Event(name="DX Korea 2026", slug=f"adm-mt-{n}-{uuid.uuid4().hex[:8]}")
        exhibitor = Organization(name_ko="한빛디펜스")
        buyer = Organization(name_ko="Global Marine")
        db.add_all([event, exhibitor, buyer])
        db.flush()
        db.add_all(
            [
                Member(organization_id=exhibitor.id, name="셀러담당", email=f"s{n}@example.com"),
                Member(organization_id=buyer.id, name="바이어담당", email=f"b{n}@example.com"),
            ]
        )
        venue_id = None
        if with_venue:
            venue = MeetingVenue(event_id=event.id, venue_type="zone_table", label="T-01")
            db.add(venue)
            db.flush()
            venue_id = venue.id

        start = datetime.now(timezone.utc) + timedelta(days=10)
        meeting = Meeting(
            event_id=event.id,
            exhibitor_org_id=exhibitor.id,
            buyer_org_id=buyer.id,
            venue_id=venue_id,
            matching_type="open",
            status=status,
            requested_by="buyer",
            scheduled_start=start,
            scheduled_end=start + timedelta(minutes=30),
        )
        db.add(meeting)
        db.commit()
        return {
            "event_id": str(event.id),
            "meeting_id": str(meeting.id),
            "exhibitor_org": str(exhibitor.id),
            "buyer_org": str(buyer.id),
        }
    finally:
        db.close()


def _cancel(client, world, body=None):
    return client.post(
        f"/api/admin/events/{world['event_id']}/meetings/{world['meeting_id']}/cancel",
        json=body if body is not None else {},
    )


# =============================================================================
# 취소 가드 + 사유
# =============================================================================
@pytest.mark.parametrize("status", ["proposed", "accepted"])
def test_live_meeting_can_be_cancelled_by_organizer(client, db_factory, status):
    world = _seed(db_factory, status=status)
    _as_master(world["event_id"])

    r = _cancel(client, world, {"reason_code": "internal_change", "reason_text": "행사 동선 변경"})
    assert r.status_code == 200
    assert r.json()["status"] == "cancelled"

    db = db_factory()
    try:
        meeting = db.get(Meeting, world["meeting_id"])
        assert meeting.cancelled_by == "organizer"
        assert meeting.cancelled_by_org_id is None  # 운영자는 org가 아니다
        assert meeting.cancelled_reason_code == "internal_change"
        assert meeting.cancelled_reason_text == "행사 동선 변경"
        assert meeting.cancelled_at is not None
        assert meeting.awaiting_org_id is None
    finally:
        db.close()


@pytest.mark.parametrize("status", ["completed", "cancelled", "rejected"])
def test_terminated_meeting_cannot_be_cancelled(client, db_factory, status):
    """이미 끝난 미팅을 '취소됨'으로 덮어쓰던 결함 — 회의록이 붙은 미팅이 사라지면 안 된다."""
    world = _seed(db_factory, status=status)
    _as_master(world["event_id"])

    r = _cancel(client, world, {"reason_code": "internal_change"})
    assert r.status_code == 409

    db = db_factory()
    try:
        assert db.get(Meeting, world["meeting_id"]).status == status  # 원 상태 보존
    finally:
        db.close()


def test_cancel_without_body_still_works(client, db_factory):
    """기존 FE가 사유 없이 호출하던 계약을 깨지 않는다 — 사유는 전부 선택."""
    world = _seed(db_factory)
    _as_master(world["event_id"])

    assert _cancel(client, world).status_code == 200


def test_cancel_accepts_reason_text_only(client, db_factory):
    """자유서술 하나만 보내는 기존 화면 형태도 그대로 받는다(운영자 취소는 어휘를 강제하지 않는다)."""
    world = _seed(db_factory)
    _as_master(world["event_id"])

    r = _cancel(client, world, {"reason_text": "장비 반입 지연"})
    assert r.status_code == 200

    db = db_factory()
    try:
        meeting = db.get(Meeting, world["meeting_id"])
        assert meeting.cancelled_reason_code is None
        assert meeting.cancelled_reason_text == "장비 반입 지연"
    finally:
        db.close()


def test_organizer_cancel_notifies_both_sides(client, db_factory):
    """참가자 취소는 상대 1곳이지만, 운영자 취소는 양쪽 다 '취소 안 한 쪽'이다."""
    world = _seed(db_factory)
    _as_master(world["event_id"])
    assert _cancel(client, world, {"reason_code": "internal_change"}).status_code == 200

    db = db_factory()
    try:
        rows = db.execute(
            select(Notification.type, Notification.recipient_org_id).where(
                Notification.meeting_id == world["meeting_id"]
            )
        ).all()
        assert sorted((t, str(o)) for t, o in rows) == sorted(
            [
                ("meeting_cancelled", world["exhibitor_org"]),
                ("meeting_cancelled", world["buyer_org"]),
            ]
        )
        payloads = db.execute(
            select(Notification.payload).where(Notification.meeting_id == world["meeting_id"])
        ).scalars().all()
        assert all(p["cancelled_by_role"] == "organizer" for p in payloads)
    finally:
        db.close()


def test_cancel_unknown_meeting_is_404(client, db_factory):
    world = _seed(db_factory)
    _as_master(world["event_id"])
    r = client.post(
        f"/api/admin/events/{world['event_id']}/meetings/{uuid.uuid4()}/cancel", json={}
    )
    assert r.status_code == 404


# =============================================================================
# 목록 응답 필드
# =============================================================================
def test_meeting_list_includes_venue_and_cancellation_context(client, db_factory):
    world = _seed(db_factory)
    _as_master(world["event_id"])
    _cancel(client, world, {"reason_code": "internal_change", "reason_text": "동선 변경"})

    r = client.get(f"/api/admin/events/{world['event_id']}/meetings")
    assert r.status_code == 200
    item = r.json()["items"][0]

    # 기존 필드는 그대로 남아 있어야 한다(FE 어댑터 호환).
    assert {"id", "exhibitor_org_id", "buyer_org_id", "status", "matching_type"} <= set(item)
    # 새로 붙은 필드.
    assert item["venue_type"] == "zone_table"
    assert item["venue_label"] == "T-01"
    assert item["cancelled_by"] == "organizer"
    assert item["cancelled_reason_code"] == "internal_change"
    assert item["cancelled_reason_text"] == "동선 변경"
    assert item["updated_at"] is not None


def test_meeting_without_venue_reports_null_venue_fields(client, db_factory):
    """장소 미지정 미팅도 목록에 나온다 — LEFT JOIN이라 행이 사라지지 않는다."""
    world = _seed(db_factory, with_venue=False)
    _as_master(world["event_id"])

    item = client.get(f"/api/admin/events/{world['event_id']}/meetings").json()["items"][0]
    assert item["venue_id"] is None
    assert item["venue_type"] is None
    assert item["venue_label"] is None


# =============================================================================
# 행사 설정 — events + event_schedule_settings 합본
# =============================================================================
def test_settings_returns_schedule_defaults_when_row_missing(client, db_factory):
    """설정 행이 없던 기존 행사도 조회가 되어야 한다 — 최초 접근 시 기본값으로 만들어진다."""
    world = _seed(db_factory)
    _as_master(world["event_id"])

    body = client.get(f"/api/admin/events/{world['event_id']}/settings").json()
    assert body["operating_start"] == "09:00:00"
    assert body["operating_end"] == "18:00:00"
    assert body["lunch_start"] is None
    assert body["min_guaranteed_slots"] == 10
    assert body["slot_minutes"] == 30


def test_settings_patch_splits_across_two_tables(client, db_factory):
    """한 화면의 '행사 설정'이 events와 event_schedule_settings로 나뉘어 저장된다."""
    world = _seed(db_factory)
    _as_master(world["event_id"])

    r = client.patch(
        f"/api/admin/events/{world['event_id']}/settings",
        json={
            "slot_minutes": 20,
            "operating_start": "10:00",
            "operating_end": "17:00",
            "lunch_start": "12:30",
            "lunch_end": "13:30",
            "min_guaranteed_slots": 5,
            "enabled_venue_types": ["booth"],
        },
    )
    assert r.status_code == 200
    body = r.json()
    assert body["slot_minutes"] == 20
    assert body["operating_start"] == "10:00:00"
    assert body["lunch_end"] == "13:30:00"
    assert body["min_guaranteed_slots"] == 5
    assert body["enabled_venue_types"] == ["booth"]

    db = db_factory()
    try:
        event = db.get(Event, world["event_id"])
        schedule = db.execute(
            select(EventScheduleSettings).where(
                EventScheduleSettings.event_id == world["event_id"]
            )
        ).scalar_one()
        assert event.slot_minutes == 20  # 슬롯 길이의 단일 진실원천은 events
        assert str(schedule.operating_start) == "10:00:00"
        assert schedule.min_guaranteed_slots == 5
        # settings 쪽에는 slot_minutes 컬럼이 아예 없다(mt001meet01에서 제거).
        assert not hasattr(schedule, "slot_minutes")
    finally:
        db.close()


def test_settings_patch_is_partial(client, db_factory):
    """보내지 않은 필드는 건드리지 않는다 — 한 값만 바꾸려다 나머지가 기본값으로 덮이면 안 된다."""
    world = _seed(db_factory)
    _as_master(world["event_id"])
    client.patch(
        f"/api/admin/events/{world['event_id']}/settings",
        json={"operating_start": "08:00", "min_guaranteed_slots": 7},
    )

    body = client.patch(
        f"/api/admin/events/{world['event_id']}/settings", json={"slot_minutes": 60}
    ).json()
    assert body["slot_minutes"] == 60
    assert body["operating_start"] == "08:00:00"  # 앞서 바꾼 값이 살아 있다
    assert body["min_guaranteed_slots"] == 7


def test_settings_rejects_unknown_field(client, db_factory):
    world = _seed(db_factory)
    _as_master(world["event_id"])
    r = client.patch(
        f"/api/admin/events/{world['event_id']}/settings", json={"slot_minutez": 60}
    )
    assert r.status_code == 422  # extra="forbid" — 오타가 조용히 무시되지 않는다
