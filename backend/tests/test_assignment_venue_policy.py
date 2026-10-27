"""운영자 배정의 장소 결정 회귀 — 2026-10-01 고객 신고 "[배정 저장에 실패했어요]" 재현.

신고: 미팅 배정 화면에서 수퍼관리자가 빈 슬롯을 눌러 바이어를 고르면 저장이 실패한다. [전체 일괄배정]은 된다.

독립 감사로 확정된 원인:

- **[9/30]** 강제 배정 BFF가 장소를 미리 골라 넘겼다(``GET .../venues`` — zone_table·business_room만
  돌려준다). ``enabled_venue_types={booth}``이고 장소가 하나도 없는 행사라 BFF가 404 ``no_venue``로
  끊어 요청이 백엔드에 닿지도 못했다. 일괄배정은 장소를 미리 고르지 않아 성공했다.
- **[10/1]** 같은 BFF가 빈 자리 확인 없이 **항상 같은 zone_table(INC)**을 골라, 한 시각에 행사 전체에서
  미팅이 1건밖에 안 잡혔다(운영 13회 중 6회 409 VENUE_TAKEN — 성공 7건이 전부 INC·전부 다른 시각).

근본 수정: 강제·⚡재보충·일괄배정 확정이 참가자 신청과 같은 정책(``_bookable_venue_types``)으로
**백엔드에서** 장소를 정한다 — 기본 정책이면 그 참가사의 부스(``assignment_service._auto_venue_resolver``).
여기 테스트는 운영 실 설정(40분 슬롯·텀 5분·10:00–18:10·점심 12:10–13:00·Asia/Seoul, 3일 행사)과 BFF가
실제로 보내는 모양(``slot_ids``, ``venue_id`` 없음)을 그대로 쓴다.

``migrated_db``는 세션 스코프(커밋이 남는다) — 단언은 항상 이 파일이 만든 event_id로 스코프를 좁힌다.
"""

from __future__ import annotations

import itertools
import threading
import time
import uuid
from datetime import date, timedelta
from datetime import time as dtime

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from app.admin.guard import EventOperatorPrincipal, require_event_operator
from app.auth.organizer_guard import EventMasterPrincipal, require_event_master
from app.auth.principal import Principal, get_current_principal
from app.config import settings as app_settings
from app.db import get_session
from app.main import app
from app.matching.acceptance_rule import EntryState
from app.matching.meeting_booking import MeetingError, book_meeting
from app.matching.slot_grid import build_grid
from app.meetings.service import schedule_policy
from app.models import (
    Booth,
    Event,
    EventScheduleSettings,
    ExhibitorProfile,
    Hall,
    Meeting,
    MeetingVenue,
    Organization,
    OrganizationEventRole,
)

_seq = itertools.count(1)

#: 운영 실 행사(2026-10-20~22, 3일)와 같은 모양 — 날짜는 상대값으로 둬 언제 돌려도 "미래 슬롯"이다.
DAY1 = date.today() + timedelta(days=19)

#: 운영 실 격자(40분 + 텀 5분, 10:00–18:10, 점심 12:10–13:00) — 12:15 칸은 점심에 걸려 없다.
PRODUCTION_GRID = [
    "10:00", "10:45", "11:30", "13:00", "13:45", "14:30", "15:15", "16:00", "16:45", "17:30",
]

#: 강제 배정·⚡재보충 — 같은 장소 규칙을 쓰는지 두 엔드포인트를 똑같이 돌린다.
OPERATOR_ENDPOINTS = pytest.mark.parametrize(
    "endpoint", ["forced-assignments", "retrigger-assignments"]
)


def _slot(hhmm: str, *, day: int = 0) -> str:
    return f"{(DAY1 + timedelta(days=day)).isoformat()}T{hhmm}"


# =============================================================================
# 픽스처 / 가드 override
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
        finally:
            db.close()

    app.dependency_overrides[get_session] = _override_session
    yield TestClient(app, raise_server_exceptions=False)
    app.dependency_overrides.clear()


def _as_master(event_id: str) -> None:
    app.dependency_overrides[require_event_master] = lambda: EventMasterPrincipal(
        member_id="mbr-org-venue", event_id=event_id
    )
    app.dependency_overrides[require_event_operator] = lambda: EventOperatorPrincipal(
        member_id="mbr-org-venue",
        event_id=event_id,
        permission_level="master",
        organizer_id=str(uuid.uuid4()),
    )


