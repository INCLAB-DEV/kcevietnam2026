"""OP-005 Phase 3+4 — 강제 배정 + AI 전체 포화배정 API 테스트.

``app.matching.assignment_service``(신규 모듈, book_meeting 프리미티브 재사용)를
``app.admin.router``의 새 엔드포인트(``/api/admin/events/{event_id}/forced-assignments``,
``/saturation-runs``)로 검증한다. 관례는 ``test_admin_meeting_ops.py``/``test_admin_api.py``와
동일(db_factory + client override, ``_as_master`` 가드 override) — 여기서 보는 건 배정 동작이지
권한 배선 자체가 아니다(실 StubSessionAuthenticator 배선 검증은 test_admin_api.py가 이미 커버).

``migrated_db``는 세션 스코프(테스트 간 커밋이 남는다) — 그래서 단언은 항상 이 파일이 만든
event_id/run_id로 스코프를 좁힌다(다른 테스트 파일의 데이터와 섞이지 않게).
"""

from __future__ import annotations

import itertools
import threading
import uuid
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import sessionmaker

from app.admin.guard import EventOperatorPrincipal, require_event_operator
from app.auth.organizer_guard import EventMasterPrincipal, require_event_master
from app.db import get_session
from app.main import app
from app.matching.slot_grid import slot_id
from app.models import (
    Event,
    EventScheduleSettings,
    ExhibitorProfile,
    Meeting,
    MeetingVenue,
    Member,
    Notification,
    NotificationDispatch,
    Organization,
    OrganizationEventRole,
    SaturationBatchRun,
    SaturationDraftItem,
)
from tests.conftest import enable_participant_email, set_participant_email

_seq = itertools.count(1)


# =============================================================================
# 픽스처 / 가드 override
# =============================================================================
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
        permission_level="master",
        organizer_id=str(uuid.uuid4()),
    )


def _as_forbidden(event_id: str) -> None:
    """master 가드를 403으로 강제 — 실 배선(StubSessionAuthenticator+directory)은
    test_admin_api.py의 "가드 배선(override 없이)" 절이 이미 커버한다. 여기서는 "가드를 통과 못
    하면 새 엔드포인트가 403을 그대로 돌려주는가"만 본다."""

    def _raise():
        raise HTTPException(status_code=403, detail="이 행사의 운영자(master) 권한이 필요합니다.")

    app.dependency_overrides[require_event_master] = _raise


# =============================================================================
# 시딩 헬퍼
# =============================================================================
def _seed_event(db_factory, **overrides) -> str:
    n = next(_seq)
    db = db_factory()
    try:
        slug = overrides.pop("slug", f"op005-{n}-{uuid.uuid4().hex[:8]}")
        today = datetime.now(timezone.utc).date()
        defaults = dict(
            name="DX Korea 2026",
            exhibition_start=today,
            exhibition_end=today + timedelta(days=5),
            timezone="Asia/Seoul",
            enabled_venue_types=["booth", "zone_table", "business_room"],
        )
        defaults.update(overrides)
        ev = Event(slug=slug, **defaults)
        db.add(ev)
        db.commit()
        return str(ev.id)
    finally:
        db.close()


def _seed_schedule_settings(db_factory, event_id: str, *, min_guaranteed_slots: int | None = None) -> None:
    """기본값(09:00-18:00, 점심 없음, N=10) 그대로 — 포화배정 그리드 생성에 필요.

    ``min_guaranteed_slots``를 지정하면 그 값으로 덮어쓴다 — 회귀 테스트가 "참가사 1건씩"
    시나리오를 원할 때 기본 N=10(보장 라운드가 참가사당 여러 바이어를 채움)이 아니라
    좁은 보장치로 재현 시나리오를 단순하게 유지하기 위함."""
    db = db_factory()
    try:
        kwargs = {}
        if min_guaranteed_slots is not None:
            kwargs["min_guaranteed_slots"] = min_guaranteed_slots
        db.add(EventScheduleSettings(event_id=event_id, **kwargs))
        db.commit()
    finally:
        db.close()


def _seed_org_role(
    db_factory,
    event_id: str,
    *,
    is_buyer: bool = False,
    is_exhibitor: bool = False,
    application_status: str = "approved",
    buyer_subtype: str | None = None,
    org_name: str = "테스트기업",
) -> dict:
    db = db_factory()
    try:
        org = Organization(name_ko=org_name)
        db.add(org)
        db.flush()
        role = OrganizationEventRole(
            organization_id=org.id,
            event_id=event_id,
            is_buyer=is_buyer,
            is_exhibitor=is_exhibitor,
            application_status=application_status,
            buyer_subtype=buyer_subtype,
        )
        db.add(role)
        db.commit()
        return {"org_id": str(org.id), "role_id": str(role.id)}
    finally:
        db.close()


def _seed_member(db_factory, org_id: str, *, email: str) -> str:
    db = db_factory()
    try:
        member = Member(organization_id=org_id, name="테스트담당", email=email)
        db.add(member)
        db.commit()
        return str(member.id)
    finally:
        db.close()


def _seed_venue(db_factory, event_id: str, *, venue_type: str = "zone_table", label: str = "T-01") -> str:
    db = db_factory()
    try:
        n = next(_seq)
        v = MeetingVenue(event_id=event_id, venue_type=venue_type, label=f"{label}-{n}")
        db.add(v)
        db.commit()
        return str(v.id)
    finally:
        db.close()


def _seed_meeting(
    db_factory,
    event_id: str,
    exhibitor_org_id: str,
    buyer_org_id: str,
    *,
    status: str = "accepted",
    start: datetime | None = None,
    minutes: int = 30,
) -> str:
    db = db_factory()
    try:
        start = start or (datetime.now(timezone.utc) + timedelta(days=1))
        m = Meeting(
            event_id=event_id,
            exhibitor_org_id=exhibitor_org_id,
            buyer_org_id=buyer_org_id,
            matching_type="open",
            status=status,
            requested_by="buyer",
            scheduled_start=start,
            scheduled_end=start + timedelta(minutes=minutes),
        )
        db.add(m)
        db.commit()
        return str(m.id)
    finally:
        db.close()


def _window(days_ahead: int = 1, minutes: int = 30) -> tuple[datetime, datetime]:
    start = datetime.now(timezone.utc) + timedelta(days=days_ahead)
    return start, start + timedelta(minutes=minutes)


def _forced_payload(exhibitor_org_id, buyer_org_id, venue_id, start, end, **extra) -> dict:
    return {
        "exhibitor_org_id": exhibitor_org_id,
        "buyer_org_id": buyer_org_id,
        "venue_id": venue_id,
        "scheduled_start": start.isoformat(),
        "scheduled_end": end.isoformat(),
        **extra,
    }


# =============================================================================
# Phase 3 — 강제 배정
# =============================================================================
def test_forced_hosted_buyer_is_accepted_immediately(client, db_factory):
    event_id = _seed_event(db_factory)
    exhibitor = _seed_org_role(db_factory, event_id, is_exhibitor=True, org_name="셀러")
    buyer = _seed_org_role(db_factory, event_id, is_buyer=True, buyer_subtype="hosted", org_name="초청바이어")
    venue_id = _seed_venue(db_factory, event_id)
    start, end = _window()
    _as_master(event_id)

    r = client.post(
        f"/api/admin/events/{event_id}/forced-assignments",
        json=_forced_payload(exhibitor["org_id"], buyer["org_id"], venue_id, start, end, reason="전략 매칭"),
    )
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["status"] == "accepted"
    assert body["matching_type"] == "forced"

    db = db_factory()
    try:
        meeting = db.get(Meeting, body["id"])
        assert meeting.awaiting_org_id is None
        assert meeting.requested_by == "organizer"
        assert meeting.request_reason == "전략 매칭"
    finally:
        db.close()


def test_forced_general_buyer_is_accepted_immediately(client, db_factory):
    """2026-09-15 정정(발주자 QA B3) — FORCED는 받는 쪽 유형 무관 항상 accepted.
    이전엔 일반 바이어 수신이 proposed였다(회귀 방지: 그 시절 동작으로 돌아가면 여기가 깨진다)."""
    event_id = _seed_event(db_factory)
    exhibitor = _seed_org_role(db_factory, event_id, is_exhibitor=True)
    buyer = _seed_org_role(db_factory, event_id, is_buyer=True, buyer_subtype="pre_registered")
    venue_id = _seed_venue(db_factory, event_id)
    start, end = _window()
    _as_master(event_id)

    r = client.post(
        f"/api/admin/events/{event_id}/forced-assignments",
        json=_forced_payload(exhibitor["org_id"], buyer["org_id"], venue_id, start, end),
    )
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["status"] == "accepted"

    db = db_factory()
    try:
        meeting = db.get(Meeting, body["id"])
        assert meeting.awaiting_org_id is None
    finally:
        db.close()


def test_forced_exhibitor_recipient_also_accepted(client, db_factory):
    """Exhibitor 수신도 FORCED 채널에서 예외 없이 accepted(2026-09-15 정정) — 바이어가 일반이어도
    마찬가지다. FORCED는 이제 "바이어 유형만 본다"는 예전 모듈 설계를 대체하고 채널 자체가
    최우선으로 accepted를 강제한다."""
    event_id = _seed_event(db_factory)
    exhibitor = _seed_org_role(db_factory, event_id, is_exhibitor=True)
    buyer = _seed_org_role(db_factory, event_id, is_buyer=True, buyer_subtype="pre_registered")
    venue_id = _seed_venue(db_factory, event_id)
    start, end = _window()
    _as_master(event_id)

    r = client.post(
        f"/api/admin/events/{event_id}/forced-assignments",
        json=_forced_payload(exhibitor["org_id"], buyer["org_id"], venue_id, start, end),
    )
    assert r.status_code == 201
    assert r.json()["status"] == "accepted"


