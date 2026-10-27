"""가용 슬롯 조회 테스트 (F-MT-001 ``GET /api/meetings/availability``).

두 종류를 본다:

1. **응답 형태** — 프런트 미팅 신청 모달의 계약(``MeetingDate``/``TimeSlot``/``VenueOption``)과
   맞는지. 날짜 id·label·weekday, 슬롯 id 형식, 장소 어휘(캐노니컬).
2. **available 판정** — 참가사 불가 슬롯, 양쪽 org의 확정 미팅 겹침, 점심 제외, 과거 배제.
   ⚠ 이 판정은 신청 시 쓰기 가드와 **같은 술어**(``matching.slot_booking``)를 써야 한다 —
   갈라지면 "화면엔 비었는데 누르면 409"가 된다. 그래서 여기서 확정 미팅을 만들고 그 슬롯이
   실제로 unavailable로 바뀌는지 확인한다.

라우트 **선언 순서 회귀**도 여기서 잠근다 — ``/availability``가 ``/{meeting_id}`` 뒤로 밀리면
"availability"가 경로 파라미터로 먹혀 404가 난다. 조용히 깨지는 종류의 사고라 테스트로 못 박는다.
"""

from __future__ import annotations

import itertools
import uuid
from datetime import date, time, timedelta
from zoneinfo import ZoneInfo

import pytest
from fastapi.routing import APIRoute
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.admin.guard import EventOperatorPrincipal, require_event_operator
from app.auth.principal import Principal, get_current_principal
from app.config import Settings
from app.config import settings as app_settings
from app.db import get_session
from app.main import app
from app.meetings.router import router as meetings_router
from app.meetings.service import _badge
from app.models import (
    Booth,
    Event,
    EventScheduleSettings,
    ExhibitorProfile,
    Hall,
    MeetingVenue,
    Organization,
    OrganizationEventRole,
)

_seq = itertools.count(1)

TODAY = date.today()
EXHIBITION_START = TODAY + timedelta(days=15)
EXHIBITION_END = EXHIBITION_START + timedelta(days=2)


def _slot(hhmm: str, *, day_offset: int = 0) -> str:
    return f"{(EXHIBITION_START + timedelta(days=day_offset)).isoformat()}T{hhmm}"


BLOCKED = _slot("09:00")


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


def _login_as(org_id: str) -> None:
    app.dependency_overrides[get_current_principal] = lambda: Principal(
        member_id=str(uuid.uuid4()), organization_id=str(org_id)
    )


def _assign_booth_as_operator(
    client, world, number: str, *, permission_level: str = "master"
):
    """운영자 콘솔의 "부스" 칸과 **같은 엔드포인트**로 부스를 지정한다(#OP PATCH .../profile).

    화면 문구 회귀를 부스 컬럼 직접 시드가 아니라 실제 운영자 경로로 잠근다 — 저장 경로와 표시
    경로가 갈라지면(운영자가 넣은 값이 미팅 화면에 안 보이면) 이 테스트가 깨져야 한다.
    """
    app.dependency_overrides[require_event_operator] = lambda: EventOperatorPrincipal(
        member_id="mbr-op", event_id=world["event_id"], permission_level=permission_level,
        organizer_id="org-op",
    )
    try:
        return client.patch(
            f"/api/admin/events/{world['event_id']}/organizations/{world['exhibitor_org']}/profile",
            params={"role": "exhibitor"},
            json={"booth_location": number},
        )
    finally:
        app.dependency_overrides.pop(require_event_operator, None)