def _login_as(org_id: str) -> None:
    """참가자 화면(내 미팅·미팅 신청 모달) 조회용 주체."""
    app.dependency_overrides[get_current_principal] = lambda: Principal(
        member_id=str(uuid.uuid4()), organization_id=str(org_id)
    )


# =============================================================================
# 시딩 — 운영 실 설정을 그대로
# =============================================================================
def _seed_event(
    db_factory,
    *,
    enabled_venue_types: list[str],
    zone_tables: tuple[str, ...] = (),
) -> str:
    n = next(_seq)
    db = db_factory()
    try:
        event = Event(
            name="K-콘텐츠 엑스포",
            slug=f"venue-policy-{n}-{uuid.uuid4().hex[:8]}",
            timezone="Asia/Seoul",
            slot_minutes=40,
            exhibition_start=DAY1,
            exhibition_end=DAY1 + timedelta(days=2),
            enabled_venue_types=enabled_venue_types,
        )
        db.add(event)
        db.flush()
        db.add(
            EventScheduleSettings(
                event_id=event.id,
                operating_start=dtime(10, 0),
                operating_end=dtime(18, 10),
                lunch_start=dtime(12, 10),
                lunch_end=dtime(13, 0),
                slot_gap_minutes=5,
                max_meeting_minutes=90,
                min_guaranteed_slots=1,
            )
        )
        for label in zone_tables:
            db.add(MeetingVenue(event_id=event.id, venue_type="zone_table", label=label))
        db.commit()
        return str(event.id)
    finally:
        db.close()


def _seed_exhibitor(db_factory, event_id: str, name: str, *, booth_code: str | None) -> str:
    """참가사 + 부스 배정("7홀 {booth_code}") — 참가자 신청 화면이 쓰는 그 정규화 부스(halls/booths)."""
    db = db_factory()
    try:
        org = Organization(name_ko=name)
        db.add(org)
        db.flush()
        role = OrganizationEventRole(
            organization_id=org.id, event_id=event_id,
            is_exhibitor=True, application_status="approved",
        )
        db.add(role)
        db.flush()
        booth_id = None
        if booth_code is not None:
            hall = db.execute(
                select(Hall).where(Hall.event_id == event_id, Hall.hall_no == "7")
            ).scalar_one_or_none()
            if hall is None:
                hall = Hall(event_id=event_id, hall_no="7", hall_name="7홀")
                db.add(hall)
                db.flush()
            booth = Booth(hall_id=hall.id, code=booth_code)
            db.add(booth)
            db.flush()
            booth_id = booth.id
        db.add(ExhibitorProfile(org_event_role_id=role.id, booth_id=booth_id))
        db.commit()
        return str(org.id)
    finally:
        db.close()


def _seed_buyer(db_factory, event_id: str, name: str) -> str:
    """초청(hosted) 바이어 — ⚡재보충에서도 즉시 확정(accepted)이라 슬롯 점유까지 같이 볼 수 있다."""
    db = db_factory()
    try:
        org = Organization(name_ko=name)
        db.add(org)
        db.flush()
        db.add(
            OrganizationEventRole(
                organization_id=org.id, event_id=event_id, is_buyer=True,
                buyer_subtype="hosted", application_status="approved",
            )
        )
        db.commit()
        return str(org.id)
    finally:
        db.close()


def _world_1001(db_factory, *, enabled_venue_types=("booth", "zone_table", "business_room"), zone_tables=("INC",)):
    """10/1 운영 재현 — 참가사 2곳(각자 부스) · 바이어 3곳 · zone_table "INC" 하나(운영에 실제로 있던 장소)."""
    event_id = _seed_event(
        db_factory, enabled_venue_types=list(enabled_venue_types), zone_tables=zone_tables
    )
    return {
        "event_id": event_id,
        "e1": _seed_exhibitor(db_factory, event_id, "참가사1", booth_code="A-12"),
        "e2": _seed_exhibitor(db_factory, event_id, "참가사2", booth_code="B-03"),
        "b1": _seed_buyer(db_factory, event_id, "바이어1"),
        "b2": _seed_buyer(db_factory, event_id, "바이어2"),
        "b3": _seed_buyer(db_factory, event_id, "바이어3"),
    }