def test_forced_notifies_both_orgs_in_app_and_email(client, db_factory):
    """강제 배정 확정 — 참가사·바이어 양쪽 조직에 meeting_accepted 알림이 인앱+이메일로 나간다
    (신규 알림 타입 없이 기존 meeting_accepted 재사용, ``_emit_assignment_notifications``)."""
    event_id = _seed_event(db_factory)
    enable_participant_email(db_factory, event_id)  # 메일 발송을 검증한다(기본은 꺼짐)
    exhibitor = _seed_org_role(db_factory, event_id, is_exhibitor=True)
    buyer = _seed_org_role(db_factory, event_id, is_buyer=True, buyer_subtype="pre_registered")
    _seed_member(db_factory, exhibitor["org_id"], email="exhibitor@example.com")
    _seed_member(db_factory, buyer["org_id"], email="buyer@example.com")
    venue_id = _seed_venue(db_factory, event_id)
    start, end = _window()
    _as_master(event_id)

    r = client.post(
        f"/api/admin/events/{event_id}/forced-assignments",
        json=_forced_payload(exhibitor["org_id"], buyer["org_id"], venue_id, start, end),
    )
    assert r.status_code == 201, r.text
    meeting_id = r.json()["id"]

    db = db_factory()
    try:
        rows = db.execute(
            select(Notification.type, Notification.recipient_org_id).where(
                Notification.meeting_id == meeting_id
            )
        ).all()
        assert sorted((t, str(o)) for t, o in rows) == sorted(
            [
                ("meeting_accepted", exhibitor["org_id"]),
                ("meeting_accepted", buyer["org_id"]),
            ]
        )

        dispatches = db.execute(
            select(NotificationDispatch.channel, NotificationDispatch.status)
            .join(Notification, Notification.id == NotificationDispatch.notification_id)
            .where(Notification.meeting_id == meeting_id)
        ).all()
        # 2개 수신 org x 2개 채널(in_app/email) = 4행, 전부 발송 성공.
        assert len(dispatches) == 4
        assert {c for c, _ in dispatches} == {"in_app", "email"}
        assert all(status == "sent" for _, status in dispatches)
    finally:
        db.close()


def test_forced_second_assignment_does_not_duplicate_first_meetings_notifications(client, db_factory):
    """같은 참가사·바이어 쌍을 다른 시간에 다시 강제 배정해도(별개 미팅), 첫 배정의 알림 행이
    중복 생성되지 않는다 — 멱등 유니크 키(type, meeting_id, recipient_org_id, due_at)는 미팅마다
    새로 생기므로 미팅 단위로는 자연히 1행씩이고, 재요청이 기존 미팅의 알림을 다시 만들지 않는다."""
    event_id = _seed_event(db_factory)
    exhibitor = _seed_org_role(db_factory, event_id, is_exhibitor=True)
    buyer = _seed_org_role(db_factory, event_id, is_buyer=True, buyer_subtype="pre_registered")
    venue_id = _seed_venue(db_factory, event_id)
    start1, end1 = _window(days_ahead=1)
    start2, end2 = _window(days_ahead=2)
    _as_master(event_id)

    r1 = client.post(
        f"/api/admin/events/{event_id}/forced-assignments",
        json=_forced_payload(exhibitor["org_id"], buyer["org_id"], venue_id, start1, end1),
    )
    assert r1.status_code == 201, r1.text
    meeting_id_1 = r1.json()["id"]

    r2 = client.post(
        f"/api/admin/events/{event_id}/forced-assignments",
        json=_forced_payload(exhibitor["org_id"], buyer["org_id"], venue_id, start2, end2),
    )
    assert r2.status_code == 201, r2.text
    meeting_id_2 = r2.json()["id"]
    assert meeting_id_1 != meeting_id_2

    db = db_factory()
    try:
        count_1 = db.execute(
            select(func.count()).select_from(Notification).where(Notification.meeting_id == meeting_id_1)
        ).scalar_one()
        count_2 = db.execute(
            select(func.count()).select_from(Notification).where(Notification.meeting_id == meeting_id_2)
        ).scalar_one()
        assert count_1 == 2  # 첫 배정 알림 — 재배정으로 덧생기지 않는다.
        assert count_2 == 2  # 두 번째 배정도 독립적으로 정확히 2건.
    finally:
        db.close()


def test_forced_notification_failure_does_not_roll_back_assignment(client, db_factory, monkeypatch):
    """알림이 터져도 강제 배정은 강제 배정이다 — meetings_api의 reject/cancel과 동일한 안전망
    (notify_after_commit)을 강제배정 경로에도 잠근다."""
    from app.notifications import service as notification_service

    def _boom(*args, **kwargs):
        raise RuntimeError("SMTP 폭발")

    monkeypatch.setattr(notification_service, "notify_meeting_accepted", _boom)

    event_id = _seed_event(db_factory)
    exhibitor = _seed_org_role(db_factory, event_id, is_exhibitor=True)
    buyer = _seed_org_role(db_factory, event_id, is_buyer=True, buyer_subtype="pre_registered")
    venue_id = _seed_venue(db_factory, event_id)
    start, end = _window()
    _as_master(event_id)

    r = client.post(
        f"/api/admin/events/{event_id}/forced-assignments",
        json=_forced_payload(exhibitor["org_id"], buyer["org_id"], venue_id, start, end),
    )
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["status"] == "accepted"  # 알림이 터져도 배정 자체(commit된 사실)는 살아 있다.

    db = db_factory()
    try:
        meeting = db.get(Meeting, body["id"])
        assert meeting.status == "accepted"
        # 알림 발화가 실패했으니 행 자체가 없다(notify_after_commit이 예외를 삼키고 롤백만 한다).
        count = db.execute(
            select(func.count()).select_from(Notification).where(Notification.meeting_id == body["id"])
        ).scalar_one()
        assert count == 0
    finally:
        db.close()


def test_forced_hard_slot_conflict_is_blocked_409(client, db_factory):
    event_id = _seed_event(db_factory)
    exhibitor = _seed_org_role(db_factory, event_id, is_exhibitor=True)
    buyer = _seed_org_role(db_factory, event_id, is_buyer=True, buyer_subtype="hosted")
    other_buyer = _seed_org_role(db_factory, event_id, is_buyer=True, buyer_subtype="hosted", org_name="다른바이어")
    venue_id = _seed_venue(db_factory, event_id)
    start, end = _window()
    # 참가사가 이미 그 시간에 다른 바이어와 확정 미팅을 갖고 있다 — 하드 제약(슬롯 겹침)은
    # 강제배정도 피해가지 못한다.
    _seed_meeting(db_factory, event_id, exhibitor["org_id"], other_buyer["org_id"], status="accepted", start=start)
    _as_master(event_id)

    r = client.post(
        f"/api/admin/events/{event_id}/forced-assignments",
        json=_forced_payload(exhibitor["org_id"], buyer["org_id"], venue_id, start, end),
    )
    assert r.status_code == 409
    assert r.json()["detail"]["code"] == "SLOT_TAKEN"


def test_forced_ignores_exhibitor_soft_unavailable_slot(client, db_factory):
    """참가사가 미팅-불가로 표시해둔 슬롯이라도 운영자 강제배정은 통과한다(자유도 최대 — D 설계)."""
    event_id = _seed_event(db_factory)
    exhibitor = _seed_org_role(db_factory, event_id, is_exhibitor=True)
    buyer = _seed_org_role(db_factory, event_id, is_buyer=True, buyer_subtype="hosted")
    venue_id = _seed_venue(db_factory, event_id)
    start, end = _window()
    blocked_slot = slot_id(start.astimezone(ZoneInfo("Asia/Seoul")))

    db = db_factory()
    try:
        db.add(
            ExhibitorProfile(
                org_event_role_id=exhibitor["role_id"], unavailable_meeting_slots=[blocked_slot]
            )
        )
        db.commit()
    finally:
        db.close()

    _as_master(event_id)
    r = client.post(
        f"/api/admin/events/{event_id}/forced-assignments",
        json=_forced_payload(exhibitor["org_id"], buyer["org_id"], venue_id, start, end),
    )
    assert r.status_code == 201, r.text  # 소프트 불가슬롯은 무시된다


def test_forced_accepts_slot_ids_instead_of_explicit_time(client, db_factory):
    event_id = _seed_event(db_factory)
    _seed_schedule_settings(db_factory, event_id)
    exhibitor = _seed_org_role(db_factory, event_id, is_exhibitor=True)
    buyer = _seed_org_role(db_factory, event_id, is_buyer=True, buyer_subtype="hosted")
    venue_id = _seed_venue(db_factory, event_id)
    _as_master(event_id)

    tomorrow = (datetime.now(ZoneInfo("Asia/Seoul")) + timedelta(days=1)).date()
    slot = f"{tomorrow.isoformat()}T09:00"  # 스케줄 기본값(09:00 시작) 그리드 안의 슬롯

    r = client.post(
        f"/api/admin/events/{event_id}/forced-assignments",
        json={
            "exhibitor_org_id": exhibitor["org_id"],
            "buyer_org_id": buyer["org_id"],
            "venue_id": venue_id,
            "slot_ids": [slot],
        },
    )
    assert r.status_code == 201, r.text