def _seed(
    db_factory,
    *,
    timezone_name: str = "Asia/Seoul",
    slot_minutes: int = 30,
    buyer_subtype: str = "pre_registered",
    enabled_venue_types: list[str] | None = None,
    zone_tables: int = 4,
    operating_start: time = time(9, 0),
    operating_end: time = time(18, 0),
    lunch_start: time | None = time(12, 0),
    lunch_end: time | None = time(13, 0),
    slot_gap_minutes: int = 0,
    max_meeting_minutes: int = 90,
    with_booth: bool = True,
    declared_booth: str | None = None,
) -> dict:
    n = next(_seq)
    db = db_factory()
    try:
        event = Event(
            name="DX Korea 2026",
            name_en="DX Korea 2026",
            slug=f"avail-{n}-{uuid.uuid4().hex[:8]}",
            timezone=timezone_name,
            slot_minutes=slot_minutes,
            exhibition_start=EXHIBITION_START,
            exhibition_end=EXHIBITION_END,
            application_start=TODAY - timedelta(days=7),
            application_end=TODAY + timedelta(days=10),
            enabled_venue_types=enabled_venue_types or ["booth", "zone_table"],
        )
        db.add(event)
        db.flush()
        db.add(
            EventScheduleSettings(
                event_id=event.id,
                operating_start=operating_start,
                operating_end=operating_end,
                lunch_start=lunch_start,
                lunch_end=lunch_end,
                slot_gap_minutes=slot_gap_minutes,
                max_meeting_minutes=max_meeting_minutes,
            )
        )
        exhibitor = Organization(name_ko="한빛디펜스", name_en="Hanbit Defense")
        buyer = Organization(name_ko="Global Marine", name_en="Global Marine")
        db.add_all([exhibitor, buyer])
        db.flush()
        exhibitor_role = OrganizationEventRole(
            event_id=event.id, organization_id=exhibitor.id,
            is_exhibitor=True, application_status="approved",
        )
        db.add(exhibitor_role)
        db.add(
            OrganizationEventRole(
                event_id=event.id, organization_id=buyer.id, is_buyer=True,
                buyer_subtype=buyer_subtype, application_status="approved",
            )
        )
        db.flush()
        booth_id = None
        if with_booth:
            hall = Hall(event_id=event.id, hall_no="7", hall_name="7홀")
            db.add(hall)
            db.flush()
            booth = Booth(hall_id=hall.id, code="A-12")
            db.add(booth)
            db.flush()
            booth_id = booth.id
        db.add(
            ExhibitorProfile(
                org_event_role_id=exhibitor_role.id,
                booth_id=booth_id,
                booth_location=declared_booth,
                unavailable_meeting_slots=[BLOCKED],
            )
        )
        for i in range(zone_tables):
            db.add(MeetingVenue(event_id=event.id, venue_type="zone_table", label=f"T-{i + 1:02d}"))
        db.commit()
        return {
            "event_id": str(event.id),
            "exhibitor_org": str(exhibitor.id),
            "buyer_org": str(buyer.id),
        }
    finally:
        db.close()


def _availability(client, world, viewer, counterpart, **params):
    _login_as(viewer)
    return client.get(
        "/api/meetings/availability",
        params={"counterpart_org_id": counterpart, "event_id": world["event_id"], **params},
    )


def _flat(day: dict) -> dict[str, bool]:
    return {s["id"]: s["available"] for s in day["morning"] + day["afternoon"]}


# =============================================================================
# 라우트 선언 순서 회귀
# =============================================================================
def test_availability_route_is_declared_before_meeting_id_route():
    """``/availability``가 ``/{meeting_id}`` 앞에 있어야 한다(FastAPI는 선언 순서로 매칭).

    앱이 아니라 **라우터**를 들여다본다 — ``include_router``가 선언 순서를 그대로 옮기므로
    불변식이 사는 곳은 라우터 모듈이고, 앱 쪽 표현은 FastAPI 버전에 따라 평탄화되지 않는다.
    """
    paths = [r.path for r in meetings_router.routes if isinstance(r, APIRoute)]
    assert paths.index("/api/meetings/availability") < paths.index("/api/meetings/{meeting_id}")


def test_availability_path_is_not_swallowed_as_meeting_id(client, db_factory):
    """경로가 단건 조회로 먹히면 404가 난다 — 200이 나오는 것 자체가 순서 보증이다."""
    world = _seed(db_factory)
    r = _availability(client, world, world["buyer_org"], world["exhibitor_org"])
    assert r.status_code == 200


def test_bookable_venue_types_setting_accepts_csv_and_json():
    """정책 스위치 표기 — 콤마 구분과 JSON 배열을 모두 받는다(표기 오타로 앱이 죽지 않게)."""
    assert Settings(
        meeting_bookable_venue_types="booth,zone_table"
    ).meeting_bookable_venue_types == ["booth", "zone_table"]
    assert Settings(
        meeting_bookable_venue_types='["booth","business_room"]'
    ).meeting_bookable_venue_types == ["booth", "business_room"]