def _assign(client, event_id, exhibitor, buyer, slot_ids, *, endpoint="forced-assignments", venue_id=None):
    """BFF(app/api/organizer/assignments/route.ts)가 실제로 보내는 바디 — slot_ids, venue_id 없음."""
    body = {"exhibitor_org_id": exhibitor, "buyer_org_id": buyer, "slot_ids": slot_ids}
    if venue_id is not None:
        body["venue_id"] = venue_id
    return client.post(f"/api/admin/events/{event_id}/{endpoint}", json=body)


def _venues_of(db_factory, event_id: str) -> list[tuple[str, str]]:
    db = db_factory()
    try:
        return sorted(
            (vtype, label)
            for vtype, label in db.execute(
                select(MeetingVenue.venue_type, MeetingVenue.label).where(
                    MeetingVenue.event_id == event_id
                )
            ).all()
        )
    finally:
        db.close()


def _meetings_at_venue(db_factory, event_id: str, label: str) -> int:
    db = db_factory()
    try:
        return len(
            db.execute(
                select(Meeting.id)
                .join(MeetingVenue, MeetingVenue.id == Meeting.venue_id)
                .where(Meeting.event_id == event_id, MeetingVenue.label == label)
            ).all()
        )
    finally:
        db.close()


# =============================================================================
# 재현 전제 — 테스트 행사가 운영 격자를 그대로 만든다
# =============================================================================
def test_test_event_reproduces_the_production_slot_grid(db_factory):
    event_id = _seed_event(db_factory, enabled_venue_types=["booth"])
    db = db_factory()
    try:
        grid = build_grid(schedule_policy(db, db.get(Event, event_id)))
    finally:
        db.close()
    assert len(grid) == 3  # 3일 행사
    assert [slot.time for slot in grid[0].slots] == PRODUCTION_GRID


# =============================================================================
# [9/30 재현] 부스 전용 행사 + 장소 0개 — venue_id 없이 배정 → 성공, 참가사 부스가 생성·사용된다
# =============================================================================
@OPERATOR_ENDPOINTS
def test_0930_booth_only_event_without_any_venue_assigns_into_exhibitor_booth(client, db_factory, endpoint):
    event_id = _seed_event(db_factory, enabled_venue_types=["booth"])
    exhibitor = _seed_exhibitor(db_factory, event_id, "부스참가사", booth_code="A-12")
    buyer = _seed_buyer(db_factory, event_id, "부스바이어")
    assert _venues_of(db_factory, event_id) == []  # 신고 당시 상태 — 장소가 하나도 없다
    _as_master(event_id)

    r = _assign(client, event_id, exhibitor, buyer, [_slot("13:00")], endpoint=endpoint)

    assert r.status_code == 201, r.text
    body = r.json()
    assert body["status"] == "accepted"
    assert (body["venue_type"], body["venue_label"]) == ("booth", "7홀 A-12")
    # 그 참가사의 부스 장소 행이 (참가자 신청과 같은 멱등키로) 새로 생겨 쓰였다.
    assert _venues_of(db_factory, event_id) == [("booth", "7홀 A-12")]


def test_0930_exhibitor_without_an_assigned_booth_still_gets_its_own_booth(client, db_factory):
    """부스번호가 아직 배정되지 않은 참가사(정상 상태)도 막히지 않는다 — 저장 라벨은 참가자 신청과 같은
    "{기업명} 부스"(``_booth_label`` 규칙)다."""
    event_id = _seed_event(db_factory, enabled_venue_types=["booth"])
    exhibitor = _seed_exhibitor(db_factory, event_id, "미배정참가사", booth_code=None)
    buyer = _seed_buyer(db_factory, event_id, "부스바이어")
    _as_master(event_id)

    r = _assign(client, event_id, exhibitor, buyer, [_slot("13:00")])

    assert r.status_code == 201, r.text
    assert (r.json()["venue_type"], r.json()["venue_label"]) == ("booth", "미배정참가사 부스")


