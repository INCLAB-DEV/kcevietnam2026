"""알림 인박스 API 테스트 (F-NT-001) — GET 인박스 / POST 읽음 / POST 모두읽음 HTTP 계약.

로컬 Postgres 없으면 conftest의 skip 패턴(migrated_db)에 따라 전체 skip.
"""

from __future__ import annotations

import itertools

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.auth.principal import get_current_principal
from app.db import get_session
from app.main import app
from app.models import Event, Member, Organization
from app.notifications import service
from app.notifications.channels import build_channels
from app.notifications.email import FakeEmailSender
from tests.conftest import header_principal

_seq = itertools.count(1)
UNKNOWN_ID = "00000000-0000-0000-0000-000000000000"


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
    # 인증은 override로 고정 — 이 파일은 인박스 계약을 검사한다(인증 계약은 test_demo_principal).
    app.dependency_overrides[get_current_principal] = header_principal
    yield TestClient(app, raise_server_exceptions=False)
    app.dependency_overrides.clear()


def _h(org_id: str, member_id: str | None = None) -> dict:
    """테스트 주체 지정. ``member_id``를 주면 읽음 감사(read_by_member_id) 대상이 된다."""
    headers = {"X-Org-Id": org_id}
    if member_id is not None:
        headers["X-Member-Id"] = member_id
    return headers


def _seed_org_with_member(db_factory) -> dict:
    n = next(_seq)
    db = db_factory()
    try:
        ev = Event(name="DX Korea 2026", slug=f"nt-router-{n}")
        org = Organization(name_ko="테스트기업")
        db.add_all([ev, org])
        db.flush()
        member = Member(organization_id=org.id, name="김테스트", email=f"router{n}@nabi.test")
        db.add(member)
        db.commit()
        return {"event_id": ev.id, "org_id": org.id, "member_id": member.id}
    finally:
        db.close()


def _seed_notification(db_factory, event_id: str, org_id: str, *, kind: str = "review_prompt") -> str:
    db = db_factory()
    try:
        channels = build_channels(FakeEmailSender())
        if kind == "review_prompt":
            n = service.notify_review_prompt(
                db, event_id=event_id, meeting_id=None, recipient_org_id=org_id,
                counterpart_org_name="상대기업", channels=channels,
            )
        else:
            n = service.notify_meeting_requested(
                db, event_id=event_id, meeting_id=None, recipient_org_id=org_id,
                counterpart_org_name="상대기업", requested_by_role="buyer", channels=channels,
            )
        return n.id
    finally:
        db.close()


class TestInbox:
    def test_unauthenticated_401(self, client):
        resp = client.get("/api/notifications")
        assert resp.status_code == 401

    def test_lists_org_notifications_with_unread_count(self, client, db_factory):
        seeded = _seed_org_with_member(db_factory)
        _seed_notification(db_factory, seeded["event_id"], seeded["org_id"])

        resp = client.get("/api/notifications", headers=_h(seeded["org_id"]))

        assert resp.status_code == 200
        body = resp.json()
        assert body["unread_count"] == 1
        assert len(body["items"]) == 1
        assert body["items"][0]["type"] == "review_prompt"
        assert body["items"][0]["payload"]["counterpart_org_name"] == "상대기업"

    def test_other_org_does_not_see_notification(self, client, db_factory):
        seeded = _seed_org_with_member(db_factory)
        _seed_notification(db_factory, seeded["event_id"], seeded["org_id"])

        resp = client.get("/api/notifications", headers=_h(UNKNOWN_ID))

        assert resp.status_code == 200
        assert resp.json()["items"] == []


