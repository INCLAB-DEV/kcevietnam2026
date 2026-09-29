"""운영자 master 가드 계약(이슈 #47, ADR-0012) — 계정×행사 master만 통과, 그 외 401/403.

순수 인가 코어(authorize_event_master)와 인증 스텁은 DB 없이 검증한다. HTTP 계약은 최소 앱에
가드를 건 라우트로 검증해 Postgres 없이도 항상 돈다("순수 규칙 테스트는 DB 없이도 돈다"). 마지막에
실제 로스터 라우트에 비-master 토큰 → 403로 단일 권한검사 지점이 배선됐음을 확인한다(거부는 DB 전).

끝의 "DB 폴백" 절만 예외 — demo 디렉터리가 하드코딩 dict 밖의 (회원ID, 행사ID)를 organizers/
event_organizers로 조회하는 결함 수정을 실 Postgres로 고정한다(Postgres 미가용이면 skip, conftest.py
의 db_session/event 픽스처 재사용).
"""

from __future__ import annotations

import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.auth.organizer_guard import (
    DEMO_EVENT_ID,
    EventMasterPrincipal,
    InMemoryEventOperatorDirectory,
    NotEventMasterError,
    PERMISSION_MASTER,
    PERMISSION_SUB,
    StubSessionAuthenticator,
    UnauthenticatedError,
    authorize_event_master,
    get_authenticator,
    get_operator_directory,
    require_event_master,
)
from app.config import settings
from app.db import get_session
from app.models import Event, EventOrganizer, Organizer

EVENT_A = "11111111-1111-1111-1111-111111111111"
EVENT_B = "22222222-2222-2222-2222-222222222222"


# --- 순수 인가 코어 -----------------------------------------------------------
def _directory() -> InMemoryEventOperatorDirectory:
    # mbr-master는 행사 A의 master, 행사 B엔 미배정. mbr-sub는 행사 A의 sub.
    return InMemoryEventOperatorDirectory(
        {("mbr-master", EVENT_A): "master", ("mbr-sub", EVENT_A): "sub"}
    )


def test_master_for_event_is_authorized():
    principal = authorize_event_master("mbr-master", EVENT_A, _directory())
    assert principal == EventMasterPrincipal(member_id="mbr-master", event_id=EVENT_A)


def test_sub_is_rejected():
    with pytest.raises(NotEventMasterError):
        authorize_event_master("mbr-sub", EVENT_A, _directory())


def test_unassigned_member_is_rejected():
    with pytest.raises(NotEventMasterError):
        authorize_event_master("mbr-buyer", EVENT_A, _directory())


def test_permission_is_per_event_not_global():
    # 행사 A의 master라도 행사 B엔 배정이 없으면 거부 — 권한은 계정×행사(ADR-0012).
    with pytest.raises(NotEventMasterError):
        authorize_event_master("mbr-master", EVENT_B, _directory())


# --- 인증 스텁 ----------------------------------------------------------------
def test_authenticator_extracts_member_id_from_demo_token():
    auth = StubSessionAuthenticator()
    assert auth.identify("Bearer access-mbr-org-01-7") == "mbr-org-01"
    assert auth.identify("Bearer id-mbr-org-01-1") == "mbr-org-01"


def test_authenticator_missing_header_unauthenticated():
    with pytest.raises(UnauthenticatedError):
        StubSessionAuthenticator().identify(None)


def test_authenticator_garbage_token_unauthenticated():
    auth = StubSessionAuthenticator()
    with pytest.raises(UnauthenticatedError):
        auth.identify("Bearer not-a-valid-token")
    with pytest.raises(UnauthenticatedError):
        auth.identify("access-mbr-org-01-1")  # "Bearer " 누락


# --- HTTP 계약(최소 앱, DB 불필요) --------------------------------------------
@pytest.fixture
def client() -> TestClient:
    app = FastAPI()

    @app.post("/events/{event_id}/guarded")
    def guarded(event_id: str, master: EventMasterPrincipal = Depends(require_event_master)) -> dict:
        return {"member_id": master.member_id, "event_id": master.event_id}

    # 데모 스텁 인증자 + 행사별 디렉터리를 명시 override(기본 cognito는 fail-closed라 의존성을 꽂아야 함).
    app.dependency_overrides[get_authenticator] = StubSessionAuthenticator
    app.dependency_overrides[get_operator_directory] = _directory
    yield TestClient(app)
    app.dependency_overrides.clear()


def test_http_master_token_passes(client):
    resp = client.post(f"/events/{EVENT_A}/guarded", headers={"Authorization": "Bearer access-mbr-master-1"})
    assert resp.status_code == 200
    assert resp.json() == {"member_id": "mbr-master", "event_id": EVENT_A}


def test_http_sub_token_forbidden(client):
    resp = client.post(f"/events/{EVENT_A}/guarded", headers={"Authorization": "Bearer access-mbr-sub-1"})
    assert resp.status_code == 403