# =============================================================================
# [10/1 재현] 운영 설정 그대로 — 같은 시각(13:00)에 서로 다른 참가사 쌍 2건 → 둘 다 성공, 각자 자기 부스
# =============================================================================
@OPERATOR_ENDPOINTS
def test_1001_two_pairs_at_the_same_time_both_succeed_each_in_own_booth(client, db_factory, endpoint):
    w = _world_1001(db_factory)
    _as_master(w["event_id"])

    first = _assign(client, w["event_id"], w["e1"], w["b1"], [_slot("13:00")], endpoint=endpoint)
    second = _assign(client, w["event_id"], w["e2"], w["b2"], [_slot("13:00")], endpoint=endpoint)

    assert first.status_code == 201, first.text
    assert second.status_code == 201, second.text  # 운영에선 여기가 409 VENUE_TAKEN(INC 고정)이었다
    assert (first.json()["venue_type"], first.json()["venue_label"]) == ("booth", "7홀 A-12")
    assert (second.json()["venue_type"], second.json()["venue_label"]) == ("booth", "7홀 B-03")
    assert first.json()["venue_id"] != second.json()["venue_id"]
    # 운영 BFF가 고정하던 zone_table "INC"에는 아무것도 잡히지 않는다(기본 정책 = 부스).
    assert _meetings_at_venue(db_factory, w["event_id"], "INC") == 0


@OPERATOR_ENDPOINTS
def test_same_exhibitor_same_time_with_another_buyer_is_slot_taken_by_exhibitor(client, db_factory, endpoint):
    w = _world_1001(db_factory)
    _as_master(w["event_id"])
    assert _assign(client, w["event_id"], w["e1"], w["b1"], [_slot("13:00")], endpoint=endpoint).status_code == 201

    r = _assign(client, w["event_id"], w["e1"], w["b3"], [_slot("13:00")], endpoint=endpoint)

    assert r.status_code == 409, r.text
    detail = r.json()["detail"]
    assert detail["code"] == "SLOT_TAKEN"
    assert detail["busy_roles"] == ["exhibitor"]  # 화면이 "참가사가 바쁘다"를 구분해 보여줄 재료
    assert detail["message"] == "참가사가 해당 시간에 이미 확정된 미팅이 있습니다."


@OPERATOR_ENDPOINTS
def test_same_buyer_same_time_with_another_exhibitor_is_slot_taken_by_buyer(client, db_factory, endpoint):
    w = _world_1001(db_factory)
    _as_master(w["event_id"])
    assert _assign(client, w["event_id"], w["e1"], w["b1"], [_slot("13:00")], endpoint=endpoint).status_code == 201

    r = _assign(client, w["event_id"], w["e2"], w["b1"], [_slot("13:00")], endpoint=endpoint)

    assert r.status_code == 409, r.text
    detail = r.json()["detail"]
    assert detail["code"] == "SLOT_TAKEN"
    assert detail["busy_roles"] == ["buyer"]
    assert detail["message"] == "바이어가 해당 시간에 이미 확정된 미팅이 있습니다."


@OPERATOR_ENDPOINTS
def test_same_exhibitor_later_slot_reuses_its_own_booth(client, db_factory, endpoint):
    """같은 참가사의 다른 시각 미팅은 같은 부스 장소 행을 다시 쓴다(부스 행이 갈라지지 않는다)."""
    w = _world_1001(db_factory)
    _as_master(w["event_id"])

    first = _assign(client, w["event_id"], w["e1"], w["b1"], [_slot("13:00")], endpoint=endpoint)
    later = _assign(client, w["event_id"], w["e1"], w["b3"], [_slot("13:45")], endpoint=endpoint)

    assert first.status_code == 201, first.text
    assert later.status_code == 201, later.text
    assert later.json()["venue_id"] == first.json()["venue_id"]
    assert [v for v in _venues_of(db_factory, w["event_id"]) if v[0] == "booth"] == [("booth", "7홀 A-12")]


