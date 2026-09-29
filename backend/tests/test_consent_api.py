"""약관 API 통합 테스트 — 실제 Postgres(격리 DB)에서 관찰 가능한 동작 검증 (F-AU-001).

검증 항목(AC):
- v1 약관 5종 시드 + UNIQUE(type, version)
- GET /active 가 필수/선택 플래그 포함 목록 반환
- POST /agree 가 마스터 갱신 + 이력 append, version·agreed_at·ip 보존
- 필수 미동의 차단, 재방문자 약관 재요구 없이 통과
- 마이그레이션 up/down (conftest의 migrated_db가 down까지 돌려 검증)
"""

from __future__ import annotations

import itertools

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, func, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import sessionmaker

from app.config import settings
from app.db import get_session
from app.main import app
from app.models import ConsentDocument, Event, Member, Organization, UserConsentHistory, UserConsentState


@pytest.fixture()
def client(migrated_db: str):
    """migrated_db에 바인딩된 세션으로 get_session을 오버라이드한 TestClient."""
    engine = create_engine(migrated_db, future=True)
    TestSession = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)

    def _override():
        db = TestSession()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_session] = _override
    yield TestClient(app), TestSession
    app.dependency_overrides.clear()
    engine.dispose()


# 테스트 간 unique 제약(events.slug / members.email) 충돌을 피하려 매번 다른 값 부여.
_seq = itertools.count(1)


def _make_member(TestSession) -> str:
    """FK 충족용 최소 event/org/member 생성 후 member.id 반환."""
    n = next(_seq)
    db = TestSession()
    try:
        ev = Event(name="DX Korea 2026", slug=f"dx-korea-2026-{n}")
        org = Organization(name_ko="테스트기업")
        db.add_all([ev, org])
        db.flush()
        m = Member(organization_id=org.id, name="홍길동", email=f"hong{n}@example.com")
        db.add(m)
        db.commit()
        return m.id
    finally:
        db.close()


# --- 시드: v1 약관 5종 + UNIQUE(type, version) -------------------------------
def test_v1_documents_seeded(client):
    c, _ = client
    resp = c.get("/api/consents/active")
    assert resp.status_code == 200
    docs = resp.json()["documents"]
    types = {d["type"] for d in docs}
    assert types == {"tos", "privacy", "sensitive", "third_party", "marketing"}
    required = {d["type"] for d in docs if d["is_required"]}
    assert required == {"tos", "privacy", "sensitive", "third_party"}
    assert all(d["version"] == "v1" for d in docs)


def test_unique_type_version_enforced(client):
    _, TestSession = client
    db = TestSession()
    try:
        with pytest.raises(IntegrityError):  # UNIQUE(type, version) 위반(execute 시점에 발생)
            db.execute(
                text(
                    "INSERT INTO consent_documents (type, title, version, is_required) "
                    "VALUES ('tos', '중복', 'v1', true)"
                )
            )
    finally:
        db.rollback()
        db.close()


# --- GET /active: 필수 먼저 노출 + member 컨텍스트 --------------------------
def test_active_lists_required_first(client):
    c, _ = client
    docs = c.get("/api/consents/active").json()["documents"]
    # 필수가 모두 선택보다 앞에 온다(화면 노출 순서).
    required_flags = [d["is_required"] for d in docs]
    assert required_flags == sorted(required_flags, reverse=True)
    assert docs[0]["already_agreed"] is None  # member 없으면 미채움


# --- POST /agree: 마스터 + 이력, version·시각·ip 보존 -----------------------
def test_agree_records_master_and_history(client):
    c, TestSession = client
    member_id = _make_member(TestSession)

    resp = c.post(
        "/api/consents/agree",
        json={"member_id": member_id, "agreed_types": ["tos", "privacy", "sensitive", "third_party"]},
        # 위조 가능한 첫 값(evil) 뒤에 신뢰 프록시(ALB)가 붙인 실제 IP가 마지막에 온다.
        headers={"X-Forwarded-For": "1.2.3.4, 203.0.113.9"},
    )
    assert resp.status_code == 200
    assert resp.json()["gate_satisfied"] is True

    db = TestSession()
    try:
        states = db.execute(
            select(UserConsentState).where(UserConsentState.member_id == member_id)
        ).scalars().all()
        assert {s.type for s in states} == {"tos", "privacy", "sensitive", "third_party"}
        assert all(s.agreed and s.agreed_at is not None for s in states)
        # version 스냅샷: 마스터가 현행 문서(v1)를 가리킨다.
        assert all(s.consent_document_id is not None for s in states)

        history = db.execute(
            select(UserConsentHistory).where(UserConsentHistory.member_id == member_id)
        ).scalars().all()
        assert len(history) == 4
        assert all(h.action == "agreed" for h in history)
        # ALB가 append한 마지막 XFF 값=실제 IP(첫 값은 클라이언트가 위조 가능).
        assert all(h.ip == "203.0.113.9" for h in history)
    finally:
        db.close()


# --- 필수 미동의 차단 (아무것도 기록 안 함) ----------------------------------
def test_missing_required_blocks_and_writes_nothing(client):
    c, TestSession = client
    member_id = _make_member(TestSession)

    resp = c.post(
        "/api/consents/agree",
        json={"member_id": member_id, "agreed_types": ["tos", "privacy"]},
    )
    assert resp.status_code == 422
    detail = resp.json()["detail"]
    assert set(detail["missing_required"]) == {"sensitive", "third_party"}

    db = TestSession()
    try:
        states = db.execute(
            select(UserConsentState).where(UserConsentState.member_id == member_id)
        ).scalars().all()
        assert states == []  # 차단 시 마스터 기록 없음
        history = db.execute(
            select(UserConsentHistory).where(UserConsentHistory.member_id == member_id)
        ).scalars().all()
        assert history == []  # 이력도 없음
    finally:
        db.close()


