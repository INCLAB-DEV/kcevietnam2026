"""자체 회원가입 API 통합 테스트(개발계획서 §7.3, ADR-0007 supersede) — POST /api/auth/signup.

Postgres 통합 DB(``migrated_db``, conftest.py)를 쓴다 — Postgres 미가용이면 전체 skip(project 관례).
가입은 Organization/Member/OrganizationEventRole을 실제로 커밋하므로 순수 로직만으론 검증할 수 없다
(bcrypt 해시·이메일 유니크·이벤트 FK가 전부 DB 제약과 얽혀 있음).
"""

from __future__ import annotations

import itertools
from datetime import date, timedelta

import bcrypt
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from app.auth.signup_router import get_email_verify_ticket_service
from app.db import get_session
from app.main import app
from app.models import Event, Member, Organization, OrganizationEventRole

_seq = itertools.count(1)


def _issue_verification_token(email: str) -> str:
    """login_router._ticket_service와 동형인 프로세스 싱글턴에서 직접 토큰을 발급받는다 —
    이메일 인증코드 HTTP 왕복 없이, 라우터가 실제로 쓰는 것과 같은 인스턴스를 쓴다(#9)."""
    return get_email_verify_ticket_service().issue({"email": email})


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


def _seed_event(db_factory, **overrides) -> str:
    n = next(_seq)
    db = db_factory()
    try:
        ev = Event(name=overrides.pop("name", "가입테스트행사"), slug=f"signup-{n}", **overrides)
        db.add(ev)
        db.commit()
        return str(ev.id)
    finally:
        db.close()


def _close_all_application_windows(db_factory) -> None:
    """기존 행사들의 신청기간을 비워 '진행 중 행사 없음' 상태를 만든다(폴백 분기 전제)."""
    db = db_factory()
    try:
        db.execute(
            Event.__table__.update().values(application_start=None, application_end=None)
        )
        db.commit()
    finally:
        db.close()


def _base_body(**overrides) -> dict:
    n = next(_seq)
    email = overrides.get("email") or f"signup-user-{n}@example.com"
    body = {
        "email": email,
        "password": "abcd1234",
        "name": "홍길동",
        "org_name_ko": f"테스트기업{n}",
        "role": "buyer",
        "email_verification_token": _issue_verification_token(email),
    }
    body.update(overrides)
    return body


# =============================================================================
# 성공 경로
# =============================================================================
def test_signup_success_creates_org_member_role(client, db_factory):
    event_id = _seed_event(db_factory)
    body = _base_body(role="exhibitor", event_id=event_id, phone="010-1234-5678", org_name_en="Test Co.")

    resp = client.post("/api/auth/signup", json=body)
    assert resp.status_code == 201
    assert resp.json() == {"outcome": "created"}

    db = db_factory()
    try:
        member = db.execute(select(Member).where(Member.email == body["email"])).scalar_one()
        assert member.name == "홍길동"
        assert member.phone == "010-1234-5678"
        assert member.password_hash is not None
        assert bcrypt.checkpw(b"abcd1234", member.password_hash.encode("utf-8"))

        org = db.get(Organization, member.organization_id)
        assert org.name_ko == body["org_name_ko"]
        assert org.name_en == "Test Co."

        role = db.execute(
            select(OrganizationEventRole).where(
                OrganizationEventRole.organization_id == org.id,
                OrganizationEventRole.event_id == event_id,
            )
        ).scalar_one()
        assert role.is_exhibitor is True
        assert role.is_buyer is False
        assert role.application_status == "registered"  # 미신청 상태로 시작(§7.3)
    finally:
        db.close()


def test_signup_uses_specified_event_id(client, db_factory):
    event_id = _seed_event(db_factory, name="지정행사")
    body = _base_body(event_id=event_id)
    resp = client.post("/api/auth/signup", json=body)
    assert resp.status_code == 201

    db = db_factory()
    try:
        member = db.execute(select(Member).where(Member.email == body["email"])).scalar_one()
        role = db.execute(
            select(OrganizationEventRole).where(OrganizationEventRole.organization_id == member.organization_id)
        ).scalar_one()
        assert str(role.event_id) == event_id
    finally:
        db.close()


def test_signup_falls_back_to_latest_event_when_unspecified(client, db_factory):
    # 이 테스트의 전제는 "지금 신청기간이 열린 행사가 하나도 없다"이다 — 그래야 폴백 분기에 닿는다.
    # ``migrated_db``는 세션 스코프라 다른 테스트 파일이 커밋한 행사가 그대로 남아 있고, 그중
    # 신청기간이 열린 게 있으면 해석기가 폴백까지 가기 전에 그걸 골라 간다(정상 동작). 전제를
    # 우연에 맡기지 않고 여기서 명시적으로 만든다.
    _close_all_application_windows(db_factory)
    _seed_event(db_factory, name="더 오래된 행사")
    newest_event_id = _seed_event(db_factory, name="가장 최근 행사")  # created_at이 더 늦다

    body = _base_body()  # event_id 미지정
    resp = client.post("/api/auth/signup", json=body)
    assert resp.status_code == 201

    db = db_factory()
    try:
        member = db.execute(select(Member).where(Member.email == body["email"])).scalar_one()
        role = db.execute(
            select(OrganizationEventRole).where(OrganizationEventRole.organization_id == member.organization_id)
        ).scalar_one()
        assert str(role.event_id) == newest_event_id
    finally:
        db.close()