def test_forced_rejects_both_time_source_missing(client, db_factory):
    event_id = _seed_event(db_factory)
    exhibitor = _seed_org_role(db_factory, event_id, is_exhibitor=True)
    buyer = _seed_org_role(db_factory, event_id, is_buyer=True, buyer_subtype="hosted")
    venue_id = _seed_venue(db_factory, event_id)
    _as_master(event_id)

    r = client.post(
        f"/api/admin/events/{event_id}/forced-assignments",
        json={"exhibitor_org_id": exhibitor["org_id"], "buyer_org_id": buyer["org_id"], "venue_id": venue_id},
    )
    assert r.status_code == 422


def test_forced_404_when_venue_missing(client, db_factory):
    event_id = _seed_event(db_factory)
    exhibitor = _seed_org_role(db_factory, event_id, is_exhibitor=True)
    buyer = _seed_org_role(db_factory, event_id, is_buyer=True, buyer_subtype="hosted")
    start, end = _window()
    _as_master(event_id)

    r = client.post(
        f"/api/admin/events/{event_id}/forced-assignments",
        json=_forced_payload(exhibitor["org_id"], buyer["org_id"], str(uuid.uuid4()), start, end),
    )
    assert r.status_code == 404
    assert r.json()["detail"]["code"] == "VENUE_NOT_FOUND"


def test_forced_404_when_buyer_not_registered_for_role(client, db_factory):
    event_id = _seed_event(db_factory)
    exhibitor = _seed_org_role(db_factory, event_id, is_exhibitor=True)
    not_a_buyer = _seed_org_role(db_factory, event_id, is_exhibitor=True, org_name="바이어아님")
    venue_id = _seed_venue(db_factory, event_id)
    start, end = _window()
    _as_master(event_id)

    r = client.post(
        f"/api/admin/events/{event_id}/forced-assignments",
        json=_forced_payload(exhibitor["org_id"], not_a_buyer["org_id"], venue_id, start, end),
    )
    assert r.status_code == 404
    assert r.json()["detail"]["code"] == "BUYER_NOT_FOUND"


def test_forced_requires_master_403(client, db_factory):
    event_id = _seed_event(db_factory)
    exhibitor = _seed_org_role(db_factory, event_id, is_exhibitor=True)
    buyer = _seed_org_role(db_factory, event_id, is_buyer=True, buyer_subtype="hosted")
    venue_id = _seed_venue(db_factory, event_id)
    start, end = _window()
    _as_forbidden(event_id)

    r = client.post(
        f"/api/admin/events/{event_id}/forced-assignments",
        json=_forced_payload(exhibitor["org_id"], buyer["org_id"], venue_id, start, end),
    )
    assert r.status_code == 403


# =============================================================================
# Phase 4 — AI 전체 포화배정
# =============================================================================
def test_saturation_run_targets_only_zero_meeting_orgs(client, db_factory):
    event_id = _seed_event(db_factory)
    _seed_schedule_settings(db_factory, event_id)
    busy_exhibitor = _seed_org_role(db_factory, event_id, is_exhibitor=True, org_name="바쁜참가사")
    free_exhibitor = _seed_org_role(db_factory, event_id, is_exhibitor=True, org_name="한가한참가사")
    busy_buyer = _seed_org_role(db_factory, event_id, is_buyer=True, buyer_subtype="hosted", org_name="바쁜바이어")
    free_buyer = _seed_org_role(db_factory, event_id, is_buyer=True, buyer_subtype="hosted", org_name="한가한바이어")
    _seed_meeting(db_factory, event_id, busy_exhibitor["org_id"], busy_buyer["org_id"], status="accepted")
    _as_master(event_id)

    r = client.post(f"/api/admin/events/{event_id}/saturation-runs")
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["status"] == "draft"
    assert body["run_number"] == 1
    assert len(body["items"]) == 1
    item = body["items"][0]
    assert item["exhibitor_org_id"] == free_exhibitor["org_id"]
    assert item["buyer_org_id"] == free_buyer["org_id"]
    assert item["venue_id"] is None  # draft 시점엔 장소 미정(모듈 설계)
    assert item["status"] == "draft"
    assert item["seq_no"] == 1


def test_saturation_run_number_increments_per_event(client, db_factory):
    event_id = _seed_event(db_factory)
    _seed_schedule_settings(db_factory, event_id)
    _as_master(event_id)

    first = client.post(f"/api/admin/events/{event_id}/saturation-runs").json()
    second = client.post(f"/api/admin/events/{event_id}/saturation-runs").json()
    assert first["run_number"] == 1
    assert second["run_number"] == 2


def test_saturation_confirm_partial_success_skips_conflicting_item(client, db_factory):
    event_id = _seed_event(db_factory)
    # N=1 — 참가사당 정확히 1쌍만 만들어 이 테스트의 관심사(항목별 confirm 경합 스킵)와
    # 보장 라운드 개수를 분리한다(라운드 개수 자체는 별도 회귀 테스트가 검증).
    _seed_schedule_settings(db_factory, event_id, min_guaranteed_slots=1)
    ex1 = _seed_org_role(db_factory, event_id, is_exhibitor=True, org_name="참가사1")
    _seed_org_role(db_factory, event_id, is_exhibitor=True, org_name="참가사2")
    _seed_org_role(db_factory, event_id, is_buyer=True, buyer_subtype="hosted", org_name="포화바이어1")
    _seed_org_role(db_factory, event_id, is_buyer=True, buyer_subtype="hosted", org_name="포화바이어2")
    _as_master(event_id)

    run = client.post(f"/api/admin/events/{event_id}/saturation-runs").json()
    assert len(run["items"]) == 2
    item_ex1 = next(i for i in run["items"] if i["exhibitor_org_id"] == ex1["org_id"])

    rival = _seed_org_role(db_factory, event_id, is_buyer=True, buyer_subtype="hosted", org_name="라이벌바이어")
    # confirm 직전 — ex1이 그 draft 슬롯과 정확히 같은 시간에 이미 확정 미팅을 갖게 만들어 경합을
    # 재현한다(운영자가 그 사이 다른 경로로 채운 것과 동일한 상황).
    _seed_meeting(
        db_factory,
        event_id,
        ex1["org_id"],
        rival["org_id"],
        status="accepted",
        start=datetime.fromisoformat(item_ex1["scheduled_start"]),
    )

    r = client.post(f"/api/admin/events/{event_id}/saturation-runs/{run['id']}/confirm")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["confirmed_count"] == 1
    assert body["skipped_count"] == 1
    assert body["run"]["status"] == "confirmed"

    skipped = next(i for i in body["items"] if i["id"] == item_ex1["id"])
    assert skipped["status"] == "skipped"
    # #11로 쌍 단위 유일성(ACTIVE_MEETING_EXISTS)은 제거됐다 — 이 경합은 ex1의 시각 점유
    # (accepted EXCLUDE)만으로 걸린다.
    assert skipped["error_code"] == "SLOT_TAKEN"
    assert skipped["materialized_meeting_id"] is None

    confirmed = next(i for i in body["items"] if i["id"] != item_ex1["id"])
    assert confirmed["status"] == "confirmed"
    assert confirmed["materialized_meeting_id"] is not None

    db = db_factory()
    try:
        meeting = db.get(Meeting, confirmed["materialized_meeting_id"])
        assert meeting.matching_type == "ai"
        assert str(meeting.saturation_run_id) == run["id"]
        assert meeting.status == "accepted"  # hosted 바이어 → 즉시확정
        assert meeting.requested_by == "organizer"

        skipped_row = db.get(SaturationDraftItem, item_ex1["id"])
        assert skipped_row.status == "skipped"
        assert skipped_row.materialized_meeting_id is None

        run_row = db.get(SaturationBatchRun, run["id"])
        assert run_row.status == "confirmed"
        assert run_row.confirmed_at is not None
    finally:
        db.close()


def _drain_bulk_email() -> None:
    """일괄 확정 이메일(응답 뒤 전용 스레드가 발송·기록)이 끝날 때까지 기다린다 — 시간을 두고 DB를 다시 읽는
    대신 그 스레드를 끝까지 join한다(bulk_dispatch.shutdown_bulk_email(wait=True)). 다음 사용 때 새로 만든다."""
    from app.notifications.bulk_dispatch import shutdown_bulk_email

    shutdown_bulk_email(wait=True)


