"""BM 프로필 API 통합 테스트 — 실제 등록폼 필드 + 승인 게이트(F-BM-001/002, #26).

검증(이슈 Acceptance criteria, 갱신):
- 단계별 부분 저장 — N단계까지 저장 후 보존, 한 단계 PATCH 시 그 단계 필드만 변경.
- 소유권 — 타 Organization 403, 무효/누락 토큰 401(실 Cognito JWT 검증 경로).
- 원자적 제출 — 프로필 최종 저장 + submitted 전환 함께 커밋, 하나라도 실패하면 둘 다 롤백.
- 멱등 — 제출/수정해도 상태 비강등(approved 유지). **매칭 노출은 approved만**(D5).

기능 테스트는 ``get_current_principal``을 override해 프로필 동작에 집중하고, 인증 계약(401/403)은
별도로 실 JWT 검증 경로(RS256 + JWKS)로 닫는다.
"""

from __future__ import annotations

import itertools
import uuid
from datetime import datetime, timedelta, timezone

import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.auth.jwks_cache import CognitoJwks
from app.auth.principal import Principal, get_current_principal, get_jwks_provider
from app.bm import service
from app.config import settings
from app.db import get_session
from app.main import app
from app.models import Event, Member, Organization, OrganizationEventRole

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


def _login_as(org_id: str, member_id: str = "00000000-0000-0000-0000-000000000001") -> None:
    app.dependency_overrides[get_current_principal] = lambda: Principal(
        member_id=member_id, organization_id=str(org_id)
    )


def _seed_role(
    db_factory, *, is_buyer=False, is_exhibitor=False, application_status="registered",
    org_name="테스트기업", event_id=None,
) -> dict:
    n = next(_seq)
    db = db_factory()
    try:
        if event_id is None:
            # slug는 events.slug UNIQUE — 세션 스코프 migrated_db를 공유하는 다른 테스트 파일(예:
            # test_admin_api.py)도 독립적으로 "dx-{n}"을 생성하므로, 파일 간 충돌을 피하려면 이
            # 파일만의 접두사(uuid 조각)로 네임스페이스를 분리해야 한다.
            ev = Event(name="DX Korea 2026", slug=f"bmprofile-{n}-{uuid.uuid4().hex[:8]}")
            db.add(ev)
            db.flush()
            event_id = ev.id
        org = Organization(name_ko=org_name)
        db.add(org)
        db.flush()
        role = OrganizationEventRole(
            organization_id=org.id, event_id=event_id, is_buyer=is_buyer,
            is_exhibitor=is_exhibitor, application_status=application_status,
        )
        db.add(role)
        db.commit()
        return {"event_id": str(event_id), "org_id": str(org.id), "role_id": str(role.id)}
    finally:
        db.close()


# =============================================================================
# AC1 — 단계별 부분 저장/조회(바이어)
# =============================================================================
def test_partial_save_preserves_earlier_steps(client, db_factory):
    info = _seed_role(db_factory, is_buyer=True)
    _login_as(info["org_id"])
    base = f"/api/bm/buyer/{info['role_id']}"

    assert client.patch(f"{base}/steps/1", json={"organization_name_ko": "한화시스템", "continent": "Asia", "annual_sales_range": "usd_1m_5m", "org_types": ["private_defense"]}).status_code == 200
    assert client.patch(f"{base}/steps/2", json={"interest_categories": ["game_production", "music_platform"], "company_intro_en": "Content systems."}).status_code == 200
    assert client.patch(f"{base}/steps/3", json={"attendees": [{"first_name": "길동", "last_name": "홍", "email": "hong@hanwha.com", "languages": ["ko", "en"]}]}).status_code == 200

    got = client.get(base).json()
    assert got["organization_name_ko"] == "한화시스템"
    assert got["continent"] == "Asia"
    assert got["annual_sales_range"] == "usd_1m_5m"
    assert got["org_types"] == ["private_defense"]
    assert sorted(got["interest_categories"]) == ["game_production", "music_platform"]
    assert got["company_intro_en"] == "Content systems."
    assert got["attendees"][0]["first_name"] == "길동"
    assert got["attendees"][0]["languages"] == ["ko", "en"]
    # 저장 안 한 4단계는 비어 있고, 제출 전이라 registered.
    assert got["participation_route"] is None
    assert got["recommended_buyers"] == []
    assert got["application_status"] == "registered"