def test_availability_badges_keep_korean_default_and_localize_to_english():
    """DB 없이도 locale별 뱃지 문구와 기존 기본값을 고정한다."""
    assert _badge(1, 1) == {"text": "가능", "tone": "available"}
    assert _badge(0, 4, locale="en") == {"text": "Full", "tone": "unavailable"}
    assert _badge(1, 4, locale="en") == {"text": "1 left", "tone": "limited"}
    assert _badge(4, 4, locale="en") == {"text": "Available", "tone": "available"}


# =============================================================================
# 응답 형태
# =============================================================================
def test_shape_matches_meeting_modal_contract(client, db_factory):
    world = _seed(db_factory)
    body = _availability(client, world, world["buyer_org"], world["exhibitor_org"]).json()

    assert body["slot_minutes"] == 30
    # 격자 모양의 나머지 두 축(mt003gap0001). TimeSlotOut 이 시작 시각만 싣기 때문에 프런트는 이
    # 값들로 종료 시각·소요시간 라벨·연속 상한을 계산한다 — 없으면 30분을 하드코딩하게 된다.
    assert body["slot_gap_minutes"] == 0
    assert body["max_meeting_minutes"] == 90
    assert body["timezone"] == "Asia/Seoul"
    assert body["acceptance_mode"] == "pending"  # 일반 바이어 → 수락대기
    assert "한빛디펜스" in body["draft_reason"]

    assert len(body["dates"]) == 3  # 전시 3일(시작·종료 포함)
    day = body["dates"][0]
    assert day["id"] == EXHIBITION_START.isoformat()
    assert day["label"] == f"{EXHIBITION_START.month}/{EXHIBITION_START.day}"
    assert day["weekday"] in tuple("월화수목금토일")

    first = day["morning"][0]
    assert first["id"] == f"{day['id']}T09:00"  # 슬롯 id 형식 계약
    assert first["time"] == "09:00"
    assert isinstance(first["available"], bool)


def test_availability_ko_is_the_existing_korean_response_and_default(client, db_factory):
    """locale 누락·ko·알 수 없는 값은 모두 기존 한국어 계약으로 수렴한다."""
    world = _seed(db_factory)
    default = _availability(client, world, world["buyer_org"], world["exhibitor_org"]).json()
    korean = _availability(
        client, world, world["buyer_org"], world["exhibitor_org"], locale="ko"
    ).json()
    unknown = _availability(
        client, world, world["buyer_org"], world["exhibitor_org"], locale="ja"
    ).json()

    assert korean == default == unknown
    assert default["draft_reason"] == (
        "안녕하세요, 한빛디펜스 담당자님.\n\n"
        "저희는 귀사의 사업 분야에 큰 관심이 있어 미팅을 요청드립니다. "
        "귀사의 기술력과 협력 가능성을 자세히 알고 싶습니다.\n\n"
        "DX Korea 2026에서 직접 뵙고 이야기 나눌 수 있기를 기대합니다."
    )
    assert default["dates"][0]["weekday"] in tuple("월화수목금토일")
    assert default["venues"][0]["name"] == "한빛디펜스 부스"
    assert default["venues"][0]["badge"]["text"] == "가능"


def test_availability_en_localizes_presentation_and_makes_bilingual_draft(client, db_factory):
    world = _seed(db_factory)
    body = _availability(
        client, world, world["buyer_org"], world["exhibitor_org"], locale="en"
    ).json()

    assert body["dates"][0]["weekday"] in {"Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"}
    assert body["venues"][0]["name"] == "Hanbit Defense Booth"
    assert body["venues"][0]["description"] == "Meeting at the exhibitor's booth (Hall 7 A-12)"
    assert body["venues"][0]["badge"]["text"] == "Available"
    assert body["venues"][1]["name"] == "Matching zone table"
    # 매칭존 테이블은 예약을 받지 않는다(운영 정책) — 자리가 비어도 '불가능'이다.
    assert body["venues"][1]["badge"]["text"] == "Unavailable"

    korean, english = body["draft_reason"].split("\n\n---\n\n", maxsplit=1)
    assert korean.startswith("안녕하세요, 한빛디펜스 담당자님.")
    assert english.startswith("Hello, Hanbit Defense representative.")
    assert english.endswith("at DX Korea 2026.")


