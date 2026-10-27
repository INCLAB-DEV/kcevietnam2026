"""로컬(자체가입) 로그인 통합 테스트 — POST /api/auth/login/start의 **실 배선**(override 없이).

``tests/test_login_transaction.py``는 검증자·디렉터리·풀·게이트를 전부 ``dependency_overrides``로
격리 더블로 갈아끼운다(DB 없이 빠르게). 이 파일은 반대로 그 배선을 그대로 두고(``get_session``만
테스트 DB로 override) 실제 체인(``LocalCredentialVerifier``/``LocalRegistrantDirectory`` → 데모
스텁/명단)이 맞물려 도는지 확인한다 — Postgres 통합 DB(``migrated_db``, conftest.py), 미가용이면
전체 skip.

핵심 검증:
1. **회귀** — 기존 데모 계정(예: ``buyer-old``)이 AUTH_BACKEND=demo에서 실 배선으로도 그대로 로그인.
2. **신규** — 자체가입(POST /api/auth/signup)한 회원이 email+password로 로그인 성공(최초=약관 게이트),
   auth_backend가 cognito(기본, fail-closed)든 demo든 로컬 검증은 항상 동작.
3. **실패** — 틀린 비밀번호는 outcome=rejected.
"""

from __future__ import annotations

import itertools

import bcrypt
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.auth.signup_router import get_email_verify_ticket_service
from app.config import settings
from app.db import get_session
from app.main import app
from app.models import Event, EventOrganizer, Member, Organization, Organizer

_seq = itertools.count(1)


@pytest.fixture()
def db_factory(migrated_db: str):
    engine = create_engine(migrated_db, future=True)
    TestSession = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)
    yield TestSession
    engine.dispose()


@pytest.fixture()
def client(db_factory):
    """get_session만 테스트 DB로 override — 검증자/디렉터리/풀/게이트는 실 배선(login_router 그대로)."""

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


def _seed_event(db_factory) -> str:
    n = next(_seq)
    db = db_factory()
    try:
        ev = Event(name="로컬로그인테스트행사", slug=f"local-login-{n}")
        db.add(ev)
        db.commit()
        return str(ev.id)
    finally:
        db.close()


def _seed_local_member(db_factory, *, email: str, password: str = "opPass123") -> str:
    """회원가입 API를 거치지 않고 Organization+Member를 직접 심는다 — 운영자 승격 테스트는
    registrant/organization_event_roles와 무관하게 로컬 로그인 가능한 Member 하나만 있으면
    된다(organizer 연결은 별도로 ``_seed_operator``가 붙인다). 반환값은 ``members.id``(UUID
    문자열) — ``LocalCredentialVerifier``가 이 값을 그대로 ``member_id``로 돌려준다.
    """
    db = db_factory()
    try:
        org = Organization(name_ko="운영자테스트기업")
        db.add(org)
        db.flush()
        member = Member(
            organization_id=org.id,
            name="운영자테스트",
            email=email,
            password_hash=bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8"),
        )
        db.add(member)
        db.commit()
        return str(member.id)
    finally:
        db.close()


def _seed_operator(
    db_factory, *, member_id: str, event_id: str | None = None, permission_level: str = "master"
) -> None:
    """``organizers``(member_id로 연결) + ``event_organizers``(배정) 실 레코드를 심는다.

    ``event_id``가 None이면 organizers 행만 만들고 배정은 만들지 않는다 — "배정 없는 운영자는
    승격되지 않는다" 케이스 전용.
    """
    db = db_factory()
    try:
        organizer = Organizer(
            name="실운영자", email=f"operator-{member_id}@example.com", member_id=member_id
        )
        db.add(organizer)
        db.flush()
        if event_id is not None:
            db.add(
                EventOrganizer(
                    event_id=event_id, organizer_id=organizer.id, permission_level=permission_level
                )
            )
        db.commit()
    finally:
        db.close()