def test_buyer_contact_and_budget_fields_round_trip(client, db_factory):
    """BM-001 실배선 신규 컬럼(신청자 식별·회사소개 국문·예산/도입시기) 저장·조회 라운드트립."""
    info = _seed_role(db_factory, is_buyer=True)
    _login_as(info["org_id"])
    base = f"/api/bm/buyer/{info['role_id']}"

    assert client.patch(f"{base}/steps/1", json={
        "contact_name_ko": "박제인", "contact_name_en": "Jane Park",
        "contact_title_ko": "이사", "contact_title_en": "Director",
        "contact_email": "jane@example.com", "contact_language": "vi",
        "contact_interpreter_need": True,
    }).status_code == 200
    assert client.patch(f"{base}/steps/2", json={
        "company_intro_ko": "국문 소개", "budget_range": "usd_1m_5m", "adoption_timeline": "2027_h1",
    }).status_code == 200

    got = client.get(base).json()
    assert got["contact_name_ko"] == "박제인"
    assert got["contact_name_en"] == "Jane Park"
    assert got["contact_title_ko"] == "이사"
    assert got["contact_title_en"] == "Director"
    assert got["contact_email"] == "jane@example.com"
    # contact_language는 backend Literal 검증 없이 자유문자열 — FE Lang(en/vi)의 "vi"가 그대로 통과해야 한다.
    assert got["contact_language"] == "vi"
    assert got["contact_interpreter_need"] is True
    assert got["company_intro_ko"] == "국문 소개"
    assert got["budget_range"] == "usd_1m_5m"
    assert got["adoption_timeline"] == "2027_h1"


def test_patch_one_step_changes_only_its_fields(client, db_factory):
    info = _seed_role(db_factory, is_buyer=True)
    _login_as(info["org_id"])
    base = f"/api/bm/buyer/{info['role_id']}"

    client.patch(f"{base}/steps/1", json={"organization_name_ko": "원래기업", "continent": "Asia"})
    client.patch(f"{base}/steps/2", json={"company_intro_en": "intro"})

    # step1에서 continent만 다시 PATCH → name_ko·step2는 그대로.
    client.patch(f"{base}/steps/1", json={"continent": "Europe"})

    got = client.get(base).json()
    assert got["continent"] == "Europe"
    assert got["organization_name_ko"] == "원래기업"  # 미제공 필드 불변
    assert got["company_intro_en"] == "intro"  # 다른 단계 불변


def test_unknown_or_wrong_step_field_rejected_422(client, db_factory):
    info = _seed_role(db_factory, is_buyer=True)
    _login_as(info["org_id"])
    base = f"/api/bm/buyer/{info['role_id']}"
    # step2 필드(company_intro_en)를 step1에 → extra=forbid 422.
    assert client.patch(f"{base}/steps/1", json={"company_intro_en": "오타"}).status_code == 422
    # 잘못된 enum 코드 → 422.
    assert client.patch(f"{base}/steps/1", json={"annual_sales_range": "bogus"}).status_code == 422
    assert client.patch(f"{base}/steps/1", json={"org_types": ["not_a_type"]}).status_code == 422


def test_invalid_step_number_404(client, db_factory):
    info = _seed_role(db_factory, is_buyer=True)
    _login_as(info["org_id"])
    assert client.patch(f"/api/bm/buyer/{info['role_id']}/steps/5", json={}).status_code == 404