def test_bilingual_draft_with_long_names_stays_within_request_limit(client, db_factory):
    world = _seed(db_factory)
    db = db_factory()
    try:
        event = db.get(Event, world["event_id"])
        counterpart = db.get(Organization, world["exhibitor_org"])
        assert event is not None and counterpart is not None
        event.name = "행사" * 100
        event.name_en = "Event" * 40
        counterpart.name_ko = "기업" * 100
        counterpart.name_en = "Company" * 28
        db.commit()
    finally:
        db.close()

    body = _availability(
        client, world, world["buyer_org"], world["exhibitor_org"], locale="en"
    ).json()
    assert len(body["draft_reason"]) < 2000


def test_lunch_slots_are_absent_not_merely_unavailable(client, db_factory):
    """점심 칸은 '불가'가 아니라 **그리드에 없다** — 선택지 자체를 만들지 않는다."""
    world = _seed(db_factory)
    body = _availability(client, world, world["buyer_org"], world["exhibitor_org"]).json()
    slots = _flat(body["dates"][0])

    assert _slot("12:00") not in slots
    assert _slot("12:30") not in slots
    assert body["dates"][0]["afternoon"][0]["time"] == "13:00"
    assert body["dates"][0]["morning"][-1]["time"] == "11:30"


def test_hosted_buyer_counterpart_reports_immediate_mode(client, db_factory):
    """초청 바이어에게 신청하면 즉시 확정 — 화면 문구가 달라야 하므로 미리 알려준다."""
    world = _seed(db_factory, buyer_subtype="hosted")
    body = _availability(client, world, world["exhibitor_org"], world["buyer_org"]).json()
    assert body["acceptance_mode"] == "immediate"


def test_venue_kinds_use_canonical_db_vocabulary(client, db_factory):
    """응답은 booth/zone_table/business_room만 — 입력 별칭(table/room)은 나가지 않는다."""
    world = _seed(db_factory)
    body = _availability(client, world, world["buyer_org"], world["exhibitor_org"]).json()

    kinds = [v["kind"] for v in body["venues"]]
    assert kinds == ["booth", "zone_table"]  # 행사에서 켜진 유형만, 캐노니컬 순서

    booth = body["venues"][0]
    assert "7홀 A-12" in booth["description"]  # 상대 참가사의 실제 부스 라벨
    assert booth["numbers"] is None  # 부스는 자리 선택이 없다
    assert booth["badge"]["tone"] == "available"

    tables = body["venues"][1]
    assert [n["value"] for n in tables["numbers"]] == ["T-01", "T-02", "T-03", "T-04"]
    assert all(n["available"] for n in tables["numbers"])


def test_disabled_venue_type_is_omitted(client, db_factory):
    world = _seed(db_factory, enabled_venue_types=["booth"])
    body = _availability(client, world, world["buyer_org"], world["exhibitor_org"]).json()
    assert [v["kind"] for v in body["venues"]] == ["booth"]


# =============================================================================
# 부스 줄 문구 — "누구의 부스인지 + 실제 부스번호"
# =============================================================================
def test_booth_option_names_the_exhibitor_and_carries_its_booth_number(client, db_factory):
    """발주사 요구 — 제목은 참가사 기업명, 설명은 실제 부스번호(일반 문구·상대 기업명 중복 금지)."""
    world = _seed(db_factory)
    booth = _availability(client, world, world["buyer_org"], world["exhibitor_org"]).json()[
        "venues"
    ][0]

    assert booth["name"] == "한빛디펜스 부스"
    assert booth["description"] == "참가기업 부스 7홀 A-12 미팅"
    assert "Global Marine" not in booth["description"]  # 상대(바이어) 이름이 끼지 않는다

    english = _availability(
        client, world, world["buyer_org"], world["exhibitor_org"], locale="en"
    ).json()["venues"][0]
    assert english["name"] == "Hanbit Defense Booth"
    assert english["description"] == "Meeting at the exhibitor's booth (Hall 7 A-12)"