def test_saturation_confirm_bulk_all_meetings_accepted_and_notifies_both_orgs(client, db_factory):
    """2026-09-15 재정정(발주자 QA B3 범위 확인) — 일괄배정(전체 포화배정)도 단건 강제배정과 동일하게
    받는 쪽 유형 무관 항상 accepted다. 일반 바이어(pre_registered)를 섞어 회귀를 막고, 확정된
    미팅 전부가 양쪽 조직에 알림을 받는지 배치 전체를 본다(알림 폭주 걱정 없이 건별 발화 그대로)."""
    event_id = _seed_event(db_factory)
    # N=1 — 이 테스트는 수락 상태·알림 배선을 보는 게 목적이라 보장 라운드 개수는 최소로 둔다.
    _seed_schedule_settings(db_factory, event_id, min_guaranteed_slots=1)
    enable_participant_email(db_factory, event_id)  # 메일 발송을 검증한다(기본은 꺼짐)
    ex1 = _seed_org_role(db_factory, event_id, is_exhibitor=True, org_name="참가사1")
    ex2 = _seed_org_role(db_factory, event_id, is_exhibitor=True, org_name="참가사2")
    buyer1 = _seed_org_role(db_factory, event_id, is_buyer=True, buyer_subtype="pre_registered", org_name="일반바이어1")
    buyer2 = _seed_org_role(db_factory, event_id, is_buyer=True, buyer_subtype="hosted", org_name="초청바이어2")
    for org in (ex1, ex2, buyer1, buyer2):
        _seed_member(db_factory, org["org_id"], email=f"{org['org_id']}@example.com")
    _as_master(event_id)

    run = client.post(f"/api/admin/events/{event_id}/saturation-runs").json()
    assert len(run["items"]) == 2

    r = client.post(f"/api/admin/events/{event_id}/saturation-runs/{run['id']}/confirm")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["confirmed_count"] == 2
    assert body["skipped_count"] == 0

    meeting_ids = [item["materialized_meeting_id"] for item in body["items"]]
    assert all(meeting_ids)
    # 이메일은 응답 이후 백그라운드가 보내고 dispatch 행을 쓴다(app.notifications.bulk_dispatch) —
    # 알림 행·인앱은 응답 시점에 이미 있고, 이메일 행은 발송이 끝나면 생긴다.
    _drain_bulk_email()

    db = db_factory()
    try:
        for meeting_id in meeting_ids:
            meeting = db.get(Meeting, meeting_id)
            # 일반 바이어 수신 미팅도 예외 없이 accepted — 정정 전이면 proposed였을 것.
            assert meeting.status == "accepted"
            assert meeting.awaiting_org_id is None

            rows = db.execute(
                select(Notification.type, Notification.recipient_org_id).where(
                    Notification.meeting_id == meeting_id
                )
            ).all()
            assert sorted((t, str(o)) for t, o in rows) == sorted(
                [
                    ("meeting_accepted", str(meeting.exhibitor_org_id)),
                    ("meeting_accepted", str(meeting.buyer_org_id)),
                ]
            )

            dispatches = db.execute(
                select(NotificationDispatch.status)
                .join(Notification, Notification.id == NotificationDispatch.notification_id)
                .where(Notification.meeting_id == meeting_id)
            ).scalars().all()
            assert len(dispatches) == 4  # 2 org x (in_app, email)
            assert all(status == "sent" for status in dispatches)
    finally:
        db.close()


class _FakeClock:
    """RateLimiter용 가짜 시계 — sleep이 시간을 그만큼 전진시킨다(실제로 기다리지 않는다)."""

    def __init__(self) -> None:
        self.now = 0.0
        self.sleeps: list[float] = []

    def monotonic(self) -> float:
        return self.now

    def sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)
        self.now += seconds


def test_saturation_confirm_responds_before_emails_and_sends_them_in_background_throttled(
    client, db_factory, monkeypatch
):
    """동시성 하드닝(1차) — 일괄 확정은 이메일을 요청 안에서 보내지 않는다.

    확정 응답이 먼저 나가고(그 시점에 보낸 메일 0통), 알림 행·인앱 dispatch는 이미 커밋돼 있다. 이메일은
    전용 스레드(bulk-email)가 보내고 결과를 dispatch 행으로 남긴다. 초당 상한은 실발송 경로
    (``SmtpEmailSender.send``)의 프로세스 공유 상한이 지킨다 — 그래서 여기서도 실제 SmtpEmailSender를 쓰고
    smtplib만 가짜로 바꾼다. 예전엔 N건 × 양쪽 × 멤버 수만큼을 요청 안에서 순서대로 보내 응답이 분 단위로
    늦어지고 SES 한도(14통/초)를 넘길 수 있었다.
    """
    import smtplib

    from app.notifications import email as email_module
    from app.notifications import service as notification_service
    from app.notifications.channels import EmailChannel, InAppChannel
    from app.notifications.email import RateLimiter, SmtpEmailSender

    gate = threading.Event()
    clock = _FakeClock()
    sends: list[tuple[str, str, float]] = []  # (수신 주소, 보낸 스레드, 가짜 시계 시각)

    class _GatedSmtp:
        """smtplib.SMTP 대역 — 게이트가 열릴 때까지 sendmail에서 멈춰 '발송이 응답 뒤에 일어남'을 드러낸다."""

        def __init__(self, host, port, timeout=None):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def starttls(self):
            pass

        def login(self, user, password):
            pass

        def sendmail(self, from_addr, to_addrs, msg_string):
            gate.wait(timeout=10)
            sends.append((to_addrs[0], threading.current_thread().name, clock.now))

    monkeypatch.setattr(smtplib, "SMTP", _GatedSmtp)
    smtp_sender = SmtpEmailSender("smtp.example.com", 587, None, None, "no-reply@salesground.kr")
    monkeypatch.setattr(
        notification_service, "_default_channels", lambda: (InAppChannel(), EmailChannel(smtp_sender))
    )
    # 프로세스 공유 상한을 초당 2통 + 가짜 시계로 — 발송 간격이 가짜 시계 기준 0.5초 이상이어야 한다.
    monkeypatch.setattr(
        email_module, "_rate_limiter", RateLimiter(2, clock=clock.monotonic, sleep=clock.sleep)
    )

    event_id = _seed_event(db_factory)
    _seed_schedule_settings(db_factory, event_id, min_guaranteed_slots=1)
    enable_participant_email(db_factory, event_id)  # 메일 발송을 검증한다(기본은 꺼짐)
    orgs = [
        _seed_org_role(db_factory, event_id, is_exhibitor=True, org_name="참가사1"),
        _seed_org_role(db_factory, event_id, is_exhibitor=True, org_name="참가사2"),
        _seed_org_role(db_factory, event_id, is_buyer=True, buyer_subtype="hosted", org_name="초청바이어1"),
        _seed_org_role(db_factory, event_id, is_buyer=True, buyer_subtype="hosted", org_name="초청바이어2"),
    ]
    for org in orgs:
        _seed_member(db_factory, org["org_id"], email=f"{org['org_id']}@example.com")
    _as_master(event_id)

    run = client.post(f"/api/admin/events/{event_id}/saturation-runs").json()
    assert len(run["items"]) == 2

    try:
        r = client.post(f"/api/admin/events/{event_id}/saturation-runs/{run['id']}/confirm")
        assert r.status_code == 200, r.text
        # 응답이 돌아온 시점에 보낸 메일은 0통 — 발송은 게이트에 막힌 백그라운드에 있고, 요청은 기다리지 않았다.
        assert sends == []

        meeting_ids = [item["materialized_meeting_id"] for item in r.json()["items"]]
        db = db_factory()
        try:
            channels = db.execute(
                select(NotificationDispatch.channel)
                .join(Notification, Notification.id == NotificationDispatch.notification_id)
                .where(Notification.meeting_id.in_(meeting_ids))
            ).scalars().all()
        finally:
            db.close()
        # 알림 4건(2미팅 × 양쪽)의 인앱 dispatch는 요청 안에서 이미 커밋됐다. 이메일 행은 아직 없다.
        assert sorted(channels) == ["in_app"] * 4
    finally:
        gate.set()

    _drain_bulk_email()
    assert len(sends) == 4
    assert {addr for addr, _, _ in sends} == {f"{org['org_id']}@example.com" for org in orgs}
    assert all(thread.startswith("bulk-email") for _, thread, _ in sends)
    stamps = [at for _, _, at in sends]
    assert all(b - a >= 0.5 for a, b in zip(stamps, stamps[1:]))
    assert clock.sleeps == [0.5, 0.5, 0.5]

    db = db_factory()
    try:
        email_statuses = db.execute(
            select(NotificationDispatch.status)
            .join(Notification, Notification.id == NotificationDispatch.notification_id)
            .where(Notification.meeting_id.in_(meeting_ids), NotificationDispatch.channel == "email")
        ).scalars().all()
    finally:
        db.close()
    assert sorted(email_statuses) == ["sent"] * 4


# --- 참가자 알림 메일 스위치(nt004mail0001) — 운영자 배정 경로 ----------------------------------
def _set_participant_email(db_factory, event_id: str, enabled: bool) -> None:
    db = db_factory()
    try:
        set_participant_email(db, event_id, enabled)
    finally:
        db.close()


def _capture_mail(monkeypatch, sender) -> None:
    from app.notifications import service as notification_service
    from app.notifications.channels import EmailChannel, InAppChannel

    monkeypatch.setattr(
        notification_service, "_default_channels", lambda: (InAppChannel(), EmailChannel(sender))
    )


def _dispatches_for_meetings(db_factory, meeting_ids) -> list[tuple[str, str, str | None]]:
    db = db_factory()
    try:
        rows = db.execute(
            select(NotificationDispatch.channel, NotificationDispatch.status, NotificationDispatch.error)
            .join(Notification, Notification.id == NotificationDispatch.notification_id)
            .where(Notification.meeting_id.in_(list(meeting_ids)))
        ).all()
    finally:
        db.close()
    return sorted((c, s, e) for c, s, e in rows)


