"""슈퍼어드민 콘솔 API 통합 테스트(#OP) — 행사 CRUD, 참가기업 관리, 미팅 운영, 통역사 배정.

Postgres 통합 DB(``migrated_db``/``db_factory``, conftest.py)를 쓴다 — Postgres 미가용이면 전체
skip(project 관례). 대부분의 기능 검증은 ``app.admin.guard``의 가드 의존성을 override해 원하는
principal(master/sub)을 직접 주입하고(test_bm_profile_api.py·test_roster_endpoint.py와 동일 관례),
가드 자체의 401/403 배선은 별도 절(끝부분)에서 실 StubSessionAuthenticator + InMemoryEventOperatorDirectory
로 override 없이 검증한다(test_organizer_guard.py의 "실제 라우트 배선 확인" 패턴).
"""

from __future__ import annotations

import itertools
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import sessionmaker

from app.admin.guard import (
    EventOperatorPrincipal,
    OperatorPrincipal,
    require_event_operator,
    require_existing_master_identity,
    require_operator_identity,
)
from app.auth.organizer_guard import (
    EventMasterPrincipal,
    InMemoryEventOperatorDirectory,
    StubSessionAuthenticator,
    get_authenticator,
    get_operator_directory,
    require_event_master,
)
from app.admin import service as admin_service
from app.bm import service as bm_service
from app.db import get_session
from app.main import app
from app.matching.assignment_service import _zero_meeting_org_ids
from app.models import (
    DEFAULT_PARTICIPANT_MENU,
    BuyerAttendee,
    BuyerInterestKeyword,
    BuyerProfile,
    Event,
    EventOrganizer,
    EventScheduleSettings,
    ExhibitorKeyword,
    ExhibitorProfile,
    Keyword,
    Meeting,
    MeetingVenue,
    Member,
    Notification,
    OrgEventRoleOrgType,
    Organization,
    OrganizationEventRole,
    Organizer,
)

_seq = itertools.count(1)


# =============================================================================
# resolve_primary_contact — 순수 함수(DB 불필요). 명단 화면(list_organizations)과 엑셀 export가
# 공유하는 담당자 폴백 규칙 — 이 테스트만으로 두 호출부가 어긋나지 않음을 별도 DB 없이 보장한다.
# =============================================================================
class TestResolvePrimaryContact:
    def test_exhibitor_uses_representative_and_main_tel(self):
        name, email, phone = admin_service.resolve_primary_contact(
            representative_name_ko="김대표",
            company_email="rep@example.com",
            main_tel="02-1111-2222",
            buyer_tel=None,
        )
        assert (name, email, phone) == ("김대표", "rep@example.com", "02-1111-2222")

    def test_buyer_without_attendee_falls_back_to_own_contact_email_and_tel(self):
        name, email, phone = admin_service.resolve_primary_contact(
            representative_name_ko=None,
            company_email=None,
            main_tel=None,
            buyer_tel="024-000-0000",
            buyer_contact_email="qwer@qwer.com",
        )
        # 대표자명이 없고 담당자(attendee)도 없으면 이름은 못 채운다(지어내지 않는다) — 이메일/전화는
        # 바이어 자신의 등록값으로 채워진다.
        assert (name, email, phone) == (None, "qwer@qwer.com", "024-000-0000")

    def test_buyer_falls_back_to_first_attendee_name_when_no_representative(self):
        name, email, phone = admin_service.resolve_primary_contact(
            representative_name_ko=None,
            company_email=None,
            main_tel=None,
            buyer_tel=None,
            attendee_first_name="Jane",
            attendee_last_name="Doe",
            attendee_email="jane@global.com",
            attendee_tel="010-9999-0000",
        )
        assert (name, email, phone) == ("Jane Doe", "jane@global.com", "010-9999-0000")

    def test_buyer_own_contact_email_wins_over_attendee_email(self):
        # buyer_profiles.contact_email(신청서 등록 이메일)이 있으면 임의의 첫 담당자 이메일보다 우선.
        _, email, _ = admin_service.resolve_primary_contact(
            representative_name_ko=None,
            company_email=None,
            main_tel=None,
            buyer_tel=None,
            buyer_contact_email="official@buyer.example",
            attendee_email="attendee@buyer.example",
        )
        assert email == "official@buyer.example"

    def test_all_blank_returns_none_triple(self):
        assert admin_service.resolve_primary_contact(
            representative_name_ko=None, company_email=None, main_tel=None, buyer_tel=None,
        ) == (None, None, None)

    def test_member_fields_are_last_resort_fallback(self):
        # 신청서(BM) 미제출 — 대표자/담당자 전부 없음. 단건 등록 당시 남긴 members 행만 있다.
        name, email, phone = admin_service.resolve_primary_contact(
            representative_name_ko=None,
            company_email=None,
            main_tel=None,
            buyer_tel=None,
            member_name="김담당",
            member_email="kim@new-exhibitor.example",
            member_phone="010-1234-5678",
        )
        assert (name, email, phone) == ("김담당", "kim@new-exhibitor.example", "010-1234-5678")

    def test_member_fields_lose_to_representative_and_attendee(self):
        # members 폴백은 최후 순위 — 신청서 데이터가 있으면 그쪽이 우선한다.
        name, email, phone = admin_service.resolve_primary_contact(
            representative_name_ko="김대표",
            company_email="rep@example.com",
            main_tel="02-1111-2222",
            buyer_tel=None,
            member_name="딴사람",
            member_email="other@example.com",
            member_phone="000-0000-0000",
        )
        assert (name, email, phone) == ("김대표", "rep@example.com", "02-1111-2222")


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


def _as_master(event_id: str, *, member_id="mbr-master", organizer_id="org-master") -> None:
    app.dependency_overrides[require_event_master] = lambda: EventMasterPrincipal(
        member_id=member_id, event_id=event_id
    )
    app.dependency_overrides[require_event_operator] = lambda: EventOperatorPrincipal(
        member_id=member_id, event_id=event_id, permission_level="master", organizer_id=organizer_id
    )


def _as_sub(event_id: str, *, member_id="mbr-sub", organizer_id) -> None:
    app.dependency_overrides[require_event_operator] = lambda: EventOperatorPrincipal(
        member_id=member_id, event_id=event_id, permission_level="sub", organizer_id=organizer_id
    )


def _as_operator_identity(*, member_id="mbr-op", organizer_id="org-op") -> None:
    principal = OperatorPrincipal(member_id=member_id, organizer_id=organizer_id)
    app.dependency_overrides[require_operator_identity] = lambda: principal
    # 행사 생성 게이트(require_existing_master_identity)도 함께 override — 이 헬퍼를 쓰는 기존
    # 테스트들은 "이미 master인 운영자가 행사를 만든다"는 전제를 그대로 유지한다(그 게이트 자체의
    # 401/403 배선 검증은 아래 "행사 생성 게이트" 절에서 실 와이어링으로 별도 확인).
    app.dependency_overrides[require_existing_master_identity] = lambda: principal


# --- 시드 헬퍼 -----------------------------------------------------------------
def _seed_event(db_factory, **overrides) -> str:
    n = next(_seq)
    db = db_factory()
    try:
        # slug는 events.slug UNIQUE — 세션 스코프 migrated_db를 공유하는 다른 테스트 파일(예:
        # test_bm_profile_api.py)도 독립적으로 "dx-{n}"을 생성하므로, 파일 간 충돌을 피하려면 이
        # 파일만의 접두사(uuid 조각)로 네임스페이스를 분리해야 한다.
        slug = overrides.pop("slug", f"admin-{n}-{uuid.uuid4().hex[:8]}")
        ev = Event(name=overrides.pop("name", "DX Korea 2026"), slug=slug, **overrides)
        db.add(ev)
        db.commit()
        return str(ev.id)
    finally:
        db.close()


def _seed_organizer(db_factory, *, member_id: str | None = None) -> str:
    n = next(_seq)
    db = db_factory()
    try:
        o = Organizer(name=f"운영자{n}", email=f"organizer{n}@example.com", member_id=member_id)
        db.add(o)
        db.commit()
        return str(o.id)
    finally:
        db.close()


def _seed_event_organizer(db_factory, event_id: str, organizer_id: str, level: str) -> str:
    """반환값은 event_organizers.id — FE 계약(AdminOrganizer.id, 회수 경로 키)과 맞춰 DELETE
    테스트가 이 값을 그대로 쓴다. 기존 호출부는 반환값을 쓰지 않아도 그대로 동작한다."""
    db = db_factory()
    try:
        eo = EventOrganizer(event_id=event_id, organizer_id=organizer_id, permission_level=level)
        db.add(eo)
        db.commit()
        return str(eo.id)
    finally:
        db.close()


def _seed_org_role(
    db_factory, event_id: str, *, is_buyer=False, is_exhibitor=False,
    application_status="registered", managing_organizer_id=None, org_name="테스트기업",
) -> dict:
    db = db_factory()
    try:
        org = Organization(name_ko=org_name)
        db.add(org)
        db.flush()
        role = OrganizationEventRole(
            organization_id=org.id, event_id=event_id, is_buyer=is_buyer, is_exhibitor=is_exhibitor,
            application_status=application_status, managing_organizer_id=managing_organizer_id,
        )
        db.add(role)
        db.commit()
        return {"org_id": str(org.id), "role_id": str(role.id)}
    finally:
        db.close()


def _seed_meeting(db_factory, event_id, exhibitor_org_id, buyer_org_id, **overrides) -> str:
    """미팅 한 건. status='accepted'면 일정이 **반드시** 있어야 한다(mt001meet01 CHECK).

    확정 미팅에 시간이 없다는 건 도메인상 성립하지 않는 상태다 — 슬롯 점유(EXCLUDE)의 전제가
    시간이라, 시간 없는 accepted는 아무 것도 점유하지 않으면서 확정된 척한다. 그래서 시드도
    실제 데이터와 같은 규칙을 따른다(테스트만 예외인 데이터를 만들지 않는다).
    """
    status = overrides.pop("status", "accepted")
    if status == "accepted" and "scheduled_start" not in overrides:
        # 미팅마다 다른 시각 — 같은 org 쌍에 여러 확정 미팅을 시드해도 슬롯 EXCLUDE에 안 걸린다.
        start = datetime(2026, 9, 16, 9, 0, tzinfo=timezone.utc) + timedelta(minutes=30 * next(_seq))
        overrides["scheduled_start"] = start
        overrides["scheduled_end"] = start + timedelta(minutes=30)
    db = db_factory()
    try:
        m = Meeting(
            event_id=event_id, exhibitor_org_id=exhibitor_org_id, buyer_org_id=buyer_org_id,
            matching_type=overrides.pop("matching_type", "open"),
            status=status, **overrides,
        )
        db.add(m)
        db.commit()
        return str(m.id)
    finally:
        db.close()


# =============================================================================
# 행사(Event) CRUD
# =============================================================================
def test_create_event_becomes_master_and_can_patch(client, db_factory):
    # organizer_id는 event_organizers.organizer_id(UUID, organizers.id FK) — 실 경로(resolve_organizer_id)
    # 처럼 먼저 진짜 Organizer 행을 만들고 그 id를 override 원리로 주입한다(임의 문자열은 FK 위반).
    creator_id = _seed_organizer(db_factory, member_id="mbr-creator")
    _as_operator_identity(organizer_id=creator_id)
    resp = client.post(
        "/api/admin/events",
        json={"name": "베트남 방산전 2027", "venue_name": "SECC 호치민", "slot_minutes": 20},
    )
    assert resp.status_code == 201
    body = resp.json()
    assert body["name"] == "베트남 방산전 2027"
    assert body["venue_name"] == "SECC 호치민"
    assert body["slot_minutes"] == 20
    assert body["slug"]  # 자동 생성
    assert sorted(body["enabled_venue_types"]) == ["booth", "business_room", "zone_table"]  # 기본 3종
    assert body["allow_same_role_discovery"] is False

    # 생성자가 자동으로 그 행사의 master로 배정됐는지 event_organizers로 확인.
    db = db_factory()
    try:
        row = db.query(EventOrganizer).filter_by(event_id=body["id"], organizer_id=creator_id).one()
        assert row.permission_level == "master"
    finally:
        db.close()


def test_list_events_scoped_to_organizer(client, db_factory):
    ev1 = _seed_event(db_factory, name="행사A")
    ev2 = _seed_event(db_factory, name="행사B")
    _seed_event(db_factory, name="행사C(무관)")
    organizer_id = _seed_organizer(db_factory, member_id="mbr-me")
    _seed_event_organizer(db_factory, ev1, organizer_id, "master")
    _seed_event_organizer(db_factory, ev2, organizer_id, "sub")

    _as_operator_identity(organizer_id=organizer_id)
    resp = client.get("/api/admin/events")
    assert resp.status_code == 200
    names = {e["name"] for e in resp.json()["items"]}
    assert names == {"행사A", "행사B"}  # 무관 행사C는 안 보인다


