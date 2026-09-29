"""접힌 로그인 트랜잭션 HTTP 계약 테스트(F-AU-001 #23 slice A, ADR-0011).

FastAPI TestClient + dependency_overrides로 데모 시드 포트(스텁 verifier / 인메모리
directory·pool·consent_gate·ticket)를 꽂는다 — **DB 없이** 외부 관찰 가능한 두 단계
(start/complete)의 결과만 본다.

start와 complete는 login_ticket·Cognito 계정 상태를 공유해야 하므로, 한 테스트 안에서
동일 인스턴스를 override로 주입한다(프로세스 싱글톤을 격리 더블로 대체).
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.auth.consent_gate import InMemoryConsentGate
from app.auth.dx_korea_verify import StubDxKoreaVerifier
from app.auth.login_router import (
    _DEMO_CONSENT_DOCUMENTS,
    _DEMO_CREDENTIALS,
    _DEMO_REGISTRANTS,
    _DEMO_RETURNING_MEMBER_IDS,
    get_consent_gate,
    get_cognito_pool,
    get_directory,
    get_ticket_service,
    get_verifier,
)
from app.auth.login_ticket import LoginTicketService
from app.auth.registrant_mapping import InMemoryRegistrantDirectory
from app.auth.session_issue import InMemoryCognitoUserPool
from app.db import get_session
from app.main import app


class _NullDbSession:
    """login_start의 신규 ``db: Session = Depends(get_session)``(실 운영자 승격 판정,
    ``_is_registered_operator``)를 이 파일의 "DB 없이"라는 모듈 계약을 깨지 않고 만족시키는
    최소 더블. ``_is_registered_operator``는 ``db.execute(...).scalar_one_or_none()`` 형태만
    쓰므로 이 두 메서드만 흉내내면 된다 — 이 파일의 시나리오는 전부 인메모리 데모 시드라 실제
    organizers 테이블에 있을 수 없으므로 None(=운영자 아님)이 정답이다. 실 DB로 태우는 조인
    검증은 ``tests/test_local_login_integration.py``가 담당한다.
    """

    def execute(self, *_args, **_kwargs):
        return self

    def scalar_one_or_none(self):
        return None


@pytest.fixture
def client() -> TestClient:
    """데모 시드 포트를 격리 더블로 꽂은 TestClient. 한 클라이언트의 start/complete는 상태를 공유한다."""
    pool = InMemoryCognitoUserPool()
    for member_id in _DEMO_RETURNING_MEMBER_IDS:
        pool.get_or_create_account(member_id)  # 재방문 회원 미리 발급

    # 상태를 공유해야 하는 포트(pool·gate·ticket)는 단일 인스턴스를 매 요청에 돌려준다 —
    # 그래야 start가 발급한 티켓을 같은 클라이언트의 complete가 검증·소진할 수 있다.
    gate = InMemoryConsentGate(_DEMO_CONSENT_DOCUMENTS)
    ticket_service = LoginTicketService()

    overrides = {
        get_verifier: lambda: StubDxKoreaVerifier(credentials=_DEMO_CREDENTIALS),
        get_directory: lambda: InMemoryRegistrantDirectory(_DEMO_REGISTRANTS),
        get_cognito_pool: lambda: pool,
        get_consent_gate: lambda: gate,
        get_ticket_service: lambda: ticket_service,
        get_session: lambda: _NullDbSession(),
    }
    app.dependency_overrides.update(overrides)
    try:
        yield TestClient(app)
    finally:
        for dep in overrides:
            app.dependency_overrides.pop(dep, None)


# --- start ------------------------------------------------------------------
def test_start_returning_member_fast_path_succeeds(client: TestClient):
    res = client.post(
        "/api/auth/login/start",
        json={"username": "buyer-old", "password": "demo1234", "deeplink_token": None},
    )
    assert res.status_code == 200
    body = res.json()
    assert body["outcome"] == "succeeded"
    assert body["role"] == "buyer"
    assert body["gate"] == {"application_status": "submitted", "has_profile": True}
    assert body["route"] == "/home"
    assert body["roles"] == ["buyer"]
    # 세션 토큰 노출 — FE BFF가 httpOnly 쿠키로 보관해 후속 인증 요청에 쓴다(어드민 가드 등).
    assert body["access_token"].startswith("access-mbr-buyer-02-")


def test_start_returning_exhibitor_fast_path_succeeds(client: TestClient):
    # exhibitor-old(mbr-exh-02) — 참가사도 buyer-old와 같은 재방문 패턴(약관 스킵)을 탄다.
    res = client.post(
        "/api/auth/login/start",
        json={"username": "exhibitor-old", "password": "demo1234", "deeplink_token": None},
    )
    assert res.status_code == 200
    body = res.json()
    assert body["outcome"] == "succeeded"
    assert body["role"] == "exhibitor"
    assert body["gate"] == {"application_status": "submitted", "has_profile": True}
    assert body["route"] == "/home"
    assert body["roles"] == ["exhibitor"]
    assert body["access_token"].startswith("access-mbr-exh-02-")


def test_start_first_time_member_requires_consent(client: TestClient):
    res = client.post(
        "/api/auth/login/start",
        json={"username": "buyer", "password": "demo1234"},
    )
    assert res.status_code == 200
    body = res.json()
    assert body["outcome"] == "consent_required"
    assert isinstance(body["login_ticket"], str) and body["login_ticket"]
    ids = [d["id"] for d in body["documents"]]
    assert ids == ["tos", "privacy", "sensitive", "marketing"]
    required = {d["id"] for d in body["documents"] if d["required"]}
    assert required == {"tos", "privacy", "sensitive"}


def test_start_demo_operator_routes_to_organizer(client: TestClient):
    # 데모 전용 운영사 경로 — roster 매핑 없이 약관 없이 곧장 /organizer로 분기(D5 흉내).
    res = client.post(
        "/api/auth/login/start",
        json={"username": "organizer", "password": "demo1234"},
    )
    assert res.status_code == 200
    body = res.json()
    assert body["outcome"] == "succeeded"
    assert body["role"] == "organizer"
    assert body["route"] == "/organizer"
    assert body["roles"] == ["operator"]
    # 운영자 세션 토큰 — 어드민 콘솔 실연동의 인증 재료(데모 디렉터리가 이 회원ID를 master로 인식).
    assert body["access_token"].startswith("access-mbr-org-01-")


def test_start_demo_sub_operator_routes_to_organizer(client: TestClient):
    # 데모 sub(무역관) 계정도 operator 경로로 /organizer 랜딩(권한등급 master/sub는 API 가드가 가름).
    res = client.post(
        "/api/auth/login/start",
        json={"username": "trade-office", "password": "demo1234"},
    )
    assert res.status_code == 200
    body = res.json()
    assert body["outcome"] == "succeeded"
    assert body["role"] == "organizer"
    assert body["route"] == "/organizer"
    assert body["roles"] == ["operator"]


def test_verifier_chain_gated_by_auth_backend(monkeypatch):
    # 데모 자격증명 시드는 AUTH_BACKEND=demo에서만 체인에 들어온다 — prod(cognito)에선 여전히
    # fail-closed라 데모 cred·운영자 승격이 동작하지 않는다(codex P1 계승). 로컬 자체가입 검증
    # (LocalCredentialVerifier)은 데모 스텁이 아닌 실 경로라 auth_backend 무관하게 항상 켜져 있다
    # (자체 회원가입 §7.3, ADR-0007 supersede). 테스트는 override를 안 거치고 팩토리를 직접
    # 검증하며, verify()는 호출하지 않으므로 DB 세션 없이(None) 인스턴스 타입만 본다.
    from app.auth.local_verify import ChainedVerifier, LocalCredentialVerifier
    from app.auth.login_router import get_verifier
    from app.config import settings

    monkeypatch.setattr(settings, "auth_backend", "cognito")
    cognito_verifier = get_verifier(db=None)
    assert isinstance(cognito_verifier, LocalCredentialVerifier)  # 데모 스텁 폴백 없음(fail-closed)

    monkeypatch.setattr(settings, "auth_backend", "demo")
    demo_verifier = get_verifier(db=None)
    assert isinstance(demo_verifier, ChainedVerifier)
    assert isinstance(demo_verifier._verifiers[0], LocalCredentialVerifier)
    assert isinstance(demo_verifier._verifiers[1], StubDxKoreaVerifier)


def test_start_bad_password_is_rejected(client: TestClient):
    res = client.post(
        "/api/auth/login/start",
        json={"username": "buyer", "password": "wrong-pw"},
    )
    assert res.status_code == 200
    assert res.json() == {"outcome": "rejected", "reason": "invalid_credentials"}


def test_start_ghost_member_not_found(client: TestClient):
    res = client.post(
        "/api/auth/login/start",
        json={"username": "ghost", "password": "demo1234"},
    )
    assert res.status_code == 200
    assert res.json() == {"outcome": "not_found"}


# --- complete ---------------------------------------------------------------
def _start_first_time(client: TestClient, username: str = "buyer") -> str:
    res = client.post(
        "/api/auth/login/start", json={"username": username, "password": "demo1234"}
    )
    body = res.json()
    assert body["outcome"] == "consent_required"
    return body["login_ticket"]


def test_complete_with_all_required_succeeds(client: TestClient):
    ticket = _start_first_time(client)
    res = client.post(
        "/api/auth/login/complete",
        json={"login_ticket": ticket, "accepted_doc_ids": ["tos", "privacy", "sensitive"]},
    )
    assert res.status_code == 200
    body = res.json()
    assert body["outcome"] == "succeeded"
    assert body["role"] == "buyer"
    assert body["gate"] == {"application_status": "registered", "has_profile": False}
    assert body["route"] == "/home"
    assert body["roles"] == ["buyer"]
    # 최초 진입자도 동의 완료 후 세션 토큰을 받는다(재방문자와 동일 계약).
    assert body["access_token"].startswith("access-mbr-buyer-01-")


def test_complete_missing_required_is_incomplete(client: TestClient):
    ticket = _start_first_time(client)
    res = client.post(
        "/api/auth/login/complete",
        json={"login_ticket": ticket, "accepted_doc_ids": ["tos"]},
    )
    assert res.status_code == 200
    body = res.json()
    assert body["outcome"] == "consent_incomplete"
    assert body["missing_required"] == ["privacy", "sensitive"]


def test_complete_forged_ticket_is_invalid(client: TestClient):
    res = client.post(
        "/api/auth/login/complete",
        json={"login_ticket": "not-a-real-ticket", "accepted_doc_ids": ["tos", "privacy", "sensitive"]},
    )
    assert res.status_code == 200
    assert res.json() == {"outcome": "ticket_invalid", "reason": "forged"}


def test_complete_is_single_use(client: TestClient):
    ticket = _start_first_time(client)
    first = client.post(
        "/api/auth/login/complete",
        json={"login_ticket": ticket, "accepted_doc_ids": ["tos", "privacy", "sensitive"]},
    )
    assert first.json()["outcome"] == "succeeded"

    # 같은 티켓 재사용 — 일회성이라 두 번째는 consumed로 거부된다.
    second = client.post(
        "/api/auth/login/complete",
        json={"login_ticket": ticket, "accepted_doc_ids": ["tos", "privacy", "sensitive"]},
    )
    assert second.status_code == 200
    assert second.json() == {"outcome": "ticket_invalid", "reason": "consumed"}


# --- 세션 토큰 소스(실 Cognito 배선, 배포차단 회귀) ----------------------------
def test_session_token_is_id_token_in_cognito_and_access_token_in_demo(monkeypatch):
    """[배포차단 회귀] ``principal.get_current_principal``은 세션 토큰을 ``token_use="id"``로
    검증한다. cognito 모드가 access 토큰을 세션으로 내보내면 참가자 라우트 전원이 401난다 — 그래서
    cognito는 ID 토큰을, demo는 기존 access 토큰(FE·데모 토큰 정규식 무회귀)을 낸다.
    """
    from app.auth.login_router import _session_token
    from app.auth.session_issue import CognitoAccount, SessionResult, SessionTokens
    from app.config import settings

    session = SessionResult(
        account=CognitoAccount(cognito_sub="sub-1", member_id="mbr-1"),
        tokens=SessionTokens(id_token="id-tok", access_token="access-tok", refresh_token="refresh-tok"),
        is_new_account=False,
    )

    monkeypatch.setattr(settings, "auth_backend", "demo")
    assert _session_token(session) == "access-tok"

    monkeypatch.setattr(settings, "auth_backend", "cognito")
    assert _session_token(session) == "id-tok"


def test_get_cognito_pool_branches_by_auth_backend(monkeypatch):
    """demo=기존 인메모리 데모 시드, cognito=실 AwsCognitoUserPool(미구성이면 fail-closed)."""
    from app.auth.cognito_pool import AwsCognitoUserPool
    from app.auth.login_router import _cognito_pool, _prod_cognito_pool, get_cognito_pool
    from app.config import settings

    monkeypatch.setattr(settings, "auth_backend", "demo")
    assert get_cognito_pool() is _cognito_pool

    monkeypatch.setattr(settings, "auth_backend", "cognito")
    monkeypatch.setattr(settings, "cognito_user_pool_id", None)
    _prod_cognito_pool.cache_clear()
    try:
        with pytest.raises(RuntimeError):
            get_cognito_pool()

        monkeypatch.setattr(settings, "cognito_user_pool_id", "ap-northeast-2_test")
        monkeypatch.setattr(settings, "cognito_client_id", "client-test")
        monkeypatch.setattr(settings, "cognito_session_password_secret", "secret-test")
        _prod_cognito_pool.cache_clear()
        pool = get_cognito_pool()
        assert isinstance(pool, AwsCognitoUserPool)
    finally:
        _prod_cognito_pool.cache_clear()  # 다른 테스트로 캐시가 새지 않게 정리