@pytest.mark.parametrize("path", ["forced-assignments", "retrigger-assignments"])
def test_operator_assignment_with_participant_email_off_sends_no_mail(
    client, db_factory, monkeypatch, path
):
    """강제 배정·⚡재보충 확정 — 꺼진 행사에선 양쪽 확정 알림이 인앱으로만 남고 메일은 0통."""
    from app.notifications.email import FakeEmailSender

    sender = FakeEmailSender()
    _capture_mail(monkeypatch, sender)
    event_id = _seed_event(db_factory)
    exhibitor = _seed_org_role(db_factory, event_id, is_exhibitor=True)
    buyer = _seed_org_role(db_factory, event_id, is_buyer=True, buyer_subtype="hosted")
    _seed_member(db_factory, exhibitor["org_id"], email=f"{exhibitor['org_id']}@example.com")
    _seed_member(db_factory, buyer["org_id"], email=f"{buyer['org_id']}@example.com")
    venue_id = _seed_venue(db_factory, event_id)
    _set_participant_email(db_factory, event_id, False)
    start, end = _window()
    _as_master(event_id)

    r = client.post(
        f"/api/admin/events/{event_id}/{path}",
        json=_forced_payload(exhibitor["org_id"], buyer["org_id"], venue_id, start, end),
    )

    assert r.status_code == 201, r.text
    assert r.json()["status"] == "accepted"
    assert sender.sent == []
    assert _dispatches_for_meetings(db_factory, [r.json()["id"]]) == sorted(
        [("in_app", "sent", None)] * 2 + [("email", "skipped", "event_email_disabled")] * 2
    )


def _seed_saturation_world(db_factory) -> str:
    event_id = _seed_event(db_factory)
    _seed_schedule_settings(db_factory, event_id, min_guaranteed_slots=1)
    orgs = [
        _seed_org_role(db_factory, event_id, is_exhibitor=True, org_name="참가사1"),
        _seed_org_role(db_factory, event_id, is_exhibitor=True, org_name="참가사2"),
        _seed_org_role(db_factory, event_id, is_buyer=True, buyer_subtype="hosted", org_name="초청바이어1"),
        _seed_org_role(db_factory, event_id, is_buyer=True, buyer_subtype="hosted", org_name="초청바이어2"),
    ]
    for org in orgs:
        _seed_member(db_factory, org["org_id"], email=f"{org['org_id']}@example.com")
    return event_id


def test_saturation_confirm_with_participant_email_off_queues_and_sends_nothing(
    client, db_factory, monkeypatch
):
    """포화 배정 확정(지연 발송) — 꺼진 행사는 메일을 대기열에 담지 않는다. 응답 시점에 이미 이메일 행이
    skipped(event_email_disabled)로 남고, 백그라운드 발송 작업이 끝난 뒤에도 메일은 0통이다."""
    from app.notifications.email import FakeEmailSender

    sender = FakeEmailSender()
    _capture_mail(monkeypatch, sender)
    event_id = _seed_saturation_world(db_factory)
    _set_participant_email(db_factory, event_id, False)
    _as_master(event_id)

    run = client.post(f"/api/admin/events/{event_id}/saturation-runs").json()
    assert len(run["items"]) == 2
    r = client.post(f"/api/admin/events/{event_id}/saturation-runs/{run['id']}/confirm")
    assert r.status_code == 200, r.text
    meeting_ids = [item["materialized_meeting_id"] for item in r.json()["items"]]
    assert all(meeting_ids)

    expected = sorted(
        [("in_app", "sent", None)] * 4 + [("email", "skipped", "event_email_disabled")] * 4
    )
    # 응답 시점 — 이메일 행이 이미 있다(요청 트랜잭션에서 skipped로 기록, 대기열 없음).
    assert _dispatches_for_meetings(db_factory, meeting_ids) == expected
    _drain_bulk_email()
    assert sender.sent == []
    assert _dispatches_for_meetings(db_factory, meeting_ids) == expected


def test_saturation_confirm_off_event_survives_broken_mail_config(client, db_factory, monkeypatch):
    """꺼진 행사(기본)는 메일 채널을 만들지 않는다 — SMTP 설정이 깨져 채널 구성이 실패해도(지연 배치 폴백 →
    채널 없이 알림 생성) 확정 알림의 인앱 행과 skipped 행이 남고 메일은 0통이다."""
    from app.notifications import service as notification_service

    def _boom():
        raise RuntimeError("SMTP 설정 없음")

    monkeypatch.setattr(notification_service, "_default_channels", _boom)
    event_id = _seed_saturation_world(db_factory)  # 스위치를 건드리지 않는다 = 기본(꺼짐)
    _as_master(event_id)

    run = client.post(f"/api/admin/events/{event_id}/saturation-runs").json()
    r = client.post(f"/api/admin/events/{event_id}/saturation-runs/{run['id']}/confirm")
    assert r.status_code == 200, r.text
    meeting_ids = [item["materialized_meeting_id"] for item in r.json()["items"]]
    assert len(meeting_ids) == 2 and all(meeting_ids)
    _drain_bulk_email()

    assert _dispatches_for_meetings(db_factory, meeting_ids) == sorted(
        [("in_app", "sent", None)] * 4 + [("email", "skipped", "event_email_disabled")] * 4
    )


def test_saturation_mail_stops_when_the_switch_is_turned_off_mid_batch(client, db_factory, monkeypatch):
    """켜진 상태에서 확정해 메일이 대기열에 담긴 뒤 운영자가 끄면 — 이미 보내던 1통만 나가고 남은 메일은
    보내기 직전 재확인에서 멈춘다(skipped, event_email_disabled)."""
    entered = threading.Event()
    gate = threading.Event()
    sends: list[str] = []

    class _GatedSender:
        """첫 발송에서 멈춰 '발송 도중'을 만든다 — 테스트가 그 사이에 스위치를 끈다."""

        def send(self, message):
            entered.set()
            gate.wait(timeout=10)
            sends.append(message.to[0])

    _capture_mail(monkeypatch, _GatedSender())
    event_id = _seed_saturation_world(db_factory)
    enable_participant_email(db_factory, event_id)  # 켜진 상태에서 확정한다
    _as_master(event_id)

    run = client.post(f"/api/admin/events/{event_id}/saturation-runs").json()
    try:
        r = client.post(f"/api/admin/events/{event_id}/saturation-runs/{run['id']}/confirm")
        assert r.status_code == 200, r.text
        meeting_ids = [item["materialized_meeting_id"] for item in r.json()["items"]]
        assert entered.wait(timeout=10)  # 백그라운드가 첫 메일을 보내는 중이다
        _set_participant_email(db_factory, event_id, False)
    finally:
        gate.set()
    _drain_bulk_email()

    assert len(sends) == 1
    emails = [row for row in _dispatches_for_meetings(db_factory, meeting_ids) if row[0] == "email"]
    assert emails == sorted(
        [("email", "sent", None)] + [("email", "skipped", "event_email_disabled")] * 3
    )


def test_saturation_confirm_notification_failure_does_not_roll_back_confirmed_items(
    client, db_factory, monkeypatch
):
    """일괄배정 알림이 터져도 확정된 항목·미팅은 그대로 남는다 — 알림 하나의 실패가 배치 전체의
    배정 사실을 되돌리지 않는다(notify_after_commit, meetings_api reject/cancel과 동일 보장)."""
    from app.notifications import service as notification_service

    def _boom(*args, **kwargs):
        raise RuntimeError("SMTP 폭발")

    monkeypatch.setattr(notification_service, "notify_meeting_accepted", _boom)

    event_id = _seed_event(db_factory)
    _seed_schedule_settings(db_factory, event_id)
    _seed_org_role(db_factory, event_id, is_exhibitor=True, org_name="참가사1")
    _seed_org_role(db_factory, event_id, is_buyer=True, buyer_subtype="pre_registered", org_name="일반바이어1")
    _as_master(event_id)

    run = client.post(f"/api/admin/events/{event_id}/saturation-runs").json()
    assert len(run["items"]) == 1

    r = client.post(f"/api/admin/events/{event_id}/saturation-runs/{run['id']}/confirm")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["confirmed_count"] == 1  # 알림이 터져도 확정은 확정.

    meeting_id = body["items"][0]["materialized_meeting_id"]
    db = db_factory()
    try:
        meeting = db.get(Meeting, meeting_id)
        assert meeting.status == "accepted"

        item = db.get(SaturationDraftItem, body["items"][0]["id"])
        assert item.status == "confirmed"

        run_row = db.get(SaturationBatchRun, run["id"])
        assert run_row.status == "confirmed"

        count = db.execute(
            select(func.count()).select_from(Notification).where(Notification.meeting_id == meeting_id)
        ).scalar_one()
        assert count == 0  # 알림 발화 자체는 실패해 행이 없다.
    finally:
        db.close()


def test_saturation_confirm_twice_returns_409(client, db_factory):
    event_id = _seed_event(db_factory)
    _seed_schedule_settings(db_factory, event_id)
    _seed_org_role(db_factory, event_id, is_exhibitor=True)
    _seed_org_role(db_factory, event_id, is_buyer=True, buyer_subtype="hosted")
    _as_master(event_id)

    run = client.post(f"/api/admin/events/{event_id}/saturation-runs").json()
    first = client.post(f"/api/admin/events/{event_id}/saturation-runs/{run['id']}/confirm")
    assert first.status_code == 200

    second = client.post(f"/api/admin/events/{event_id}/saturation-runs/{run['id']}/confirm")
    assert second.status_code == 409
    assert second.json()["detail"]["code"] == "RUN_NOT_DRAFT"