def test_booth_option_uses_the_exhibitor_booth_in_the_other_direction(client, db_factory):
    """참가사 → 바이어 신청에서도 부스 주인은 참가사다 — 상대(바이어) 이름이 제목이 되면 안 된다."""
    world = _seed(db_factory)
    booth = _availability(client, world, world["exhibitor_org"], world["buyer_org"]).json()[
        "venues"
    ][0]

    assert booth["name"] == "한빛디펜스 부스"
    assert booth["description"] == "참가기업 부스 7홀 A-12 미팅"


def test_booth_option_falls_back_to_the_declared_booth_number(client, db_factory):
    """부스 배정 행이 없어도 참가신청 신고값(booth_location)이 있으면 그 번호를 보여준다.

    운영자 콘솔의 "부스" 칸과 같은 출처다 — 배정 테이블(halls/booths)이 아직 비어 있는 행사에서도
    참가자가 찾아갈 번호가 화면에 있어야 한다.
    """
    world = _seed(db_factory, with_booth=False, declared_booth="01")
    booth = _availability(client, world, world["buyer_org"], world["exhibitor_org"]).json()[
        "venues"
    ][0]

    assert booth["name"] == "한빛디펜스 부스"
    assert booth["description"] == "참가기업 부스 01 미팅"

    english = _availability(
        client, world, world["buyer_org"], world["exhibitor_org"], locale="en"
    ).json()["venues"][0]
    assert english["description"] == "Meeting at the exhibitor's booth (01)"


def test_operator_assigned_booth_number_shows_up_on_the_meeting_request_screen(
    client, db_factory
):
    """발주자 요구(2026-09-28) 종단 확인 — 운영자가 부스를 지정하면 미팅 신청 2단계에 그대로 보인다.

    지정 전엔 번호 없는 문구, 지정 후엔 목업 문구("참가기업 부스 01 미팅")다. en도 같은 값을 쓴다.
    """
    world = _seed(db_factory, with_booth=False, declared_booth=None)

    before = _availability(client, world, world["buyer_org"], world["exhibitor_org"]).json()
    assert before["venues"][0]["description"] == "참가기업 부스에서 미팅"

    assert _assign_booth_as_operator(client, world, "01").status_code == 200

    after = _availability(client, world, world["buyer_org"], world["exhibitor_org"]).json()
    assert after["venues"][0]["name"] == "한빛디펜스 부스"
    assert after["venues"][0]["description"] == "참가기업 부스 01 미팅"

    english = _availability(
        client, world, world["buyer_org"], world["exhibitor_org"], locale="en"
    ).json()
    assert english["venues"][0]["description"] == "Meeting at the exhibitor's booth (01)"


def test_sub_operator_cannot_change_the_booth_number_shown_on_the_screen(client, db_factory):
    """부스 지정은 master 전용 — sub 요청은 403이고 화면 문구도 그대로다."""
    world = _seed(db_factory, with_booth=False, declared_booth="01")

    assert _assign_booth_as_operator(client, world, "99", permission_level="sub").status_code == 403

    booth = _availability(client, world, world["buyer_org"], world["exhibitor_org"]).json()[
        "venues"
    ][0]
    assert booth["description"] == "참가기업 부스 01 미팅"


def test_assigned_booth_wins_over_the_declared_number(client, db_factory):
    """배정값이 있으면 그것이 진실이다(신고값은 배정 전 임시 표시일 뿐)."""
    world = _seed(db_factory, declared_booth="01")
    booth = _availability(client, world, world["buyer_org"], world["exhibitor_org"]).json()[
        "venues"
    ][0]

    assert booth["description"] == "참가기업 부스 7홀 A-12 미팅"


def test_declared_booth_number_does_not_leak_into_the_stored_venue_label(client, db_factory):
    """화면 문구가 바뀌어도 meeting_venues 저장 라벨 규칙은 그대로다.

    저장 라벨은 장소 행의 멱등키((event_id,'booth',label))이고 부스 중복예약 가드가 그 행 단위로
    돈다 — 신고값이 라벨로 새면 같은 부스에 장소 행이 둘 생겨 같은 시간에 두 건이 잡힐 수 있다.
    """
    world = _seed(db_factory, with_booth=False, declared_booth="01")

    _login_as(world["buyer_org"])
    created = client.post(
        "/api/meetings",
        json={
            "counterpart_org_id": world["exhibitor_org"],
            "event_id": world["event_id"],
            "slot_ids": [_slot("10:00")],
            "venue_type": "booth",
        },
    )
    assert created.status_code == 201
    assert created.json()["venue_label"] == "한빛디펜스 부스"


