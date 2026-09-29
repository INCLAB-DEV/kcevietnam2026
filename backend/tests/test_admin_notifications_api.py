"""어드민 콘솔 알림 발송 이력 API 통합 테스트(#OP 알림 콘솔).

경로 계약: ``GET /api/admin/events/{event_id}/notifications`` (조회 — master+sub),
``POST /api/admin/events/{event_id}/notifications/{dispatch_id}/resend`` (재발송 — master 전용).
프론트 계약은 frontend/lib/admin/api-paths.ts · types.ts ``AdminNotificationLog``.

픽스처·가드 관례는 test_admin_api.py와 동일 — 기능 검증은 가드 override, 가드 배선 자체는
실 StubSessionAuthenticator + InMemoryEventOperatorDirectory override 없이 검증한다.
"""

from __future__ import annotations

import itertools
import uuid

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.admin.guard import EventOperatorPrincipal, require_event_operator
from app.auth.organizer_guard import (
    EventMasterPrincipal,
    InMemoryEventOperatorDirectory,
    StubSessionAuthenticator,
    get_authenticator,
    get_operator_directory,
    require_event_master,
)
from app.db import get_session
from app.main import app
from app.models import Event, Member, Notification, NotificationDispatch, Organization

_seq = itertools.count(1)


# =============================================================================
# 픽스처
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
        except Exception:
            db.rollback()
            raise
        finally:
            db.close()

    app.dependency_overrides[get_session] = _override_session
    yield TestClient(app, raise_server_exceptions=False)
    app.dependency_overrides.clear()


def _as_master(event_id: str) -> None:
    app.dependency_overrides[require_event_master] = lambda: EventMasterPrincipal(
        member_id="mbr-master", event_id=event_id
    )
    app.dependency_overrides[require_event_operator] = lambda: EventOperatorPrincipal(
        member_id="mbr-master", event_id=event_id, permission_level="master", organizer_id="org-master"
    )


# --- 시드 헬퍼 -----------------------------------------------------------------
def _seed_event(db_factory) -> str:
    db = db_factory()
    try:
        ev = Event(name=f"알림 테스트 행사 {next(_seq)}", slug=f"notif-{next(_seq)}-{uuid.uuid4().hex[:8]}")
        db.add(ev)
        db.commit()
        return str(ev.id)
    finally:
        db.close()


def _seed_org_with_member(db_factory, name_ko="수신기업") -> dict:
    db = db_factory()
    try:
        org = Organization(name_ko=name_ko)
        db.add(org)
        db.flush()
        n = next(_seq)
        member = Member(organization_id=org.id, name=f"멤버{n}", email=f"member{n}@example.com")
        db.add(member)
        db.commit()
        return {"org_id": str(org.id), "member_id": str(member.id)}
    finally:
        db.close()


def _seed_notification_with_dispatches(db_factory, event_id: str, org_id: str, member_id: str) -> dict:
    """알림 1건 + dispatch 2행(인앱 성공·이메일 실패) — 재발송 테스트의 실패 행을 포함해 시드."""
    db = db_factory()
    try:
        notification = Notification(
            event_id=event_id,
            recipient_org_id=org_id,
            type="meeting_requested",
            payload={"counterpart_org_name": "상대기업", "requested_by_role": "buyer"},
        )
        db.add(notification)
        db.flush()
        ok_dispatch = NotificationDispatch(
            notification_id=notification.id, member_id=member_id, channel="in_app", status="sent"
        )
        failed_dispatch = NotificationDispatch(
            notification_id=notification.id,
            member_id=member_id,
            channel="email",
            status="failed",
            error="smtp down",
        )
        db.add_all([ok_dispatch, failed_dispatch])
        db.commit()
        return {
            "notification_id": str(notification.id),
            "in_app_id": str(ok_dispatch.id),
            "email_id": str(failed_dispatch.id),
        }
    finally:
        db.close()


# =============================================================================
# 조회 — dispatch 행 단위, 최신순, 수신 기업명 조인
# =============================================================================
def test_list_notification_logs_returns_dispatch_rows(client, db_factory):
    event_id = _seed_event(db_factory)
    org = _seed_org_with_member(db_factory)
    seeded = _seed_notification_with_dispatches(db_factory, event_id, org["org_id"], org["member_id"])
    _as_master(event_id)

    res = client.get(f"/api/admin/events/{event_id}/notifications")
    assert res.status_code == 200
    items = res.json()["items"]
    assert len(items) == 2  # dispatch 행 단위 — 알림 1건이 채널별로 2행

    by_channel = {row["channel"]: row for row in items}
    in_app = by_channel["in_app"]
    assert in_app["id"] == seeded["in_app_id"]
    assert in_app["event_id"] == event_id
    assert in_app["type"] == "meeting_requested"
    assert in_app["recipient_org_id"] == org["org_id"]
    assert in_app["recipient_org_name"] == "수신기업"
    assert in_app["delivered"] is True

    email = by_channel["email"]
    assert email["delivered"] is False  # status='failed' 행
    assert email["resend_count"] == 0