def test_signup_prefers_event_with_open_application_period(client, db_factory):
    # 회귀: Date 컬럼은 드라이버가 datetime.date로 돌려주는데, 신청기간 판정이 이걸 오늘(ISO 문자열)과
    # 섞어 비교하다 TypeError(500)를 냈다. 신청기간이 설정된 행사로 해결 경로를 검증한다.
    today = date.today()
    open_event_id = _seed_event(
        db_factory,
        name="신청 진행중 행사",
        application_start=today - timedelta(days=1),
        application_end=today + timedelta(days=1),
    )
    _seed_event(
        db_factory,
        name="신청 마감 행사",
        application_start=today - timedelta(days=10),
        application_end=today - timedelta(days=5),
    )

    body = _base_body()  # event_id 미지정 — 신청기간 내 행사로 해결돼야 한다
    resp = client.post("/api/auth/signup", json=body)
    assert resp.status_code == 201

    db = db_factory()
    try:
        member = db.execute(select(Member).where(Member.email == body["email"])).scalar_one()
        role = db.execute(
            select(OrganizationEventRole).where(OrganizationEventRole.organization_id == member.organization_id)
        ).scalar_one()
        assert str(role.event_id) == open_event_id
    finally:
        db.close()


# =============================================================================
# 실패 경로
# =============================================================================
def test_signup_duplicate_email_409(client, db_factory):
    event_id = _seed_event(db_factory)
    body = _base_body(event_id=event_id)

    first = client.post("/api/auth/signup", json=body)
    assert first.status_code == 201

    # 인증 토큰은 1회용(login_ticket 소진 규약) — 같은 이메일로 재시도하려면 새로 발급받는다.
    second_body = dict(body, email_verification_token=_issue_verification_token(body["email"]))
    second = client.post("/api/auth/signup", json=second_body)
    assert second.status_code == 409


# =============================================================================
# 이메일 인증 토큰(#9) — 없거나 위조·불일치면 가입을 거부한다
# =============================================================================
def test_signup_without_verification_token_422(client, db_factory):
    event_id = _seed_event(db_factory)
    body = _base_body(event_id=event_id)
    del body["email_verification_token"]  # 필수 필드 자체가 없음 — pydantic이 422로 원천 차단

    resp = client.post("/api/auth/signup", json=body)
    assert resp.status_code == 422


def test_signup_forged_verification_token_403(client, db_factory):
    event_id = _seed_event(db_factory)
    body = _base_body(event_id=event_id, email_verification_token="not-a-real-token")

    resp = client.post("/api/auth/signup", json=body)
    assert resp.status_code == 403


def test_signup_verification_token_for_different_email_403(client, db_factory):
    event_id = _seed_event(db_factory)
    n = next(_seq)
    real_email = f"signup-user-{n}@example.com"
    token_for_other_email = _issue_verification_token("someone-else@example.com")
    body = {
        "email": real_email,
        "password": "abcd1234",
        "name": "홍길동",
        "org_name_ko": f"테스트기업{n}",
        "role": "buyer",
        "event_id": event_id,
        "email_verification_token": token_for_other_email,
    }

    resp = client.post("/api/auth/signup", json=body)
    assert resp.status_code == 403


def test_signup_reused_verification_token_403(client, db_factory):
    event_id = _seed_event(db_factory)
    body = _base_body(event_id=event_id)

    first = client.post("/api/auth/signup", json=body)
    assert first.status_code == 201

    # 같은 토큰으로 다른 이메일 가입을 시도해도(재사용) 일회성 소진 규약에 걸려 거부된다.
    n = next(_seq)
    reused_body = {
        "email": f"another-{n}@example.com",
        "password": "abcd1234",
        "name": "홍길동",
        "org_name_ko": f"테스트기업{n}",
        "role": "buyer",
        "event_id": event_id,
        "email_verification_token": body["email_verification_token"],
    }
    resp = client.post("/api/auth/signup", json=reused_body)
    assert resp.status_code == 403


def test_signup_weak_password_422(client, db_factory):
    event_id = _seed_event(db_factory)

    too_short = client.post("/api/auth/signup", json=_base_body(event_id=event_id, password="ab1"))
    assert too_short.status_code == 422

    letters_only = client.post("/api/auth/signup", json=_base_body(event_id=event_id, password="abcdefgh"))
    assert letters_only.status_code == 422

    digits_only = client.post("/api/auth/signup", json=_base_body(event_id=event_id, password="12345678"))
    assert digits_only.status_code == 422


@pytest.mark.parametrize("bad_role", ["organizer", "admin", "master", "sub", "operator", ""])
def test_signup_non_buyer_exhibitor_role_rejected_422(client, db_factory, bad_role):
    event_id = _seed_event(db_factory)
    resp = client.post("/api/auth/signup", json=_base_body(event_id=event_id, role=bad_role))
    assert resp.status_code == 422  # role Literal["buyer","exhibitor"] 밖 — organizer/admin 계열 원천 차단


def test_signup_unknown_event_id_404(client, db_factory):
    resp = client.post(
        "/api/auth/signup",
        json=_base_body(event_id="00000000-0000-0000-0000-000000000000"),
    )
    assert resp.status_code == 404