def _use_fake_cognito_pool_for_cognito_mode(auth_backend: str) -> None:
    """cognito 모드에서 ``get_cognito_pool``을 FakeCognitoIdp 기반 실 어댑터로 override한다.

    실 배선을 그대로 쓴다는 이 파일의 취지(모듈 docstring)는 유지하되, ``get_cognito_pool``이
    이제 cognito 모드에서 ``_prod_cognito_pool()``(실 AWS)로 분기해 로컬(AWS 자격증명 없음)에선
    fail-closed로 500이 난다 — 이 1단계는 로컬 구현까지만이라 실 AWS를 붙이지 않는다. 그래서
    cognito 모드 테스트만 최소로 override해 **실 ``AwsCognitoUserPool`` 코드 경로**를
    ``FakeCognitoIdp``로 태운다(예전엔 우연히 데모 풀로 새던 것보다 오히려 더 실 경로에 가깝다).
    demo 모드 테스트(기존 데모 계정 회귀)는 이 함수를 부르지 않아 실 데모 시드(``_cognito_pool``)
    그대로 돈다 — ``client`` 픽스처가 테스트 종료 시 override를 정리한다.
    """
    if auth_backend != "cognito":
        return

    from cryptography.hazmat.primitives.asymmetric import rsa

    from app.auth.cognito_pool import AwsCognitoUserPool
    from app.auth.login_router import get_cognito_pool
    from tests.fake_cognito_idp import FakeCognitoIdp

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    fake = FakeCognitoIdp(
        issuer="https://cognito-idp.ap-northeast-2.amazonaws.com/pool-it-local",
        client_id="client-it-local",
        signing_key=key,
    )
    pool = AwsCognitoUserPool(
        user_pool_id="pool-it-local",
        app_client_id="client-it-local",
        region="ap-northeast-2",
        password_secret="it-local-secret",
        client=fake,
    )
    app.dependency_overrides[get_cognito_pool] = lambda: pool


def _signup(client, db_factory, *, role="buyer", password="abcd1234") -> dict:
    n = next(_seq)
    event_id = _seed_event(db_factory)
    email = f"local-login-{n}@example.com"
    # #9 — 이메일 인증코드 확인을 거쳐야 발급되는 토큰. HTTP 왕복 없이 signup_router가 실제로
    # 쓰는 프로세스 싱글턴에서 직접 발급받는다(tests/test_signup_api.py와 동일 관례).
    token = get_email_verify_ticket_service().issue({"email": email})
    body = {
        "email": email,
        "password": password,
        "name": "로컬가입자",
        "org_name_ko": f"로컬기업{n}",
        "role": role,
        "event_id": event_id,
        "email_verification_token": token,
    }
    resp = client.post("/api/auth/signup", json=body)
    assert resp.status_code == 201, resp.text
    return body


