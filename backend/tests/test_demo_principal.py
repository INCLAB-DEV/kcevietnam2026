"""데모 신원 해석 테스트 (``AUTH_BACKEND=demo``의 ``get_current_principal`` 분기).

데모 로그인이 내는 토큰(``access-{subject}-{seq}``)의 subject는 두 갈래다:

- **UUID** — 자체 회원가입(§7.3)으로 만들어진 ``members.id``
- **비-UUID**(``mbr-buyer-01`` 등) — 명단 적재층의 ``registrants.organizer_member_id``

⚠ 가장 중요한 회귀 지점은 **UUID 여부를 조회 전에 판별한다**는 것이다. ``members.id``는 uuid
컬럼이라 비-UUID 문자열을 그대로 비교에 넣으면 Postgres가 22P02로 트랜잭션을 깨고 **500**이 난다.
"없는 회원이라 401"이 되어야 할 자리에서 서버 에러가 나는 건 다른 종류의 실패다.

또 하나: 데모 모드는 **실 JWT 경로를 대체하지 않고 앞에 놓인다**. 데모 형식이 아닌 토큰은 그대로
Cognito 검증으로 흘러가야 한다 — 그래야 AUTH_BACKEND=demo인 로컬/CI에서도 RS256 계약 테스트가
그대로 돈다(`test_bm_profile_api.py`의 auth 섹션).
"""

from __future__ import annotations

import itertools
import uuid

import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.auth.principal import Principal, get_current_principal, get_jwks_provider
from app.config import settings
from app.db import get_session
from app.models import Event, Member, Organization, Registrant

_seq = itertools.count(1)


@pytest.fixture()
def db_factory(migrated_db: str):
    engine = create_engine(migrated_db, future=True)
    TestSession = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)
    yield TestSession
    engine.dispose()


@pytest.fixture()
def client(db_factory, monkeypatch):
    """principal만 노출하는 최소 앱 — 실제 라우터의 도메인 규칙에 가리지 않고 신원 해석만 본다."""
    monkeypatch.setattr(settings, "auth_backend", "demo")

    probe = FastAPI()

    def _override_session():
        db = db_factory()
        try:
            yield db
        finally:
            db.close()

    probe.dependency_overrides[get_session] = _override_session

    @probe.get("/whoami")
    def whoami(principal: Principal = Depends(get_current_principal)) -> dict:
        return {"member_id": principal.member_id, "organization_id": principal.organization_id}

    return TestClient(probe, raise_server_exceptions=False)


def _seed_registrant_member(db_factory, member_id: str) -> str:
    """명단 적재 경로 — organizer_member_id로 org를 찾는 비-UUID subject."""
    n = next(_seq)
    db = db_factory()
    try:
        event = Event(name="DX Korea 2026", slug=f"demo-principal-{n}-{uuid.uuid4().hex[:8]}")
        org = Organization(name_ko="명단기업")
        db.add_all([event, org])
        db.flush()
        db.add(
            Registrant(
                event_id=event.id,
                organizer_member_id=member_id,
                organization_id=org.id,
                raw={"source": "test"},
            )
        )
        db.commit()
        return str(org.id)
    finally:
        db.close()


def _seed_self_signup_member(db_factory) -> tuple[str, str]:
    """자체 가입 경로 — members.id(UUID)가 곧 subject."""
    n = next(_seq)
    db = db_factory()
    try:
        org = Organization(name_ko="가입기업")
        db.add(org)
        db.flush()
        member = Member(organization_id=org.id, name="담당", email=f"self{n}@example.com")
        db.add(member)
        db.commit()
        return str(member.id), str(org.id)
    finally:
        db.close()


def _get(client, token: str | None):
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    return client.get("/whoami", headers=headers)


# =============================================================================
# 두 갈래 subject 해석
# =============================================================================
def test_uuid_subject_resolves_via_members(client, db_factory):
    member_id, org_id = _seed_self_signup_member(db_factory)
    r = _get(client, f"access-{member_id}-1")

    assert r.status_code == 200
    assert r.json() == {"member_id": member_id, "organization_id": org_id}


def test_non_uuid_subject_resolves_via_registrants(client, db_factory):
    org_id = _seed_registrant_member(db_factory, "mbr-buyer-01")
    r = _get(client, "access-mbr-buyer-01-1")

    assert r.status_code == 200
    assert r.json() == {"member_id": "mbr-buyer-01", "organization_id": org_id}


def test_id_token_prefix_is_also_accepted(client, db_factory):
    """데모 유저풀은 access/id 두 접두사를 낸다 — 둘 다 같은 subject로 읽힌다."""
    org_id = _seed_registrant_member(db_factory, "mbr-exh-01")
    r = _get(client, "id-mbr-exh-01-7")

    assert r.status_code == 200
    assert r.json()["organization_id"] == org_id


def test_non_uuid_subject_does_not_crash_on_uuid_column(client, db_factory):
    """⚠ 핵심 회귀 — 비-UUID를 members.id 비교에 넣으면 Postgres 22P02로 **500**이 난다.

    "명단에 없는 회원"은 401이어야지 서버 에러여선 안 된다.
    """
    r = _get(client, "access-mbr-nowhere-9")

    assert r.status_code == 401
    assert r.status_code != 500