def test_http_no_token_unauthorized(client):
    resp = client.post(f"/events/{EVENT_A}/guarded")
    assert resp.status_code == 401


def test_http_garbage_token_unauthorized(client):
    resp = client.post(f"/events/{EVENT_A}/guarded", headers={"Authorization": "Bearer garbage"})
    assert resp.status_code == 401


def test_http_master_wrong_event_forbidden(client):
    # 행사 A의 master 토큰으로 행사 B 라우트 → 403(행사별 권한).
    resp = client.post(f"/events/{EVENT_B}/guarded", headers={"Authorization": "Bearer access-mbr-master-1"})
    assert resp.status_code == 403


# --- 실제 로스터 라우트 배선 확인(거부는 DB 전이라 Postgres 불필요) -----------
def test_roster_import_rejects_non_operator_token():
    """OP-002 적재 라우트가 단일 권한검사 지점을 통과하는지 — 이 행사 운영자가 아닌 토큰은 적재 전 403.

    명단 업로드는 발주자 지시(2026-09-16)로 master 전용에서 이 행사의 운영자(master·sub)로 개방됐다
    (app.roster.router — sub 통과·관할 계약은 test_roster_account_import.py). 여기선 운영자가 아닌 회원
    (참가자)과 다른 행사의 master가 여전히 막히는지만 본다.
    """
    from app.main import app

    app.dependency_overrides[get_authenticator] = StubSessionAuthenticator
    app.dependency_overrides[get_operator_directory] = _directory
    try:
        tc = TestClient(app)
        files = {"file": ("roster.csv", b"\xef\xbb\xbf\xed\x9a\x8c\xec\x9b\x90ID\n", "text/csv")}
        participant = tc.post(
            f"/organizer/events/{EVENT_A}/members/import",
            files=files,
            headers={"Authorization": "Bearer access-mbr-buyer-1"},
        )
        assert participant.status_code == 403  # 인가에서 막혀 파서·DB까지 가지 않는다
        other_event_master = tc.post(
            f"/organizer/events/{EVENT_B}/members/import",
            files=files,
            headers={"Authorization": "Bearer access-mbr-master-1"},
        )
        assert other_event_master.status_code == 403  # 권한은 행사별
    finally:
        app.dependency_overrides.clear()


# --- fail-closed 기본 + 데모 토글(codex P1, 실 Cognito 배선 후) ----------------
def test_default_cognito_mode_wires_real_adapters_and_still_fails_closed(monkeypatch):
    """기본(cognito)에선 서명검증 없는 데모 스텁 대신 실 Cognito 인증자/DB 디렉터리로 배선된다 —
    RuntimeError로 막던 자리가 이제 실제 어댑터다. 그래도 서명 없는 토큰·미배정 회원은 여전히
    통과 못 한다(조용한 폴백이 아니라 실제 검증/조회로 fail-closed가 유지된다는 확인).
    """
    from app.auth.cognito_pool import CognitoSessionAuthenticator

    monkeypatch.setattr(settings, "auth_backend", "cognito")

    authenticator = get_authenticator()
    assert isinstance(authenticator, CognitoSessionAuthenticator)
    with pytest.raises(UnauthenticatedError):
        authenticator.identify("Bearer not-a-real-cognito-token")

    directory = get_operator_directory(db=None)
    assert isinstance(directory, InMemoryEventOperatorDirectory)
    # 데모 하드코딩 시드 없음(cognito 모드는 DB만) — db=None이라 폴백도 못 하니 그대로 미배정.
    assert directory.permission_level("mbr-org-01", DEMO_EVENT_ID) is None


def test_demo_mode_is_per_event_scoped(monkeypatch):
    # AUTH_BACKEND=demo만 스텁을 켜고, 데모 권한은 DEMO_EVENT_ID 한정(모든 행사 아님 — ADR-0012).
    # get_operator_directory는 이제 db(Depends(get_session))를 받는다 — 여기선 DB 폴백 없이 순수
    # 하드코딩 dict만 검증하는 게 목적이라 db=None을 명시로 넘겨 폴백 경로를 끈다(DB 불필요 유지).
    monkeypatch.setattr(settings, "auth_backend", "demo")
    assert isinstance(get_authenticator(), StubSessionAuthenticator)
    directory = get_operator_directory(db=None)
    assert directory.permission_level("mbr-org-01", DEMO_EVENT_ID) == "master"  # 데모 master(주최사)
    assert directory.permission_level("mbr-trade-01", DEMO_EVENT_ID) == "sub"  # 데모 sub(무역관)
    assert directory.permission_level("mbr-org-01", EVENT_B) is None  # 다른 행사엔 권한 없음