# =============================================================================
# 일괄배정 확정도 같은 규칙 — 기본 정책이면 zone_table이 있어도 부스
# =============================================================================
def test_saturation_confirm_places_meetings_in_exhibitor_booths_by_default(client, db_factory):
    w = _world_1001(db_factory, zone_tables=("INC", "T-02"))
    _as_master(w["event_id"])

    run = client.post(f"/api/admin/events/{w['event_id']}/saturation-runs")
    assert run.status_code == 201, run.text
    run_body = run.json()
    assert {i["exhibitor_org_id"] for i in run_body["items"]} == {w["e1"], w["e2"]}

    r = client.post(f"/api/admin/events/{w['event_id']}/saturation-runs/{run_body['id']}/confirm")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["skipped_count"] == 0
    assert body["confirmed_count"] == len(run_body["items"])

    expected = {w["e1"]: "7홀 A-12", w["e2"]: "7홀 B-03"}
    db = db_factory()
    try:
        for item in body["items"]:
            meeting = db.get(Meeting, item["materialized_meeting_id"])
            venue = db.get(MeetingVenue, meeting.venue_id)
            assert (venue.venue_type, venue.label) == ("booth", expected[str(meeting.exhibitor_org_id)])
    finally:
        db.close()
    # 예전 일괄배정 resolver는 정책을 무시하고 zone_table을 먼저 썼다.
    assert _meetings_at_venue(db_factory, w["event_id"], "INC") == 0
    assert _meetings_at_venue(db_factory, w["event_id"], "T-02") == 0


# =============================================================================
# booth가 허용되지 않는 행사 — 그 시각 비어 있는 자리를 찾는다
# =============================================================================
def test_reopened_zone_table_policy_spreads_same_time_pairs_over_free_tables_then_fails_clearly(
    client, db_factory, monkeypatch
):
    """MEETING_BOOKABLE_VENUE_TYPES=zone_table로 재오픈 — 같은 시각 여러 쌍이 **서로 다른 빈 테이블**로
    가고, 테이블이 다 차면 무엇이 모자란지 말하는 409가 난다(예전 BFF처럼 한 테이블에 몰지 않는다)."""
    monkeypatch.setattr(app_settings, "meeting_bookable_venue_types", ["zone_table"], raising=True)
    w = _world_1001(db_factory, enabled_venue_types=("booth", "zone_table"), zone_tables=("T-01", "T-02"))
    e3 = _seed_exhibitor(db_factory, w["event_id"], "참가사3", booth_code="C-07")
    _as_master(w["event_id"])

    first = _assign(client, w["event_id"], w["e1"], w["b1"], [_slot("13:00")])
    second = _assign(client, w["event_id"], w["e2"], w["b2"], [_slot("13:00")])
    third = _assign(client, w["event_id"], e3, w["b3"], [_slot("13:00")])

    assert first.status_code == 201, first.text
    assert second.status_code == 201, second.text
    assert {first.json()["venue_type"], second.json()["venue_type"]} == {"zone_table"}
    assert {first.json()["venue_label"], second.json()["venue_label"]} == {"T-01", "T-02"}

    assert third.status_code == 409, third.text
    detail = third.json()["detail"]
    assert detail["code"] == "VENUE_TAKEN"
    assert "비즈매칭존 테이블" in detail["message"]
    assert "2곳이 모두 사용 중" in detail["message"]


def test_reopened_policy_without_registered_tables_is_venue_type_disabled(client, db_factory, monkeypatch):
    monkeypatch.setattr(app_settings, "meeting_bookable_venue_types", ["zone_table"], raising=True)
    w = _world_1001(db_factory, enabled_venue_types=("booth", "zone_table"), zone_tables=())
    _as_master(w["event_id"])

    r = _assign(client, w["event_id"], w["e1"], w["b1"], [_slot("13:00")])

    assert r.status_code == 422, r.text
    detail = r.json()["detail"]
    assert detail["code"] == "VENUE_TYPE_DISABLED"
    assert "등록된 미팅 장소(비즈매칭존 테이블)가 없습니다" in detail["message"]


def test_event_without_booth_falls_back_to_a_free_table(client, db_factory):
    """부스를 쓰지 않는 행사(enabled=zone_table) — 기본 정책(booth)과 교집합이 비어 행사 설정으로
    폴백한다(참가자 신청과 같은 규칙, ``_bookable_venue_types``)."""
    w = _world_1001(db_factory, enabled_venue_types=("zone_table",), zone_tables=("T-01", "T-02"))
    _as_master(w["event_id"])

    first = _assign(client, w["event_id"], w["e1"], w["b1"], [_slot("13:00")])
    second = _assign(client, w["event_id"], w["e2"], w["b2"], [_slot("13:00")])

    assert first.status_code == 201, first.text
    assert second.status_code == 201, second.text
    assert (first.json()["venue_type"], first.json()["venue_label"]) == ("zone_table", "T-01")
    assert (second.json()["venue_type"], second.json()["venue_label"]) == ("zone_table", "T-02")