def test_list_notification_logs_empty_event(client, db_factory):
    event_id = _seed_event(db_factory)
    _as_master(event_id)

    res = client.get(f"/api/admin/events/{event_id}/notifications")
    assert res.status_code == 200
    assert res.json()["items"] == []


def test_list_notification_logs_only_this_event(client, db_factory):
    event_a = _seed_event(db_factory)
    event_b = _seed_event(db_factory)
    org = _seed_org_with_member(db_factory)
    _seed_notification_with_dispatches(db_factory, event_a, org["org_id"], org["member_id"])
    _as_master(event_b)

    res = client.get(f"/api/admin/events/{event_b}/notifications")
    assert res.status_code == 200
    assert res.json()["items"] == []  # 다른 행사 알림은 섞이지 않는다


# =============================================================================
# 재발송 — 실패 행 갱신(유니크 제약상 신규 행 불가), 다른 행사 dispatch는 404
# =============================================================================
def test_resend_failed_dispatch_updates_row_in_place(client, db_factory):
    event_id = _seed_event(db_factory)
    org = _seed_org_with_member(db_factory)
    seeded = _seed_notification_with_dispatches(db_factory, event_id, org["org_id"], org["member_id"])
    _as_master(event_id)

    res = client.post(f"/api/admin/events/{event_id}/notifications/{seeded['email_id']}/resend")
    assert res.status_code == 200
    body = res.json()
    assert body["id"] == seeded["email_id"]
    assert body["channel"] == "email"
    assert body["delivered"] is True  # fake 이메일 채널(기본)은 발송 성공

    # 행이 새로 생기지 않고 그 자리에서 갱신됐다(유니크 제약 + 계약).
    res = client.get(f"/api/admin/events/{event_id}/notifications")
    items = res.json()["items"]
    assert len(items) == 2
    email_row = next(row for row in items if row["channel"] == "email")
    assert email_row["delivered"] is True


def test_resend_dispatch_of_other_event_is_404(client, db_factory):
    event_a = _seed_event(db_factory)
    event_b = _seed_event(db_factory)
    org = _seed_org_with_member(db_factory)
    seeded = _seed_notification_with_dispatches(db_factory, event_a, org["org_id"], org["member_id"])
    _as_master(event_b)

    res = client.post(f"/api/admin/events/{event_b}/notifications/{seeded['email_id']}/resend")
    assert res.status_code == 404


def test_resend_unknown_dispatch_is_404(client, db_factory):
    event_id = _seed_event(db_factory)
    _as_master(event_id)

    res = client.post(f"/api/admin/events/{event_id}/notifications/{uuid.uuid4()}/resend")
    assert res.status_code == 404


# =============================================================================
# 가드 배선(실 와이어링) — 조회는 sub 통과, 재발송은 sub 403·미인증 401
# =============================================================================
@pytest.fixture()
def wired_env(db_factory):
    event_id = _seed_event(db_factory)

    def _override_session():
        db = db_factory()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_session] = _override_session
    app.dependency_overrides[get_authenticator] = StubSessionAuthenticator
    app.dependency_overrides[get_operator_directory] = lambda: InMemoryEventOperatorDirectory(
        {("mbr-master", event_id): "master", ("mbr-sub", event_id): "sub"}
    )
    yield TestClient(app, raise_server_exceptions=False), event_id
    app.dependency_overrides.clear()


def test_sub_reads_logs_but_cannot_resend(wired_env, db_factory):
    client, event_id = wired_env
    org = _seed_org_with_member(db_factory)
    seeded = _seed_notification_with_dispatches(db_factory, event_id, org["org_id"], org["member_id"])

    read = client.get(
        f"/api/admin/events/{event_id}/notifications",
        headers={"Authorization": "Bearer access-mbr-sub-1"},
    )
    assert read.status_code == 200  # 조회는 sub도 통과(master+sub 겸용 가드)

    resend = client.post(
        f"/api/admin/events/{event_id}/notifications/{seeded['email_id']}/resend",
        headers={"Authorization": "Bearer access-mbr-sub-1"},
    )
    assert resend.status_code == 403  # 재발송은 master 전용


def test_master_resends_and_no_token_is_401(wired_env, db_factory):
    client, event_id = wired_env
    org = _seed_org_with_member(db_factory)
    seeded = _seed_notification_with_dispatches(db_factory, event_id, org["org_id"], org["member_id"])

    ok = client.post(
        f"/api/admin/events/{event_id}/notifications/{seeded['email_id']}/resend",
        headers={"Authorization": "Bearer access-mbr-master-1"},
    )
    assert ok.status_code == 200

    anon = client.get(f"/api/admin/events/{event_id}/notifications")
    assert anon.status_code == 401