def test_demo_accounts_through_real_guard_wiring(monkeypatch):
    # 데모 계정이 실제 가드 배선(override 없이, AUTH_BACKEND=demo)으로 master/sub를 가르는지 — 6·17 데모용.
    monkeypatch.setattr(settings, "auth_backend", "demo")
    app = FastAPI()

    @app.post("/events/{event_id}/guarded")
    def guarded(event_id: str, master: EventMasterPrincipal = Depends(require_event_master)) -> dict:
        return {"member_id": master.member_id}

    tc = TestClient(app)
    # master(주최사) 데모 계정 토큰 → 데모 행사에서 통과.
    ok = tc.post(f"/events/{DEMO_EVENT_ID}/guarded", headers={"Authorization": "Bearer access-mbr-org-01-1"})
    assert ok.status_code == 200
    # sub(무역관) 데모 계정 토큰 → master 전용 가드에서 403.
    sub = tc.post(f"/events/{DEMO_EVENT_ID}/guarded", headers={"Authorization": "Bearer access-mbr-trade-01-1"})
    assert sub.status_code == 403


# --- DB 폴백(결함 수정: demo 디렉터리가 DB로 부여한 권한을 무시하던 문제) -------------------
# 하드코딩 dict(DEMO_EVENT_ID 한정)에 없는 (회원ID, 행사ID)라도 organizers/event_organizers에
# 실제로 배정이 있으면 통과해야 한다 — 그래야 DB로 새 행사에 master를 부여했을 때 demo 모드
# API(어드민 콘솔 등)가 계속 403을 내는 사고가 재발하지 않는다. Postgres 미가용이면 db_session
# 픽스처(conftest.py)가 skip 처리한다.
def _grant(db: Session, event_id: str, member_id: str, level: str) -> None:
    organizer = Organizer(name=f"운영자 {member_id}", email=f"{member_id}@organizer.nabi.local", member_id=member_id)
    db.add(organizer)
    db.flush()
    db.add(EventOrganizer(event_id=event_id, organizer_id=organizer.id, permission_level=level))
    db.flush()


def test_directory_falls_back_to_db_when_not_in_hardcoded_dict(db_session, event):
    # 하드코딩 dict는 비워두고(demo 시드 아님) DB로만 배정 — 순수 인메모리 조회로는 못 찾을 조합.
    _grant(db_session, event.id, "mbr-db-master", PERMISSION_MASTER)
    directory = InMemoryEventOperatorDirectory({}, db=db_session)
    assert directory.permission_level("mbr-db-master", event.id) == PERMISSION_MASTER


def test_directory_prefers_hardcoded_dict_over_db(db_session, event):
    # dict에 이미 값이 있으면 DB를 보지 않는다(같은 키를 DB에 다른 값으로 심어 우선순위 확인).
    _grant(db_session, event.id, "mbr-org-01", PERMISSION_SUB)
    directory = InMemoryEventOperatorDirectory({("mbr-org-01", event.id): PERMISSION_MASTER}, db=db_session)
    assert directory.permission_level("mbr-org-01", event.id) == PERMISSION_MASTER


def test_directory_db_fallback_still_fails_closed_for_unassigned(db_session, event):
    # dict에도 DB에도 없는 회원ID는 여전히 None(조용한 전체 허용 금지).
    directory = InMemoryEventOperatorDirectory({}, db=db_session)
    assert directory.permission_level("mbr-nobody", event.id) is None


def test_demo_guard_passes_db_granted_master_through_real_wiring(db_session, monkeypatch):
    """실 PG로 고정: DB로만 master를 부여한 행사가 demo 모드 real 배선(override 없음)에서 통과한다.

    override 없이 진짜 get_authenticator/get_operator_directory를 태워, defect #2("멀티 행사에서
    DB로 부여한 권한이 demo 가드에서 무시되어 403/500")가 재발하지 않음을 라우트 레벨로 고정한다.
    """
    monkeypatch.setattr(settings, "auth_backend", "demo")
    other_event = Event(name="새 행사(DB로만 master 부여)", slug="db-granted-event")
    db_session.add(other_event)
    db_session.flush()
    _grant(db_session, other_event.id, "mbr-db-master", PERMISSION_MASTER)
    _grant(db_session, other_event.id, "mbr-db-sub", PERMISSION_SUB)

    app = FastAPI()

    @app.post("/events/{event_id}/guarded")
    def guarded(event_id: str, master: EventMasterPrincipal = Depends(require_event_master)) -> dict:
        return {"member_id": master.member_id}

    app.dependency_overrides[get_session] = lambda: db_session
    try:
        tc = TestClient(app)
        # DB로만 master 부여 → 하드코딩 dict엔 없어도 통과해야 한다(수정 전엔 403이었다).
        ok = tc.post(
            f"/events/{other_event.id}/guarded", headers={"Authorization": "Bearer access-mbr-db-master-1"}
        )
        assert ok.status_code == 200
        assert ok.json() == {"member_id": "mbr-db-master"}
        # DB로 sub만 부여 → master 전용 가드는 여전히 403(fail-closed 유지, 무차별 허용 아님).
        sub = tc.post(
            f"/events/{other_event.id}/guarded", headers={"Authorization": "Bearer access-mbr-db-sub-1"}
        )
        assert sub.status_code == 403
    finally:
        app.dependency_overrides.clear()