def test_event_without_any_enabled_venue_type_is_venue_type_disabled(client, db_factory):
    w = _world_1001(db_factory, enabled_venue_types=(), zone_tables=())
    _as_master(w["event_id"])

    r = _assign(client, w["event_id"], w["e1"], w["b1"], [_slot("13:00")])

    assert r.status_code == 422, r.text
    assert r.json()["detail"]["code"] == "VENUE_TYPE_DISABLED"
    assert "장소 유형" in r.json()["detail"]["message"]


# =============================================================================
# 하위 호환 — venue_id를 명시하면 그 장소를 그대로 쓴다
# =============================================================================
@OPERATOR_ENDPOINTS
def test_explicit_venue_id_is_still_honored(client, db_factory, endpoint):
    """운영자가 장소를 명시하면 정책 대신 그 장소다. 같은 장소를 같은 시각에 또 명시하면 VENUE_TAKEN —
    10/1 운영에서 BFF가 매번 INC를 명시해 넘긴 결과가 정확히 이것이었다(그래서 BFF는 이제 안 넘긴다)."""
    w = _world_1001(db_factory)
    db = db_factory()
    try:
        inc_id = str(
            db.execute(
                select(MeetingVenue.id).where(
                    MeetingVenue.event_id == w["event_id"], MeetingVenue.label == "INC"
                )
            ).scalar_one()
        )
    finally:
        db.close()
    _as_master(w["event_id"])

    first = _assign(client, w["event_id"], w["e1"], w["b1"], [_slot("13:00")], endpoint=endpoint, venue_id=inc_id)
    second = _assign(client, w["event_id"], w["e2"], w["b2"], [_slot("13:00")], endpoint=endpoint, venue_id=inc_id)

    assert first.status_code == 201, first.text
    assert (first.json()["venue_id"], first.json()["venue_label"]) == (inc_id, "INC")
    assert second.status_code == 409, second.text
    assert second.json()["detail"]["code"] == "VENUE_TAKEN"


# =============================================================================
# 참가자 화면에서도 같은 부스·같은 표기 — "참가기업 부스 7홀 A-12"
# =============================================================================
def test_forced_meeting_shows_as_the_same_booth_on_participant_screens(client, db_factory):
    """강제 배정(venue_id 없음)으로 생긴 미팅이 참가자 쪽에서 **같은 부스 장소 행**으로 보이는가.

    - 내 미팅(GET /api/meetings): 양쪽 모두 venue_type=booth, venue_label="7홀 A-12".
    - 미팅 신청 2단계(GET /api/meetings/availability): 부스 줄 문구가 "참가기업 부스 7홀 A-12 미팅"이고,
      그 시각엔 이 미팅 때문에 부스가 "마감"으로 잡힌다 — 참가자 신청이 찾는 장소 행(저장 라벨 멱등키)과
      운영자 배정이 쓴 장소 행이 같다는 증거. 다른 시각엔 그대로 "가능".
    """
    w = _world_1001(db_factory)
    _as_master(w["event_id"])
    assert _assign(client, w["event_id"], w["e1"], w["b1"], [_slot("13:00")]).status_code == 201

    for viewer in (w["e1"], w["b1"]):
        _login_as(viewer)
        listed = client.get("/api/meetings", params={"event_id": w["event_id"]})
        assert listed.status_code == 200, listed.text
        [item] = listed.json()["items"]
        assert (item["venue_type"], item["venue_label"]) == ("booth", "7홀 A-12")

    def _booth_option(slot_hhmm: str) -> dict:
        _login_as(w["b2"])  # 다른 바이어가 같은 참가사에게 신청하려는 화면
        r = client.get(
            "/api/meetings/availability",
            params={
                "counterpart_org_id": w["e1"],
                "event_id": w["event_id"],
                "slot_ids": [_slot(slot_hhmm)],
            },
        )
        assert r.status_code == 200, r.text
        return next(v for v in r.json()["venues"] if v["kind"] == "booth")

    taken = _booth_option("13:00")
    assert taken["name"] == "참가사1 부스"
    assert taken["description"] == "참가기업 부스 7홀 A-12 미팅"
    assert taken["badge"]["tone"] == "unavailable"  # 강제 배정 미팅이 바로 이 부스를 쓰고 있다

    free = _booth_option("13:45")
    assert free["description"] == "참가기업 부스 7홀 A-12 미팅"
    assert free["badge"]["tone"] == "available"