# =============================================================================
# AC3 — 원자적 제출(submitted 전환 + 최종 저장)
# =============================================================================
def test_submit_promotes_to_submitted(client, db_factory):
    info = _seed_role(db_factory, is_buyer=True)
    _login_as(info["org_id"])
    base = f"/api/bm/buyer/{info['role_id']}"

    client.patch(f"{base}/steps/1", json={"contact_name_en": "Jane Park", "contact_email": "jane@example.com"})
    client.patch(f"{base}/steps/2", json={"company_intro_en": "intro"})
    resp = client.post(f"{base}/submit", json={"note": "최종 제출"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["application_status"] == "submitted"  # 제출=submitted(승인은 운영 별도, D5)
    assert body["note"] == "최종 제출"
    assert body["company_intro_en"] == "intro"

    db = db_factory()
    try:
        assert db.get(OrganizationEventRole, info["role_id"]).application_status == "submitted"
    finally:
        db.close()


def test_submit_is_atomic_both_rollback_on_failure(db_factory, monkeypatch):
    """전환이 실패하면 같은 트랜잭션의 최종 저장도 롤백된다(반쪽 제출 불가, D6)."""
    info = _seed_role(db_factory, is_buyer=True)
    db = db_factory()
    try:
        role = service.get_role(db, info["role_id"])
        service.patch_buyer_step(
            db, role, {"contact_name_en": "Jane Park", "contact_email": "jane@example.com"}
        )
        service.patch_buyer_step(db, role, {"company_intro_en": "원래"})  # 사전 커밋

        def _boom(_db, _role):
            raise RuntimeError("전환 실패 시뮬레이션")

        monkeypatch.setattr(service, "_promote_to_submitted", _boom)
        with pytest.raises(RuntimeError):
            service.submit_buyer(db, role, {"company_intro_en": "바뀐값"})
        db.rollback()
    finally:
        db.close()

    db2 = db_factory()
    try:
        role2 = service.get_role(db2, info["role_id"])
        prof = service.get_buyer_profile(db2, role2)
        assert role2.application_status == "registered"  # 전환 롤백
        assert prof.company_intro_en == "원래"  # 최종 저장도 롤백(둘이 함께)
    finally:
        db2.close()


# =============================================================================
# AC4 — 멱등(상태 비강등) + 매칭 노출(approved만)
# =============================================================================
def test_edit_after_submit_keeps_status_and_approved_not_downgraded(client, db_factory):
    info = _seed_role(db_factory, is_buyer=True)
    _login_as(info["org_id"])
    base = f"/api/bm/buyer/{info['role_id']}"

    client.patch(f"{base}/steps/1", json={"contact_name_en": "Jane Park", "contact_email": "jane@example.com"})
    client.post(f"{base}/submit", json=None)
    assert client.get(base).json()["application_status"] == "submitted"

    # 운영 승인(approved)을 모사 → 이후 수정/재제출이 approved를 되돌리지 않아야 한다.
    db = db_factory()
    try:
        role = db.get(OrganizationEventRole, info["role_id"])
        role.application_status = "approved"
        db.commit()
    finally:
        db.close()

    client.patch(f"{base}/steps/2", json={"company_intro_en": "수정"})
    assert client.get(base).json()["application_status"] == "approved"  # PATCH는 상태 미변경
    assert client.post(f"{base}/submit", json=None).json()["application_status"] == "approved"  # 재제출도 비강등


def test_matching_query_exposes_only_approved(db_factory):
    event_id = _seed_role(db_factory, is_buyer=True, application_status="approved")["event_id"]
    approved_buyer = _seed_role(db_factory, is_buyer=True, application_status="approved", event_id=event_id)
    _seed_role(db_factory, is_buyer=True, application_status="submitted", event_id=event_id)  # 미승인
    _seed_role(db_factory, is_buyer=True, application_status="registered", event_id=event_id)
    approved_exh = _seed_role(db_factory, is_exhibitor=True, application_status="approved", event_id=event_id)

    db = db_factory()
    try:
        buyers = service.select_exposed_org_ids(db, event_id, role="buyer")
        exhibitors = service.select_exposed_org_ids(db, event_id, role="exhibitor")
    finally:
        db.close()

    assert approved_buyer["org_id"] in buyers
    assert len(buyers) == 2  # 첫 approved + approved_buyer; submitted·registered 제외
    assert approved_exh["org_id"] in exhibitors
    assert approved_buyer["org_id"] not in exhibitors


def test_submit_real_commit_failure_rolls_back_atomically(client, db_factory):
    """진짜 commit-time 실패(DB CHECK 위반)에서 라우트/세션이 함께 롤백한다(codex P2-5)."""
    info = _seed_role(db_factory, is_buyer=True)
    _login_as(info["org_id"])
    base = f"/api/bm/buyer/{info['role_id']}"
    client.patch(f"{base}/steps/1", json={"contact_name_en": "Jane Park", "contact_email": "jane@example.com"})
    client.patch(f"{base}/steps/2", json={"company_intro_en": "원래"})
    # route != 'new' 인데 channel 설정 → 채널/경로 CHECK 위반(commit 시점). 같은 트랜잭션의 intro 변경도 롤백돼야.
    resp = client.post(f"{base}/submit", json={"company_intro_en": "바뀐값", "participation_route": "re_1_2", "new_acquisition_channel": "edm"})
    assert resp.status_code == 500
    got = client.get(base).json()
    assert got["application_status"] == "registered"  # 승격 롤백
    assert got["company_intro_en"] == "원래"  # 최종 저장도 롤백(둘이 함께)


def test_rejected_cannot_resubmit_409(client, db_factory):
    info = _seed_role(db_factory, is_buyer=True, application_status="rejected")
    _login_as(info["org_id"])
    assert client.post(f"/api/bm/buyer/{info['role_id']}/submit", json=None).status_code == 409


def test_submit_new_route_requires_channel_422_then_ok(client, db_factory):
    info = _seed_role(db_factory, is_buyer=True)
    _login_as(info["org_id"])
    base = f"/api/bm/buyer/{info['role_id']}"
    client.patch(f"{base}/steps/1", json={"contact_name_en": "Jane Park", "contact_email": "jane@example.com"})
    client.patch(f"{base}/steps/4", json={"participation_route": "new"})  # 채널 없이 신규
    assert client.post(f"{base}/submit", json=None).status_code == 422
    client.patch(f"{base}/steps/4", json={"new_acquisition_channel": "edm"})
    assert client.post(f"{base}/submit", json=None).json()["application_status"] == "submitted"


def test_submit_requires_contact_name_en_and_email_422(client, db_factory):
    """BM-001 실배선 — 신청자 영문 이름·이메일은 제출 필수(부분저장은 계속 허용)."""
    info = _seed_role(db_factory, is_buyer=True)
    _login_as(info["org_id"])
    base = f"/api/bm/buyer/{info['role_id']}"

    # 아무 것도 안 채운 채 제출 → 422(영문 이름 누락이 먼저 걸린다).
    assert client.post(f"{base}/submit", json=None).status_code == 422
    # 부분 저장은 필수 미충족이어도 항상 허용(#26 정합) — 이름만 채워도 여전히 저장은 된다.
    assert client.patch(f"{base}/steps/1", json={"contact_name_en": "Jane Park"}).status_code == 200
    # 이름만 있고 이메일이 없으면 여전히 422.
    assert client.post(f"{base}/submit", json=None).status_code == 422
    # 이메일까지 채우면 제출 성공.
    client.patch(f"{base}/steps/1", json={"contact_email": "jane@example.com"})
    resp = client.post(f"{base}/submit", json=None)
    assert resp.status_code == 200
    assert resp.json()["application_status"] == "submitted"


def test_duplicate_attendee_email_rejected_422(client, db_factory):
    info = _seed_role(db_factory, is_buyer=True)
    _login_as(info["org_id"])
    r = client.patch(f"/api/bm/buyer/{info['role_id']}/steps/3", json={"attendees": [{"email": "x@y.com"}, {"email": "x@y.com"}]})
    assert r.status_code == 422


def test_null_list_is_noop_empty_clears(client, db_factory):
    info = _seed_role(db_factory, is_buyer=True)
    _login_as(info["org_id"])
    base = f"/api/bm/buyer/{info['role_id']}"
    client.patch(f"{base}/steps/1", json={"org_types": ["private_defense"]})
    client.patch(f"{base}/steps/1", json={"org_types": None})  # null = 건드리지 않음
    assert client.get(base).json()["org_types"] == ["private_defense"]
    client.patch(f"{base}/steps/1", json={"org_types": []})  # [] = 비우기
    assert client.get(base).json()["org_types"] == []


# =============================================================================
# 참가사(F-BM-002) — 제품/분류/org 라운드트립
# =============================================================================
def test_exhibitor_steps_round_trip_aligned_layout(client, db_factory):
    # 프론트 정렬 단계: 1 기본정보(부스 신고값·대표자·업태/종목·담당자) · 2 회사소개 · 3 전시품목 · 4 타겟
    info = _seed_role(db_factory, is_exhibitor=True)
    _login_as(info["org_id"])
    base = f"/api/bm/exhibitor/{info['role_id']}"

    r1 = client.patch(f"{base}/steps/1", json={
        "organization_name_ko": "LIG넥스원", "organization_name_en": "LIG Nex1",
        "business_reg_no": "123-45-67890", "main_tel": "02-1234-5678",
        "booth_hall": "10", "booth_pavilion": "드론/대드론/로봇관", "booth_type": "독립부스",
        "booth_count": 2, "representative_name_ko": "홍길동", "company_email": "info@example.com",
        "zip_code": "06236", "address_ko": "서울 강남", "address_detail": "5층",
        "business_type": "제조업", "business_item": "방산전자",
        "attendees": [{"first_name_ko": "김담당", "email": "lead@example.com"}],
    })
    assert r1.status_code == 200
    client.patch(f"{base}/steps/2", json={
        "intro_ko": "정밀유도 전문", "intro_en": "Precision guided",
        "website": "https://lignex1.com", "available_languages": ["ko", "en"],
    })
    r3 = client.patch(f"{base}/steps/3", json={
        "products": [
            {"name_ko": "게임 타이틀 A", "name_en": "Title A", "business_field": "game_production",
             "hs_code": "9301", "spec": "PC/콘솔 크로스플레이", "spec_en": "PC/console cross-play",
             "price_range": "krw_50_70m"},
            {"name_ko": "OST 앨범 B", "business_field": "music_production", "hs_code": "8526"},
        ],
        "exhibition_categories": ["game_production", "music_production"],
    })
    assert r3.status_code == 200
    client.patch(f"{base}/steps/4", json={
        "preferred_buyer_countries": ["uae", "poland"],
        "preferred_buyer_types": ["government", "private_defense"],
    })

    got = client.get(base).json()
    # 1 기본정보
    assert got["organization_name_ko"] == "LIG넥스원"
    assert got["business_reg_no"] == "123-45-67890"
    assert got["booth_hall"] == "10"
    assert got["booth_pavilion"] == "드론/대드론/로봇관"
    assert got["booth_count"] == 2
    assert got["representative_name_ko"] == "홍길동"
    assert got["business_type"] == "제조업"
    assert got["address_detail"] == "5층"
    assert got["attendees"][0]["email"] == "lead@example.com"
    # 2 회사소개
    assert got["intro_ko"] == "정밀유도 전문"
    assert got["website"] == "https://lignex1.com"
    assert got["available_languages"] == ["ko", "en"]
    # 3 전시품목 — 제품별 가격대·사양 영문
    assert [p["name_ko"] for p in got["products"]] == ["게임 타이틀 A", "OST 앨범 B"]  # 순서 보존
    assert got["products"][0]["business_field"] == "game_production"
    assert got["products"][1]["business_field"] == "music_production"
    assert got["products"][0]["price_range"] == "krw_50_70m"
    assert got["products"][0]["spec_en"] == "PC/console cross-play"
    assert got["products"][1]["price_range"] is None
    assert sorted(got["exhibition_categories"]) == ["game_production", "music_production"]
    # 4 타겟 — 선호 바이어 국가/구분 멀티
    assert got["preferred_buyer_countries"] == ["uae", "poland"]
    assert sorted(got["preferred_buyer_types"]) == ["government", "private_defense"]


def test_exhibitor_meeting_slots_write_rejected_operator_only(client, db_factory):
    # 미팅 '불가' 슬롯은 이제 운영자 전용 필드(#OP 슈퍼어드민 콘솔) — 기업 측 PATCH는 조용히 드롭이
    # 아니라 422로 명시 거부(fail-closed). 조회 응답 키·기본값([])은 그대로 유지.
    info = _seed_role(db_factory, is_exhibitor=True)
    _login_as(info["org_id"])
    base = f"/api/bm/exhibitor/{info['role_id']}"

    assert client.get(base).json()["unavailable_meeting_slots"] == []

    slots = ["2026-09-16T09:00", "2026-09-16T09:30", "2026-09-18T17:30"]
    r = client.patch(f"{base}/steps/4", json={"unavailable_meeting_slots": slots})
    assert r.status_code == 422

    # 거부됐으므로 저장되지 않는다.
    assert client.get(base).json()["unavailable_meeting_slots"] == []

    # 제출 시 최종 편집(전 단계 합집합)에서도 같은 필드는 여전히 거부된다.
    r2 = client.post(f"{base}/submit", json={"unavailable_meeting_slots": slots})
    assert r2.status_code == 422


def test_role_path_mismatch_409(client, db_factory):
    info = _seed_role(db_factory, is_buyer=True)
    _login_as(info["org_id"])
    r = client.patch(f"/api/bm/exhibitor/{info['role_id']}/steps/1", json={"organization_name_ko": "X"})
    assert r.status_code == 409


# =============================================================================
# AC2 — 소유권/인증(실 Cognito JWT 검증 경로)
# =============================================================================
ISSUER = "https://cognito-idp.ap-northeast-2.amazonaws.com/pool-XYZ"
CLIENT_ID = "app-client-123"
KID = "key-2026-06"


def _gen_key() -> rsa.RSAPrivateKey:
    return rsa.generate_private_key(public_exponent=65537, key_size=2048)


def _jwks(private_key: rsa.RSAPrivateKey) -> dict:
    jwk = jwt.algorithms.RSAAlgorithm.to_jwk(private_key.public_key(), as_dict=True)
    jwk.update({"kid": KID, "alg": "RS256", "use": "sig"})
    return {"keys": [jwk]}


def _id_token(private_key: rsa.RSAPrivateKey, *, sub: str) -> str:
    now = datetime.now(timezone.utc)
    claims = {"sub": sub, "iss": ISSUER, "aud": CLIENT_ID, "token_use": "id", "iat": now, "exp": now + timedelta(hours=1)}
    pem = private_key.private_bytes(
        encoding=serialization.Encoding.PEM, format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    )
    return jwt.encode(claims, pem, algorithm="RS256", headers={"kid": KID})


@pytest.fixture()
def auth_client(db_factory, monkeypatch):
    key = _gen_key()
    monkeypatch.setattr(settings, "cognito_issuer", ISSUER)
    monkeypatch.setattr(settings, "cognito_client_id", CLIENT_ID)

    def _override_session():
        db = db_factory()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_session] = _override_session
    app.dependency_overrides[get_jwks_provider] = lambda: CognitoJwks(
        ISSUER, static_override=_jwks(key)
    )
    yield TestClient(app, raise_server_exceptions=False), key
    app.dependency_overrides.clear()


def _seed_member(db_factory, org_id: str) -> str:
    n = next(_seq)
    member_id = str(uuid.uuid4())
    db = db_factory()
    try:
        db.add(Member(id=member_id, organization_id=org_id, name="담당자", email=f"u{n}@example.com"))
        db.commit()
    finally:
        db.close()
    return member_id


def test_valid_token_owner_can_read(auth_client, db_factory):
    client, key = auth_client
    info = _seed_role(db_factory, is_buyer=True)
    member_id = _seed_member(db_factory, info["org_id"])
    token = _id_token(key, sub=member_id)
    r = client.get(f"/api/bm/buyer/{info['role_id']}", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 200
    assert r.json()["org_event_role_id"] == info["role_id"]


def test_other_org_forbidden_403(auth_client, db_factory):
    client, key = auth_client
    target = _seed_role(db_factory, is_buyer=True)
    other = _seed_role(db_factory, is_buyer=True)
    intruder = _seed_member(db_factory, other["org_id"])
    token = _id_token(key, sub=intruder)
    r = client.get(f"/api/bm/buyer/{target['role_id']}", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 403


def test_invalid_token_401(auth_client, db_factory):
    client, key = auth_client
    info = _seed_role(db_factory, is_buyer=True)
    member_id = _seed_member(db_factory, info["org_id"])
    token = _id_token(key, sub=member_id)
    tampered = token[:-3] + ("aaa" if not token.endswith("aaa") else "bbb")
    r = client.get(f"/api/bm/buyer/{info['role_id']}", headers={"Authorization": f"Bearer {tampered}"})
    assert r.status_code == 401


def test_missing_token_401(auth_client, db_factory):
    client, _ = auth_client
    info = _seed_role(db_factory, is_buyer=True)
    r = client.get(f"/api/bm/buyer/{info['role_id']}")
    assert r.status_code == 401