# --- 재방문자: 약관 재요구 없이 통과 ----------------------------------------
def test_revisitor_passes_gate(client):
    c, TestSession = client
    member_id = _make_member(TestSession)
    c.post(
        "/api/consents/agree",
        json={"member_id": member_id, "agreed_types": ["tos", "privacy", "sensitive", "third_party"]},
    )
    # 재방문: member_id로 active 조회 → 게이트 충족, 약관 다시 안 받아도 됨.
    resp = c.get("/api/consents/active", params={"member_id": member_id})
    body = resp.json()
    assert body["gate_satisfied"] is True
    agreed = {d["type"] for d in body["documents"] if d["already_agreed"]}
    assert {"tos", "privacy", "sensitive", "third_party"} <= agreed


# --- 미지 항목 거부 ----------------------------------------------------------
def test_unknown_type_rejected(client):
    c, TestSession = client
    member_id = _make_member(TestSession)
    resp = c.post(
        "/api/consents/agree",
        json={"member_id": member_id, "agreed_types": ["tos", "bogus"]},
    )
    assert resp.status_code == 422


# --- 재제출 멱등: 마스터 1행 유지, 이력은 누적 -------------------------------
def test_reagree_idempotent_master_appends_history(client):
    c, TestSession = client
    member_id = _make_member(TestSession)
    payload = {"member_id": member_id, "agreed_types": ["tos", "privacy", "sensitive", "third_party"]}
    c.post("/api/consents/agree", json=payload)
    c.post("/api/consents/agree", json=payload)

    db = TestSession()
    try:
        states = db.execute(
            select(UserConsentState).where(UserConsentState.member_id == member_id)
        ).scalars().all()
        assert len(states) == 4  # (member, type) UNIQUE — 마스터 누적 안 됨
        history = db.execute(
            select(UserConsentHistory).where(UserConsentHistory.member_id == member_id)
        ).scalars().all()
        assert len(history) == 8  # 이력은 두 번 다 append
    finally:
        db.close()


# --- 입력 검증: malformed UUID 422, 미존재 member 404 (500 아님) -------------
def test_malformed_uuid_member_returns_422(client):
    c, _ = client
    resp = c.post(
        "/api/consents/agree",
        json={"member_id": "not-a-uuid", "agreed_types": ["tos"]},
    )
    assert resp.status_code == 422


def test_nonexistent_member_returns_404(client):
    c, _ = client
    # 형식은 맞지만 존재하지 않는 UUID → FK 500이 아니라 404.
    resp = c.post(
        "/api/consents/agree",
        json={
            "member_id": "00000000-0000-0000-0000-000000000000",
            "agreed_types": ["tos", "privacy", "sensitive", "third_party"],
        },
    )
    assert resp.status_code == 404


def test_active_endpoint_rejects_malformed_member_id(client):
    c, _ = client
    resp = c.get("/api/consents/active", params={"member_id": "bogus"})
    assert resp.status_code == 422


# --- 미래 시행일 약관은 활성에서 제외 ----------------------------------------
def test_future_effective_document_excluded(client):
    c, TestSession = client
    db = TestSession()
    try:
        # tos 미래 개정본(v-future) 삽입 — 시행일이 미래라 아직 활성 아님.
        db.execute(
            text(
                "INSERT INTO consent_documents (type, title, version, is_required, effective_date) "
                "VALUES ('tos', '미래 개정', 'v-future', true, current_date + interval '30 day')"
            )
        )
        db.commit()
    finally:
        db.close()

    docs = c.get("/api/consents/active").json()["documents"]
    tos = [d for d in docs if d["type"] == "tos"]
    assert len(tos) == 1
    assert tos[0]["version"] == "v1"  # 미래 개정본이 아니라 현행 v1이 활성


# --- 마이그레이션 up/down 왕복 (데이터 없는 클린 DB) -------------------------
def test_migration_up_down_roundtrip(empty_db_url):
    from alembic import command
    from alembic.config import Config

    original = settings.database_url
    settings.database_url = empty_db_url
    cfg = Config("alembic.ini")
    engine = create_engine(empty_db_url, future=True)
    try:
        command.upgrade(cfg, "head")
        with engine.connect() as c:
            count = c.execute(
                select(func.count()).select_from(ConsentDocument.__table__).where(
                    ConsentDocument.version == "v1"
                )
            ).scalar_one()
            assert count == 5  # v1 약관 5종 시드됨

        command.downgrade(cfg, "base")  # 전체 down — 깨끗이 내려가야 한다
        with engine.connect() as c:
            tables = c.execute(
                text("SELECT to_regclass('public.consent_documents')")
            ).scalar_one()
            assert tables is None  # 테이블 제거됨

        command.upgrade(cfg, "head")  # 재적용도 가능(멱등 시드 포함)
        with engine.connect() as c:
            count = c.execute(
                select(func.count()).select_from(ConsentDocument.__table__)
            ).scalar_one()
            assert count == 5
    finally:
        engine.dispose()
        settings.database_url = original