# =============================================================================
# 동시성 — 장소 결정은 book_meeting 임계구역 안에서 일어난다
# =============================================================================
def test_concurrent_same_time_assignments_take_different_free_tables(db_factory, monkeypatch):
    """테이블 2개(T-01·T-02) · 같은 시각 · 서로 다른 쌍 두 건이 **동시에** 들어오면 A는 T-01, B는 **T-02**를 얻는다.

    A가 장소 락을 쥔 채(flush만, commit 전) 있는 동안 B는 장소 후보 락에서 실제로 대기해야 하고, A commit
    뒤 풀려난 B는 T-01이 찼다는 걸 **락 안에서** 보고 비어 있는 T-02로 가야 한다.

    판별력(리뷰 L1): 예전 판(테이블 1개, "B는 VENUE_TAKEN")은 장소를 잠금 **밖에서** 미리 고르는 잘못된
    구현으로도 통과했다 — DB EXCLUDE 제약이 대신 B를 막아 같은 VENUE_TAKEN이 났기 때문이다. 테이블이
    2개면 잘못된 구현의 B는 A의 미커밋 T-01을 못 보고 T-01을 골랐다가 EXCLUDE에 막혀 실패한다 — 그래서
    "B가 T-02로 성공"을 단언해야 구현이 잠금 안에서 판정한다는 증거가 된다.
    """
    from app.matching.assignment_service import _auto_venue_resolver

    monkeypatch.setattr(app_settings, "meeting_bookable_venue_types", ["zone_table"], raising=True)
    w = _world_1001(db_factory, enabled_venue_types=("zone_table",), zone_tables=("T-01", "T-02"))
    db = db_factory()
    try:
        policy = schedule_policy(db, db.get(Event, w["event_id"]))
        slot = next(s for s in build_grid(policy)[0].slots if s.time == "13:00")
    finally:
        db.close()

    a_flushed = threading.Event()
    release_a = threading.Event()
    b_finished = threading.Event()
    results: dict = {}

    def _book(session, exhibitor, buyer):
        event = session.get(Event, w["event_id"])
        meeting = book_meeting(
            session,
            event_id=w["event_id"],
            exhibitor_org_id=exhibitor,
            buyer_org_id=buyer,
            start=slot.start,
            end=slot.end,
            resolve_venue=_auto_venue_resolver(
                session, event, exhibitor_org_id=exhibitor, start=slot.start, end=slot.end
            ),
            entry_state=EntryState.ACCEPTED,
            matching_type="forced",
            requested_by="organizer",
        )
        return session.get(MeetingVenue, meeting.venue_id).label

    def _run_a():
        session_a = db_factory()
        try:
            results["a_venue"] = _book(session_a, w["e1"], w["b1"])
            a_flushed.set()
            # A는 장소 락을 쥔 채(트랜잭션 미종료) B가 그 락에서 대기하는 걸 재현할 시간을 준다.
            release_a.wait(timeout=5)
            session_a.commit()
        finally:
            session_a.close()

    def _run_b():
        session_b = db_factory()
        try:
            a_flushed.wait(timeout=5)
            try:
                results["b_venue"] = _book(session_b, w["e2"], w["b2"])
                session_b.commit()
                results["b_error"] = None
            except MeetingError as exc:
                results["b_error"] = exc
            finally:
                b_finished.set()
        finally:
            session_b.rollback()
            session_b.close()

    thread_a = threading.Thread(target=_run_a)
    thread_b = threading.Thread(target=_run_b)
    thread_a.start()
    assert a_flushed.wait(timeout=5), "A가 제시간에 flush를 못 끝냈다"
    thread_b.start()

    time.sleep(0.3)
    assert not b_finished.is_set(), "B가 A의 장소 락을 기다리지 않았다 — 장소 판정이 임계구역 밖이다"

    release_a.set()
    thread_a.join(timeout=5)
    thread_b.join(timeout=5)

    assert results.get("a_venue") == "T-01"
    assert results.get("b_error") is None, f"B가 빈 T-02를 두고 거부됐다: {results.get('b_error')!r}"
    assert results.get("b_venue") == "T-02"
    assert _meetings_at_venue(db_factory, w["event_id"], "T-01") == 1
    assert _meetings_at_venue(db_factory, w["event_id"], "T-02") == 1