def test_saturation_discard_does_not_materialize(client, db_factory):
    event_id = _seed_event(db_factory)
    _seed_schedule_settings(db_factory, event_id)
    _seed_org_role(db_factory, event_id, is_exhibitor=True)
    _seed_org_role(db_factory, event_id, is_buyer=True, buyer_subtype="hosted")
    _as_master(event_id)

    run = client.post(f"/api/admin/events/{event_id}/saturation-runs").json()
    assert len(run["items"]) == 1

    r = client.post(f"/api/admin/events/{event_id}/saturation-runs/{run['id']}/discard")
    assert r.status_code == 200
    assert r.json()["status"] == "discarded"

    db = db_factory()
    try:
        materialized = db.execute(
            select(func.count())
            .select_from(Meeting)
            .where(Meeting.saturation_run_id == run["id"])
        ).scalar_one()
        assert materialized == 0
        run_row = db.get(SaturationBatchRun, run["id"])
        assert run_row.status == "discarded"
        assert run_row.confirmed_at is None
    finally:
        db.close()


def test_saturation_discard_twice_returns_409(client, db_factory):
    event_id = _seed_event(db_factory)
    _seed_schedule_settings(db_factory, event_id)
    _as_master(event_id)

    run = client.post(f"/api/admin/events/{event_id}/saturation-runs").json()
    first = client.post(f"/api/admin/events/{event_id}/saturation-runs/{run['id']}/discard")
    assert first.status_code == 200

    second = client.post(f"/api/admin/events/{event_id}/saturation-runs/{run['id']}/discard")
    assert second.status_code == 409
    assert second.json()["detail"]["code"] == "RUN_NOT_DRAFT"


def test_saturation_run_not_found_404(client, db_factory):
    event_id = _seed_event(db_factory)
    _as_master(event_id)
    r = client.get(f"/api/admin/events/{event_id}/saturation-runs/{uuid.uuid4()}")
    assert r.status_code == 404
    assert r.json()["detail"]["code"] == "RUN_NOT_FOUND"


def test_saturation_requires_master_403(client, db_factory):
    event_id = _seed_event(db_factory)
    _seed_schedule_settings(db_factory, event_id)
    _as_forbidden(event_id)

    r = client.post(f"/api/admin/events/{event_id}/saturation-runs")
    assert r.status_code == 403


# =============================================================================
# 전체 일괄배정 시뮬레이션 회귀(발주자 QA 지적 A, 2026-09-15) — "정상 작동하는지 시뮬레이션 돌려
# 확인"을 pytest로 고정한다. 이전 구현은 참가사↔바이어를 1:1로만 짝지어 min_guaranteed_slots(N)를
# 사실상 무시했고(참가사가 몇 명이든 항상 미팅 1건), 참가사 미팅-불가 슬롯도 보지 않았다 —
# 두 문제 모두 여기서 고치고(app.matching.assignment_service._build_saturation_pairs), 그 규칙을
# 재현 테스트로 남긴다.
# =============================================================================
def test_saturation_run_fills_each_exhibitor_up_to_min_guaranteed_slots(client, db_factory):
    """참가사 1곳 · 바이어 3곳 · N=2 — 참가사가 최소 보장 슬롯 수(N)만큼, 서로 다른 바이어·
    서로 다른 시간으로 채워져야 한다(이전 구현은 N과 무관하게 항상 1건만 만들었다)."""
    event_id = _seed_event(db_factory)
    _seed_schedule_settings(db_factory, event_id, min_guaranteed_slots=2)
    exhibitor = _seed_org_role(db_factory, event_id, is_exhibitor=True, org_name="포화참가사")
    buyer1 = _seed_org_role(db_factory, event_id, is_buyer=True, buyer_subtype="hosted", org_name="포화바이어1")
    buyer2 = _seed_org_role(db_factory, event_id, is_buyer=True, buyer_subtype="hosted", org_name="포화바이어2")
    _seed_org_role(db_factory, event_id, is_buyer=True, buyer_subtype="hosted", org_name="포화바이어3")
    _as_master(event_id)

    r = client.post(f"/api/admin/events/{event_id}/saturation-runs")
    assert r.status_code == 201, r.text
    items = r.json()["items"]
    assert len(items) == 2  # N=2 — 딱 보장치만큼

    buyer_ids = {i["buyer_org_id"] for i in items}
    assert buyer_ids == {buyer1["org_id"], buyer2["org_id"]} or len(buyer_ids) == 2  # 서로 다른 바이어
    assert all(i["exhibitor_org_id"] == exhibitor["org_id"] for i in items)
    starts = {i["scheduled_start"] for i in items}
    assert len(starts) == 2  # 서로 다른 시간 — 참가사가 동시에 두 미팅을 가질 수 없다


def test_saturation_run_caps_at_available_buyers_when_below_min_guaranteed(client, db_factory):
    """바이어가 N보다 적으면(공급 부족) 있는 만큼만 채우고 억지로 채우지 않는다."""
    event_id = _seed_event(db_factory)
    _seed_schedule_settings(db_factory, event_id, min_guaranteed_slots=10)
    _seed_org_role(db_factory, event_id, is_exhibitor=True, org_name="포화참가사")
    _seed_org_role(db_factory, event_id, is_buyer=True, buyer_subtype="hosted", org_name="포화바이어1")
    _seed_org_role(db_factory, event_id, is_buyer=True, buyer_subtype="hosted", org_name="포화바이어2")
    _as_master(event_id)

    r = client.post(f"/api/admin/events/{event_id}/saturation-runs")
    assert r.status_code == 201, r.text
    assert len(r.json()["items"]) == 2  # 바이어 2곳뿐 — N=10이어도 2건까지만


def test_saturation_run_respects_exhibitor_unavailable_slots(client, db_factory):
    """참가사가 신청 때 표시해둔 미팅-불가 슬롯은 전체 포화배정 draft가 침범하지 않는다
    (강제배정 FORCED와 달리 전체 포화배정은 운영자가 참가사 캘린더를 "대신" 채우는 자동 채널이라
    참가사가 명시적으로 막은 시간은 존중한다)."""
    event_id = _seed_event(db_factory)
    _seed_schedule_settings(db_factory, event_id, min_guaranteed_slots=1)
    exhibitor = _seed_org_role(db_factory, event_id, is_exhibitor=True)
    _seed_org_role(db_factory, event_id, is_buyer=True, buyer_subtype="hosted")
    _as_master(event_id)

    # 첫 확률로 뽑힐 미래 슬롯을 미리 알아내 그 슬롯을 통째로 막는다 — 09:00 시작 그리드의
    # 첫 칸(가장 이른 미래 슬롯)이 블록 대상이다.
    event = None
    db = db_factory()
    try:
        event = db.get(Event, event_id)
    finally:
        db.close()
    from app.matching.assignment_service import _future_grid_slots

    db2 = db_factory()
    try:
        first_slot = _future_grid_slots(db2, event)[0]
    finally:
        db2.close()

    db3 = db_factory()
    try:
        db3.add(
            ExhibitorProfile(
                org_event_role_id=exhibitor["role_id"],
                unavailable_meeting_slots=[first_slot.id],
            )
        )
        db3.commit()
    finally:
        db3.close()

    r = client.post(f"/api/admin/events/{event_id}/saturation-runs")
    assert r.status_code == 201, r.text
    items = r.json()["items"]
    assert len(items) == 1
    assert items[0]["scheduled_start"] != first_slot.start.isoformat()


def test_saturation_run_draft_never_double_books_same_org_same_time(client, db_factory):
    """참가사·바이어 여러 명을 보장 라운드로 채워도, 같은 기업이 같은 시각에 두 항목을 갖지
    않는다(이중예약 없음 — 발주자 QA 체크리스트)."""
    event_id = _seed_event(db_factory)
    _seed_schedule_settings(db_factory, event_id, min_guaranteed_slots=3)
    for i in range(3):
        _seed_org_role(db_factory, event_id, is_exhibitor=True, org_name=f"참가사{i}")
    for i in range(4):
        _seed_org_role(db_factory, event_id, is_buyer=True, buyer_subtype="hosted", org_name=f"바이어{i}")
    _as_master(event_id)

    r = client.post(f"/api/admin/events/{event_id}/saturation-runs")
    assert r.status_code == 201, r.text
    items = r.json()["items"]
    assert len(items) > 0

    seen: dict[tuple[str, str], int] = {}
    for i in items:
        for org_id in (i["exhibitor_org_id"], i["buyer_org_id"]):
            key = (org_id, i["scheduled_start"])
            seen[key] = seen.get(key, 0) + 1
    assert all(count == 1 for count in seen.values()), "같은 기업이 같은 시각에 두 항목을 가졌다"

    # 같은 (참가사, 바이어) 쌍이 이 실행 안에서 두 번 나오지 않는다.
    pair_keys = [(i["exhibitor_org_id"], i["buyer_org_id"]) for i in items]
    assert len(pair_keys) == len(set(pair_keys))