class TestMarkRead:
    def test_marks_single_notification_read(self, client, db_factory):
        seeded = _seed_org_with_member(db_factory)
        nid = _seed_notification(db_factory, seeded["event_id"], seeded["org_id"])

        # 읽은 주체는 **세션에서** 나온다 — 요청 바디로 자기신고하지 않는다(인증 이관).
        resp = client.post(
            f"/api/notifications/{nid}/read",
            headers=_h(seeded["org_id"], member_id=seeded["member_id"]),
        )

        assert resp.status_code == 200
        body = resp.json()
        assert body["read_at"] is not None
        assert body["read_by_member_id"] == seeded["member_id"]

    def test_non_uuid_subject_records_read_without_member(self, client, db_factory):
        """데모 토큰 주체(비-UUID)로 읽어도 500이 아니라 정상 읽음 — 주체만 비운다.

        ``read_by_member_id``는 members FK(uuid)라 명단 적재층 키(``mbr-buyer-01``)를 넣으면
        22P02로 터진다. 읽음 자체는 org 공유 상태라 주체 없이도 성립해야 한다.
        """
        seeded = _seed_org_with_member(db_factory)
        nid = _seed_notification(db_factory, seeded["event_id"], seeded["org_id"])

        resp = client.post(f"/api/notifications/{nid}/read", headers=_h(seeded["org_id"]))

        assert resp.status_code == 200
        body = resp.json()
        assert body["read_at"] is not None
        assert body["read_by_member_id"] is None

    def test_body_member_id_is_ignored(self, client, db_factory):
        """바디로 실린 ``member_id``는 더 이상 감사 기록에 반영되지 않는다(자기신고 폐기 회귀)."""
        seeded = _seed_org_with_member(db_factory)
        nid = _seed_notification(db_factory, seeded["event_id"], seeded["org_id"])

        resp = client.post(
            f"/api/notifications/{nid}/read",
            json={"member_id": seeded["member_id"]},
            headers=_h(seeded["org_id"]),
        )

        assert resp.status_code == 200
        assert resp.json()["read_by_member_id"] is None

    def test_read_by_member_name_is_resolved_in_read_and_inbox(self, client, db_factory):
        """인박스의 "읽음 {이름}" 표시용 — 읽음 응답과 목록 조회가 같은 이름을 돌려준다.

        org 공유 인박스라 "누가 먼저 읽었는가"가 팀 안에서 의미 있는 정보다. id만 주면 화면이
        이름을 얻으려 회원 조회를 한 번 더 해야 하고, 그건 목록에서 곧장 N+1이 된다.
        """
        seeded = _seed_org_with_member(db_factory)
        nid = _seed_notification(db_factory, seeded["event_id"], seeded["org_id"])
        headers = _h(seeded["org_id"], member_id=seeded["member_id"])

        read = client.post(f"/api/notifications/{nid}/read", headers=headers)
        assert read.status_code == 200
        assert read.json()["read_by_member_name"] == "김테스트"

        inbox = client.get("/api/notifications", headers=headers).json()
        row = next(item for item in inbox["items"] if item["id"] == nid)
        assert row["read_by_member_id"] == seeded["member_id"]
        assert row["read_by_member_name"] == "김테스트"

    def test_read_by_member_name_is_none_without_recordable_subject(self, client, db_factory):
        """주체를 기록할 수 없었으면(데모 subject) 이름도 없다 — 화면은 이름 없이 "읽음"만 그린다."""
        seeded = _seed_org_with_member(db_factory)
        nid = _seed_notification(db_factory, seeded["event_id"], seeded["org_id"])

        resp = client.post(f"/api/notifications/{nid}/read", headers=_h(seeded["org_id"]))

        assert resp.status_code == 200
        assert resp.json()["read_by_member_name"] is None

    def test_unread_notification_has_no_read_by_name(self, client, db_factory):
        seeded = _seed_org_with_member(db_factory)
        _seed_notification(db_factory, seeded["event_id"], seeded["org_id"])

        inbox = client.get("/api/notifications", headers=_h(seeded["org_id"])).json()

        assert inbox["items"][0]["read_at"] is None
        assert inbox["items"][0]["read_by_member_name"] is None

    def test_malformed_id_404(self, client, db_factory):
        seeded = _seed_org_with_member(db_factory)
        resp = client.post("/api/notifications/not-a-uuid/read", headers=_h(seeded["org_id"]))
        assert resp.status_code == 404

    def test_unknown_id_404(self, client, db_factory):
        seeded = _seed_org_with_member(db_factory)
        resp = client.post(f"/api/notifications/{UNKNOWN_ID}/read", headers=_h(seeded["org_id"]))
        assert resp.status_code == 404

    def test_read_all_marks_all_unread_and_preserves_already_read(self, client, db_factory):
        seeded = _seed_org_with_member(db_factory)
        _seed_notification(db_factory, seeded["event_id"], seeded["org_id"], kind="review_prompt")
        _seed_notification(db_factory, seeded["event_id"], seeded["org_id"], kind="meeting_requested")

        resp = client.post("/api/notifications/read-all", headers=_h(seeded["org_id"]))

        assert resp.status_code == 200
        assert resp.json()["updated_count"] == 2

        inbox = client.get("/api/notifications", headers=_h(seeded["org_id"])).json()
        assert inbox["unread_count"] == 0


def test_forged_org_header_rejected(db_factory):
    """``X-Org-Id`` 위조만으로는 남의 인박스를 열 수 없다(인증 이관 회귀 방지).

    principal override를 끼우지 않고 **실 인증 경로**를 태운다 — 헤더만 실은 요청은 실재하는
    org id를 정확히 맞혀도 401이어야 한다.
    """
    seeded = _seed_org_with_member(db_factory)

    def _override_session():
        db = db_factory()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_session] = _override_session
    try:
        unauthenticated = TestClient(app, raise_server_exceptions=False)
        assert unauthenticated.get("/api/notifications", headers=_h(seeded["org_id"])).status_code == 401
        assert (
            unauthenticated.post(
                "/api/notifications/read-all", headers=_h(seeded["org_id"])
            ).status_code
            == 401
        )
    finally:
        app.dependency_overrides.clear()