def test_booth_option_degrades_when_no_booth_number_is_recorded(client, db_factory):
    """배정도 신고도 없으면(정상 상태) 가짜 번호를 만들지 않고 기업명만 남긴다."""
    world = _seed(db_factory, with_booth=False)
    booth = _availability(client, world, world["buyer_org"], world["exhibitor_org"]).json()[
        "venues"
    ][0]

    assert booth["name"] == "한빛디펜스 부스"
    assert booth["description"] == "참가기업 부스에서 미팅"

    english = _availability(
        client, world, world["buyer_org"], world["exhibitor_org"], locale="en"
    ).json()["venues"][0]
    assert english["name"] == "Hanbit Defense Booth"
    assert english["description"] == "Meeting at the exhibitor's booth"


# =============================================================================
# 선택 가능 정책(settings.meeting_bookable_venue_types)
# =============================================================================
def test_only_booth_is_selectable_by_default(client, db_factory):
    """현 운영 정책 — 부스만 예약을 받는다. 나머지는 목록에 남되 '불가능'으로 선택 불가."""
    world = _seed(
        db_factory, enabled_venue_types=["booth", "zone_table", "business_room"]
    )
    venues = _availability(client, world, world["buyer_org"], world["exhibitor_org"]).json()[
        "venues"
    ]

    assert [(v["kind"], v["selectable"]) for v in venues] == [
        ("booth", True),
        ("zone_table", False),
        ("business_room", False),
    ]
    assert [v["badge"]["text"] for v in venues] == ["가능", "불가능", "불가능"]
    assert [v["badge"]["tone"] for v in venues] == ["available", "unavailable", "unavailable"]
    # 자리 계산은 계속 내려간다 — 정책이 열리는 순간 화면이 다시 정확해야 한다.
    assert [n["value"] for n in venues[1]["numbers"]] == ["T-01", "T-02", "T-03", "T-04"]

    english = _availability(
        client, world, world["buyer_org"], world["exhibitor_org"], locale="en"
    ).json()["venues"]
    assert [v["badge"]["text"] for v in english] == ["Available", "Unavailable", "Unavailable"]


def test_policy_switch_reopens_a_venue_type(client, db_factory, monkeypatch):
    """스위치 하나로 되돌릴 수 있어야 한다(MEETING_BOOKABLE_VENUE_TYPES)."""
    monkeypatch.setattr(
        app_settings, "meeting_bookable_venue_types", ["booth", "zone_table"], raising=True
    )
    world = _seed(db_factory)
    venues = _availability(client, world, world["buyer_org"], world["exhibitor_org"]).json()[
        "venues"
    ]

    assert [(v["kind"], v["selectable"]) for v in venues] == [
        ("booth", True),
        ("zone_table", True),
    ]
    assert [v["badge"]["text"] for v in venues] == ["가능", "가능"]


def test_policy_does_not_lock_an_event_without_a_bookable_venue(client, db_factory):
    """정책과 행사 설정의 교집합이 비면 정책을 적용하지 않는다 — 신청 자체를 막는 게 더 나쁘다."""
    world = _seed(db_factory, enabled_venue_types=["zone_table"])
    venues = _availability(client, world, world["buyer_org"], world["exhibitor_org"]).json()[
        "venues"
    ]

    assert [(v["kind"], v["selectable"]) for v in venues] == [("zone_table", True)]
    assert venues[0]["badge"]["text"] == "가능"


# =============================================================================
# available 판정
# =============================================================================
def test_exhibitor_blocked_slot_is_unavailable(client, db_factory):
    world = _seed(db_factory)
    body = _availability(client, world, world["buyer_org"], world["exhibitor_org"]).json()
    assert _flat(body["dates"][0])[BLOCKED] is False