def test_saturation_full_simulation_mixed_participants_end_to_end(client, db_factory):
    """발주자 QA 지적 A — "슈퍼 관리자 모드에서 전체 일괄 배정이 정상 작동하는지 시뮬레이션".

    참가사 3곳(그중 1곳은 이미 미팅 보유 → 대상 제외, 1곳은 불가슬롯 보유) · 바이어 4곳(그중 1곳은
    이미 미팅 보유 → 제외)을 섞어 draft → confirm까지 돌리고 다음을 전부 검증한다:
    ① 보장 슬롯 수(N=2) 충족 ② 기존 확정 미팅·참가사 불가시간 미침범 ③ 이중예약 없음
    ④ 확정된 미팅은 전부 accepted + 양쪽 알림 ⑤ draft(제안)→confirm(확정) 2단계 분리(draft 단계에선
    Meeting이 하나도 안 생긴다).
    """
    event_id = _seed_event(db_factory)
    _seed_schedule_settings(db_factory, event_id, min_guaranteed_slots=2)

    busy_exhibitor = _seed_org_role(db_factory, event_id, is_exhibitor=True, org_name="바쁜참가사")
    blocked_exhibitor = _seed_org_role(db_factory, event_id, is_exhibitor=True, org_name="불가슬롯참가사")
    free_exhibitor = _seed_org_role(db_factory, event_id, is_exhibitor=True, org_name="한가한참가사")
    busy_buyer = _seed_org_role(db_factory, event_id, is_buyer=True, buyer_subtype="hosted", org_name="바쁜바이어")
    buyer1 = _seed_org_role(db_factory, event_id, is_buyer=True, buyer_subtype="pre_registered", org_name="일반바이어1")
    buyer2 = _seed_org_role(db_factory, event_id, is_buyer=True, buyer_subtype="hosted", org_name="초청바이어2")
    buyer3 = _seed_org_role(db_factory, event_id, is_buyer=True, buyer_subtype="hosted", org_name="초청바이어3")
    for org in (busy_exhibitor, blocked_exhibitor, free_exhibitor, busy_buyer, buyer1, buyer2, buyer3):
        _seed_member(db_factory, org["org_id"], email=f"{org['org_id']}@example.com")

    # 기존 확정 미팅 — busy_exhibitor·busy_buyer는 이미 활성 미팅이 있어 대상에서 완전히 빠진다.
    existing_meeting_id = _seed_meeting(db_factory, event_id, busy_exhibitor["org_id"], busy_buyer["org_id"], status="accepted")

    event = None
    db = db_factory()
    try:
        event = db.get(Event, event_id)
    finally:
        db.close()
    from app.matching.assignment_service import _future_grid_slots

    db2 = db_factory()
    try:
        blocked_slot = _future_grid_slots(db2, event)[0]
    finally:
        db2.close()

    db3 = db_factory()
    try:
        db3.add(
            ExhibitorProfile(
                org_event_role_id=blocked_exhibitor["role_id"],
                unavailable_meeting_slots=[blocked_slot.id],
            )
        )
        db3.commit()
    finally:
        db3.close()

    _as_master(event_id)

    # --- ① draft 생성 — 아직 미팅이 하나도 안 만들어진다 ---
    run = client.post(f"/api/admin/events/{event_id}/saturation-runs").json()
    items = run["items"]
    assert len(items) > 0

    db4 = db_factory()
    try:
        materialized_before = db4.execute(
            select(func.count()).select_from(Meeting).where(Meeting.saturation_run_id == run["id"])
        ).scalar_one()
        assert materialized_before == 0  # draft는 물질화하지 않는다(2단계 분리)
        # 대상에서 완전히 빠졌는가 — busy 쌍은 draft에 안 나온다.
        assert all(i["exhibitor_org_id"] != busy_exhibitor["org_id"] for i in items)
        assert all(i["buyer_org_id"] != busy_buyer["org_id"] for i in items)
    finally:
        db4.close()

    # --- ② 보장 슬롯 수(N=2) — 빈 참가사(free_exhibitor·blocked_exhibitor)는 최대 N건까지 ---
    by_exhibitor: dict[str, list[dict]] = {}
    for i in items:
        by_exhibitor.setdefault(i["exhibitor_org_id"], []).append(i)
    assert len(by_exhibitor.get(free_exhibitor["org_id"], [])) == 2  # 바이어 3곳 있으니 N=2 꽉 채움
    # blocked_exhibitor도 나머지 가능한 슬롯으로 N=2까지 채워질 수 있다(바이어 풀은 충분).
    assert len(by_exhibitor.get(blocked_exhibitor["org_id"], [])) <= 2

    # --- ③ 참가사 불가시간 미침범 ---
    blocked_items = by_exhibitor.get(blocked_exhibitor["org_id"], [])
    assert all(i["scheduled_start"] != blocked_slot.start.isoformat() for i in blocked_items)

    # --- ④ 이중예약 없음 ---
    seen: dict[tuple[str, str], int] = {}
    for i in items:
        for org_id in (i["exhibitor_org_id"], i["buyer_org_id"]):
            seen[(org_id, i["scheduled_start"])] = seen.get((org_id, i["scheduled_start"]), 0) + 1
    assert all(count == 1 for count in seen.values())

    # --- ⑤ confirm — 전부 accepted + 양쪽 알림, 기존 미팅은 그대로(추가 전용·비파괴) ---
    r = client.post(f"/api/admin/events/{event_id}/saturation-runs/{run['id']}/confirm")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["skipped_count"] == 0  # draft 단계에서 이미 충돌을 피했으니 confirm은 전부 성공
    assert body["confirmed_count"] == len(items)

    db5 = db_factory()
    try:
        for item in body["items"]:
            meeting = db5.get(Meeting, item["materialized_meeting_id"])
            assert meeting.status == "accepted"  # 전체 포화배정은 받는 쪽 유형 무관 항상 accepted
            assert meeting.awaiting_org_id is None
            rows = db5.execute(
                select(Notification.type, Notification.recipient_org_id).where(
                    Notification.meeting_id == meeting.id
                )
            ).all()
            assert sorted((t, str(o)) for t, o in rows) == sorted(
                [
                    ("meeting_accepted", str(meeting.exhibitor_org_id)),
                    ("meeting_accepted", str(meeting.buyer_org_id)),
                ]
            )

        # 기존 미팅(busy 쌍)은 재실행으로도 건드려지지 않는다.
        existing = db5.get(Meeting, existing_meeting_id)
        assert existing.status == "accepted"
        assert existing.saturation_run_id is None
    finally:
        db5.close()


# =============================================================================
# 단일 기업 AI 재트리거(⚡, F-OP-003) 확정 — 발주자 QA 지적 B: "번개버튼 누르고 확정 누르면
# 매칭이 제대로 등록 안 되는 것 같음". 실제 원인은 백엔드에 이 채널을 받는 엔드포인트가 아예
# 없어 FE가 실세션에서도 인메모리 mock store로 조용히 폴백하던 것(frontend
# app/api/organizer/assignments/route.ts) — 여기서는 새로 추가한 백엔드 엔드포인트/서비스만 본다.
# =============================================================================
def test_retrigger_hosted_buyer_is_accepted_immediately(client, db_factory):
    event_id = _seed_event(db_factory)
    exhibitor = _seed_org_role(db_factory, event_id, is_exhibitor=True)
    buyer = _seed_org_role(db_factory, event_id, is_buyer=True, buyer_subtype="hosted")
    venue_id = _seed_venue(db_factory, event_id)
    start, end = _window()
    _as_master(event_id)

    r = client.post(
        f"/api/admin/events/{event_id}/retrigger-assignments",
        json=_forced_payload(exhibitor["org_id"], buyer["org_id"], venue_id, start, end),
    )
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["status"] == "accepted"
    assert body["matching_type"] == "ai"

    db = db_factory()
    try:
        meeting = db.get(Meeting, body["id"])
        assert meeting.awaiting_org_id is None
        assert meeting.requested_by == "organizer"
    finally:
        db.close()


def test_retrigger_general_buyer_is_awaiting_acceptance(client, db_factory):
    """운영자 개입 채널(FORCED·AI_SATURATION)과 달리 AI_RETRIGGER는 받는 쪽 바이어 유형을 그대로
    따른다 — 일반 바이어 수신은 수락대기(proposed)다. 이 분기가 없으면 예전엔 book_meeting의
    ``_guard_entry_state``가 matching_type='ai'를 AI_SATURATION으로 오인해 ENTRY_STATE_INVALID(500)를
    던졌다(회귀 방지 — 이게 발주자 QA 지적 B의 실제 파손 지점)."""
    event_id = _seed_event(db_factory)
    exhibitor = _seed_org_role(db_factory, event_id, is_exhibitor=True)
    buyer = _seed_org_role(db_factory, event_id, is_buyer=True, buyer_subtype="pre_registered")
    venue_id = _seed_venue(db_factory, event_id)
    start, end = _window()
    _as_master(event_id)

    r = client.post(
        f"/api/admin/events/{event_id}/retrigger-assignments",
        json=_forced_payload(exhibitor["org_id"], buyer["org_id"], venue_id, start, end),
    )
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["status"] == "proposed"

    db = db_factory()
    try:
        meeting = db.get(Meeting, body["id"])
        assert str(meeting.awaiting_org_id) == buyer["org_id"]
    finally:
        db.close()

    db2 = db_factory()
    try:
        notif = db2.execute(
            select(Notification.type, Notification.recipient_org_id).where(
                Notification.meeting_id == body["id"]
            )
        ).all()
        # 수락대기 — 응답을 쥔 바이어에게만 신청 알림(양쪽 확정 알림이 아니다).
        assert [(t, str(o)) for t, o in notif] == [("meeting_requested", buyer["org_id"])]
    finally:
        db2.close()