def test_unknown_uuid_subject_is_401(client, db_factory):
    r = _get(client, f"access-{uuid.uuid4()}-1")
    assert r.status_code == 401


def test_registrant_without_organization_is_401(client, db_factory):
    """명단에 있어도 기업 매핑 전이면 자원 접근의 닻이 없다 — 조용히 통과시키지 않는다."""
    n = next(_seq)
    db = db_factory()
    try:
        event = Event(name="DX Korea 2026", slug=f"demo-orphan-{n}-{uuid.uuid4().hex[:8]}")
        db.add(event)
        db.flush()
        db.add(
            Registrant(
                event_id=event.id,
                organizer_member_id="mbr-orphan-01",
                organization_id=None,
                raw={"source": "test"},
            )
        )
        db.commit()
    finally:
        db.close()

    assert _get(client, "access-mbr-orphan-01-1").status_code == 401


def test_latest_registrant_wins_across_events(client, db_factory):
    """같은 회원이 여러 행사 명단에 있으면 최신 적재분을 쓴다(결정적 선택)."""
    member_id = f"mbr-multi-{next(_seq)}"
    first_org = _seed_registrant_member(db_factory, member_id)
    second_org = _seed_registrant_member(db_factory, member_id)
    assert first_org != second_org

    r = _get(client, f"access-{member_id}-1")
    assert r.status_code == 200
    assert r.json()["organization_id"] == second_org


# =============================================================================
# 토큰 형식 / 폴백
# =============================================================================
@pytest.mark.parametrize(
    "token",
    [
        "garbage",
        "access-mbr-buyer-01",  # seq 없음
        "mbr-buyer-01-1",  # 접두사 없음
        "refresh-mbr-buyer-01-1",  # access/id가 아님
    ],
)
def test_non_demo_token_falls_through_to_cognito_and_closes(client, db_factory, token):
    """데모 형식이 아니면 실 JWT 경로로 넘어가고, 미구성이면 거기서 401로 닫힌다(조용한 통과 없음)."""
    _seed_registrant_member(db_factory, "mbr-buyer-01")
    assert _get(client, token).status_code == 401


def test_missing_authorization_header_is_401(client, db_factory):
    assert _get(client, None).status_code == 401


def test_demo_mode_does_not_break_jwks_dependency(monkeypatch):
    """데모 모드에서 JWKS 미설정은 정상 상태다 — provider 생성 자체가 네트워크를 타지 않으므로
    의존성 단계에서 요청이 끊기지 않는다(예전 get_jwks()가 미구성 시 즉시 401을 던져 데모 분기에
    도달 못 하던 문제가 구조적으로 사라졌다). issuer/오버라이드 둘 다 없으면 빈 키셋 — 실 JWT
    검증은 여전히 실패시킨다(조용한 통과 아님).
    """
    monkeypatch.setattr(settings, "auth_backend", "demo")
    monkeypatch.setattr(settings, "cognito_jwks_json", None)
    monkeypatch.setattr(settings, "cognito_issuer", None)
    get_jwks_provider.cache_clear()
    try:
        assert get_jwks_provider().keys() == {"keys": []}
    finally:
        get_jwks_provider.cache_clear()  # 다른 테스트로 캐시가 새지 않게 정리


def test_cognito_mode_keeps_failing_closed(monkeypatch):
    """기본(cognito)에서 이슈어 미설정이면 provider가 빈 키셋을 낸다 — 실제 401 거부는
    ``get_current_principal``의 issuer/client_id 명시 체크가 담당한다(아래
    ``test_cognito_mode_ignores_demo_tokens``가 그 경로를 통합 검증). provider 자체가 여기서
    죽지 않아야 데모/미구성 어느 쪽에서도 의존성 단계에서 요청이 끊기지 않는다.
    """
    monkeypatch.setattr(settings, "auth_backend", "cognito")
    monkeypatch.setattr(settings, "cognito_jwks_json", None)
    monkeypatch.setattr(settings, "cognito_issuer", None)
    get_jwks_provider.cache_clear()
    try:
        assert get_jwks_provider().keys() == {"keys": []}
    finally:
        get_jwks_provider.cache_clear()


def test_cognito_mode_ignores_demo_tokens(db_factory, monkeypatch):
    """AUTH_BACKEND=cognito면 데모 토큰이 아예 해석되지 않는다(서명 없는 신원 차단)."""
    org_id = _seed_registrant_member(db_factory, "mbr-buyer-02")
    assert org_id

    monkeypatch.setattr(settings, "auth_backend", "cognito")
    monkeypatch.setattr(settings, "cognito_jwks_json", None)

    probe = FastAPI()

    def _override_session():
        db = db_factory()
        try:
            yield db
        finally:
            db.close()

    probe.dependency_overrides[get_session] = _override_session

    @probe.get("/whoami")
    def whoami(principal: Principal = Depends(get_current_principal)) -> dict:
        return {"organization_id": principal.organization_id}

    tc = TestClient(probe, raise_server_exceptions=False)
    r = tc.get("/whoami", headers={"Authorization": "Bearer access-mbr-buyer-02-1"})
    assert r.status_code == 401