def test_patch_event_updates_schedule_fields(client, db_factory):
    event_id = _seed_event(db_factory)
    _as_master(event_id)
    resp = client.patch(
        f"/api/admin/events/{event_id}",
        json={"venue_name": "새 전시장", "exhibition_start": "2027-03-10", "exhibition_end": "2027-03-13"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["venue_name"] == "새 전시장"
    assert body["exhibition_start"] == "2027-03-10"


def test_patch_event_timezone_updates_and_is_returned_by_get(client, db_factory):
    # events.timezone 기본값은 'Asia/Seoul' — PATCH로 행사 현지(ICT)로 바꿀 수 있어야 한다(P0-1,
    # ADR-0014). GET이 그 값을 되돌려주지 않으면 FE가 다시 KST를 하드코딩하게 된다(H5 재발 방지).
    event_id = _seed_event(db_factory)
    _as_master(event_id)
    get_before = client.get(f"/api/admin/events/{event_id}")
    assert get_before.json()["timezone"] == "Asia/Seoul"

    resp = client.patch(f"/api/admin/events/{event_id}", json={"timezone": "Asia/Ho_Chi_Minh"})
    assert resp.status_code == 200
    assert resp.json()["timezone"] == "Asia/Ho_Chi_Minh"

    get_after = client.get(f"/api/admin/events/{event_id}")
    assert get_after.json()["timezone"] == "Asia/Ho_Chi_Minh"


def test_patch_event_timezone_rejects_unknown_iana_422(client, db_factory):
    # 조용한 UTC 폴백 금지(slot_grid.resolve_zone 계약) — 알 수 없는 타임존은 422.
    event_id = _seed_event(db_factory)
    _as_master(event_id)
    resp = client.patch(f"/api/admin/events/{event_id}", json={"timezone": "Not/AZone"})
    assert resp.status_code == 422


def test_event_settings_slot_minutes_rejects_invalid_422(client, db_factory):
    event_id = _seed_event(db_factory)
    _as_master(event_id)
    bad = client.patch(f"/api/admin/events/{event_id}/settings", json={"slot_minutes": 15})
    assert bad.status_code == 422

    ok = client.patch(f"/api/admin/events/{event_id}/settings", json={"slot_minutes": 60})
    assert ok.status_code == 200
    assert ok.json()["slot_minutes"] == 60


def test_event_settings_accepts_forty_minute_slots(client, db_factory):
    # 40분은 발주사 운영표(40분 상담 + 5분 텀) 대응으로 허용 어휘에 추가됐다(mt003gap0001).
    # API Literal 과 DB CHECK(events_slot_minutes_check)가 둘 다 열려야 저장된다 — 어느 한쪽만
    # 열리면 422 아니면 IntegrityError 로 드러난다.
    event_id = _seed_event(db_factory)
    _as_master(event_id)
    resp = client.patch(f"/api/admin/events/{event_id}/settings", json={"slot_minutes": 40})
    assert resp.status_code == 200
    assert resp.json()["slot_minutes"] == 40


def test_event_settings_gap_and_max_meeting_roundtrip(client, db_factory):
    """§3.1 인수기준: 발주사 격자 설정값이 PATCH → GET 으로 왕복한다."""
    event_id = _seed_event(db_factory)
    _as_master(event_id)

    # 기본값 — 기존 행사는 텀 0 / 상한 90이라 격자가 구버전과 동일해야 한다(하위호환).
    before = client.get(f"/api/admin/events/{event_id}/settings").json()
    assert before["slot_gap_minutes"] == 0
    assert before["max_meeting_minutes"] == 90

    resp = client.patch(
        f"/api/admin/events/{event_id}/settings",
        json={
            "slot_minutes": 40,
            "slot_gap_minutes": 5,
            "max_meeting_minutes": 90,
            "operating_start": "10:00",
            "operating_end": "18:10",
            "lunch_start": "12:10",
            "lunch_end": "13:00",
        },
    )
    assert resp.status_code == 200
    body = resp.json()
    assert (body["slot_minutes"], body["slot_gap_minutes"]) == (40, 5)
    assert body["operating_start"].startswith("10:00")
    assert body["operating_end"].startswith("18:10")

    # 응답이 아니라 **저장된 값**을 다시 읽어 확인한다(PATCH 응답만 믿으면 저장 누락을 못 잡는다).
    again = client.get(f"/api/admin/events/{event_id}/settings").json()
    assert again["slot_gap_minutes"] == 5
    assert again["max_meeting_minutes"] == 90
    assert again["slot_minutes"] == 40


@pytest.mark.parametrize(
    "payload",
    [
        {"slot_gap_minutes": -1},   # 음수 텀
        {"slot_gap_minutes": 31},   # 상한(30) 초과
        {"max_meeting_minutes": 9},   # 하한(10) 미만
        {"max_meeting_minutes": 481},  # 상한(480) 초과
    ],
)
def test_event_settings_rejects_out_of_range_grid_values(client, db_factory, payload):
    # 범위는 DB CHECK 가 아니라 API 경계(Pydantic Field)에서 강제한다 — 마이그레이션 docstring 참고.
    event_id = _seed_event(db_factory)
    _as_master(event_id)
    assert client.patch(f"/api/admin/events/{event_id}/settings", json=payload).status_code == 422


def test_event_settings_narrows_venue_types_and_flips_visibility_policy(client, db_factory):
    event_id = _seed_event(db_factory)
    _as_master(event_id)
    resp = client.patch(
        f"/api/admin/events/{event_id}/settings",
        json={"enabled_venue_types": ["booth"], "allow_same_role_discovery": True},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["enabled_venue_types"] == ["booth"]
    assert body["allow_same_role_discovery"] is True


# --- 참가자 메뉴(F-NV-001 D15, nv001menu0001) ----------------------------------
def test_event_settings_participant_menu_defaults_to_meetings_only_and_roundtrips(client, db_factory):
    """기본은 미팅만(meetings_only)이고, 전체 메뉴(full)로 바꿨다가 되돌릴 수 있다."""
    event_id = _seed_event(db_factory)
    _as_master(event_id)

    # 한 번도 설정을 열지 않은 행사 — GET이 설정 행을 만들면서 기본값을 돌려준다. 기본값은 코드의 상수
    # 하나(DEFAULT_PARTICIPANT_MENU)이고, 컬럼 server_default도 같은 값이어야 한다.
    assert DEFAULT_PARTICIPANT_MENU == "meetings_only"
    assert (
        client.get(f"/api/admin/events/{event_id}/settings").json()["participant_menu"]
        == DEFAULT_PARTICIPANT_MENU
    )

    resp = client.patch(f"/api/admin/events/{event_id}/settings", json={"participant_menu": "full"})
    assert resp.status_code == 200
    assert resp.json()["participant_menu"] == "full"
    # 응답이 아니라 저장된 값을 다시 읽는다(PATCH 응답만 믿으면 저장 누락을 못 잡는다).
    again = client.get(f"/api/admin/events/{event_id}/settings").json()
    assert again["participant_menu"] == "full"

    back = client.patch(
        f"/api/admin/events/{event_id}/settings", json={"participant_menu": "meetings_only"}
    )
    assert back.status_code == 200
    assert (
        client.get(f"/api/admin/events/{event_id}/settings").json()["participant_menu"]
        == "meetings_only"
    )


def test_event_settings_participant_menu_is_independent_of_other_settings(client, db_factory):
    """메뉴만 바꾸면 격자 설정이 그대로고, 격자만 바꾸면 메뉴가 그대로다(부분 수정)."""
    event_id = _seed_event(db_factory)
    _as_master(event_id)
    before = client.get(f"/api/admin/events/{event_id}/settings").json()

    client.patch(f"/api/admin/events/{event_id}/settings", json={"participant_menu": "full"})
    after_menu = client.get(f"/api/admin/events/{event_id}/settings").json()
    assert {**after_menu, "participant_menu": before["participant_menu"]} == before

    client.patch(f"/api/admin/events/{event_id}/settings", json={"slot_gap_minutes": 5})
    after_grid = client.get(f"/api/admin/events/{event_id}/settings").json()
    assert after_grid["slot_gap_minutes"] == 5
    assert after_grid["participant_menu"] == "full"


@pytest.mark.parametrize(
    "payload",
    [
        {"participant_menu": "none"},  # 어휘 밖
        {"participant_menu": "FULL"},  # 대소문자 구분
        {"participant_menu": ""},
        {"participant_menu": None},  # NOT NULL 컬럼 — 500이 아니라 422로 막는다
    ],
)
def test_event_settings_rejects_unknown_participant_menu(client, db_factory, payload):
    event_id = _seed_event(db_factory)
    _as_master(event_id)
    client.patch(f"/api/admin/events/{event_id}/settings", json={"participant_menu": "full"})

    assert client.patch(f"/api/admin/events/{event_id}/settings", json=payload).status_code == 422
    # 거절된 요청은 아무것도 바꾸지 않는다 — 고른 값(full)이 기본값으로 되돌아가지도 않는다.
    assert client.get(f"/api/admin/events/{event_id}/settings").json()["participant_menu"] == "full"


def test_participant_menu_check_constraint_rejects_unknown_value(db_factory):
    """API를 우회해 DB에 직접 써도 어휘 밖 값은 CHECK가 막는다(읽는 쪽은 두 값만 가정한다)."""
    event_id = _seed_event(db_factory)
    db = db_factory()
    try:
        db.add(EventScheduleSettings(event_id=event_id, participant_menu="everything"))
        with pytest.raises(IntegrityError, match="event_schedule_settings_participant_menu_check"):
            db.commit()
    finally:
        db.rollback()
        db.close()


def test_participant_menu_column_default_matches_the_code_constant(db_factory):
    """컬럼 server_default와 코드 상수가 같은 값이다 — 갈라지면 "설정 행이 있는 행사"와 "없는 행사"의
    기본 화면이 달라진다(행은 처음 닿을 때 생기므로 운영자가 설정을 열어 보기만 해도 값이 바뀌어 보인다)."""
    event_id = _seed_event(db_factory)
    db = db_factory()
    try:
        row = EventScheduleSettings(event_id=event_id)  # participant_menu를 주지 않는다 → DB 기본값
        db.add(row)
        db.commit()
        db.refresh(row)
        assert row.participant_menu == DEFAULT_PARTICIPANT_MENU
    finally:
        db.close()


def test_participant_menu_write_is_master_only_through_real_guard_wiring(
    wired_client, db_factory, event_a
):
    """참가자 화면 전체가 바뀌는 설정이라 쓰기는 master 전용, 읽기는 sub도 된다(기존 설정과 같은 가드)."""
    _seed_event(db_factory, id=event_a)
    sub = {"Authorization": "Bearer access-mbr-sub-1"}
    master = {"Authorization": "Bearer access-mbr-master-1"}
    url = f"/api/admin/events/{event_a}/settings"

    denied = wired_client.patch(url, json={"participant_menu": "full"}, headers=sub)
    assert denied.status_code == 403
    assert wired_client.get(url, headers=sub).json()["participant_menu"] == "meetings_only"

    ok = wired_client.patch(url, json={"participant_menu": "full"}, headers=master)
    assert ok.status_code == 200
    assert wired_client.get(url, headers=sub).json()["participant_menu"] == "full"


def test_participant_menu_migration_backfills_meetings_only_and_roundtrips(empty_db_url):
    """nv001menu0001 — 이미 있던 설정 행은 기본값(meetings_only)으로 백필되고, 컬럼·CHECK가 깨끗이
    내려갔다 다시 올라온다."""
    from alembic import command
    from alembic.config import Config
    from sqlalchemy import text

    from app.config import settings

    def _column_count(connection) -> int:
        return connection.execute(
            text(
                "SELECT count(*) FROM information_schema.columns WHERE table_name ="
                " 'event_schedule_settings' AND column_name = 'participant_menu'"
            )
        ).scalar_one()

    def _check_count(connection) -> int:
        return connection.execute(
            text(
                "SELECT count(*) FROM pg_constraint WHERE conrelid ="
                " 'event_schedule_settings'::regclass AND conname ="
                " 'event_schedule_settings_participant_menu_check'"
            )
        ).scalar_one()

    def _menus(connection) -> list[str]:
        return connection.execute(
            text("SELECT participant_menu FROM event_schedule_settings")
        ).scalars().all()

    original = settings.database_url
    settings.database_url = empty_db_url
    cfg = Config("alembic.ini")
    engine = create_engine(empty_db_url, future=True)
    try:
        # 이 리비전 직전 상태에서 행사·설정 행을 만든다 — "기존 행"의 백필을 보려는 것이다.
        command.upgrade(cfg, "mt003gap0001")
        with engine.begin() as c:
            assert _column_count(c) == 0
            event_id = c.execute(
                text("INSERT INTO events (name, slug) VALUES ('기존 행사', 'nv001-backfill') RETURNING id")
            ).scalar_one()
            c.execute(
                text("INSERT INTO event_schedule_settings (event_id) VALUES (:event_id)"),
                {"event_id": event_id},
            )

        command.upgrade(cfg, "head")
        with engine.connect() as c:
            assert (_column_count(c), _check_count(c)) == (1, 1)
            # 마이그레이션에 적힌 기본값(리비전 시점의 스냅샷)이 지금 코드 상수와 같은지도 함께 본다.
            assert _menus(c) == ["meetings_only"] == [DEFAULT_PARTICIPANT_MENU]

        # 전체 메뉴로 바꿔 둔 행사가 있어도 내려간다 — 그 선택은 컬럼과 함께 사라진다.
        with engine.begin() as c:
            c.execute(text("UPDATE event_schedule_settings SET participant_menu = 'full'"))
        command.downgrade(cfg, "mt003gap0001")
        with engine.connect() as c:
            assert (_column_count(c), _check_count(c)) == (0, 0)
            assert c.execute(text("SELECT count(*) FROM event_schedule_settings")).scalar_one() == 1

        command.upgrade(cfg, "head")  # 재적용 — 되돌아온 컬럼은 다시 기본값이다
        with engine.connect() as c:
            assert (_column_count(c), _check_count(c)) == (1, 1)
            assert _menus(c) == ["meetings_only"]
    finally:
        engine.dispose()
        settings.database_url = original


# --- 참가자 알림 메일(F-NT-001, nt004mail0001) ------------------------------------
def test_event_settings_participant_email_defaults_to_disabled_and_roundtrips(client, db_factory):
    """기본은 꺼짐(false — 2026-10-16 발주사 결정)이고, 켰다가 다시 끌 수 있다."""
    from app.models import DEFAULT_PARTICIPANT_EMAIL_ENABLED

    event_id = _seed_event(db_factory)
    _as_master(event_id)
    url = f"/api/admin/events/{event_id}/settings"

    # 한 번도 설정을 열지 않은 행사 — GET이 설정 행을 만들면서(get_or_create) 기본값(꺼짐)을 돌려준다.
    assert DEFAULT_PARTICIPANT_EMAIL_ENABLED is False
    assert client.get(url).json()["participant_email_enabled"] is False

    resp = client.patch(url, json={"participant_email_enabled": True})
    assert resp.status_code == 200
    assert resp.json()["participant_email_enabled"] is True
    # 응답이 아니라 저장된 값을 다시 읽는다.
    assert client.get(url).json()["participant_email_enabled"] is True
    db = db_factory()
    try:
        row = db.execute(
            select(EventScheduleSettings).where(EventScheduleSettings.event_id == event_id)
        ).scalar_one()
        assert row.participant_email_enabled is True
    finally:
        db.close()

    back = client.patch(url, json={"participant_email_enabled": False})
    assert back.status_code == 200
    assert client.get(url).json()["participant_email_enabled"] is False


def test_new_event_starts_with_participant_email_off(client, db_factory):
    """새로 만든 행사도 꺼짐으로 시작한다 — 설정 행이 생기기 전(알림 경로의 폴백)과 생긴 뒤(GET) 모두."""
    from app.notifications import service as notification_service

    creator_id = _seed_organizer(db_factory, member_id="mbr-email-default")
    _as_operator_identity(organizer_id=creator_id)
    created = client.post("/api/admin/events", json={"name": "새 행사 — 메일 기본값"})
    assert created.status_code == 201
    event_id = created.json()["id"]

    db = db_factory()
    try:
        # 행사 생성은 설정 행을 만들지 않는다 — 알림 경로는 행이 없으면 기본값(꺼짐)으로 읽는다.
        assert db.execute(
            select(EventScheduleSettings).where(EventScheduleSettings.event_id == event_id)
        ).scalar_one_or_none() is None
        assert notification_service.participant_email_enabled_for_event(db, event_id) is False
    finally:
        db.close()

    _as_master(event_id)
    assert client.get(f"/api/admin/events/{event_id}/settings").json()[
        "participant_email_enabled"
    ] is False


def test_event_settings_participant_email_is_independent_of_other_settings(client, db_factory):
    """메일 스위치만 바꾸면 나머지 설정이 그대로고, 다른 설정만 바꾸면 스위치가 그대로다(부분 수정)."""
    event_id = _seed_event(db_factory)
    _as_master(event_id)
    url = f"/api/admin/events/{event_id}/settings"
    before = client.get(url).json()

    client.patch(url, json={"participant_email_enabled": True})
    after_switch = client.get(url).json()
    assert {**after_switch, "participant_email_enabled": False} == before

    client.patch(url, json={"participant_menu": "full", "slot_gap_minutes": 5})
    after_other = client.get(url).json()
    assert after_other["participant_email_enabled"] is True
    assert after_other["participant_menu"] == "full"


@pytest.mark.parametrize(
    "payload",
    [
        {"participant_email_enabled": None},  # NOT NULL 컬럼 — 500이 아니라 422
        {"participant_email_enabled": "false"},  # 문자열을 느슨하게 bool로 해석하지 않는다
        {"participant_email_enabled": "off"},
        {"participant_email_enabled": 0},
        {"participant_email_enabled": 1},
    ],
)
def test_event_settings_rejects_non_boolean_participant_email(client, db_factory, payload):
    event_id = _seed_event(db_factory)
    _as_master(event_id)
    url = f"/api/admin/events/{event_id}/settings"
    client.patch(url, json={"participant_email_enabled": True})

    assert client.patch(url, json=payload).status_code == 422
    # 거절된 요청은 아무것도 바꾸지 않는다 — 켜 둔 값이 기본값(꺼짐)으로 되돌아가지도 않는다.
    assert client.get(url).json()["participant_email_enabled"] is True


def test_participant_email_column_default_matches_the_code_constant(db_factory):
    """컬럼 기본값과 코드 상수가 같은 값(꺼짐)이다 — 갈라지면 설정 행이 있는 행사와 없는 행사가 다르게 동작한다."""
    from app.models import DEFAULT_PARTICIPANT_EMAIL_ENABLED

    assert DEFAULT_PARTICIPANT_EMAIL_ENABLED is False

    event_id = _seed_event(db_factory)
    db = db_factory()
    try:
        row = EventScheduleSettings(event_id=event_id)  # 값을 주지 않는다 → DB 기본값
        db.add(row)
        db.commit()
        db.refresh(row)
        assert row.participant_email_enabled is DEFAULT_PARTICIPANT_EMAIL_ENABLED
    finally:
        db.close()


def test_participant_email_write_is_master_only_through_real_guard_wiring(
    wired_client, db_factory, event_a
):
    """참가자 메뉴와 같은 가드 — 쓰기(PATCH)는 master 전용, 읽기는 sub도 된다."""
    _seed_event(db_factory, id=event_a)
    sub = {"Authorization": "Bearer access-mbr-sub-1"}
    master = {"Authorization": "Bearer access-mbr-master-1"}
    url = f"/api/admin/events/{event_a}/settings"

    denied = wired_client.patch(url, json={"participant_email_enabled": True}, headers=sub)
    assert denied.status_code == 403
    assert wired_client.get(url, headers=sub).json()["participant_email_enabled"] is False

    ok = wired_client.patch(url, json={"participant_email_enabled": True}, headers=master)
    assert ok.status_code == 200
    assert wired_client.get(url, headers=sub).json()["participant_email_enabled"] is True

    assert wired_client.patch(url, json={"participant_email_enabled": False}).status_code == 401


def test_participant_email_migration_backfills_false_and_roundtrips(empty_db_url):
    """nt004mail0001 — 이미 있던 설정 행은 false(기본 꺼짐 — 배포 즉시 모든 행사의 자동 알림 메일이 멈춘다)로
    백필되고, 컬럼이 깨끗이 내려갔다 다시 올라온다."""
    from app.models import DEFAULT_PARTICIPANT_EMAIL_ENABLED

    from alembic import command
    from alembic.config import Config
    from sqlalchemy import text

    from app.config import settings

    def _column_count(connection) -> int:
        return connection.execute(
            text(
                "SELECT count(*) FROM information_schema.columns WHERE table_name ="
                " 'event_schedule_settings' AND column_name = 'participant_email_enabled'"
            )
        ).scalar_one()

    def _values(connection) -> list[bool]:
        return connection.execute(
            text("SELECT participant_email_enabled FROM event_schedule_settings")
        ).scalars().all()

    original = settings.database_url
    settings.database_url = empty_db_url
    cfg = Config("alembic.ini")
    engine = create_engine(empty_db_url, future=True)
    try:
        # 이 리비전 직전 상태에서 행사·설정 행을 만든다 — "기존 행"의 백필을 보려는 것이다.
        command.upgrade(cfg, "nv001menu0001")
        with engine.begin() as c:
            assert _column_count(c) == 0
            event_id = c.execute(
                text("INSERT INTO events (name, slug) VALUES ('기존 행사', 'nt004-backfill') RETURNING id")
            ).scalar_one()
            c.execute(
                text("INSERT INTO event_schedule_settings (event_id) VALUES (:event_id)"),
                {"event_id": event_id},
            )

        command.upgrade(cfg, "head")
        with engine.connect() as c:
            assert _column_count(c) == 1
            # 마이그레이션에 적힌 기본값(리비전 시점의 스냅샷)이 지금 코드 상수와 같은지도 함께 본다.
            assert _values(c) == [False] == [DEFAULT_PARTICIPANT_EMAIL_ENABLED]

        # 켜 둔 행사가 있어도 내려간다 — 그 선택은 컬럼과 함께 사라진다.
        with engine.begin() as c:
            c.execute(text("UPDATE event_schedule_settings SET participant_email_enabled = true"))
        command.downgrade(cfg, "-1")
        with engine.connect() as c:
            assert _column_count(c) == 0
            assert c.execute(text("SELECT count(*) FROM event_schedule_settings")).scalar_one() == 1

        command.upgrade(cfg, "head")  # 재적용 — 되돌아온 컬럼은 다시 기본값(false)이다
        with engine.connect() as c:
            assert _column_count(c) == 1
            assert _values(c) == [False]
    finally:
        engine.dispose()
        settings.database_url = original


def test_participant_email_migration_gives_up_quickly_when_the_table_is_locked(empty_db_url):
    """nt004mail0001은 잠금을 3초까지만 기다린다(lock_timeout) — 운영 앱이 테이블을 쥐고 있어도 배포가 무한정
    멈추거나 그 뒤로 요청이 줄 서지 않고 실패로 끝난다. upgrade·downgrade 둘 다."""
    import threading
    import time

    from alembic import command
    from alembic.config import Config
    from sqlalchemy import text

    from app.config import settings

    def _run_while_locked(engine, action) -> tuple[Exception | None, float]:
        """다른 트랜잭션이 테이블을 쥔 채로 action을 돌린다. 상한이 없으면 15초 뒤 잠금을 놓아 성공해 버린다."""
        holder = engine.connect()
        tx = holder.begin()
        holder.execute(text("LOCK TABLE event_schedule_settings IN ACCESS SHARE MODE"))
        outcome: dict = {}

        def _target():
            started = time.monotonic()
            try:
                action()
            except Exception as exc:  # noqa: BLE001 - 잠금 시간 초과를 결과로 받는다
                outcome["exc"] = exc
            outcome["elapsed"] = time.monotonic() - started

        worker = threading.Thread(target=_target)
        worker.start()
        worker.join(timeout=15)
        tx.rollback()  # 잠금을 놓는다 — 상한이 없었다면 여기서야 진행된다
        holder.close()
        worker.join(timeout=30)
        return outcome.get("exc"), outcome.get("elapsed", 999.0)

    original = settings.database_url
    settings.database_url = empty_db_url
    cfg = Config("alembic.ini")
    engine = create_engine(empty_db_url, future=True)
    try:
        command.upgrade(cfg, "nv001menu0001")

        exc, elapsed = _run_while_locked(engine, lambda: command.upgrade(cfg, "head"))
        assert exc is not None and "lock timeout" in str(exc), exc
        assert elapsed < 10
        with engine.connect() as c:  # 실패한 upgrade는 아무것도 남기지 않았다
            assert c.execute(text("SELECT version_num FROM alembic_version")).scalar_one() == (
                "nv001menu0001"
            )

        command.upgrade(cfg, "head")  # 잠금이 없으면 그대로 올라간다
        exc, elapsed = _run_while_locked(engine, lambda: command.downgrade(cfg, "-1"))
        assert exc is not None and "lock timeout" in str(exc), exc
        assert elapsed < 10
        with engine.connect() as c:
            assert c.execute(text("SELECT version_num FROM alembic_version")).scalar_one() == (
                "nt004mail0001"
            )
    finally:
        engine.dispose()
        settings.database_url = original


def _capture_mail(monkeypatch) -> list:
    """알림 기본 채널의 메일 발송을 가로챈다 — 라우터 경로는 채널 주입을 못 하므로 _default_channels를 바꾼다."""
    from app.notifications import service as notification_service
    from app.notifications.channels import EmailChannel, InAppChannel
    from app.notifications.email import FakeEmailSender

    sender = FakeEmailSender()
    monkeypatch.setattr(
        notification_service, "_default_channels", lambda: (InAppChannel(), EmailChannel(sender))
    )
    return sender.sent


def _set_participant_email(db_factory, event_id: str, enabled: bool) -> None:
    from tests.conftest import set_participant_email

    db = db_factory()
    try:
        set_participant_email(db, event_id, enabled)
    finally:
        db.close()


def _seed_contact(db_factory, org_id: str) -> str:
    """알림 수신 멤버(이메일 있음) 한 명 — 이메일을 돌려준다."""
    n = next(_seq)
    email = f"notify-{n}-{uuid.uuid4().hex[:6]}@example.com"
    db = db_factory()
    try:
        db.add(Member(organization_id=org_id, name=f"담당{n}", email=email))
        db.commit()
        return email
    finally:
        db.close()


def _email_dispatches(db_factory, event_id: str, type_: str) -> list[tuple[str, str | None]]:
    from app.models import NotificationDispatch

    db = db_factory()
    try:
        rows = db.execute(
            select(NotificationDispatch.status, NotificationDispatch.error)
            .join(Notification, Notification.id == NotificationDispatch.notification_id)
            .where(
                Notification.event_id == event_id,
                Notification.type == type_,
                NotificationDispatch.channel == "email",
            )
        ).all()
        return sorted((s, e) for s, e in rows)
    finally:
        db.close()


def _notification_count(db_factory, event_id: str, type_: str) -> int:
    db = db_factory()
    try:
        return len(
            db.execute(
                select(Notification).where(
                    Notification.event_id == event_id, Notification.type == type_
                )
            ).scalars().all()
        )
    finally:
        db.close()


def test_review_approve_with_participant_email_off_sends_no_mail(client, db_factory, monkeypatch):
    sent = _capture_mail(monkeypatch)
    event_id = _seed_event(db_factory)
    org = _seed_org_role(db_factory, event_id, is_exhibitor=True, application_status="submitted")
    _seed_contact(db_factory, org["org_id"])
    _set_participant_email(db_factory, event_id, False)
    _as_master(event_id)

    resp = client.patch(
        f"/api/admin/events/{event_id}/organizations/{org['org_id']}/review",
        json={"status": "approved"},
    )

    assert resp.status_code == 200
    assert sent == []  # 메일 0통
    assert _notification_count(db_factory, event_id, "application_approved") == 1  # 인앱은 남는다
    assert _email_dispatches(db_factory, event_id, "application_approved") == [
        ("skipped", "event_email_disabled")
    ]


@pytest.mark.parametrize("enabled", [True, False])
def test_master_proxy_profile_auto_approval_mail_follows_the_switch(
    client, db_factory, monkeypatch, enabled
):
    """마스터 대리작성은 즉시 승인되고 승인 알림이 나간다 — 켜짐이면 메일 1통(지금 동작 고정), 꺼짐이면 0통."""
    sent = _capture_mail(monkeypatch)
    event_id = _seed_event(db_factory)
    exhibitor = _seed_org_role(
        db_factory, event_id, is_exhibitor=True, application_status="registered"
    )
    email = _seed_contact(db_factory, exhibitor["org_id"])
    _set_participant_email(db_factory, event_id, enabled)
    _as_master(event_id, member_id="mbr-proxy-writer")

    resp = client.post(
        f"/api/admin/events/{event_id}/organizations/{exhibitor['org_id']}/proxy-profile",
        params={"role": "exhibitor"},
        json={"organization_name_ko": "명단으로 대리작성한 기업", "main_tel": "02-0000-0000"},
    )

    assert resp.status_code == 200
    assert resp.json()["application_status"] == "approved"
    assert _notification_count(db_factory, event_id, "application_approved") == 1
    if enabled:
        assert [m.to for m in sent] == [[email]]
        assert _email_dispatches(db_factory, event_id, "application_approved") == [("sent", None)]
    else:
        assert sent == []
        assert _email_dispatches(db_factory, event_id, "application_approved") == [
            ("skipped", "event_email_disabled")
        ]


def test_operator_cancel_with_participant_email_off_sends_no_mail(client, db_factory, monkeypatch):
    sent = _capture_mail(monkeypatch)
    event_id = _seed_event(db_factory)
    exh = _seed_org_role(db_factory, event_id, is_exhibitor=True)
    buy = _seed_org_role(db_factory, event_id, is_buyer=True)
    _seed_contact(db_factory, exh["org_id"])
    _seed_contact(db_factory, buy["org_id"])
    meeting_id = _seed_meeting(db_factory, event_id, exh["org_id"], buy["org_id"])
    _set_participant_email(db_factory, event_id, False)
    _as_master(event_id)

    resp = client.post(f"/api/admin/events/{event_id}/meetings/{meeting_id}/cancel")

    assert resp.status_code == 200
    assert resp.json()["status"] == "cancelled"
    assert sent == []
    assert _notification_count(db_factory, event_id, "meeting_cancelled") == 2  # 양쪽 인앱
    assert _email_dispatches(db_factory, event_id, "meeting_cancelled") == [
        ("skipped", "event_email_disabled"),
        ("skipped", "event_email_disabled"),
    ]


# =============================================================================
# Organization 목록/상세 — 조회 + sub 관할 필터
# =============================================================================
def test_list_organizations_filters_by_role_and_status(client, db_factory):
    event_id = _seed_event(db_factory)
    _seed_org_role(db_factory, event_id, is_exhibitor=True, application_status="approved", org_name="참가사A")
    _seed_org_role(db_factory, event_id, is_buyer=True, application_status="submitted", org_name="바이어A")

    _as_master(event_id)
    resp = client.get(f"/api/admin/events/{event_id}/organizations", params={"role": "buyer"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] == 1
    assert body["items"][0]["name_ko"] == "바이어A"

    resp2 = client.get(f"/api/admin/events/{event_id}/organizations", params={"status": "approved"})
    assert resp2.json()["total"] == 1
    assert resp2.json()["items"][0]["name_ko"] == "참가사A"


def test_sub_sees_all_exhibitors_but_only_own_buyers(client, db_factory):
    event_id = _seed_event(db_factory)
    sub_id = _seed_organizer(db_factory)
    other_sub_id = _seed_organizer(db_factory)
    _seed_org_role(db_factory, event_id, is_exhibitor=True, org_name="참가사(열람만)")
    _seed_org_role(db_factory, event_id, is_buyer=True, managing_organizer_id=sub_id, org_name="내바이어")
    _seed_org_role(db_factory, event_id, is_buyer=True, managing_organizer_id=other_sub_id, org_name="남의바이어")

    _as_sub(event_id, organizer_id=sub_id)
    resp = client.get(f"/api/admin/events/{event_id}/organizations")
    assert resp.status_code == 200
    names = {i["name_ko"] for i in resp.json()["items"]}
    assert names == {"참가사(열람만)", "내바이어"}  # 관할 밖 바이어는 제외


def test_list_organizations_enriches_contact_booth_and_categories(client, db_factory):
    """명단이 담당자·부스·사업분야/관심분야를 전부 "-"로만 보여주던 버그의 회귀 테스트 —
    OrganizationListItem이 exhibitor_profiles/buyer_profiles를 LEFT JOIN해 채우는지 확인한다."""
    event_id = _seed_event(db_factory)
    db = db_factory()
    try:
        # 참가사 — 대표자/부스/사업분야(ExhibitorKeyword)까지 채운다.
        ex_org = Organization(name_ko="게임기업")
        db.add(ex_org)
        db.flush()
        ex_role = OrganizationEventRole(
            organization_id=ex_org.id, event_id=event_id, is_exhibitor=True, application_status="approved",
        )
        db.add(ex_role)
        db.flush()
        ex_profile = ExhibitorProfile(
            org_event_role_id=ex_role.id,
            representative_name_ko="김대표",
            company_email="rep@game.example",
            main_tel="02-1111-2222",
            booth_hall="9",
            booth_pavilion="게임관",
            booth_location="A-101",
            booth_type="독립부스",
            booth_count=2,
            content_category="comics_game_music",
        )
        db.add(ex_profile)
        db.flush()
        kw_game = db.execute(select(Keyword).where(Keyword.code == "game_production")).scalar_one()
        db.add(ExhibitorKeyword(exhibitor_profile_id=ex_profile.id, keyword_id=kw_game.id))

        # 바이어 — 신청자 식별(BM-001 step1) + 첫 담당자(attendee) + 관심분야/참가자구분까지 채운다.
        by_org = Organization(name_ko="1등회사inc")
        db.add(by_org)
        db.flush()
        by_role = OrganizationEventRole(
            organization_id=by_org.id, event_id=event_id, is_buyer=True, application_status="approved",
        )
        db.add(by_role)
        db.flush()
        by_profile = BuyerProfile(
            org_event_role_id=by_role.id,
            contact_name_ko="난몰라",
            contact_name_en="Nanmolla",
            contact_title_ko="팀장",
            contact_email="qwer@qwer.com",
            contact_language="en",
            contact_interpreter_need=True,
            country="vietnam",
            city_state="Hanoi",
            tel="024-000-0000",
        )
        db.add(by_profile)
        db.flush()
        db.add(
            BuyerAttendee(
                buyer_profile_id=by_profile.id, first_name="Jane", last_name="Doe",
                email="jane@buyer.example", sort_order=0,
            )
        )
        kw_content = db.execute(select(Keyword).where(Keyword.code == "content_production")).scalar_one()
        db.add(BuyerInterestKeyword(buyer_profile_id=by_profile.id, keyword_id=kw_content.id))
        kw_org_type = db.execute(
            select(Keyword).where(Keyword.category == "org_type", Keyword.code == "private_commercial")
        ).scalar_one()
        db.add(OrgEventRoleOrgType(org_event_role_id=by_role.id, keyword_id=kw_org_type.id))
        db.commit()
    finally:
        db.close()

    _as_master(event_id)
    resp = client.get(f"/api/admin/events/{event_id}/organizations")
    assert resp.status_code == 200
    items = {i["name_ko"]: i for i in resp.json()["items"]}

    exhibitor_item = items["게임기업"]
    assert exhibitor_item["contact_name"] == "김대표"
    assert exhibitor_item["contact_email"] == "rep@game.example"
    assert exhibitor_item["contact_phone"] == "02-1111-2222"
    assert exhibitor_item["representative_name_ko"] == "김대표"
    assert exhibitor_item["booth_hall"] == "9"
    assert exhibitor_item["booth_pavilion"] == "게임관"
    assert exhibitor_item["booth_location"] == "A-101"
    assert exhibitor_item["booth_type"] == "독립부스"
    assert exhibitor_item["booth_count"] == 2
    assert exhibitor_item["content_category"] == "comics_game_music"
    assert exhibitor_item["exhibition_categories"] == ["game_production"]
    # 바이어 전용 필드는 참가사 행에서 전부 비어 있다(지어내지 않는다).
    assert exhibitor_item["contact_name_ko"] is None
    assert exhibitor_item["interest_categories"] == []

    buyer_item = items["1등회사inc"]
    assert buyer_item["contact_name_ko"] == "난몰라"
    assert buyer_item["contact_name_en"] == "Nanmolla"
    assert buyer_item["contact_title_ko"] == "팀장"
    assert buyer_item["contact_language"] == "en"
    assert buyer_item["contact_interpreter_need"] is True
    assert buyer_item["country"] == "vietnam"
    assert buyer_item["city_state"] == "Hanoi"
    assert buyer_item["tel"] == "024-000-0000"
    assert buyer_item["interest_categories"] == ["content_production"]
    assert buyer_item["org_types"] == ["private_commercial"]
    # 공통 담당자 필드 — 대표자명이 없으니 이름은 첫 담당자로 폴백, 이메일은 바이어 자신의 등록값 우선.
    assert buyer_item["contact_name"] == "Jane Doe"
    assert buyer_item["contact_email"] == "qwer@qwer.com"
    assert buyer_item["contact_phone"] == "024-000-0000"
    # 참가사 전용 필드는 바이어 행에서 전부 비어 있다.
    assert buyer_item["representative_name_ko"] is None
    assert buyer_item["exhibition_categories"] == []


def test_list_organizations_exposes_meeting_count_and_proxy_flag(client, db_factory):
    """이슈 #15 ①·② 회귀 — 목록 API가 미팅 건수·대리작성 감사 플래그를 실제로 내려주는지 확인한다.

    ①: match_count는 서비스가 이미 집계하고 있었다(list_organizations의 match_counts) — 프론트가
    안 쓰고 있었을 뿐이라 여기선 백엔드 계약만 잠근다.
    ②: proxy_written_by_organizer_id는 OrganizationDetail(상세)에만 있고 목록 응답엔 없었다 — 쓰기는
    되는데 읽기가 빠진 버그였다. 목록 스키마에 추가한 값을 여기서 확인한다.
    """
    event_id = _seed_event(db_factory)
    exhibitor = _seed_org_role(db_factory, event_id, is_exhibitor=True, org_name="합성참가사 A", application_status="approved")
    buyer = _seed_org_role(db_factory, event_id, is_buyer=True, org_name="합성바이어 B", application_status="approved")
    untouched = _seed_org_role(db_factory, event_id, is_exhibitor=True, org_name="합성참가사 C", application_status="registered")

    # 두 기업 모두 같은 미팅 2건을 센다(취소/거절/만료 제외).
    _seed_meeting(db_factory, event_id, exhibitor["org_id"], buyer["org_id"])
    _seed_meeting(db_factory, event_id, exhibitor["org_id"], buyer["org_id"])
    # 취소된 미팅은 카운트에서 빠져야 한다.
    _seed_meeting(db_factory, event_id, exhibitor["org_id"], buyer["org_id"], status="cancelled")

    # 마지막 참가사만 대리작성 — proxy-profile 저장 경로로 감사 컬럼을 채운다.
    _as_master(event_id, member_id="mbr-proxy-writer")
    resp = client.post(
        f"/api/admin/events/{event_id}/organizations/{untouched['org_id']}/proxy-profile",
        params={"role": "exhibitor"},
        json={"organization_name_ko": "합성참가사 C"},
    )
    assert resp.status_code == 200

    resp = client.get(f"/api/admin/events/{event_id}/organizations")
    assert resp.status_code == 200
    items = {i["name_ko"]: i for i in resp.json()["items"]}

    assert items["합성참가사 A"]["match_count"] == 2
    assert items["합성바이어 B"]["match_count"] == 2
    assert items["합성참가사 A"]["proxy_written_by_organizer_id"] is None

    assert items["합성참가사 C"]["proxy_written_by_organizer_id"] is not None


# =============================================================================
# 참가기업 단건 등록 / 삭제 (roster 없이 운영자가 한 건씩 CRUD)
# =============================================================================
def test_create_organization_appears_in_list(client, db_factory):
    event_id = _seed_event(db_factory)
    _as_master(event_id)
    resp = client.post(
        f"/api/admin/events/{event_id}/organizations",
        json={
            "name_ko": "새참가사",
            "name_en": "New Exhibitor",
            "role": "exhibitor",
            "contact_name": "김담당",
            "contact_email": "kim@new-exhibitor.example",
            "contact_phone": "010-1234-5678",
        },
    )
    assert resp.status_code == 201
    body = resp.json()
    assert body["name_ko"] == "새참가사"
    assert body["is_exhibitor"] is True
    assert body["is_buyer"] is False
    assert body["application_status"] == "registered"

    listed = client.get(f"/api/admin/events/{event_id}/organizations").json()
    assert body["id"] in {i["id"] for i in listed["items"]}

    # 담당자(member)도 함께 생겼는지 — 신청서 상세로는 확인 안 되니 DB로 직접.
    db = db_factory()
    try:
        member = db.query(Member).filter_by(organization_id=body["id"]).one()
        assert member.email == "kim@new-exhibitor.example"
    finally:
        db.close()

    # 회귀(H4, 2026-09-12): 신청서 미제출 기업(exhibitor/buyer 프로필 없음)도 등록 당시 입력한
    # 담당자명·이메일·전화가 목록에서 "-"로 사라지지 않아야 한다 — resolve_primary_contact가
    # members 테이블을 최후 폴백으로 본다(list_organizations).
    new_item = next(i for i in listed["items"] if i["id"] == body["id"])
    assert new_item["contact_name"] == "김담당"
    assert new_item["contact_email"] == "kim@new-exhibitor.example"
    assert new_item["contact_phone"] == "010-1234-5678"


def test_create_organization_duplicate_contact_email_409(client, db_factory):
    event_id = _seed_event(db_factory)
    _as_master(event_id)
    payload = {
        "name_ko": "회사A",
        "role": "buyer",
        "contact_email": "dup@example.com",
    }
    first = client.post(f"/api/admin/events/{event_id}/organizations", json=payload)
    assert first.status_code == 201

    dup = client.post(
        f"/api/admin/events/{event_id}/organizations",
        json={**payload, "name_ko": "회사B"},
    )
    assert dup.status_code == 409


def test_create_organization_sub_forbidden_403(wired_client, db_factory, event_a):
    """sub의 **참가사** 단건 등록은 계속 403 — 2026-09-21에 단건 등록을 master+sub로 열었지만
    sub 몫은 바이어뿐이다(service.check_create_jurisdiction, 명단 업로드의 buyer_only와 같은 규칙).
    sub가 바이어를 만드는 경로와 관할 귀속은 tests/test_admin_contact_password.py가 따로 고정한다."""
    db = db_factory()
    try:
        db.add(Event(id=event_a, name="단건등록 권한 확인", slug=f"create-org-{next(_seq)}"))
        db.commit()
    finally:
        db.close()

    resp = wired_client.post(
        f"/api/admin/events/{event_a}/organizations",
        json={"name_ko": "X", "role": "exhibitor"},
        headers={"Authorization": "Bearer access-mbr-sub-1"},
    )
    assert resp.status_code == 403


def test_delete_organization_removes_role_and_org(client, db_factory):
    event_id = _seed_event(db_factory)
    seeded = _seed_org_role(db_factory, event_id, is_exhibitor=True, org_name="삭제될기업")
    _as_master(event_id)

    resp = client.delete(f"/api/admin/events/{event_id}/organizations/{seeded['org_id']}")
    assert resp.status_code == 204

    listed = client.get(f"/api/admin/events/{event_id}/organizations").json()
    assert seeded["org_id"] not in {i["id"] for i in listed["items"]}

    # 마지막 role이었으니 org 자체도 사라졌다.
    db = db_factory()
    try:
        assert db.get(Organization, seeded["org_id"]) is None
    finally:
        db.close()


def test_delete_organization_with_meetings_409(client, db_factory):
    """확정(accepted) 미팅이 있는 기업은 409 — meetings.exhibitor_org_id/buyer_org_id는 ondelete 없는
    FK라 선검사가 없으면 500이 난다. 취소·거절된 미팅만 있는 기업은 지워진다 — 상태별 규칙과 "무엇이
    함께 지워지는가"는 tests/test_admin_org_delete.py가 고정한다."""
    event_id = _seed_event(db_factory)
    exhibitor = _seed_org_role(db_factory, event_id, is_exhibitor=True)
    buyer = _seed_org_role(db_factory, event_id, is_buyer=True)
    _seed_meeting(db_factory, event_id, exhibitor["org_id"], buyer["org_id"])
    _as_master(event_id)

    resp = client.delete(f"/api/admin/events/{event_id}/organizations/{exhibitor['org_id']}")
    assert resp.status_code == 409
    detail = resp.json()["detail"]
    assert detail["code"] == "ORG_HAS_MEETINGS"
    assert detail["meeting_count"] == 1
    assert (detail["scheduled_count"], detail["completed_count"]) == (1, 0)

    # 삭제되지 않고 그대로 남아 있다.
    listed = client.get(f"/api/admin/events/{event_id}/organizations").json()
    assert exhibitor["org_id"] in {i["id"] for i in listed["items"]}


def test_delete_organization_sub_forbidden_403(wired_client, db_factory, event_a):
    db = db_factory()
    try:
        db.add(Event(id=event_a, name="삭제 권한 확인", slug=f"delete-org-{next(_seq)}"))
        db.commit()
    finally:
        db.close()
    seeded = _seed_org_role(db_factory, event_a, is_exhibitor=True)

    resp = wired_client.delete(
        f"/api/admin/events/{event_a}/organizations/{seeded['org_id']}",
        headers={"Authorization": "Bearer access-mbr-sub-1"},
    )
    assert resp.status_code == 403


def test_get_organization_404_for_unknown(client, db_factory):
    event_id = _seed_event(db_factory)
    _as_master(event_id)
    resp = client.get(f"/api/admin/events/{event_id}/organizations/00000000-0000-0000-0000-000000000000")
    assert resp.status_code == 404


def test_sub_forbidden_from_out_of_jurisdiction_buyer_detail(client, db_factory):
    event_id = _seed_event(db_factory)
    sub_id = _seed_organizer(db_factory)
    other_sub_id = _seed_organizer(db_factory)
    other_buyer = _seed_org_role(db_factory, event_id, is_buyer=True, managing_organizer_id=other_sub_id)

    _as_sub(event_id, organizer_id=sub_id)
    resp = client.get(f"/api/admin/events/{event_id}/organizations/{other_buyer['org_id']}")
    assert resp.status_code == 403


def test_sub_can_read_exhibitor_detail_regardless_of_jurisdiction(client, db_factory):
    event_id = _seed_event(db_factory)
    sub_id = _seed_organizer(db_factory)
    exhibitor = _seed_org_role(db_factory, event_id, is_exhibitor=True)

    _as_sub(event_id, organizer_id=sub_id)
    resp = client.get(f"/api/admin/events/{event_id}/organizations/{exhibitor['org_id']}")
    assert resp.status_code == 200


# =============================================================================
# 직접수정 / 대리작성
# =============================================================================
def test_master_direct_patch_updates_buyer_profile(client, db_factory):
    event_id = _seed_event(db_factory)
    buyer = _seed_org_role(db_factory, event_id, is_buyer=True)
    _as_master(event_id)

    resp = client.patch(
        f"/api/admin/events/{event_id}/organizations/{buyer['org_id']}/profile",
        params={"role": "buyer"},
        json={"organization_name_ko": "슈퍼어드민이 고침", "continent": "Asia"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["organization_name_ko"] == "슈퍼어드민이 고침"
    assert body["continent"] == "Asia"


def test_direct_patch_role_mismatch_409(client, db_factory):
    event_id = _seed_event(db_factory)
    buyer = _seed_org_role(db_factory, event_id, is_buyer=True)
    _as_master(event_id)
    resp = client.patch(
        f"/api/admin/events/{event_id}/organizations/{buyer['org_id']}/profile",
        params={"role": "exhibitor"},
        json={"organization_name_ko": "X"},
    )
    assert resp.status_code == 409


def test_master_proxy_profile_auto_approves_and_enters_matching_pool(client, db_factory):
    event_id = _seed_event(db_factory)
    exhibitor = _seed_org_role(db_factory, event_id, is_exhibitor=True, application_status="registered")
    _as_master(event_id, member_id="mbr-proxy-writer")

    resp = client.post(
        f"/api/admin/events/{event_id}/organizations/{exhibitor['org_id']}/proxy-profile",
        params={"role": "exhibitor"},
        json={"organization_name_ko": "엑셀만 있는 기업", "main_tel": "02-0000-0000"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["organization_name_ko"] == "엑셀만 있는 기업"
    assert body["application_status"] == "approved"

    db = db_factory()
    try:
        role = db.get(OrganizationEventRole, exhibitor["role_id"])
        assert role.application_status == "approved"
        assert role.proxy_written_by_organizer_id is not None  # 감사 컬럼 채워짐
        assert role.reviewed_by == role.proxy_written_by_organizer_id
        assert role.reviewed_at is not None
        assert exhibitor["org_id"] in bm_service.select_exposed_org_ids(
            db, event_id, role="exhibitor"
        )
        # 실제 매칭 경로는 포화배정(create_saturation_run)이 쓰는 _zero_meeting_org_ids다 —
        # select_exposed_org_ids는 프로덕션 호출처가 없으니 그것만 보면 회로를 놓친다.
        assert exhibitor["org_id"] in _zero_meeting_org_ids(db, event_id, role_flag="exhibitor")

        organizer = db.get(Organizer, role.proxy_written_by_organizer_id)
        assert organizer.member_id == "mbr-proxy-writer"  # 대행한 슈퍼어드민 계정으로 귀속
    finally:
        db.close()


def test_proxy_profile_blocked_once_already_submitted_409(client, db_factory):
    event_id = _seed_event(db_factory)
    exhibitor = _seed_org_role(db_factory, event_id, is_exhibitor=True, application_status="submitted")
    _as_master(event_id)
    resp = client.post(
        f"/api/admin/events/{event_id}/organizations/{exhibitor['org_id']}/proxy-profile",
        params={"role": "exhibitor"},
        json={"organization_name_ko": "이미 제출됨"},
    )
    assert resp.status_code == 409


# =============================================================================
# 직접수정 / 대리작성 — sub 운영자 개방(ADR-0012 개정, 2026-09-09)
# 기업 신청서 편집·대리작성은 master+sub 공용. sub는 관할 기업만(읽기 관할 필터 미러) — 관할 밖 403.
# 거버넌스(역할 전환·검토·운영자 부여)는 여전히 master 전용(이 파일 다른 절에서 검증).
# =============================================================================
def test_sub_can_direct_patch_managed_buyer(client, db_factory):
    event_id = _seed_event(db_factory)
    sub_id = _seed_organizer(db_factory)
    my_buyer = _seed_org_role(db_factory, event_id, is_buyer=True, managing_organizer_id=sub_id)
    _as_sub(event_id, organizer_id=sub_id)

    resp = client.patch(
        f"/api/admin/events/{event_id}/organizations/{my_buyer['org_id']}/profile",
        params={"role": "buyer"},
        json={"organization_name_ko": "sub가 고친 관할 바이어"},
    )
    assert resp.status_code == 200
    assert resp.json()["organization_name_ko"] == "sub가 고친 관할 바이어"


def test_sub_can_proxy_write_exhibitor_and_add_attendee(client, db_factory):
    """핵심 목적 — sub가 셀프가입 참가사(미신청)의 신청서를 대리작성하며 담당자(attendee)를 보강."""
    event_id = _seed_event(db_factory)
    sub_id = _seed_organizer(db_factory)
    exhibitor = _seed_org_role(
        db_factory, event_id, is_exhibitor=True, application_status="registered"
    )
    _as_sub(event_id, organizer_id=sub_id)

    resp = client.post(
        f"/api/admin/events/{event_id}/organizations/{exhibitor['org_id']}/proxy-profile",
        params={"role": "exhibitor"},
        json={
            "organization_name_ko": "sub가 대리작성",
            "attendees": [{"last_name_ko": "김", "first_name_ko": "담당", "email": "lead@x.com"}],
        },
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["organization_name_ko"] == "sub가 대리작성"
    assert body["application_status"] == "submitted"  # sub 대리작성은 master 승인 대기로 전환
    assert len(body["attendees"]) == 1  # 담당자 보강됨(0명 → 1명)
    assert body["attendees"][0]["last_name_ko"] == "김"


def test_sub_forbidden_direct_patch_out_of_jurisdiction_buyer_403(client, db_factory):
    event_id = _seed_event(db_factory)
    sub_id = _seed_organizer(db_factory)
    other_sub_id = _seed_organizer(db_factory)
    other_buyer = _seed_org_role(
        db_factory, event_id, is_buyer=True, managing_organizer_id=other_sub_id
    )
    _as_sub(event_id, organizer_id=sub_id)

    resp = client.patch(
        f"/api/admin/events/{event_id}/organizations/{other_buyer['org_id']}/profile",
        params={"role": "buyer"},
        json={"organization_name_ko": "관할 밖 침범 시도"},
    )
    assert resp.status_code == 403


def test_sub_forbidden_proxy_write_out_of_jurisdiction_buyer_403_not_409(client, db_factory):
    """관할 검사가 상태(409) 검사보다 먼저 — 관할 밖 기업의 신청 상태를 sub에게 흘리지 않는다."""
    event_id = _seed_event(db_factory)
    sub_id = _seed_organizer(db_factory)
    other_sub_id = _seed_organizer(db_factory)
    # registered(대리작성 가능한 상태)이지만 관할 밖 — 403이어야 하고 409여선 안 된다.
    other_buyer = _seed_org_role(
        db_factory, event_id, is_buyer=True, application_status="registered",
        managing_organizer_id=other_sub_id,
    )
    _as_sub(event_id, organizer_id=sub_id)

    resp = client.post(
        f"/api/admin/events/{event_id}/organizations/{other_buyer['org_id']}/proxy-profile",
        params={"role": "buyer"},
        json={"organization_name_ko": "관할 밖 대리작성 시도"},
    )
    assert resp.status_code == 403


def test_profile_write_opens_to_sub_but_scoped_through_real_guard_wiring(
    wired_client, db_factory, event_a
):
    """override 없이 실 가드 배선 — sub는 이제 참가사 대리작성이 되지만(개방), 관할 밖 바이어는 막힌다.

    master는 동일 요청이 그대로 통과(가드가 라우트를 통째로 연 게 아니라 관할로 스코프한다는 확인).
    """
    _seed_event(db_factory, id=event_a)
    exhibitor = _seed_org_role(
        db_factory, event_a, is_exhibitor=True, application_status="registered"
    )
    other_organizer_id = _seed_organizer(db_factory, member_id="mbr-other-owner")
    out_buyer = _seed_org_role(
        db_factory, event_a, is_buyer=True, managing_organizer_id=other_organizer_id
    )
    sub = {"Authorization": "Bearer access-mbr-sub-1"}
    master = {"Authorization": "Bearer access-mbr-master-1"}

    # sub: 참가사(공유풀) 대리작성 통과.
    opened = wired_client.post(
        f"/api/admin/events/{event_a}/organizations/{exhibitor['org_id']}/proxy-profile",
        params={"role": "exhibitor"},
        json={"organization_name_ko": "sub 실배선 대리작성"},
        headers=sub,
    )
    assert opened.status_code == 200

    # sub: 관할 밖 바이어 직접수정 차단(403).
    denied = wired_client.patch(
        f"/api/admin/events/{event_a}/organizations/{out_buyer['org_id']}/profile",
        params={"role": "buyer"},
        json={"organization_name_ko": "관할 밖"},
        headers=sub,
    )
    assert denied.status_code == 403

    # master: 같은 관할 밖 바이어도 전역 통과.
    ok = wired_client.patch(
        f"/api/admin/events/{event_a}/organizations/{out_buyer['org_id']}/profile",
        params={"role": "buyer"},
        json={"organization_name_ko": "master 전역"},
        headers=master,
    )
    assert ok.status_code == 200


# =============================================================================
# 부스 지정(운영자) — 발주자 요구 2026-09-28
#
# "부스넘버를 관리자가 입력할 수 있게" + "입력값을 미팅 신청할 때 보일 수 있도록". 저장 필드는
# ``exhibitor_profiles.booth_location``이고, 그 값이 미팅 신청 장소 단계 문구가 된다
# (``app.meetings.service._booth_presentation`` — 화면 문구 회귀는 test_meetings_availability.py).
# 쓰기 권한은 master 전용이다(행사장 배치는 승인 심사·역할 전환과 같은 master 소관 축).
# =============================================================================
def test_master_assigns_booth_number_through_profile_patch(client, db_factory):
    event_id = _seed_event(db_factory)
    exhibitor = _seed_org_role(
        db_factory, event_id, is_exhibitor=True, application_status="approved"
    )
    _as_master(event_id)

    resp = client.patch(
        f"/api/admin/events/{event_id}/organizations/{exhibitor['org_id']}/profile",
        params={"role": "exhibitor"},
        json={"booth_location": "01"},
    )
    assert resp.status_code == 200
    assert resp.json()["booth_location"] == "01"

    # 재조회(운영자 콘솔 새로고침) — 응답만이 아니라 DB에 남아야 한다.
    detail = client.get(f"/api/admin/events/{event_id}/organizations/{exhibitor['org_id']}")
    assert detail.json()["exhibitor_profile"]["booth_location"] == "01"
    db = db_factory()
    try:
        profile = db.execute(
            select(ExhibitorProfile).where(
                ExhibitorProfile.org_event_role_id == exhibitor["role_id"]
            )
        ).scalar_one()
        assert profile.booth_location == "01"
    finally:
        db.close()


def test_master_can_clear_an_assigned_booth_number(client, db_factory):
    """부스 칸의 주인은 운영자다 — 비워 보내면 "안 건드림"이 아니라 미배정으로 돌아간다.

    다른 자유텍스트 필드는 빈 값을 omit하지만(지움 의도를 구분할 수 없음), 부스는 이 화면이 유일한
    쓰기 경로라 빈 값이 곧 "부스 없음"이다 — 미팅 화면도 번호 없는 문구로 되돌아간다.
    """
    event_id = _seed_event(db_factory)
    exhibitor = _seed_org_role(
        db_factory, event_id, is_exhibitor=True, application_status="approved"
    )
    _as_master(event_id)
    base = f"/api/admin/events/{event_id}/organizations/{exhibitor['org_id']}/profile"

    client.patch(base, params={"role": "exhibitor"}, json={"booth_location": "01"})
    cleared = client.patch(base, params={"role": "exhibitor"}, json={"booth_location": ""})
    assert cleared.status_code == 200
    assert cleared.json()["booth_location"] == ""


def test_sub_cannot_assign_booth_but_still_edits_the_rest(client, db_factory):
    """sub는 신청서는 고치지만 부스는 못 건드린다 — 403이고, 기존 부스 값도 그대로 남는다."""
    event_id = _seed_event(db_factory)
    sub_id = _seed_organizer(db_factory)
    exhibitor = _seed_org_role(
        db_factory, event_id, is_exhibitor=True, application_status="approved"
    )
    _as_master(event_id)
    base = f"/api/admin/events/{event_id}/organizations/{exhibitor['org_id']}/profile"
    client.patch(base, params={"role": "exhibitor"}, json={"booth_location": "01"})

    _as_sub(event_id, organizer_id=sub_id)
    denied = client.patch(base, params={"role": "exhibitor"}, json={"booth_location": "99"})
    assert denied.status_code == 403

    # 부스 없는 편집은 sub도 그대로 통과한다(가드가 필드 단위라 경로를 닫지 않는다).
    ok = client.patch(base, params={"role": "exhibitor"}, json={"main_tel": "02-9999-0000"})
    assert ok.status_code == 200
    assert ok.json()["main_tel"] == "02-9999-0000"
    assert ok.json()["booth_location"] == "01"  # master가 넣은 값이 살아 있다


def test_sub_cannot_assign_booth_through_proxy_write_either(client, db_factory):
    """대리작성 경로도 같은 규칙 — sub가 부스를 실으면 403이고 상태 전이도 일어나지 않는다."""
    event_id = _seed_event(db_factory)
    sub_id = _seed_organizer(db_factory)
    exhibitor = _seed_org_role(
        db_factory, event_id, is_exhibitor=True, application_status="registered"
    )
    _as_sub(event_id, organizer_id=sub_id)

    denied = client.post(
        f"/api/admin/events/{event_id}/organizations/{exhibitor['org_id']}/proxy-profile",
        params={"role": "exhibitor"},
        json={"organization_name_ko": "부스까지 넣어보는 sub", "booth_location": "99"},
    )
    assert denied.status_code == 403

    db = db_factory()
    try:
        role = db.get(OrganizationEventRole, exhibitor["role_id"])
        assert role.application_status == "registered"  # 상태 전이 없음(원자성)
    finally:
        db.close()


def test_master_assigns_booth_through_proxy_write(client, db_factory):
    """미신청 기업은 대리작성 한 번에 부스까지 지정된다(master)."""
    event_id = _seed_event(db_factory)
    exhibitor = _seed_org_role(
        db_factory, event_id, is_exhibitor=True, application_status="registered"
    )
    _as_master(event_id)

    resp = client.post(
        f"/api/admin/events/{event_id}/organizations/{exhibitor['org_id']}/proxy-profile",
        params={"role": "exhibitor"},
        json={"organization_name_ko": "명단만 있던 기업", "booth_location": "B-07"},
    )
    assert resp.status_code == 200
    assert resp.json()["booth_location"] == "B-07"
    assert resp.json()["application_status"] == "approved"


def test_booth_field_is_not_accepted_on_a_buyer_profile(client, db_factory):
    """부스는 참가사 축이다 — 바이어 스키마엔 없으므로 422(extra=forbid)."""
    event_id = _seed_event(db_factory)
    buyer = _seed_org_role(db_factory, event_id, is_buyer=True, application_status="approved")
    _as_master(event_id)

    resp = client.patch(
        f"/api/admin/events/{event_id}/organizations/{buyer['org_id']}/profile",
        params={"role": "buyer"},
        json={"booth_location": "01"},
    )
    assert resp.status_code == 422


# =============================================================================
# 불가슬롯 운영자 관리
# =============================================================================
def test_admin_sets_unavailable_slots(client, db_factory):
    event_id = _seed_event(db_factory)
    exhibitor = _seed_org_role(db_factory, event_id, is_exhibitor=True)
    _as_master(event_id)

    slots = ["2027-03-10T09:00", "2027-03-10T09:30"]
    resp = client.patch(
        f"/api/admin/events/{event_id}/organizations/{exhibitor['org_id']}/unavailable-slots",
        json={"slots": slots},
    )
    assert resp.status_code == 200
    assert resp.json()["unavailable_meeting_slots"] == slots


def test_admin_unavailable_slots_survive_reload(client, db_factory):
    """H8 회귀 — PATCH는 예전에도 200이었고 실제로도 저장됐다(위 테스트). 문제는 되돌려줄 GET이
    아예 없어서 프론트 설정 화면이 새로고침 때마다 빈 배열로 다시 채웠던 것 — GET이 PATCH 직후
    같은 값을 돌려주는지 확인한다."""
    event_id = _seed_event(db_factory)
    exhibitor = _seed_org_role(db_factory, event_id, is_exhibitor=True)
    other_exhibitor = _seed_org_role(db_factory, event_id, is_exhibitor=True)
    _as_master(event_id)

    slots = ["2027-03-10T09:00", "2027-03-10T09:30"]
    client.patch(
        f"/api/admin/events/{event_id}/organizations/{exhibitor['org_id']}/unavailable-slots",
        json={"slots": slots},
    )

    # 재조회(새로고침 시뮬레이션) — PATCH 응답이 아니라 별도 GET으로 값이 그대로 남아 있어야 한다.
    got = client.get(f"/api/admin/events/{event_id}/unavailable-slots")
    assert got.status_code == 200
    body = got.json()
    assert body[exhibitor["org_id"]] == slots
    # 손대지 않은 기업은 빈 배열(또는 키 없음)로 남아, 다른 기업 데이터가 섞이지 않는다.
    assert body.get(other_exhibitor["org_id"], []) == []


# =============================================================================
# 참가 기업 역할 전환(#OP 역할 관리) — master 전용
# =============================================================================
def test_update_organization_role_switches_flags(client, db_factory):
    event_id = _seed_event(db_factory)
    exhibitor = _seed_org_role(db_factory, event_id, is_exhibitor=True)
    _as_master(event_id)

    resp = client.patch(
        f"/api/admin/events/{event_id}/organizations/{exhibitor['org_id']}/role",
        json={"role": "buyer"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["is_exhibitor"] is False
    assert body["is_buyer"] is True

    db = db_factory()
    try:
        role = db.get(OrganizationEventRole, exhibitor["role_id"])
        assert role.is_exhibitor is False
        assert role.is_buyer is True
    finally:
        db.close()


def test_update_organization_role_rejects_invalid_value_422(client, db_factory):
    event_id = _seed_event(db_factory)
    exhibitor = _seed_org_role(db_factory, event_id, is_exhibitor=True)
    _as_master(event_id)

    resp = client.patch(
        f"/api/admin/events/{event_id}/organizations/{exhibitor['org_id']}/role",
        json={"role": "organizer"},
    )
    assert resp.status_code == 422  # ProfileRole Literal 밖 — organizer 계열은 여기로 못 들어온다


def test_update_organization_role_blocked_when_meeting_exists_409(client, db_factory):
    event_id = _seed_event(db_factory)
    exhibitor = _seed_org_role(db_factory, event_id, is_exhibitor=True)
    buyer = _seed_org_role(db_factory, event_id, is_buyer=True)
    _seed_meeting(db_factory, event_id, exhibitor["org_id"], buyer["org_id"])
    _as_master(event_id)

    resp = client.patch(
        f"/api/admin/events/{event_id}/organizations/{exhibitor['org_id']}/role",
        json={"role": "buyer"},
    )
    assert resp.status_code == 409
    assert "미팅" in resp.json()["detail"]


# =============================================================================
# 신청서 검토(승인/반려/수정요청, OP-003) — master 전용
# =============================================================================
def test_review_organization_approves_submitted(client, db_factory):
    event_id = _seed_event(db_factory)
    org = _seed_org_role(db_factory, event_id, is_exhibitor=True, application_status="submitted")
    _as_master(event_id, member_id="mbr-reviewer")

    resp = client.patch(
        f"/api/admin/events/{event_id}/organizations/{org['org_id']}/review",
        json={"status": "approved"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["application_status"] == "approved"
    assert body["reviewed_at"] is not None
    assert body["reviewed_by"] is not None
    assert body["review_note"] is None

    db = db_factory()
    try:
        role = db.get(OrganizationEventRole, org["role_id"])
        assert role.application_status == "approved"
        assert role.reviewed_at is not None
        assert role.reviewed_by is not None
    finally:
        db.close()


def test_review_organization_rejects_submitted_with_note(client, db_factory):
    event_id = _seed_event(db_factory)
    org = _seed_org_role(db_factory, event_id, is_buyer=True, application_status="submitted")
    _as_master(event_id)

    resp = client.patch(
        f"/api/admin/events/{event_id}/organizations/{org['org_id']}/review",
        json={"status": "rejected", "note": "서류 미비"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["application_status"] == "rejected"
    assert body["review_note"] == "서류 미비"


def test_review_organization_requests_changes(client, db_factory):
    event_id = _seed_event(db_factory)
    org = _seed_org_role(db_factory, event_id, is_exhibitor=True, application_status="submitted")
    _as_master(event_id)

    resp = client.patch(
        f"/api/admin/events/{event_id}/organizations/{org['org_id']}/review",
        json={"status": "changes_requested", "note": "제품 정보 보완 필요"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["application_status"] == "changes_requested"
    assert body["review_note"] == "제품 정보 보완 필요"


def test_review_organization_rejects_invalid_status_422(client, db_factory):
    event_id = _seed_event(db_factory)
    org = _seed_org_role(db_factory, event_id, is_exhibitor=True, application_status="submitted")
    _as_master(event_id)

    resp = client.patch(
        f"/api/admin/events/{event_id}/organizations/{org['org_id']}/review",
        json={"status": "registered"},
    )
    assert resp.status_code == 422  # ApplicationReviewDecision Literal 밖


def test_review_organization_not_found_404(client, db_factory):
    event_id = _seed_event(db_factory)
    _as_master(event_id)

    resp = client.patch(
        f"/api/admin/events/{event_id}/organizations/{uuid.uuid4()}/review",
        json={"status": "approved"},
    )
    assert resp.status_code == 404


def test_review_organization_blocks_transition_from_non_submitted_409(client, db_factory):
    event_id = _seed_event(db_factory)
    already_approved = _seed_org_role(db_factory, event_id, is_exhibitor=True, application_status="approved")
    not_yet_submitted = _seed_org_role(db_factory, event_id, is_buyer=True, application_status="registered")
    _as_master(event_id)

    resp1 = client.patch(
        f"/api/admin/events/{event_id}/organizations/{already_approved['org_id']}/review",
        json={"status": "approved"},
    )
    assert resp1.status_code == 409

    resp2 = client.patch(
        f"/api/admin/events/{event_id}/organizations/{not_yet_submitted['org_id']}/review",
        json={"status": "approved"},
    )
    assert resp2.status_code == 409


def test_review_organization_approve_sends_application_approved_notification(client, db_factory):
    event_id = _seed_event(db_factory)
    org = _seed_org_role(db_factory, event_id, is_exhibitor=True, application_status="submitted")
    _as_master(event_id)

    resp = client.patch(
        f"/api/admin/events/{event_id}/organizations/{org['org_id']}/review",
        json={"status": "approved"},
    )
    assert resp.status_code == 200

    db = db_factory()
    try:
        rows = db.execute(
            select(Notification).where(
                Notification.recipient_org_id == org["org_id"],
                Notification.type == "application_approved",
            )
        ).scalars().all()
        assert len(rows) == 1
        assert rows[0].payload == {"org_name": "테스트기업", "role": "exhibitor"}
    finally:
        db.close()


def test_review_organization_reject_and_changes_requested_send_no_notification(client, db_factory):
    event_id = _seed_event(db_factory)
    rejected = _seed_org_role(db_factory, event_id, is_buyer=True, application_status="submitted")
    needs_changes = _seed_org_role(db_factory, event_id, is_exhibitor=True, application_status="submitted")
    _as_master(event_id)

    resp1 = client.patch(
        f"/api/admin/events/{event_id}/organizations/{rejected['org_id']}/review",
        json={"status": "rejected", "note": "서류 미비"},
    )
    assert resp1.status_code == 200

    resp2 = client.patch(
        f"/api/admin/events/{event_id}/organizations/{needs_changes['org_id']}/review",
        json={"status": "changes_requested", "note": "제품 정보 보완 필요"},
    )
    assert resp2.status_code == 200

    db = db_factory()
    try:
        rows = db.execute(
            select(Notification).where(
                Notification.recipient_org_id.in_([rejected["org_id"], needs_changes["org_id"]]),
                Notification.type == "application_approved",
            )
        ).scalars().all()
        assert rows == []
    finally:
        db.close()


def test_review_organization_reapproval_after_changes_requested_does_not_duplicate_notification(
    client, db_factory
):
    """반려/수정요청 후 재제출→재승인해도 승인 통지가 org당 최초 1회만 나간다(멱등, 중복 폭탄 방지)."""
    event_id = _seed_event(db_factory)
    org = _seed_org_role(db_factory, event_id, is_exhibitor=True, application_status="submitted")
    _as_master(event_id)

    first = client.patch(
        f"/api/admin/events/{event_id}/organizations/{org['org_id']}/review",
        json={"status": "approved"},
    )
    assert first.status_code == 200

    # 재제출 사이클을 흉내낸다 — 검토 전이는 submitted에서만 가능하므로 DB에서 직접 되돌린다
    # (bm 쪽 실제 재제출 플로우는 이 테스트의 관심사가 아니다).
    db = db_factory()
    try:
        role = db.get(OrganizationEventRole, org["role_id"])
        role.application_status = "submitted"
        db.commit()
    finally:
        db.close()

    second = client.patch(
        f"/api/admin/events/{event_id}/organizations/{org['org_id']}/review",
        json={"status": "approved"},
    )
    assert second.status_code == 200

    db = db_factory()
    try:
        rows = db.execute(
            select(Notification).where(
                Notification.recipient_org_id == org["org_id"],
                Notification.type == "application_approved",
            )
        ).scalars().all()
        assert len(rows) == 1  # 두 번째 승인은 멱등 유니크에 걸려 재통지되지 않는다
    finally:
        db.close()


def test_review_organization_rejects_sub_through_real_guard_wiring(wired_client, db_factory, event_a):
    _seed_event(db_factory, id=event_a)
    org = _seed_org_role(db_factory, event_a, is_exhibitor=True, application_status="submitted")

    resp = wired_client.patch(
        f"/api/admin/events/{event_a}/organizations/{org['org_id']}/review",
        json={"status": "approved"},
        headers={"Authorization": "Bearer access-mbr-sub-1"},
    )
    assert resp.status_code == 403  # sub는 검토 불가(master 전용)

    ok = wired_client.patch(
        f"/api/admin/events/{event_a}/organizations/{org['org_id']}/review",
        json={"status": "approved"},
        headers={"Authorization": "Bearer access-mbr-master-1"},
    )
    assert ok.status_code == 200


# =============================================================================
# 운영자(Organizer) 관리(#OP 역할 관리) — 서브어드민 부여/회수/목록, 전부 master 전용
#
# 부여 대상은 **가입된 회원**을 로그인 이메일로 지정한다(2026-09-17). 예전엔 회원 UUID를 손으로 받아
# 없는 ID도 organizers 행(유령 운영자, 이름 "운영자 {UUID}")이 됐다 — 발주사 무역관 실계정을 이 화면으로
# 장기 운영하기 전에 막는다.
# =============================================================================
def _seed_login_member(db_factory, *, email: str, name: str = "김무역") -> str:
    """로그인 가능한 회원 1명(내부 조직 소속, 참가 역할 없음) — 운영자 계정이 실제로 생기는 모양."""
    db = db_factory()
    try:
        org = Organization(name_ko=f"KOTRA 무역관 {next(_seq)}")
        db.add(org)
        db.flush()
        member = Member(organization_id=org.id, name=name, email=email)
        db.add(member)
        db.commit()
        return str(member.id)
    finally:
        db.close()


def _unique_email(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:8]}@kotra.example.com"


def test_grant_sub_organizer_by_email_succeeds(client, db_factory):
    event_id = _seed_event(db_factory)
    email = _unique_email("trade")
    member_id = _seed_login_member(db_factory, email=email, name="박무역")
    _as_master(event_id)

    # 대소문자·공백이 섞여도 같은 회원 — 로그인 검증자도 소문자로 접어 비교한다.
    resp = client.post(
        f"/api/admin/events/{event_id}/organizers",
        json={"email": f"  {email.upper()} ", "permission_level": "sub"},
    )
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["permission_level"] == "sub"
    assert body["member_id"] == member_id  # 로그인 신원 키(members.id)로 잇는다
    assert body["name"] == "박무역"
    assert body["email"] == email

    db = db_factory()
    try:
        row = db.query(EventOrganizer).filter_by(id=body["id"]).one()
        assert row.permission_level == "sub"
        organizer = db.get(Organizer, row.organizer_id)
        assert organizer.member_id == member_id
    finally:
        db.close()

    # 응답 id(event_organizers.id)로 곧바로 회수할 수 있다 — 화면이 서버 응답 id로 행을 추가하는 근거.
    revoke = client.delete(f"/api/admin/events/{event_id}/organizers/{body['id']}")
    assert revoke.status_code == 204


def test_grant_sub_organizer_by_member_id_backward_compat(client, db_factory):
    event_id = _seed_event(db_factory)
    member_id = _seed_login_member(db_factory, email=_unique_email("compat"))
    _as_master(event_id)

    resp = client.post(
        f"/api/admin/events/{event_id}/organizers",
        json={"member_id": member_id, "permission_level": "sub"},
    )
    assert resp.status_code == 201, resp.text
    assert resp.json()["member_id"] == member_id


def test_grant_unknown_member_404_and_creates_no_ghost_organizer(client, db_factory):
    event_id = _seed_event(db_factory)
    _as_master(event_id)
    missing_email = _unique_email("nobody")

    by_email = client.post(
        f"/api/admin/events/{event_id}/organizers",
        json={"email": missing_email, "permission_level": "sub"},
    )
    assert by_email.status_code == 404
    assert by_email.json()["detail"]["code"] == "MEMBER_NOT_FOUND"

    # 하위 호환 member_id도 가입 회원이어야 한다 — 비-UUID·없는 UUID 모두 404.
    for ghost in ("mbr-new-sub", str(uuid.uuid4())):
        resp = client.post(
            f"/api/admin/events/{event_id}/organizers",
            json={"member_id": ghost, "permission_level": "sub"},
        )
        assert resp.status_code == 404
        assert resp.json()["detail"]["code"] == "MEMBER_NOT_FOUND"

    db = db_factory()
    try:
        assert db.query(EventOrganizer).filter_by(event_id=event_id).count() == 0
        assert db.query(Organizer).filter_by(member_id="mbr-new-sub").first() is None
    finally:
        db.close()


def test_grant_requires_exactly_one_target_422(client, db_factory):
    event_id = _seed_event(db_factory)
    _as_master(event_id)
    url = f"/api/admin/events/{event_id}/organizers"

    assert client.post(url, json={"permission_level": "sub"}).status_code == 422
    both = {"email": _unique_email("both"), "member_id": str(uuid.uuid4()), "permission_level": "sub"}
    assert client.post(url, json=both).status_code == 422


def test_grant_master_organizer_rejected_422(client, db_factory):
    event_id = _seed_event(db_factory)
    email = _unique_email("wannabe")
    _seed_login_member(db_factory, email=email)
    _as_master(event_id)

    resp = client.post(
        f"/api/admin/events/{event_id}/organizers",
        json={"email": email, "permission_level": "master"},
    )
    assert resp.status_code == 422
    # pydantic field_validator ValidationError는 {"detail":[{..., "msg": "Value error, ..."}]} 형태.
    assert "슈퍼어드민" in str(resp.json()["detail"])


def test_grant_organizer_already_assigned_409(client, db_factory):
    event_id = _seed_event(db_factory)
    email = _unique_email("already")
    member_id = _seed_login_member(db_factory, email=email)
    organizer_id = _seed_organizer(db_factory, member_id=member_id)
    _seed_event_organizer(db_factory, event_id, organizer_id, "sub")
    _as_master(event_id)

    resp = client.post(
        f"/api/admin/events/{event_id}/organizers",
        json={"email": email, "permission_level": "sub"},
    )
    assert resp.status_code == 409
    assert resp.json()["detail"]["code"] == "ORGANIZER_ALREADY_ASSIGNED"


def test_list_organizers_shows_member_name_and_email_not_placeholders(client, db_factory):
    """목록은 회원 행의 실명·이메일 — organizers 자리표시자(운영자 {UUID}·{UUID}@organizer.nabi.local)나
    UUID를 이름·이메일 칸에 싣지 않는다. 회원이 없는(데모 키) 운영자도 목록에서 빠지지 않는다."""
    event_id = _seed_event(db_factory)
    email = _unique_email("listed")
    member_id = _seed_login_member(db_factory, email=email, name="이관할")
    db = db_factory()
    try:
        # resolve_organizer_id가 만드는 것과 같은 자리표시자 행 — 과거 부여분이 실제로 이렇게 남아 있다.
        placeholder = Organizer(
            name=f"운영자 {member_id}", email=f"{member_id}@organizer.nabi.local", member_id=member_id
        )
        db.add(placeholder)
        db.commit()
        placeholder_id = str(placeholder.id)
    finally:
        db.close()
    _seed_event_organizer(db_factory, event_id, placeholder_id, "sub")
    demo_key = f"mbr-demo-{uuid.uuid4().hex[:6]}"
    db = db_factory()
    try:
        ghost = Organizer(name=f"운영자 {demo_key}", email=f"{demo_key}@organizer.nabi.local", member_id=demo_key)
        db.add(ghost)
        db.commit()
        ghost_id = str(ghost.id)
    finally:
        db.close()
    _seed_event_organizer(db_factory, event_id, ghost_id, "master")
    _as_master(event_id)

    resp = client.get(f"/api/admin/events/{event_id}/organizers")
    assert resp.status_code == 200
    rows = {row["permission_level"]: row for row in resp.json()}
    assert rows["sub"]["name"] == "이관할"
    assert rows["sub"]["email"] == email
    assert rows["master"]["name"] == "이름 미등록"
    assert rows["master"]["email"] == ""
    for row in resp.json():
        assert member_id not in row["name"] and member_id not in row["email"]
        assert "organizer.nabi.local" not in row["email"]


def test_list_organizers_shows_master_and_sub(client, db_factory):
    event_id = _seed_event(db_factory)
    master_id = _seed_organizer(db_factory, member_id="mbr-list-master")
    sub_id = _seed_organizer(db_factory, member_id="mbr-list-sub")
    _seed_event_organizer(db_factory, event_id, master_id, "master")
    _seed_event_organizer(db_factory, event_id, sub_id, "sub")
    _as_master(event_id)

    resp = client.get(f"/api/admin/events/{event_id}/organizers")
    assert resp.status_code == 200
    levels = {row["member_id"]: row["permission_level"] for row in resp.json()}
    assert levels == {"mbr-list-master": "master", "mbr-list-sub": "sub"}


def test_remove_sub_organizer_succeeds(client, db_factory):
    event_id = _seed_event(db_factory)
    sub_id = _seed_organizer(db_factory, member_id="mbr-removable-sub")
    event_organizer_id = _seed_event_organizer(db_factory, event_id, sub_id, "sub")
    _as_master(event_id)

    # 경로 값은 event_organizers.id(= FE AdminOrganizer.id, GET 목록 응답의 id와 동일 계약).
    resp = client.delete(f"/api/admin/events/{event_id}/organizers/{event_organizer_id}")
    assert resp.status_code == 204

    db = db_factory()
    try:
        assert db.query(EventOrganizer).filter_by(id=event_organizer_id).first() is None
    finally:
        db.close()


def test_remove_master_organizer_always_blocked_403(client, db_factory):
    # 자기 자신이든 다른 master든 — master 배정은 이 API로 절대 회수되지 않는다(카테고리 규칙,
    # 발주자 지시로 "자기 자신 회수 409"보다 넓게 대체됨).
    event_id = _seed_event(db_factory)
    other_master_id = _seed_organizer(db_factory, member_id="mbr-other-master")
    event_organizer_id = _seed_event_organizer(db_factory, event_id, other_master_id, "master")
    _as_master(event_id)

    resp = client.delete(f"/api/admin/events/{event_id}/organizers/{event_organizer_id}")
    assert resp.status_code == 403

    db = db_factory()
    try:
        assert db.query(EventOrganizer).filter_by(id=event_organizer_id).first() is not None  # 안 지워짐
    finally:
        db.close()


def test_remove_organizer_not_assigned_404(client, db_factory):
    event_id = _seed_event(db_factory)
    _as_master(event_id)

    resp = client.delete(f"/api/admin/events/{event_id}/organizers/00000000-0000-0000-0000-000000000000")
    assert resp.status_code == 404


# =============================================================================
# 미팅(Schedule Table)
# =============================================================================
def test_cancel_meeting_sets_status_cancelled(client, db_factory):
    event_id = _seed_event(db_factory)
    exh = _seed_org_role(db_factory, event_id, is_exhibitor=True)
    buy = _seed_org_role(db_factory, event_id, is_buyer=True)
    meeting_id = _seed_meeting(db_factory, event_id, exh["org_id"], buy["org_id"])

    _as_master(event_id)
    resp = client.post(f"/api/admin/events/{event_id}/meetings/{meeting_id}/cancel")
    assert resp.status_code == 200
    assert resp.json()["status"] == "cancelled"


def test_cancel_unknown_meeting_404(client, db_factory):
    event_id = _seed_event(db_factory)
    _as_master(event_id)
    resp = client.post(f"/api/admin/events/{event_id}/meetings/00000000-0000-0000-0000-000000000000/cancel")
    assert resp.status_code == 404


def test_cancel_meeting_notifies_both_orgs(client, db_factory):
    """운영자 취소는 참가자 취소와 달리 **양측**이 알림을 받는다(취소 안 한 쪽이 둘 다이므로) —
    backend/app/admin/router.py cancel_meeting의 exhibitor/buyer 양쪽 notify_meeting_cancelled 루프."""
    event_id = _seed_event(db_factory)
    exh = _seed_org_role(db_factory, event_id, is_exhibitor=True)
    buy = _seed_org_role(db_factory, event_id, is_buyer=True)
    meeting_id = _seed_meeting(db_factory, event_id, exh["org_id"], buy["org_id"])

    _as_master(event_id)
    resp = client.post(f"/api/admin/events/{event_id}/meetings/{meeting_id}/cancel")
    assert resp.status_code == 200

    db = db_factory()
    try:
        rows = db.execute(
            select(Notification).where(
                Notification.type == "meeting_cancelled",
                Notification.recipient_org_id.in_([exh["org_id"], buy["org_id"]]),
            )
        ).scalars().all()
        recipients = {str(r.recipient_org_id) for r in rows}
        assert recipients == {exh["org_id"], buy["org_id"]}  # 양쪽 다 받는다
    finally:
        db.close()


def test_cancel_meeting_reopens_slot(client, db_factory):
    """취소는 슬롯을 점유하지 않는다 — has_accepted_overlap(다른 배정/신청의 충돌 판정이 쓰는 그
    쿼리)이 취소 전엔 True, 취소 후엔 False여야 한다."""
    from app.matching.slot_booking import has_accepted_overlap

    event_id = _seed_event(db_factory)
    exh = _seed_org_role(db_factory, event_id, is_exhibitor=True)
    buy = _seed_org_role(db_factory, event_id, is_buyer=True)
    start = datetime(2026, 9, 16, 9, 0, tzinfo=timezone.utc)
    end = start + timedelta(minutes=30)
    meeting_id = _seed_meeting(
        db_factory, event_id, exh["org_id"], buy["org_id"],
        scheduled_start=start, scheduled_end=end,
    )

    db = db_factory()
    try:
        assert has_accepted_overlap(
            db, event_id=event_id, org_ids=[exh["org_id"]], start=start, end=end
        )
    finally:
        db.close()

    _as_master(event_id)
    resp = client.post(f"/api/admin/events/{event_id}/meetings/{meeting_id}/cancel")
    assert resp.status_code == 200

    db = db_factory()
    try:
        assert not has_accepted_overlap(
            db, event_id=event_id, org_ids=[exh["org_id"]], start=start, end=end
        )
    finally:
        db.close()


def test_cancel_meeting_is_master_only_through_real_guard_wiring(wired_client, db_factory, event_a):
    """슈퍼관리자(master)는 운영자가 강제 배정한 미팅도 이 엔드포인트로 취소할 수 있어야 한다 —
    발주자 QA 3차 지적 #1("슈퍼관리자 미팅 취소 시 권한 없음"). override 없이 실 가드 배선
    (require_event_master)을 태운다: sub는 403, master는 200."""
    _seed_event(db_factory, id=event_a)
    exh = _seed_org_role(db_factory, event_a, is_exhibitor=True)
    buy = _seed_org_role(db_factory, event_a, is_buyer=True)
    meeting_id = _seed_meeting(db_factory, event_a, exh["org_id"], buy["org_id"])

    sub_resp = wired_client.post(
        f"/api/admin/events/{event_a}/meetings/{meeting_id}/cancel",
        headers={"Authorization": "Bearer access-mbr-sub-1"},
    )
    assert sub_resp.status_code == 403

    master_resp = wired_client.post(
        f"/api/admin/events/{event_a}/meetings/{meeting_id}/cancel",
        headers={"Authorization": "Bearer access-mbr-master-1"},
    )
    assert master_resp.status_code == 200
    assert master_resp.json()["status"] == "cancelled"


def test_sub_meeting_list_filtered_to_managed_buyer(client, db_factory):
    event_id = _seed_event(db_factory)
    sub_id = _seed_organizer(db_factory)
    other_sub_id = _seed_organizer(db_factory)
    exh = _seed_org_role(db_factory, event_id, is_exhibitor=True)
    my_buyer = _seed_org_role(db_factory, event_id, is_buyer=True, managing_organizer_id=sub_id)
    other_buyer = _seed_org_role(db_factory, event_id, is_buyer=True, managing_organizer_id=other_sub_id)
    _seed_meeting(db_factory, event_id, exh["org_id"], my_buyer["org_id"])
    _seed_meeting(db_factory, event_id, exh["org_id"], other_buyer["org_id"])

    _as_sub(event_id, organizer_id=sub_id)
    resp = client.get(f"/api/admin/events/{event_id}/meetings")
    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] == 1
    assert body["items"][0]["buyer_org_id"] == my_buyer["org_id"]


# =============================================================================
# 통역사 배정
# =============================================================================
def test_interpreter_crud_and_assignment_lifecycle(client, db_factory):
    event_id = _seed_event(db_factory)
    org = _seed_org_role(db_factory, event_id, is_exhibitor=True)
    _as_master(event_id)

    create = client.post(
        f"/api/admin/events/{event_id}/interpreters",
        json={"name": "김통역", "languages": ["ko", "en"], "phone": "010-1111-2222"},
    )
    assert create.status_code == 201
    interpreter_id = create.json()["id"]
    assert create.json()["assigned_organization_ids"] == []

    listed = client.get(f"/api/admin/events/{event_id}/interpreters")
    assert listed.status_code == 200
    assert len(listed.json()) == 1

    updated = client.patch(
        f"/api/admin/events/{event_id}/interpreters/{interpreter_id}", json={"phone": "010-9999-0000"}
    )
    assert updated.status_code == 200
    assert updated.json()["phone"] == "010-9999-0000"
    assert updated.json()["name"] == "김통역"  # 미제공 필드 불변

    assigned = client.post(
        f"/api/admin/events/{event_id}/interpreters/{interpreter_id}/assign",
        json={"organization_id": org["org_id"]},
    )
    assert assigned.status_code == 200
    assert assigned.json()["assigned_organization_ids"] == [org["org_id"]]

    unassigned = client.delete(
        f"/api/admin/events/{event_id}/interpreters/{interpreter_id}/assign/{org['org_id']}"
    )
    assert unassigned.status_code == 200
    assert unassigned.json()["assigned_organization_ids"] == []

    deleted = client.delete(f"/api/admin/events/{event_id}/interpreters/{interpreter_id}")
    assert deleted.status_code == 204
    assert client.get(f"/api/admin/events/{event_id}/interpreters/{interpreter_id}").status_code == 404


def test_delete_interpreter_with_active_assignment_does_not_500(client, db_factory):
    """배정 행이 있는 통역사도 FastAPI는 삭제 후 204를 반환한다.

    라이브 500의 원인은 FastAPI가 아니라 Next.js BFF의 204 본문 처리였다.
    이 검증은 삭제와 배정 CASCADE의 서버 계약을 잠근다.
    """
    event_id = _seed_event(db_factory)
    org = _seed_org_role(db_factory, event_id, is_exhibitor=True)
    _as_master(event_id)
    interp = client.post(f"/api/admin/events/{event_id}/interpreters", json={"name": "X"}).json()
    client.post(
        f"/api/admin/events/{event_id}/interpreters/{interp['id']}/assign",
        json={"organization_id": org["org_id"]},
    )
    resp = client.delete(f"/api/admin/events/{event_id}/interpreters/{interp['id']}")
    assert resp.status_code == 204
    # 배정도 실제로 함께 사라졌는지 확인 — cascade가 고아 행을 남기지 않는지까지 잠근다.
    assert client.get(f"/api/admin/events/{event_id}/interpreters/{interp['id']}").status_code == 404


def test_reassigning_interpreter_replaces_previous_assignment(client, db_factory):
    event_id = _seed_event(db_factory)
    org = _seed_org_role(db_factory, event_id, is_exhibitor=True)
    _as_master(event_id)

    a = client.post(f"/api/admin/events/{event_id}/interpreters", json={"name": "통역A"}).json()
    b = client.post(f"/api/admin/events/{event_id}/interpreters", json={"name": "통역B"}).json()

    client.post(f"/api/admin/events/{event_id}/interpreters/{a['id']}/assign", json={"organization_id": org["org_id"]})
    # 같은 기업에 다른 통역사를 배정하면 갈아끼운다(unique(event, organization)).
    resp = client.post(f"/api/admin/events/{event_id}/interpreters/{b['id']}/assign", json={"organization_id": org["org_id"]})
    assert resp.status_code == 200

    a_after = client.get(f"/api/admin/events/{event_id}/interpreters/{a['id']}").json()
    b_after = client.get(f"/api/admin/events/{event_id}/interpreters/{b['id']}").json()
    assert a_after["assigned_organization_ids"] == []
    assert b_after["assigned_organization_ids"] == [org["org_id"]]


def test_assign_interpreter_to_org_outside_event_404(client, db_factory):
    event_id = _seed_event(db_factory)
    other_event = _seed_event(db_factory)
    org_in_other_event = _seed_org_role(db_factory, other_event, is_exhibitor=True)
    _as_master(event_id)

    interpreter = client.post(f"/api/admin/events/{event_id}/interpreters", json={"name": "통역A"}).json()
    resp = client.post(
        f"/api/admin/events/{event_id}/interpreters/{interpreter['id']}/assign",
        json={"organization_id": org_in_other_event["org_id"]},
    )
    assert resp.status_code == 404


# =============================================================================
# 미팅 장소(venue) 프로비저닝
# =============================================================================
def _seed_booth_venue(db_factory, event_id: str, label: str = "7홀 A-12") -> str:
    """참가사 부스 장소 — 실 경로에서는 미팅 신청이 자동 생성하는 행(콘솔 CRUD 대상이 아니다)."""
    db = db_factory()
    try:
        venue = MeetingVenue(event_id=event_id, venue_type="booth", label=label)
        db.add(venue)
        db.commit()
        return str(venue.id)
    finally:
        db.close()


def test_venue_crud_lifecycle(client, db_factory):
    event_id = _seed_event(db_factory)
    _as_master(event_id)

    created = client.post(
        f"/api/admin/events/{event_id}/venues", json={"venue_type": "zone_table", "label": "T-02"}
    )
    assert created.status_code == 201
    venue_id = created.json()["id"]
    assert created.json()["venue_type"] == "zone_table"
    assert created.json()["meeting_count"] == 0

    client.post(
        f"/api/admin/events/{event_id}/venues", json={"venue_type": "zone_table", "label": "T-01"}
    )
    client.post(
        f"/api/admin/events/{event_id}/venues",
        json={"venue_type": "business_room", "label": "Room A"},
    )

    listed = client.get(f"/api/admin/events/{event_id}/venues")
    assert listed.status_code == 200
    # 라벨 순 = 실제 배정 순서(meetings.service._resolve_venue가 비어 있는 첫 장소를 고른다).
    assert [v["label"] for v in listed.json()] == ["Room A", "T-01", "T-02"]

    renamed = client.patch(
        f"/api/admin/events/{event_id}/venues/{venue_id}", json={"label": "T-09"}
    )
    assert renamed.status_code == 200
    assert renamed.json()["label"] == "T-09"
    assert renamed.json()["venue_type"] == "zone_table"  # 종류는 안 바뀐다

    assert client.delete(f"/api/admin/events/{event_id}/venues/{venue_id}").status_code == 204
    assert [v["label"] for v in client.get(f"/api/admin/events/{event_id}/venues").json()] == [
        "Room A",
        "T-01",
    ]


def test_venue_list_excludes_booth_venues(client, db_factory):
    """booth는 미팅 신청이 자동 생성하는 파생물이라 콘솔 목록에 나오지 않는다."""
    event_id = _seed_event(db_factory)
    _as_master(event_id)
    _seed_booth_venue(db_factory, event_id)
    client.post(
        f"/api/admin/events/{event_id}/venues", json={"venue_type": "zone_table", "label": "T-01"}
    )

    listed = client.get(f"/api/admin/events/{event_id}/venues").json()

    assert [v["venue_type"] for v in listed] == ["zone_table"]


def test_venue_duplicate_label_409(client, db_factory):
    event_id = _seed_event(db_factory)
    _as_master(event_id)
    client.post(
        f"/api/admin/events/{event_id}/venues", json={"venue_type": "zone_table", "label": "T-01"}
    )

    dup = client.post(
        f"/api/admin/events/{event_id}/venues", json={"venue_type": "zone_table", "label": "T-01"}
    )

    assert dup.status_code == 409
    assert dup.json()["detail"]["code"] == "VENUE_LABEL_TAKEN"

    # 같은 라벨이라도 종류가 다르면 별개 장소다(유니크는 (행사, 종류, 라벨)).
    other_type = client.post(
        f"/api/admin/events/{event_id}/venues",
        json={"venue_type": "business_room", "label": "T-01"},
    )
    assert other_type.status_code == 201


def test_venue_rename_to_existing_label_409(client, db_factory):
    event_id = _seed_event(db_factory)
    _as_master(event_id)
    client.post(
        f"/api/admin/events/{event_id}/venues", json={"venue_type": "zone_table", "label": "T-01"}
    )
    second = client.post(
        f"/api/admin/events/{event_id}/venues", json={"venue_type": "zone_table", "label": "T-02"}
    ).json()

    resp = client.patch(
        f"/api/admin/events/{event_id}/venues/{second['id']}", json={"label": "T-01"}
    )

    assert resp.status_code == 409
    assert resp.json()["detail"]["code"] == "VENUE_LABEL_TAKEN"

    # 자기 라벨 그대로 저장하는 건 충돌이 아니다(no-op).
    same = client.patch(
        f"/api/admin/events/{event_id}/venues/{second['id']}", json={"label": "T-02"}
    )
    assert same.status_code == 200


def test_delete_venue_in_use_409_with_meeting_count(client, db_factory):
    """``meetings.venue_id``는 ondelete 없는 FK — 선검사가 없으면 500이 난다."""
    event_id = _seed_event(db_factory)
    exhibitor = _seed_org_role(db_factory, event_id, is_exhibitor=True)
    buyer = _seed_org_role(db_factory, event_id, is_buyer=True)
    _as_master(event_id)
    venue = client.post(
        f"/api/admin/events/{event_id}/venues", json={"venue_type": "zone_table", "label": "T-01"}
    ).json()
    _seed_meeting(
        db_factory, event_id, exhibitor["org_id"], buyer["org_id"], venue_id=venue["id"]
    )

    resp = client.delete(f"/api/admin/events/{event_id}/venues/{venue['id']}")

    assert resp.status_code == 409
    detail = resp.json()["detail"]
    assert detail["code"] == "VENUE_IN_USE"
    assert detail["meeting_count"] == 1
    assert "1건" in detail["message"]

    # 목록도 같은 사실을 미리 알려준다(콘솔이 삭제 버튼을 잠글 수 있게).
    listed = client.get(f"/api/admin/events/{event_id}/venues").json()
    assert listed[0]["meeting_count"] == 1


def test_booth_venue_patch_and_delete_rejected_422(client, db_factory):
    """부스 장소는 실재하지만 이 경로의 대상이 아니다 — 404가 아니라 422로 이유를 알린다."""
    event_id = _seed_event(db_factory)
    _as_master(event_id)
    booth_venue_id = _seed_booth_venue(db_factory, event_id)

    patched = client.patch(
        f"/api/admin/events/{event_id}/venues/{booth_venue_id}", json={"label": "8홀 B-01"}
    )
    deleted = client.delete(f"/api/admin/events/{event_id}/venues/{booth_venue_id}")

    assert patched.status_code == 422
    assert patched.json()["detail"]["code"] == "VENUE_NOT_MANAGEABLE"
    assert deleted.status_code == 422
    assert deleted.json()["detail"]["code"] == "VENUE_NOT_MANAGEABLE"


def test_create_booth_venue_rejected_422(client, db_factory):
    """생성 요청의 venue_type은 스키마 단계에서 좁혀둔다(booth는 서비스까지 가지 않는다)."""
    event_id = _seed_event(db_factory)
    _as_master(event_id)

    resp = client.post(
        f"/api/admin/events/{event_id}/venues", json={"venue_type": "booth", "label": "7홀 A-12"}
    )

    assert resp.status_code == 422


def test_venue_of_other_event_404(client, db_factory):
    event_id = _seed_event(db_factory)
    other_event = _seed_event(db_factory)
    _as_master(other_event)
    foreign = client.post(
        f"/api/admin/events/{other_event}/venues",
        json={"venue_type": "zone_table", "label": "T-01"},
    ).json()
    _as_master(event_id)

    assert (
        client.patch(
            f"/api/admin/events/{event_id}/venues/{foreign['id']}", json={"label": "T-02"}
        ).status_code
        == 404
    )
    assert (
        client.delete(f"/api/admin/events/{event_id}/venues/{foreign['id']}").status_code == 404
    )
    # 형식이 틀린 id도 500이 아니라 404(uuid 컬럼에 임의 문자열을 넣으면 22P02로 트랜잭션이 깨진다).
    assert (
        client.delete(f"/api/admin/events/{event_id}/venues/not-a-uuid").status_code == 404
    )


def test_venue_writes_are_master_only_but_sub_can_read(wired_client, db_factory, event_a):
    """읽기는 sub도 통과(require_event_operator), 쓰기는 master 전용(require_event_master).

    override 없이 실 가드 배선을 태운다(이 파일 끝의 "가드 배선" 절과 같은 패턴).
    """
    _seed_event(db_factory, id=event_a)
    sub = {"Authorization": "Bearer access-mbr-sub-1"}

    assert wired_client.get(f"/api/admin/events/{event_a}/venues", headers=sub).status_code == 200
    assert (
        wired_client.post(
            f"/api/admin/events/{event_a}/venues",
            json={"venue_type": "zone_table", "label": "T-01"},
            headers=sub,
        ).status_code
        == 403
    )
    assert (
        wired_client.patch(
            f"/api/admin/events/{event_a}/venues/{uuid.uuid4()}",
            json={"label": "T-02"},
            headers=sub,
        ).status_code
        == 403
    )
    assert (
        wired_client.delete(
            f"/api/admin/events/{event_a}/venues/{uuid.uuid4()}", headers=sub
        ).status_code
        == 403
    )
    # master는 같은 요청이 통과한다(가드가 라우트를 통째로 막은 게 아니라는 확인).
    assert (
        wired_client.post(
            f"/api/admin/events/{event_a}/venues",
            json={"venue_type": "zone_table", "label": "T-01"},
            headers={"Authorization": "Bearer access-mbr-master-1"},
        ).status_code
        == 201
    )


# =============================================================================
# 가드 배선(override 없이) — 비-master 403, sub 읽기 통과, 미인증 401
# =============================================================================
def _directory(event_id: str) -> InMemoryEventOperatorDirectory:
    return InMemoryEventOperatorDirectory({("mbr-master", event_id): "master", ("mbr-sub", event_id): "sub"})


@pytest.fixture()
def event_a() -> str:
    """가드 배선 검증용 이벤트 id — 세션 스코프 migrated_db는 테스트 간 커밋이 그대로 남는다.
    예전엔 고정 문자열(EVENT_A)을 여러 테스트가 재사용했는데, 그건 Postgres 없이(전체 skip) 한
    번도 실행된 적이 없어 events_pkey 충돌이 드러나지 않았을 뿐이다. 매 테스트 고유 UUID로 발급."""
    return str(uuid.uuid4())


@pytest.fixture()
def wired_client(db_factory, event_a):
    def _override_session():
        db = db_factory()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_session] = _override_session
    app.dependency_overrides[get_authenticator] = StubSessionAuthenticator
    app.dependency_overrides[get_operator_directory] = lambda: _directory(event_a)
    yield TestClient(app, raise_server_exceptions=False)
    app.dependency_overrides.clear()


def test_write_endpoint_rejects_sub_through_real_guard_wiring(wired_client, db_factory, event_a):
    db = db_factory()
    try:
        db.add(Event(id=event_a, name="배선 확인용", slug=f"wiring-{next(_seq)}"))
        db.commit()
    finally:
        db.close()

    resp = wired_client.patch(
        f"/api/admin/events/{event_a}",
        json={"venue_name": "X"},
        headers={"Authorization": "Bearer access-mbr-sub-1"},
    )
    assert resp.status_code == 403  # sub는 쓰기 불가(master 전용)

    ok = wired_client.patch(
        f"/api/admin/events/{event_a}",
        json={"venue_name": "X"},
        headers={"Authorization": "Bearer access-mbr-master-1"},
    )
    assert ok.status_code == 200


def test_read_endpoint_allows_sub_through_real_guard_wiring(wired_client, db_factory, event_a):
    db = db_factory()
    try:
        db.add(Event(id=event_a, name="배선 확인용2", slug=f"wiring2-{next(_seq)}"))
        db.commit()
    finally:
        db.close()

    resp = wired_client.get(
        f"/api/admin/events/{event_a}/organizations", headers={"Authorization": "Bearer access-mbr-sub-1"}
    )
    assert resp.status_code == 200  # 읽기는 sub도 통과(관할 필터는 적용되나 403은 아님)


def test_no_token_401_through_real_guard_wiring(wired_client, db_factory, event_a):
    db = db_factory()
    try:
        db.add(Event(id=event_a, name="배선 확인용3", slug=f"wiring3-{next(_seq)}"))
        db.commit()
    finally:
        db.close()

    resp = wired_client.get(f"/api/admin/events/{event_a}/organizations")
    assert resp.status_code == 401


# =============================================================================
# 행사 생성 게이트(require_existing_master_identity, 실 와이어링) — 크로스리뷰로 강화된 규칙:
# "어디선가 이미 master인 운영자"만 새 행사를 만들 수 있다. get_operator_directory와는 무관하게
# event_organizers를 직접 조회하므로, 여기서는 그 디렉터리 override를 쓰지 않고 실 DB 시드로 검증한다.
# =============================================================================
def test_create_event_master_elsewhere_succeeds(wired_client, db_factory):
    other_event = _seed_event(db_factory, name="기존행사(마스터 보유)")
    organizer_id = _seed_organizer(db_factory, member_id="mbr-existing-master")
    _seed_event_organizer(db_factory, other_event, organizer_id, "master")

    resp = wired_client.post(
        "/api/admin/events",
        json={"name": "새 행사", "name_en": "New Expo"},
        headers={"Authorization": "Bearer access-mbr-existing-master-1"},
    )
    assert resp.status_code == 201
    assert resp.json()["name_en"] == "New Expo"

    db = db_factory()
    try:
        row = db.query(EventOrganizer).filter_by(event_id=resp.json()["id"], organizer_id=organizer_id).one()
        assert row.permission_level == "master"  # 자기증식 — 새 행사에서도 master
    finally:
        db.close()


def test_create_event_sub_only_forbidden_403(wired_client, db_factory):
    other_event = _seed_event(db_factory, name="기존행사(sub만 보유)")
    organizer_id = _seed_organizer(db_factory, member_id="mbr-sub-only")
    _seed_event_organizer(db_factory, other_event, organizer_id, "sub")

    resp = wired_client.post(
        "/api/admin/events",
        json={"name": "새 행사"},
        headers={"Authorization": "Bearer access-mbr-sub-only-1"},
    )
    assert resp.status_code == 403
    assert "슈퍼어드민" in resp.json()["detail"]


def test_create_event_identity_only_no_assignment_forbidden_403(wired_client, db_factory):
    # organizers 신원은 (get-or-create로) 생기지만 event_organizers 배정이 전혀 없는 신규 운영자.
    resp = wired_client.post(
        "/api/admin/events",
        json={"name": "새 행사"},
        headers={"Authorization": "Bearer access-mbr-nobody-1"},
    )
    assert resp.status_code == 403


# =============================================================================
# GET /api/admin/me — 로그인한 운영자 본인의 실 신원 + 행사별 권한등급
#
# 이 엔드포인트가 없던 동안 프론트는 목업 인물("정세훈")을 사이드바에 그리고, 그 이름을
# 대리작성·미팅취소 감사기록의 actorName으로 넣었다. 여기서 지키는 계약은 셋이다:
#   ① 신원은 members 행(사람이 관리하는 값) 우선, organizers 행은 폴백
#   ② 배정이 없는 주체는 403 — 그리고 organizers 행을 새로 만들지 않는다(get-or-create 금지)
#   ③ 비-UUID 회원키(데모 토큰)에서도 members 조회로 22P02(500)를 내지 않는다
# =============================================================================
def _seed_member(db_factory, *, name: str, email: str, phone: str | None, org_name: str) -> str:
    db = db_factory()
    try:
        org = Organization(name_ko=org_name)
        db.add(org)
        db.flush()
        member = Member(organization_id=org.id, name=name, email=email, phone=phone)
        db.add(member)
        db.commit()
        return str(member.id)
    finally:
        db.close()


def test_admin_me_returns_member_identity_and_per_event_levels(wired_client, db_factory):
    member_id = _seed_member(
        db_factory,
        name="운영 담당 (슈퍼관리자)",
        email=f"sean-{next(_seq)}@example.com",
        phone="010-1111-2222",
        org_name="마인즈그라운드 운영팀",
    )
    organizer_id = _seed_organizer(db_factory, member_id=member_id)
    master_event = _seed_event(db_factory, name="마스터 행사")
    sub_event = _seed_event(db_factory, name="서브 행사")
    _seed_event_organizer(db_factory, master_event, organizer_id, "master")
    _seed_event_organizer(db_factory, sub_event, organizer_id, "sub")

    resp = wired_client.get("/api/admin/me", headers={"Authorization": f"Bearer access-{member_id}-1"})

    assert resp.status_code == 200
    body = resp.json()
    assert body["member_id"] == member_id
    assert body["organizer_id"] == organizer_id
    # organizers 행에도 name/email이 있지만(운영자{n}/organizer{n}@example.com) members 쪽이 이긴다.
    assert body["name"] == "운영 담당 (슈퍼관리자)"
    assert body["phone"] == "010-1111-2222"
    assert body["affiliation"] == "마인즈그라운드 운영팀"
    assert {e["event_id"]: e["permission_level"] for e in body["events"]} == {
        master_event: "master",
        sub_event: "sub",
    }


def test_admin_me_blank_member_phone_is_null_not_empty_string(wired_client, db_factory):
    """빈 연락처는 None으로 접는다 — 사이드바가 아이콘만 남은 빈 줄을 그리지 않도록."""
    member_id = _seed_member(
        db_factory, name="연락처없음", email=f"nophone-{next(_seq)}@example.com", phone="  ", org_name="운영팀"
    )
    organizer_id = _seed_organizer(db_factory, member_id=member_id)
    event_id = _seed_event(db_factory, name="연락처 행사")
    _seed_event_organizer(db_factory, event_id, organizer_id, "master")

    resp = wired_client.get("/api/admin/me", headers={"Authorization": f"Bearer access-{member_id}-1"})

    assert resp.status_code == 200
    assert resp.json()["phone"] is None


def test_admin_me_non_uuid_member_key_falls_back_to_organizer_row(wired_client, db_factory):
    """데모 토큰의 비-UUID 회원키 — members.id(uuid 컬럼) 조회로 22P02(500)가 나면 안 된다."""
    organizer_id = _seed_organizer(db_factory, member_id="mbr-demo-op-01")
    event_id = _seed_event(db_factory, name="데모 행사")
    _seed_event_organizer(db_factory, event_id, organizer_id, "sub")

    resp = wired_client.get("/api/admin/me", headers={"Authorization": "Bearer access-mbr-demo-op-01-1"})

    assert resp.status_code == 200
    body = resp.json()
    assert body["name"].startswith("운영자")  # organizers 행 폴백
    assert body["affiliation"] is None  # members가 없으니 소속을 지어내지 않는다
    assert body["events"] == [{"event_id": event_id, "permission_level": "sub"}]


def test_admin_me_hides_placeholder_organizer_email(wired_client, db_factory):
    """guard.resolve_organizer_id가 심는 자리표시자 이메일은 화면에 흘리지 않는다."""
    db = db_factory()
    try:
        organizer = Organizer(
            name="운영자 mbr-placeholder-01",
            email="mbr-placeholder-01@organizer.nabi.local",
            member_id="mbr-placeholder-01",
        )
        db.add(organizer)
        db.commit()
        organizer_id = str(organizer.id)
    finally:
        db.close()
    event_id = _seed_event(db_factory, name="자리표시자 행사")
    _seed_event_organizer(db_factory, event_id, organizer_id, "master")

    resp = wired_client.get("/api/admin/me", headers={"Authorization": "Bearer access-mbr-placeholder-01-1"})

    assert resp.status_code == 200
    assert resp.json()["email"] is None


def test_admin_me_unknown_subject_403_and_creates_no_organizer_row(wired_client, db_factory):
    """운영자가 아닌 주체(참가자 등)가 불러도 organizers 자리표시자 행이 생기면 안 된다."""
    resp = wired_client.get("/api/admin/me", headers={"Authorization": "Bearer access-mbr-not-an-op-1"})

    assert resp.status_code == 403
    db = db_factory()
    try:
        assert (
            db.query(Organizer).filter(Organizer.member_id == "mbr-not-an-op").one_or_none() is None
        )
    finally:
        db.close()


def test_admin_me_operator_without_any_assignment_403(wired_client, db_factory):
    _seed_organizer(db_factory, member_id="mbr-unassigned-op")

    resp = wired_client.get("/api/admin/me", headers={"Authorization": "Bearer access-mbr-unassigned-op-1"})

    assert resp.status_code == 403


def test_admin_me_without_token_401(wired_client):
    assert wired_client.get("/api/admin/me").status_code == 401