def test_retrigger_accepts_slot_ids(client, db_factory):
    event_id = _seed_event(db_factory)
    _seed_schedule_settings(db_factory, event_id)
    exhibitor = _seed_org_role(db_factory, event_id, is_exhibitor=True)
    buyer = _seed_org_role(db_factory, event_id, is_buyer=True, buyer_subtype="hosted")
    venue_id = _seed_venue(db_factory, event_id)
    _as_master(event_id)

    tomorrow = (datetime.now(ZoneInfo("Asia/Seoul")) + timedelta(days=1)).date()
    slot = f"{tomorrow.isoformat()}T09:00"

    r = client.post(
        f"/api/admin/events/{event_id}/retrigger-assignments",
        json={
            "exhibitor_org_id": exhibitor["org_id"],
            "buyer_org_id": buyer["org_id"],
            "venue_id": venue_id,
            "slot_ids": [slot],
        },
    )
    assert r.status_code == 201, r.text


def test_retrigger_hard_slot_conflict_is_blocked_409(client, db_factory):
    event_id = _seed_event(db_factory)
    exhibitor = _seed_org_role(db_factory, event_id, is_exhibitor=True)
    buyer = _seed_org_role(db_factory, event_id, is_buyer=True, buyer_subtype="hosted")
    other_buyer = _seed_org_role(db_factory, event_id, is_buyer=True, buyer_subtype="hosted", org_name="다른바이어")
    venue_id = _seed_venue(db_factory, event_id)
    start, end = _window()
    _seed_meeting(db_factory, event_id, exhibitor["org_id"], other_buyer["org_id"], status="accepted", start=start)
    _as_master(event_id)

    r = client.post(
        f"/api/admin/events/{event_id}/retrigger-assignments",
        json=_forced_payload(exhibitor["org_id"], buyer["org_id"], venue_id, start, end),
    )
    assert r.status_code == 409
    assert r.json()["detail"]["code"] == "SLOT_TAKEN"


def test_retrigger_requires_master_403(client, db_factory):
    event_id = _seed_event(db_factory)
    exhibitor = _seed_org_role(db_factory, event_id, is_exhibitor=True)
    buyer = _seed_org_role(db_factory, event_id, is_buyer=True, buyer_subtype="hosted")
    venue_id = _seed_venue(db_factory, event_id)
    start, end = _window()
    _as_forbidden(event_id)

    r = client.post(
        f"/api/admin/events/{event_id}/retrigger-assignments",
        json=_forced_payload(exhibitor["org_id"], buyer["org_id"], venue_id, start, end),
    )
    assert r.status_code == 403


# =============================================================================
# 교차리뷰 반영(2026-10-02) — H1: 일괄 확정 알림 루프가 중간에 터져도 메일은 넘긴다 /
# H2: 알림(커밋 + SMTP 대기) 뒤 커넥션 풀이 고갈돼도 이미 커밋된 배정이 500으로 보이지 않는다
# =============================================================================
def _exhaust_pool_once_mail_is_sent(monkeypatch, db_factory) -> list[object]:
    """첫 알림 메일을 보내는 순간부터 커넥션을 못 빌리게 한다 — 'SMTP를 기다리는 사이 풀이 고갈됐다'를 재현.

    단건 알림은 커밋한 뒤 SMTP를 기다리고, 그 뒤 결과 기록·알림 행 재조회에 커넥션을 다시 빌린다. 그 사이 풀이
    고갈되면 그 실패는 알림 쪽(notify_after_commit)에서 삼켜지지만, 예전 라우트는 그다음 응답을 만들며 만료된
    미팅·장소 객체를 다시 읽으러 커넥션을 빌렸다 → 이미 커밋된 배정이 500으로 보였다(리뷰 H2).
    """
    from sqlalchemy.exc import TimeoutError as PoolTimeout

    from app.notifications import service as notification_service
    from app.notifications.channels import EmailChannel, InAppChannel

    engine = db_factory.kw["bind"]
    sent: list[object] = []

    def _no_connection(*args, **kwargs):
        raise PoolTimeout("QueuePool limit of size 10 overflow 20 reached, connection timed out, timeout 10.00")

    class _ExhaustingSender:
        def send(self, message):
            sent.append(message)
            monkeypatch.setattr(engine.pool, "connect", _no_connection)

    monkeypatch.setattr(
        notification_service, "_default_channels", lambda: (InAppChannel(), EmailChannel(_ExhaustingSender()))
    )
    return sent


@pytest.mark.parametrize("endpoint", ["forced-assignments", "retrigger-assignments"])
def test_assignment_response_survives_pool_exhaustion_after_notifications(
    client, db_factory, monkeypatch, endpoint
):
    event_id = _seed_event(db_factory)
    enable_participant_email(db_factory, event_id)  # 메일 발송을 검증한다(기본은 꺼짐)
    exhibitor = _seed_org_role(db_factory, event_id, is_exhibitor=True)
    buyer = _seed_org_role(db_factory, event_id, is_buyer=True, buyer_subtype="hosted")
    _seed_member(db_factory, exhibitor["org_id"], email=f"h2-ex-{uuid.uuid4().hex[:6]}@example.com")
    _seed_member(db_factory, buyer["org_id"], email=f"h2-by-{uuid.uuid4().hex[:6]}@example.com")
    venue_id = _seed_venue(db_factory, event_id)
    start, end = _window()
    _as_master(event_id)
    sent = _exhaust_pool_once_mail_is_sent(monkeypatch, db_factory)

    r = client.post(
        f"/api/admin/events/{event_id}/{endpoint}",
        json=_forced_payload(exhibitor["org_id"], buyer["org_id"], venue_id, start, end),
    )
    monkeypatch.undo()  # 아래 확인 쿼리를 위해 풀을 되돌린다

    assert sent  # 알림 메일을 보내는 중에 풀이 고갈됐다
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["status"] == "accepted"
    assert body["venue_id"] == venue_id
    assert body["venue_type"] == "zone_table"
    assert body["exhibitor_org_id"] == exhibitor["org_id"]
    assert body["buyer_org_id"] == buyer["org_id"]

    db = db_factory()
    try:
        meeting = db.get(Meeting, body["id"])
        assert meeting is not None and meeting.status == "accepted"  # 배정은 실제로 커밋돼 있다
    finally:
        db.close()


def test_saturation_confirm_hands_over_emails_even_if_the_notification_loop_fails(
    client, db_factory, monkeypatch
):
    """H1 — 확정 알림 루프가 두 번째 미팅에서 예외로 끝나도, 첫 미팅 알림의 메일은 백그라운드로 넘긴다.

    알림 행은 이미 커밋돼 멱등 키가 잡혔으므로, 넘기지 못하면 다시 확정해도 그 메일은 영영 나가지 않는다.
    """
    from app.admin import router as admin_router
    from app.notifications import bulk_dispatch

    event_id = _seed_event(db_factory)
    _seed_schedule_settings(db_factory, event_id, min_guaranteed_slots=1)
    enable_participant_email(db_factory, event_id)  # 메일 발송을 검증한다(기본은 꺼짐)
    orgs = [
        _seed_org_role(db_factory, event_id, is_exhibitor=True, org_name="H1참가사1"),
        _seed_org_role(db_factory, event_id, is_exhibitor=True, org_name="H1참가사2"),
        _seed_org_role(db_factory, event_id, is_buyer=True, buyer_subtype="hosted", org_name="H1바이어1"),
        _seed_org_role(db_factory, event_id, is_buyer=True, buyer_subtype="hosted", org_name="H1바이어2"),
    ]
    for org in orgs:
        _seed_member(db_factory, org["org_id"], email=f"{org['org_id']}@example.com")
    _as_master(event_id)
    run = client.post(f"/api/admin/events/{event_id}/saturation-runs").json()
    assert len(run["items"]) == 2

    real_emit = admin_router._emit_assignment_notifications
    emitted: list[str] = []

    def flaky_emit(db, meeting, *, channels=None):
        if emitted:
            raise RuntimeError("두 번째 미팅 알림 중 실패(테스트)")
        emitted.append(str(meeting.id))
        return real_emit(db, meeting, channels=channels)

    handed_over: list[int] = []
    real_send = bulk_dispatch.DeferredEmailBatch.send_in_background

    def spy_send(self, session_factory):
        handed_over.append(self.pending_messages)
        return real_send(self, session_factory)

    monkeypatch.setattr(admin_router, "_emit_assignment_notifications", flaky_emit)
    monkeypatch.setattr(bulk_dispatch.DeferredEmailBatch, "send_in_background", spy_send)

    r = client.post(f"/api/admin/events/{event_id}/saturation-runs/{run['id']}/confirm")

    assert r.status_code == 500  # 루프의 예외 자체는 그대로 드러난다(확정은 이미 커밋됐다)
    assert handed_over == [2]  # 그래도 첫 미팅 양쪽 기업 메일 2통은 넘겼다
    _drain_bulk_email()

    db = db_factory()
    try:
        sent = db.execute(
            select(func.count())
            .select_from(NotificationDispatch)
            .join(Notification, Notification.id == NotificationDispatch.notification_id)
            .where(
                Notification.meeting_id == emitted[0],
                NotificationDispatch.channel == "email",
                NotificationDispatch.status == "sent",
            )
        ).scalar_one()
        assert sent == 2
    finally:
        db.close()