# =============================================================================
# 회귀 — 기존 데모 계정, 실 배선(override 없이)
# =============================================================================
def test_existing_demo_account_still_logs_in_through_real_wiring(client, monkeypatch):
    monkeypatch.setattr(settings, "auth_backend", "demo")
    resp = client.post(
        "/api/auth/login/start",
        json={"username": "buyer-old", "password": "demo1234"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["outcome"] == "succeeded"
    assert body["role"] == "buyer"
    assert body["route"] == "/home"


def test_demo_account_rejected_with_bad_password_through_real_wiring(client, monkeypatch):
    monkeypatch.setattr(settings, "auth_backend", "demo")
    resp = client.post(
        "/api/auth/login/start",
        json={"username": "buyer-old", "password": "wrong"},
    )
    assert resp.status_code == 200
    assert resp.json() == {"outcome": "rejected", "reason": "invalid_credentials"}


# =============================================================================
# 신규 — 자체가입 회원 로컬 로그인(auth_backend 무관하게 동작 — 데모 스텁이 아닌 실 경로)
# =============================================================================
@pytest.mark.parametrize("auth_backend", ["cognito", "demo"])
def test_local_signup_member_logs_in_first_time_requires_consent(client, db_factory, monkeypatch, auth_backend):
    monkeypatch.setattr(settings, "auth_backend", auth_backend)
    _use_fake_cognito_pool_for_cognito_mode(auth_backend)
    signup_body = _signup(client, db_factory, role="exhibitor")

    resp = client.post(
        "/api/auth/login/start",
        json={"username": signup_body["email"], "password": signup_body["password"]},
    )
    assert resp.status_code == 200
    body = resp.json()
    # Cognito 풀에 이 회원(신규 UUID)의 계정이 없어 최초 진입으로 분기 — 약관을 요구한다.
    assert body["outcome"] == "consent_required"
    assert isinstance(body["login_ticket"], str) and body["login_ticket"]


@pytest.mark.parametrize("auth_backend", ["cognito", "demo"])
def test_local_signup_member_wrong_password_rejected(client, db_factory, monkeypatch, auth_backend):
    monkeypatch.setattr(settings, "auth_backend", auth_backend)
    _use_fake_cognito_pool_for_cognito_mode(auth_backend)
    signup_body = _signup(client, db_factory)

    resp = client.post(
        "/api/auth/login/start",
        json={"username": signup_body["email"], "password": "totally-wrong-1"},
    )
    assert resp.status_code == 200
    assert resp.json() == {"outcome": "rejected", "reason": "invalid_credentials"}


def test_local_signup_member_completes_login_and_role_matches_signup(client, db_factory, monkeypatch):
    monkeypatch.setattr(settings, "auth_backend", "cognito")  # prod 기본값에서도 로컬 로그인 완주
    _use_fake_cognito_pool_for_cognito_mode("cognito")
    signup_body = _signup(client, db_factory, role="buyer")

    start = client.post(
        "/api/auth/login/start",
        json={"username": signup_body["email"], "password": signup_body["password"]},
    )
    assert start.status_code == 200
    ticket = start.json()["login_ticket"]

    complete = client.post(
        "/api/auth/login/complete",
        json={"login_ticket": ticket, "accepted_doc_ids": ["tos", "privacy", "sensitive"]},
    )
    assert complete.status_code == 200
    body = complete.json()
    assert body["outcome"] == "succeeded"
    assert body["role"] == "buyer"
    assert body["route"] == "/home"
    assert body["gate"] == {"application_status": "registered", "has_profile": False}


# =============================================================================
# 실 운영자 승격(``login_router._is_registered_operator``) — cognito(prod)에서도 도달 가능해야
# 하는 신규 분기. 데모 ID 집합과 무관하게 organizers+event_organizers 실 레코드로만 판정한다.
# =============================================================================
@pytest.mark.parametrize("auth_backend", ["cognito", "demo"])
def test_real_operator_with_event_assignment_routes_to_organizer(
    client, db_factory, monkeypatch, auth_backend
):
    """organizers(member_id=X)+event_organizers(master) 실 레코드를 가진 회원은 데모 ID가
    아니어도 role=organizer로 라우팅되고(roster·consent 건너뜀) 세션이 발급된다 — cognito
    모드에서도(이번 변경 전엔 도달 불가였던 경로)."""
    monkeypatch.setattr(settings, "auth_backend", auth_backend)
    _use_fake_cognito_pool_for_cognito_mode(auth_backend)
    n = next(_seq)
    email = f"real-operator-{n}@example.com"
    password = "opPass123"
    member_id = _seed_local_member(db_factory, email=email, password=password)
    event_id = _seed_event(db_factory)
    _seed_operator(db_factory, member_id=member_id, event_id=event_id, permission_level="master")

    resp = client.post("/api/auth/login/start", json={"username": email, "password": password})
    assert resp.status_code == 200
    body = resp.json()
    assert body["outcome"] == "succeeded"
    assert body["role"] == "organizer"
    assert body["route"] == "/organizer"
    assert body["roles"] == ["operator"]
    assert isinstance(body["access_token"], str) and body["access_token"]


def test_operator_without_event_assignment_is_not_promoted(client, db_factory, monkeypatch):
    """organizers 행은 있지만 event_organizers 배정이 하나도 없으면(콘솔이 빌 운영자) 운영자로
    승격되지 않는다 — registrant/organization_event_roles도 없는 회원이라 참가자 매핑도 실패해
    not_found로 떨어진다."""
    monkeypatch.setattr(settings, "auth_backend", "cognito")
    _use_fake_cognito_pool_for_cognito_mode("cognito")
    n = next(_seq)
    email = f"unassigned-operator-{n}@example.com"
    password = "opPass123"
    member_id = _seed_local_member(db_factory, email=email, password=password)
    _seed_operator(db_factory, member_id=member_id, event_id=None)  # 배정 없음

    resp = client.post("/api/auth/login/start", json={"username": email, "password": password})
    assert resp.status_code == 200
    assert resp.json() == {"outcome": "not_found"}


def test_ordinary_participant_is_not_promoted_to_operator(client, db_factory, monkeypatch):
    """organizers 레코드가 전혀 없는 일반 자체가입 회원은 여전히 참가자 매핑을 그대로 탄다 —
    실 운영자 판정 추가가 기존 참가자 로그인 경로를 건드리지 않는다는 회귀 확인."""
    monkeypatch.setattr(settings, "auth_backend", "cognito")
    _use_fake_cognito_pool_for_cognito_mode("cognito")
    signup_body = _signup(client, db_factory, role="buyer")

    resp = client.post(
        "/api/auth/login/start",
        json={"username": signup_body["email"], "password": signup_body["password"]},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["outcome"] == "consent_required"  # organizer로 새지 않고 기존 최초-진입 흐름 그대로
    assert "role" not in body