def test_accepted_meeting_makes_slot_unavailable_for_both_orgs(client, db_factory):
    """가용성과 쓰기 가드가 같은 술어를 쓰는지 — 확정 미팅을 만들고 그 슬롯이 닫히는지 본다."""
    world = _seed(db_factory, buyer_subtype="hosted")
    target = _slot("10:00")

    _login_as(world["exhibitor_org"])
    created = client.post(
        "/api/meetings",
        json={
            "counterpart_org_id": world["buyer_org"],
            "event_id": world["event_id"],
            "slot_ids": [target],
            "venue_type": "booth",
        },
    )
    assert created.status_code == 201 and created.json()["status"] == "accepted"

    body = _availability(client, world, world["exhibitor_org"], world["buyer_org"]).json()
    slots = _flat(body["dates"][0])
    assert slots[target] is False
    assert slots[_slot("10:30")] is True  # 인접 칸은 그대로 열려 있다(반열림 구간)


def test_proposed_meeting_does_not_close_the_slot(client, db_factory):
    """proposed는 점유하지 않는다 — 다른 신청자에게 그 시간은 여전히 열려 있어야 한다."""
    world = _seed(db_factory)
    target = _slot("10:00")

    _login_as(world["buyer_org"])
    created = client.post(
        "/api/meetings",
        json={
            "counterpart_org_id": world["exhibitor_org"],
            "event_id": world["event_id"],
            "slot_ids": [target],
            "venue_type": "booth",
        },
    )
    assert created.status_code == 201 and created.json()["status"] == "proposed"

    body = _availability(client, world, world["buyer_org"], world["exhibitor_org"]).json()
    assert _flat(body["dates"][0])[target] is True


def test_slot_ids_filter_venue_numbers_by_time(client, db_factory):
    """시간을 먼저 고르면 그 시간 기준으로 자리 가용이 계산된다(모달의 2단계 흐름)."""
    world = _seed(db_factory, buyer_subtype="hosted", zone_tables=2)
    target = _slot("11:00")

    _login_as(world["exhibitor_org"])
    created = client.post(
        "/api/meetings",
        json={
            "counterpart_org_id": world["buyer_org"],
            "event_id": world["event_id"],
            "slot_ids": [target],
            "venue_type": "zone_table",
        },
    )
    assert created.status_code == 201

    # 그 시간엔 T-01이 찼다.
    at_target = _availability(
        client, world, world["exhibitor_org"], world["buyer_org"], slot_ids=[target]
    ).json()
    numbers = {n["value"]: n["available"] for n in at_target["venues"][1]["numbers"]}
    assert numbers == {"T-01": False, "T-02": True}

    # 다른 시간엔 둘 다 비어 있다.
    elsewhere = _availability(
        client, world, world["exhibitor_org"], world["buyer_org"], slot_ids=[_slot("15:00")]
    ).json()
    assert all(n["available"] for n in elsewhere["venues"][1]["numbers"])


def test_invalid_slot_ids_do_not_fail_availability(client, db_factory):
    """가용성 조회는 시간 조합을 검증하는 자리가 아니다 — 신청 시점에 정확히 거부된다."""
    world = _seed(db_factory)
    r = _availability(
        client, world, world["buyer_org"], world["exhibitor_org"], slot_ids=["garbage"]
    )
    assert r.status_code == 200
    assert r.json()["venues"]  # 장소 목록은 필터 없이 그대로 나온다


# =============================================================================
# 타임존 / 슬롯 길이 변형
# =============================================================================
def test_ho_chi_minh_event_reports_its_own_timezone(client, db_factory):
    """멀티 행사 — KST를 코드에 박지 않는다. 그리드는 행사 로컬 시각으로 만들어진다."""
    world = _seed(db_factory, timezone_name="Asia/Ho_Chi_Minh")
    body = _availability(client, world, world["buyer_org"], world["exhibitor_org"]).json()

    assert body["timezone"] == "Asia/Ho_Chi_Minh"
    # 로컬 벽시계 기준 그리드라 운영 09:00 시작은 타임존과 무관하게 같은 문자열이다.
    assert body["dates"][0]["morning"][0]["time"] == "09:00"

    _login_as(world["buyer_org"])
    created = client.post(
        "/api/meetings",
        json={
            "counterpart_org_id": world["exhibitor_org"],
            "event_id": world["event_id"],
            "slot_ids": [_slot("10:00")],
            "venue_type": "booth",
        },
    )
    assert created.status_code == 201
    # 저장된 절대시각은 +07:00 오프셋으로 해석된다(문자열은 같아도 순간은 다르다).
    assert created.json()["scheduled_start"].endswith("+07:00")


@pytest.mark.parametrize(
    "slot_minutes, expected_morning, expected_afternoon",
    [
        # 운영 09:00~18:00, 점심 12:00~13:00 기준 하루 칸 수.
        (60, 3, 5),  # 09,10,11 / 13,14,15,16,17
        (30, 6, 10),
    ],
)
def test_slot_minutes_shapes_the_grid(
    client, db_factory, slot_minutes, expected_morning, expected_afternoon
):
    world = _seed(db_factory, slot_minutes=slot_minutes)
    body = _availability(client, world, world["buyer_org"], world["exhibitor_org"]).json()

    assert body["slot_minutes"] == slot_minutes
    day = body["dates"][0]
    assert len(day["morning"]) == expected_morning
    assert len(day["afternoon"]) == expected_afternoon


def test_client_grid_with_gap_is_served_end_to_end(client, db_factory):
    """발주사 운영표(40분 상담 + 5분 텀)가 **API 응답까지** 그대로 나오는지 — 단위 격자 테스트가
    아니라 settings 행 → schedule_policy → build_grid → AvailabilityOut 의 전 구간을 검증한다.

    칸 길이가 간격과 다르므로, 프런트는 응답의 ``slot_gap_minutes`` 없이는 종료 시각을 계산할 수
    없다(→ 30분 하드코딩 회귀). 그래서 값 자체도 함께 고정한다.
    """
    world = _seed(
        db_factory,
        slot_minutes=40,
        operating_start=time(10, 0),
        operating_end=time(18, 10),
        lunch_start=time(12, 10),
        lunch_end=time(13, 0),
        slot_gap_minutes=5,
    )
    body = _availability(client, world, world["buyer_org"], world["exhibitor_org"]).json()

    assert (body["slot_minutes"], body["slot_gap_minutes"]) == (40, 5)
    day = body["dates"][0]
    morning = [s["time"] for s in day["morning"]]
    afternoon = [s["time"] for s in day["afternoon"]]
    assert morning == ["10:00", "10:45", "11:30"]
    assert afternoon == ["13:00", "13:45", "14:30", "15:15", "16:00", "16:45", "17:30"]
    assert len(morning) + len(afternoon) == 10
    # 슬롯 id 는 시작 시각만 담는 계약이 gap 도입 후에도 유지된다(unavailable_meeting_slots 와 공유).
    assert day["morning"][1]["id"] == f"{day['id']}T10:45"


def test_past_slots_are_unavailable_on_the_first_day(client, db_factory, monkeypatch):
    """행사 첫날 오전 중이라면 이미 지난 칸은 닫혀 있어야 한다 — 그리드는 남기되 선택은 막는다."""
    from app.meetings import service

    world = _seed(db_factory)
    zone = ZoneInfo("Asia/Seoul")
    frozen = __import__("datetime").datetime.combine(
        EXHIBITION_START, time(11, 0), tzinfo=zone
    )
    monkeypatch.setattr(service, "event_now", lambda event, now=None: frozen)

    body = _availability(client, world, world["buyer_org"], world["exhibitor_org"]).json()
    slots = _flat(body["dates"][0])
    assert slots[_slot("10:00")] is False  # 지났다
    assert slots[_slot("11:30")] is True  # 아직 남았다


# =============================================================================
# 권한
# =============================================================================
def test_availability_requires_counterpart_org_id(client, db_factory):
    world = _seed(db_factory)
    _login_as(world["buyer_org"])
    assert client.get(
        "/api/meetings/availability", params={"event_id": world["event_id"]}
    ).status_code == 422


def test_availability_rejects_unapproved_viewer(client, db_factory):
    world = _seed(db_factory)
    db = db_factory()
    try:
        role = db.execute(
            OrganizationEventRole.__table__.select().where(
                OrganizationEventRole.organization_id == world["buyer_org"]
            )
        ).first()
        db.execute(
            OrganizationEventRole.__table__.update()
            .where(OrganizationEventRole.id == role.id)
            .values(application_status="submitted")
        )
        db.commit()
    finally:
        db.close()

    r = _availability(client, world, world["buyer_org"], world["exhibitor_org"])
    assert r.status_code == 403
    assert r.json()["detail"]["code"] == "PROFILE_NOT_APPROVED"
