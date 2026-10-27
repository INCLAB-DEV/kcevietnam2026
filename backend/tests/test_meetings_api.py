"""참가자용 미팅 API 통합 테스트 (F-MT-001) — 신청·수락·거절·취소 + 동시성 + 알림.

이 파일이 지키는 핵심 불변식:

- **에러 코드 매트릭스** — 각 거부 사유가 정확히 그 코드/상태로 나온다. 화면이 코드로 분기하므로
  코드가 바뀌면 조용히 잘못된 안내가 뜬다.
- **점유는 accepted만** — 같은 슬롯에 proposed 두 건이 공존할 수 있고, 첫 수락이 이긴다.
- **D9 양방향** — 역할이 뒤집힌 쌍도 같은 두 기업 사이의 미팅이다.
- **알림 커밋 경계** — 알림이 실패해도 상태 전이는 남는다.

알림은 전부 `channels=[]`(빈 채널)로 검사한다 — SMTP/인앱 디스패치 부작용 없이 `notifications`
행 생성만 본다. 라우터 경로 테스트는 채널 주입을 못 하므로 기본 채널(fake 이메일)이 돈다.
"""

from __future__ import annotations

import itertools
import uuid
from datetime import date, time, timedelta
from zoneinfo import ZoneInfo

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select, text
from sqlalchemy.orm import sessionmaker

from app.auth.principal import Principal, get_current_principal
from app.db import get_session
from app.main import app
from app.models import (
    Booth,
    Event,
    EventScheduleSettings,
    ExhibitorProfile,
    Hall,
    Meeting,
    MeetingParticipant,
    MeetingVenue,
    Member,
    Notification,
    NotificationDispatch,
    Organization,
    OrganizationEventRole,
    PostMeetingReview,
)
from tests.conftest import enable_participant_email

_seq = itertools.count(1)

KST = ZoneInfo("Asia/Seoul")

# ⚠ 날짜를 **오늘 기준 상대값**으로 잡는다. 고정 날짜(2026-09-16 등)를 박으면 그 날이 지나는 순간
# "미래 슬롯만 예약 가능"·"신청 기간 안" 규칙에 걸려 테스트가 통째로 무너진다 — 코드가 아니라
# 달력이 바꾼 실패라 원인을 찾기도 어렵다. 여유(±7일 이상)를 둬서 시스템 타임존과 행사 타임존이
# 하루 어긋나도 창 안팎 판정이 뒤집히지 않게 한다.
TODAY = date.today()
EXHIBITION_START = TODAY + timedelta(days=15)
EXHIBITION_END = EXHIBITION_START + timedelta(days=3)
APPLICATION_START = TODAY - timedelta(days=7)
APPLICATION_END = TODAY + timedelta(days=10)


def _slot(hhmm: str, *, day_offset: int = 0, day: date | None = None) -> str:
    """슬롯 id 조립 — 형식은 ``"YYYY-MM-DDTHH:MM"``(그리드·프런트와 공유하는 계약)."""
    base = day or (EXHIBITION_START + timedelta(days=day_offset))
    return f"{base.isoformat()}T{hhmm}"


SLOT_A = _slot("10:00")  # 오전, 비어 있음
SLOT_B = _slot("10:30")  # SLOT_A 바로 다음 칸
SLOT_C = _slot("14:00")  # 오후
SLOT_D = _slot("15:00")  # 오후, C와 인접하지 않음
BLOCKED_SLOT = _slot("09:00")  # 참가사가 불가로 막아둔 칸


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


def _login_as(org_id: str, member_id: str | None = None) -> None:
    """인증을 override해 미팅 도메인 동작에만 집중한다(인증 계약은 test_demo_principal이 닫는다)."""
    app.dependency_overrides[get_current_principal] = lambda: Principal(
        member_id=member_id or str(uuid.uuid4()), organization_id=str(org_id)
    )


class World:
    """한 행사와 그 안의 기업들 — 테스트가 읽기 쉬운 이름으로 id를 들고 다닌다."""

    def __init__(self, **kwargs):
        self.__dict__.update(kwargs)


def _seed_world(
    db_factory,
    *,
    timezone_name: str = "Asia/Seoul",
    slot_minutes: int = 30,
    lunch: tuple[time, time] | None = (time(12, 0), time(13, 0)),
    enabled_venue_types: list[str] | None = None,
    application_start: date | None = APPLICATION_START,
    application_end: date | None = APPLICATION_END,
    exhibitor_approved: bool = True,
    buyer_subtype: str = "pre_registered",
    provision_zone_tables: int = 2,
    blocked_slots: tuple[str, ...] = (BLOCKED_SLOT,),
    with_booth: bool = True,
) -> World:
    """행사 + 참가사 1 + 바이어 1 + 부스/장소 풀을 깐다(기본값 = 정상 신청이 통과하는 상태)."""
    n = next(_seq)
    db = db_factory()
    try:
        event = Event(
            name="DX Korea 2026",
            slug=f"mt-{n}-{uuid.uuid4().hex[:8]}",
            timezone=timezone_name,
            slot_minutes=slot_minutes,
            exhibition_start=EXHIBITION_START,
            exhibition_end=EXHIBITION_END,
            application_start=application_start,
            application_end=application_end,
            enabled_venue_types=enabled_venue_types
            or ["booth", "zone_table", "business_room"],
        )
        db.add(event)
        db.flush()

        db.add(
            EventScheduleSettings(
                event_id=event.id,
                operating_start=time(9, 0),
                operating_end=time(18, 0),
                lunch_start=lunch[0] if lunch else None,
                lunch_end=lunch[1] if lunch else None,
            )
        )

        exhibitor = Organization(name_ko="한빛디펜스")
        buyer = Organization(name_ko="Global Marine")
        db.add_all([exhibitor, buyer])
        db.flush()

        exhibitor_member = Member(
            organization_id=exhibitor.id, name="셀러담당", email=f"seller{n}@example.com"
        )
        buyer_member = Member(
            organization_id=buyer.id, name="바이어담당", email=f"buyer{n}@example.com"
        )
        db.add_all([exhibitor_member, buyer_member])

        exhibitor_role = OrganizationEventRole(
            event_id=event.id,
            organization_id=exhibitor.id,
            is_exhibitor=True,
            application_status="approved" if exhibitor_approved else "submitted",
        )
        buyer_role = OrganizationEventRole(
            event_id=event.id,
            organization_id=buyer.id,
            is_buyer=True,
            buyer_subtype=buyer_subtype,
            application_status="approved",
        )
        db.add_all([exhibitor_role, buyer_role])
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
                unavailable_meeting_slots=list(blocked_slots),
            )
        )

        for i in range(provision_zone_tables):
            db.add(
                MeetingVenue(event_id=event.id, venue_type="zone_table", label=f"T-{i + 1:02d}")
            )

        db.commit()
        return World(
            event_id=str(event.id),
            exhibitor_org=str(exhibitor.id),
            buyer_org=str(buyer.id),
            exhibitor_role_id=str(exhibitor_role.id),
            buyer_role_id=str(buyer_role.id),
            exhibitor_member=str(exhibitor_member.id),
            buyer_member=str(buyer_member.id),
        )
    finally:
        db.close()


def _create_body(world: World, counterpart: str, **overrides) -> dict:
    body = {
        "counterpart_org_id": counterpart,
        "slot_ids": [SLOT_A],
        "venue_type": "booth",
        "event_id": world.event_id,
    }
    body.update(overrides)
    return body


def _apply(client, world: World, as_org: str, counterpart: str, **overrides):
    _login_as(as_org)
    return client.post("/api/meetings", json=_create_body(world, counterpart, **overrides))


def _code(response) -> str:
    return response.json()["detail"]["code"]


# =============================================================================
# 신청 — 정상 경로
# =============================================================================
def test_buyer_applies_to_exhibitor_creates_proposed_meeting(client, db_factory):
    world = _seed_world(db_factory)
    r = _apply(client, world, world.buyer_org, world.exhibitor_org, request_reason="협력 논의")

    assert r.status_code == 201
    body = r.json()
    assert body["status"] == "proposed"
    assert body["requested_by"] == "buyer"
    assert body["requested_by_org_id"] == world.buyer_org
    # 공은 수신측(참가사)이 쥔다 — 수락/거절 권한 판정의 닻.
    assert body["awaiting_org_id"] == world.exhibitor_org
    assert body["counterpart_org_id"] == world.exhibitor_org
    assert body["counterpart_name"] == "한빛디펜스"
    assert body["request_reason"] == "협력 논의"
    assert body["duration_minutes"] == 30
    # 행사 타임존 오프셋이 그대로 실려 나간다(클라이언트가 UTC를 되돌릴 필요 없음).
    assert body["scheduled_start"].endswith("+09:00")
    assert body["venue_type"] == "booth"
    assert body["venue_label"] == "7홀 A-12"  # Hall명 + 부스코드(프런트 boothLabel과 같은 규칙)


def test_hosted_buyer_recipient_is_immediately_accepted(client, db_factory):
    """초청 바이어 수신은 수락 단계 없이 확정된다(ADR-0005) — 의무 미팅."""
    world = _seed_world(db_factory, buyer_subtype="hosted")
    r = _apply(client, world, world.exhibitor_org, world.buyer_org)

    assert r.status_code == 201
    body = r.json()
    assert body["status"] == "accepted"
    assert body["awaiting_org_id"] is None  # 응답을 기다릴 주체가 없다


def test_three_consecutive_slots_span_full_duration(client, db_factory):
    world = _seed_world(db_factory)
    r = _apply(
        client, world, world.buyer_org, world.exhibitor_org,
        slot_ids=[SLOT_A, SLOT_B, _slot("11:00")],
    )
    assert r.status_code == 201
    assert r.json()["duration_minutes"] == 90


def test_venue_type_aliases_are_canonicalized(client, db_factory):
    """입력만 별칭을 받고 응답은 DB 어휘로 수렴한다 — 어휘가 두 갈래로 굳지 않게."""
    world = _seed_world(db_factory)
    r = _apply(client, world, world.buyer_org, world.exhibitor_org, venue_type="table")
    assert r.status_code == 201
    assert r.json()["venue_type"] == "zone_table"


def test_venue_label_pins_the_chosen_table(client, db_factory):
    """H-02 — 사용자가 고른 구체적 자리(T-02)가 신청 응답에 그대로 저장돼야 한다.

    ``provision_zone_tables=2``라 자동배정이면 항상 T-01(정렬 순 첫 자리)을 받는다. venue_label로
    T-02를 명시했는데도 T-01이 나오면 회귀(선택 무시하고 임의 배정)다.
    """
    world = _seed_world(db_factory, provision_zone_tables=2)
    r = _apply(
        client, world, world.buyer_org, world.exhibitor_org,
        venue_type="zone_table", venue_label="T-02",
    )
    assert r.status_code == 201
    assert r.json()["venue_label"] == "T-02"


def test_venue_label_unknown_is_rejected(client, db_factory):
    """존재하지 않는 라벨을 보내면 조용히 다른 자리로 자동배정하지 않고 거부한다."""
    world = _seed_world(db_factory, provision_zone_tables=2)
    r = _apply(
        client, world, world.buyer_org, world.exhibitor_org,
        venue_type="zone_table", venue_label="T-99",
    )
    assert r.status_code == 409
    assert _code(r) == "VENUE_TAKEN"


def test_venue_label_busy_falls_back_to_conflict_not_another_table(client, db_factory):
    """고른 자리가 그 사이 찼으면(동시 신청) 다른 자리로 조용히 넘어가지 않고 409로 되묻는다."""
    world = _seed_world(db_factory, provision_zone_tables=2)
    other_buyer = _extra_buyer(db_factory, world)
    n = next(_seq)
    db = db_factory()
    try:
        org = Organization(name_ko=f"추가참가사{n}")
        db.add(org)
        db.flush()
        db.add(Member(organization_id=org.id, name="담당", email=f"exh{n}@example.com"))
        db.add(
            OrganizationEventRole(
                event_id=world.event_id,
                organization_id=org.id,
                is_exhibitor=True,
                application_status="approved",
            )
        )
        db.commit()
        second_exhibitor = str(org.id)
    finally:
        db.close()

    first = _apply(
        client, world, world.buyer_org, world.exhibitor_org,
        venue_type="zone_table", venue_label="T-01",
    ).json()
    assert first["venue_label"] == "T-01"
    _login_as(world.exhibitor_org)
    assert client.post(f"/api/meetings/{first['id']}/accept", json={}).status_code == 200

    second = _apply(
        client, world, other_buyer, second_exhibitor,
        venue_type="zone_table", venue_label="T-01",
    )
    assert second.status_code == 409
    assert _code(second) == "VENUE_TAKEN"


def test_event_id_is_auto_resolved_when_org_has_single_event(client, db_factory):
    world = _seed_world(db_factory)
    _login_as(world.buyer_org)
    body = _create_body(world, world.exhibitor_org)
    body.pop("event_id")
    assert client.post("/api/meetings", json=body).status_code == 201


# =============================================================================
# 신청 — 에러 코드 매트릭스
# =============================================================================
def test_event_ambiguous_when_org_participates_in_multiple_events(client, db_factory):
    world_a = _seed_world(db_factory)
    world_b = _seed_world(db_factory)
    # 같은 org를 두 번째 행사에도 참가시킨다 → 자동 해석 불가.
    db = db_factory()
    try:
        db.add(
            OrganizationEventRole(
                event_id=world_b.event_id,
                organization_id=world_a.buyer_org,
                is_buyer=True,
                application_status="approved",
            )
        )
        db.commit()
    finally:
        db.close()

    _login_as(world_a.buyer_org)
    body = _create_body(world_a, world_a.exhibitor_org)
    body.pop("event_id")
    r = client.post("/api/meetings", json=body)
    assert r.status_code == 400
    assert _code(r) == "EVENT_AMBIGUOUS"


def test_role_ambiguous_when_both_sides_are_dual_role(client, db_factory):
    world = _seed_world(db_factory)
    db = db_factory()
    try:
        for role_id in (world.exhibitor_role_id, world.buyer_role_id):
            role = db.get(OrganizationEventRole, role_id)
            role.is_exhibitor = True
            role.is_buyer = True
        db.commit()
    finally:
        db.close()

    r = _apply(client, world, world.buyer_org, world.exhibitor_org)
    assert r.status_code == 400
    assert _code(r) == "ROLE_AMBIGUOUS"

    # my_role을 주면 방향이 하나로 좁혀져 통과한다.
    r = _apply(client, world, world.buyer_org, world.exhibitor_org, my_role="buyer")
    assert r.status_code == 201
    assert r.json()["buyer_org_id"] == world.buyer_org


def test_profile_not_approved_blocks_application(client, db_factory):
    world = _seed_world(db_factory, exhibitor_approved=False)
    r = _apply(client, world, world.exhibitor_org, world.buyer_org)
    assert r.status_code == 403
    assert _code(r) == "PROFILE_NOT_APPROVED"


def test_same_role_pair_is_not_visible(client, db_factory):
    """참가사↔참가사는 기본 정책상 서로 열람 불가(개발계획서 §8)."""
    world = _seed_world(db_factory)
    db = db_factory()
    try:
        role = db.get(OrganizationEventRole, world.buyer_role_id)
        role.is_buyer = False
        role.is_exhibitor = True  # 둘 다 참가사가 된다
        db.commit()
    finally:
        db.close()

    r = _apply(client, world, world.exhibitor_org, world.buyer_org)
    assert r.status_code == 403
    assert _code(r) == "NOT_VISIBLE"


def test_application_window_closed_before_and_after(client, db_factory):
    already_closed = _seed_world(
        db_factory,
        application_start=TODAY - timedelta(days=30),
        application_end=TODAY - timedelta(days=2),
    )
    r = _apply(client, already_closed, already_closed.buyer_org, already_closed.exhibitor_org)
    assert r.status_code == 403
    assert _code(r) == "APPLICATION_WINDOW_CLOSED"

    not_open_yet = _seed_world(
        db_factory,
        application_start=TODAY + timedelta(days=2),
        application_end=TODAY + timedelta(days=30),
    )
    r = _apply(client, not_open_yet, not_open_yet.buyer_org, not_open_yet.exhibitor_org)
    assert r.status_code == 403
    assert _code(r) == "APPLICATION_WINDOW_CLOSED"


def test_unbounded_application_window_is_open(client, db_factory):
    """신청 기간 미설정은 '닫힘'이 아니라 '경계 없음'이다 — 운영자가 아직 안 정한 상태."""
    world = _seed_world(db_factory, application_start=None, application_end=None)
    assert _apply(client, world, world.buyer_org, world.exhibitor_org).status_code == 201


def test_venue_type_disabled_for_event(client, db_factory):
    world = _seed_world(db_factory, enabled_venue_types=["booth"])
    r = _apply(client, world, world.buyer_org, world.exhibitor_org, venue_type="zone_table")
    assert r.status_code == 422
    assert _code(r) == "VENUE_TYPE_DISABLED"


def test_venue_type_without_provisioned_rows_is_rejected(client, db_factory):
    """zone_table/business_room은 운영자가 깔아둔 행만 쓴다 — 없으면 신청이 아니라 프로비저닝 문제."""
    world = _seed_world(db_factory, provision_zone_tables=0)
    r = _apply(client, world, world.buyer_org, world.exhibitor_org, venue_type="zone_table")
    assert r.status_code == 422
    assert _code(r) == "VENUE_TYPE_DISABLED"


@pytest.mark.parametrize(
    "slot_ids, why",
    [
        ([], "빈 선택"),
        ([SLOT_A, SLOT_B, _slot("11:00"), _slot("11:30")], "4칸 초과"),
        ([SLOT_C, SLOT_D], "인접하지 않음"),
        ([_slot("11:30"), _slot("13:00")], "점심 건너뜀"),
        ([_slot("08:00")], "운영시간 이전"),
        ([_slot("12:00")], "점심시간"),
        ([_slot("10:00", day=EXHIBITION_END + timedelta(days=3))], "행사기간 밖"),
        ([_slot("10:00", day=TODAY - timedelta(days=1))], "과거"),
        ([_slot("10:15")], "그리드 격자에 없음"),
        (["not-a-slot"], "형식 오류"),
        ([SLOT_A, SLOT_A], "같은 슬롯 중복"),
        ([SLOT_A, _slot("10:30", day_offset=1)], "날짜가 다름"),
    ],
)
def test_slot_invalid_matrix(client, db_factory, slot_ids, why):
    world = _seed_world(db_factory)
    r = _apply(client, world, world.buyer_org, world.exhibitor_org, slot_ids=slot_ids)
    # 빈 리스트/4칸은 Pydantic이 먼저 잡는다(둘 다 422 — 클라이언트 처리는 동일).
    assert r.status_code == 422, why
    if slot_ids and len(slot_ids) <= 3:
        assert _code(r) == "SLOT_INVALID", why


def test_exhibitor_blocked_slot_is_rejected(client, db_factory):
    world = _seed_world(db_factory)
    r = _apply(client, world, world.buyer_org, world.exhibitor_org, slot_ids=[BLOCKED_SLOT])
    assert r.status_code == 409
    assert _code(r) == "SLOT_TAKEN"


def test_event_schedule_unset_blocks_application(client, db_factory):
    world = _seed_world(db_factory)
    db = db_factory()
    try:
        db.execute(
            text("DELETE FROM event_schedule_settings WHERE event_id = :e"),
            {"e": world.event_id},
        )
        db.commit()
    finally:
        db.close()

    r = _apply(client, world, world.buyer_org, world.exhibitor_org)
    assert r.status_code == 409
    assert _code(r) == "EVENT_SCHEDULE_UNSET"


def test_unknown_counterpart_is_404(client, db_factory):
    world = _seed_world(db_factory)
    r = _apply(client, world, world.buyer_org, str(uuid.uuid4()))
    assert r.status_code == 404


def test_self_application_is_rejected(client, db_factory):
    world = _seed_world(db_factory)
    r = _apply(client, world, world.buyer_org, world.buyer_org)
    assert r.status_code == 400
    assert _code(r) == "ROLE_AMBIGUOUS"


# =============================================================================
# #11(2026-09-15) — 쌍 단위 유일성(D9) 제거, (쌍,시각) 단위 중복만 방지
# =============================================================================
def test_same_pair_can_have_two_meetings_at_different_times(client, db_factory):
    """같은 두 기업도 다른 시각이면 미팅을 여러 건 가질 수 있다(발주자 결정, #11)."""
    world = _seed_world(db_factory)
    first = _apply(client, world, world.buyer_org, world.exhibitor_org)
    assert first.status_code == 201

    second = _apply(client, world, world.buyer_org, world.exhibitor_org, slot_ids=[SLOT_C])
    assert second.status_code == 201
    assert second.json()["id"] != first.json()["id"]


def test_same_pair_other_direction_can_also_apply_at_different_time(client, db_factory):
    """상대 쪽에서 신청을 걸어도(호출 방향이 바뀌어도) 같은 쌍·다른 시각이면 통과한다."""
    world = _seed_world(db_factory)
    assert _apply(client, world, world.buyer_org, world.exhibitor_org).status_code == 201

    other_direction = _apply(client, world, world.exhibitor_org, world.buyer_org, slot_ids=[SLOT_C])
    assert other_direction.status_code == 201


def test_duplicate_application_same_pair_same_slot_is_rejected(client, db_factory):
    """같은 상대에게 같은 시각으로 중복 신청하는 건 여전히 막는다((쌍,시각) 단위 가드)."""
    world = _seed_world(db_factory)
    first = _apply(client, world, world.buyer_org, world.exhibitor_org)
    assert first.status_code == 201

    second = _apply(client, world, world.buyer_org, world.exhibitor_org)  # 같은 SLOT_A
    assert second.status_code == 409
    assert _code(second) == "DUPLICATE_APPLICATION"
    # 화면이 "기존 미팅 보기"로 이동할 수 있게 id를 함께 준다.
    assert second.json()["detail"]["existing_meeting_id"] == first.json()["id"]


def test_terminated_meeting_does_not_block_reapplication(client, db_factory):
    """거절/취소된 미팅은 (쌍,시각) 중복 검사 대상이 아니다 — 재신청을 막으면 안 된다."""
    world = _seed_world(db_factory)
    first = _apply(client, world, world.buyer_org, world.exhibitor_org).json()

    _login_as(world.exhibitor_org)
    assert client.post(
        f"/api/meetings/{first['id']}/reject", json={"reason_code": "schedule_unavailable"}
    ).status_code == 200

    # 같은 시각(SLOT_A)으로도 재신청이 성공한다 — 거절로 자리는 이미 비었다.
    assert _apply(client, world, world.buyer_org, world.exhibitor_org).status_code == 201


def test_accepted_meeting_at_other_time_does_not_block_reapplication(client, db_factory):
    """다른 시각에 확정(accepted) 미팅이 있어도 같은 상대에게 재신청할 수 있다.

    라이브 실측 재현(#11) — 준↔잉크 쌍이 10/21 확정 미팅을 갖고 있어도 10/20 13:00은 비어
    있으니 신청이 통과해야 한다.
    """
    # 참가사가 hosted 바이어에게 신청하면 즉시 accepted(수신측이 hosted면 동의 절차 생략).
    world = _seed_world(db_factory, buyer_subtype="hosted")
    first = _apply(client, world, world.exhibitor_org, world.buyer_org).json()
    assert first["status"] == "accepted"

    second = _apply(client, world, world.buyer_org, world.exhibitor_org, slot_ids=[SLOT_C])
    assert second.status_code == 201


# =============================================================================
# 점유 — accepted만 점유하고, 첫 수락이 이긴다
# =============================================================================
def _extra_buyer(db_factory, world: World, *, subtype: str = "pre_registered") -> str:
    """같은 행사에 바이어를 하나 더 깐다(같은 슬롯 경합을 만들기 위해)."""
    n = next(_seq)
    db = db_factory()
    try:
        org = Organization(name_ko=f"추가바이어{n}")
        db.add(org)
        db.flush()
        db.add(Member(organization_id=org.id, name="담당", email=f"extra{n}@example.com"))
        db.add(
            OrganizationEventRole(
                event_id=world.event_id,
                organization_id=org.id,
                is_buyer=True,
                buyer_subtype=subtype,
                application_status="approved",
            )
        )
        db.commit()
        return str(org.id)
    finally:
        db.close()


def test_two_proposed_meetings_can_share_a_slot(client, db_factory):
    """proposed는 점유하지 않는다 — 참가사가 같은 시간에 여러 신청을 받아두는 게 정상 흐름."""
    world = _seed_world(db_factory)
    other_buyer = _extra_buyer(db_factory, world)

    assert _apply(client, world, world.buyer_org, world.exhibitor_org).status_code == 201
    assert _apply(client, world, other_buyer, world.exhibitor_org).status_code == 201


def test_first_accept_wins_and_second_gets_slot_taken(client, db_factory):
    """수락 시점이 곧 점유 시점 — 둘째 수락은 409로 튕기고 미팅은 proposed로 남는다."""
    world = _seed_world(db_factory)
    other_buyer = _extra_buyer(db_factory, world)

    first = _apply(client, world, world.buyer_org, world.exhibitor_org).json()
    second = _apply(client, world, other_buyer, world.exhibitor_org).json()

    _login_as(world.exhibitor_org)
    assert client.post(f"/api/meetings/{first['id']}/accept", json={}).status_code == 200

    clash = client.post(f"/api/meetings/{second['id']}/accept", json={})
    assert clash.status_code == 409
    assert _code(clash) == "SLOT_TAKEN"

    # 실패한 쪽은 상태를 잃지 않는다 — 시간을 바꿔 다시 시도할 수 있어야 한다.
    still = client.get(f"/api/meetings/{second['id']}").json()
    assert still["status"] == "proposed"


def test_accepted_overlap_blocks_new_application(client, db_factory):
    world = _seed_world(db_factory)
    other_buyer = _extra_buyer(db_factory, world, subtype="hosted")

    # hosted 수신이라 즉시 확정 → 그 슬롯이 참가사에게 점유된다.
    assert _apply(client, world, world.exhibitor_org, other_buyer).status_code == 201

    clash = _apply(client, world, world.buyer_org, world.exhibitor_org)
    assert clash.status_code == 409
    assert _code(clash) == "SLOT_TAKEN"


def test_venue_taken_when_pool_exhausted(client, db_factory):
    """장소 풀이 그 시간에 다 차면 409 — 부스가 아닌 공용 자원의 경합."""
    world = _seed_world(db_factory, provision_zone_tables=1, buyer_subtype="hosted")
    other_buyer = _extra_buyer(db_factory, world, subtype="hosted")

    assert _apply(
        client, world, world.exhibitor_org, world.buyer_org, venue_type="zone_table"
    ).status_code == 201

    # 다른 참가사를 만들어 같은 시간·같은 테이블을 노리게 한다(참가사 슬롯 겹침을 피하려고).
    n = next(_seq)
    db = db_factory()
    try:
        org = Organization(name_ko=f"추가참가사{n}")
        db.add(org)
        db.flush()
        db.add(Member(organization_id=org.id, name="담당", email=f"exh{n}@example.com"))
        db.add(
            OrganizationEventRole(
                event_id=world.event_id,
                organization_id=org.id,
                is_exhibitor=True,
                application_status="approved",
            )
        )
        db.commit()
        second_exhibitor = str(org.id)
    finally:
        db.close()

    clash = _apply(
        client, world, second_exhibitor, other_buyer, venue_type="zone_table"
    )
    assert clash.status_code == 409
    assert _code(clash) == "VENUE_TAKEN"


# =============================================================================
# 수락 / 거절 / 취소 — 권한과 전이
# =============================================================================
def test_accept_requires_awaiting_party(client, db_factory):
    world = _seed_world(db_factory)
    meeting = _apply(client, world, world.buyer_org, world.exhibitor_org).json()

    # 신청한 쪽이 자기 신청을 수락할 수는 없다.
    _login_as(world.buyer_org)
    r = client.post(f"/api/meetings/{meeting['id']}/accept", json={})
    assert r.status_code == 403
    assert _code(r) == "NOT_AWAITING_PARTY"


def test_accept_sets_participants_and_clears_awaiting(client, db_factory):
    world = _seed_world(db_factory)
    meeting = _apply(client, world, world.buyer_org, world.exhibitor_org).json()

    _login_as(world.exhibitor_org)
    r = client.post(
        f"/api/meetings/{meeting['id']}/accept",
        json={"attendee_member_ids": [world.exhibitor_member]},
    )
    assert r.status_code == 200
    assert r.json()["status"] == "accepted"
    assert r.json()["awaiting_org_id"] is None

    db = db_factory()
    try:
        rows = db.execute(
            select(MeetingParticipant.member_id).where(
                MeetingParticipant.meeting_id == meeting["id"]
            )
        ).scalars().all()
        assert [str(m) for m in rows] == [world.exhibitor_member]
    finally:
        db.close()


def test_notification_email_is_sent_after_commit_holding_no_db_connection(client, db_factory, monkeypatch):
    """동시성 하드닝(1차) — 신청·수락처럼 요청 안에서 알림 메일을 보내는 경로는 알림 행을 **커밋한 뒤에** SMTP를
    부른다. 예전엔 알림 INSERT 직후 열린 트랜잭션 안에서 보내, 메일 서버를 기다리는 동안 커넥션이 'idle in
    transaction'으로 묶였다. 만들어지는 알림·메일·발송 기록은 예전과 같아야 한다."""
    from app.notifications import service as notification_service
    from app.notifications.channels import EmailChannel, InAppChannel

    engine = db_factory.kw["bind"]
    sends: list[tuple[str, int]] = []  # (수신 주소, 보내는 순간 체크아웃된 커넥션 수)

    class _ProbeSender:
        def send(self, message):
            sends.append((message.to[0], engine.pool.checkedout()))

    monkeypatch.setattr(
        notification_service, "_default_channels", lambda: (InAppChannel(), EmailChannel(_ProbeSender()))
    )
    world = _seed_world(db_factory)
    enable_participant_email(db_factory, world.event_id)  # 메일 발송을 검증한다(기본은 꺼짐)
    db = db_factory()
    try:
        exhibitor_email = db.get(Member, world.exhibitor_member).email
        buyer_email = db.get(Member, world.buyer_member).email
    finally:
        db.close()

    meeting = _apply(client, world, world.buyer_org, world.exhibitor_org).json()  # → 참가사에게 신청 알림
    _login_as(world.exhibitor_org)
    assert client.post(f"/api/meetings/{meeting['id']}/accept", json={}).status_code == 200  # → 바이어에게 수락 알림

    # 두 메일 모두 갔고, 보내는 순간 이 요청은 DB 커넥션을 하나도 쥐고 있지 않았다.
    assert sends == [(exhibitor_email, 0), (buyer_email, 0)]

    db = db_factory()
    try:
        rows = db.execute(
            select(Notification.type, NotificationDispatch.channel, NotificationDispatch.status)
            .join(Notification, Notification.id == NotificationDispatch.notification_id)
            .where(Notification.meeting_id == meeting["id"])
        ).all()
    finally:
        db.close()
    # 발송 기록은 그대로 — 알림마다 인앱 1건(커밋과 함께) + 이메일 1건(보낸 뒤 기록), 모두 sent.
    assert sorted(rows) == sorted(
        [
            ("meeting_requested", "in_app", "sent"),
            ("meeting_requested", "email", "sent"),
            ("meeting_accepted", "in_app", "sent"),
            ("meeting_accepted", "email", "sent"),
        ]
    )


def test_notification_email_failure_after_commit_is_recorded_not_raised(client, db_factory, monkeypatch):
    """커밋 뒤에 보내므로 채널이 예외를 던져도 알림·수락은 그대로 남고, 실패는 email dispatch 'failed'로 남는다."""
    from app.notifications import service as notification_service
    from app.notifications.channels import InAppChannel

    class _ExplodingChannel:
        name = "email"

        def send(self, envelope, recipients):
            raise RuntimeError("템플릿 렌더 실패")

    monkeypatch.setattr(
        notification_service, "_default_channels", lambda: (InAppChannel(), _ExplodingChannel())
    )
    world = _seed_world(db_factory)
    enable_participant_email(db_factory, world.event_id)  # 메일 발송을 검증한다(기본은 꺼짐)
    meeting = _apply(client, world, world.buyer_org, world.exhibitor_org).json()
    _login_as(world.exhibitor_org)
    r = client.post(f"/api/meetings/{meeting['id']}/accept", json={})
    assert r.status_code == 200
    assert r.json()["status"] == "accepted"

    db = db_factory()
    try:
        rows = db.execute(
            select(NotificationDispatch.channel, NotificationDispatch.status, NotificationDispatch.error)
            .join(Notification, Notification.id == NotificationDispatch.notification_id)
            .where(Notification.meeting_id == meeting["id"], Notification.type == "meeting_accepted")
        ).all()
    finally:
        db.close()
    assert sorted(rows) == [("email", "failed", "템플릿 렌더 실패"), ("in_app", "sent", None)]


@pytest.mark.parametrize(
    ("menu", "expected", "absent"),
    [
        # 기본(설정을 건드리지 않은 행사) = 미팅만 — 메일은 메뉴에 없는 알림함 대신 미팅 화면을 가리킨다.
        (None, "미팅 화면에서 자세히 확인하세요", "알림함"),
        ("meetings_only", "미팅 화면에서 자세히 확인하세요", "알림함"),
        # 전체 메뉴로 설정한 행사 — 이 설정이 생기기 전의 문구 그대로다.
        ("full", "알림함에서 자세히 확인하세요", "미팅 화면"),
    ],
)
def test_participant_menu_changes_mail_wording_but_never_the_meeting_api(
    client, db_factory, monkeypatch, menu, expected, absent
):
    """참가자 메뉴(nv001menu0001)는 화면 구성용 값이다 — 어느 값이든 미팅 신청·수락 API는 똑같이 동작하고
    (권한이 아니다, ADR-0015), 달라지는 건 알림 메일이 가리키는 화면뿐이다."""
    from app.notifications import service as notification_service
    from app.notifications.channels import EmailChannel, InAppChannel

    bodies: list[str] = []

    class _CaptureSender:
        def send(self, message):
            bodies.append(message.body)

    monkeypatch.setattr(
        notification_service, "_default_channels", lambda: (InAppChannel(), EmailChannel(_CaptureSender()))
    )
    world = _seed_world(db_factory)
    enable_participant_email(db_factory, world.event_id)  # 메일 발송을 검증한다(기본은 꺼짐)
    if menu is not None:
        db = db_factory()
        try:
            schedule = db.execute(
                select(EventScheduleSettings).where(EventScheduleSettings.event_id == world.event_id)
            ).scalar_one()
            schedule.participant_menu = menu
            db.commit()
        finally:
            db.close()

    applied = _apply(client, world, world.buyer_org, world.exhibitor_org)
    assert applied.status_code == 201
    _login_as(world.exhibitor_org)
    accepted = client.post(f"/api/meetings/{applied.json()['id']}/accept", json={})
    assert accepted.status_code == 200
    assert accepted.json()["status"] == "accepted"

    assert len(bodies) == 2  # 신청 알림(참가사) + 수락 알림(바이어)
    for body in bodies:
        assert expected in body
        assert absent not in body


def _run_meeting_flow(client, world: World, flow: str) -> str:
    """참가자 본인 조작 한 흐름 — 공통 비밀번호로 로그인한 운영 담당자도 백엔드에는 같은 요청이다."""
    if flow == "immediate_confirm":
        # 초청 바이어에게 신청하면 즉시 확정 — 양쪽에 meeting_accepted.
        r = _apply(client, world, world.exhibitor_org, world.buyer_org)
        assert r.status_code == 201 and r.json()["status"] == "accepted", r.text
        return r.json()["id"]
    r = _apply(client, world, world.buyer_org, world.exhibitor_org)
    assert r.status_code == 201 and r.json()["status"] == "proposed", r.text
    meeting_id = r.json()["id"]
    if flow == "accept":
        _login_as(world.exhibitor_org)
        assert client.post(f"/api/meetings/{meeting_id}/accept", json={}).status_code == 200
    elif flow == "reject":
        _login_as(world.exhibitor_org)
        assert client.post(
            f"/api/meetings/{meeting_id}/reject", json={"reason_code": "interest_mismatch"}
        ).status_code == 200
    elif flow == "cancel":
        _login_as(world.buyer_org)
        assert client.post(
            f"/api/meetings/{meeting_id}/cancel", json={"reason_code": "internal_change"}
        ).status_code == 200
    return meeting_id


@pytest.mark.parametrize(
    ("flow", "expected_types"),
    [
        ("request", ["meeting_requested"]),
        ("immediate_confirm", ["meeting_accepted", "meeting_accepted"]),
        ("accept", ["meeting_accepted", "meeting_requested"]),
        ("reject", ["meeting_rejected", "meeting_requested"]),
        ("cancel", ["meeting_cancelled", "meeting_requested"]),
    ],
)
def test_participant_email_off_sends_no_meeting_mail_but_keeps_in_app(
    client, db_factory, monkeypatch, flow, expected_types
):
    """참가자 알림 메일(nt004mail0001)이 꺼진 행사 — 미팅 신청·즉시확정·수락·거절·취소 어느 흐름이든 메일은 0통,
    인앱 알림 행은 그대로 생기고 이메일 dispatch는 skipped(event_email_disabled)로 남는다. API 동작은 같다."""
    from app.notifications import service as notification_service
    from app.notifications.channels import EmailChannel, InAppChannel

    sent: list = []

    class _CaptureSender:
        def send(self, message):
            sent.append(message)

    monkeypatch.setattr(
        notification_service, "_default_channels", lambda: (InAppChannel(), EmailChannel(_CaptureSender()))
    )
    world = _seed_world(
        db_factory, buyer_subtype="hosted" if flow == "immediate_confirm" else "pre_registered"
    )
    db = db_factory()
    try:
        schedule = db.execute(
            select(EventScheduleSettings).where(EventScheduleSettings.event_id == world.event_id)
        ).scalar_one()
        schedule.participant_email_enabled = False
        db.commit()
    finally:
        db.close()

    meeting_id = _run_meeting_flow(client, world, flow)

    assert sent == []
    db = db_factory()
    try:
        types = sorted(
            db.execute(select(Notification.type).where(Notification.meeting_id == meeting_id))
            .scalars()
            .all()
        )
        dispatches = db.execute(
            select(NotificationDispatch.channel, NotificationDispatch.status, NotificationDispatch.error)
            .join(Notification, Notification.id == NotificationDispatch.notification_id)
            .where(Notification.meeting_id == meeting_id)
        ).all()
    finally:
        db.close()
    assert types == sorted(expected_types)
    # 알림마다 수신 기업 멤버 1명 — 인앱 sent 1 + 이메일 skipped 1.
    assert sorted(dispatches) == sorted(
        [("in_app", "sent", None)] * len(expected_types)
        + [("email", "skipped", "event_email_disabled")] * len(expected_types)
    )


def test_accept_twice_is_invalid_transition(client, db_factory):
    world = _seed_world(db_factory)
    meeting = _apply(client, world, world.buyer_org, world.exhibitor_org).json()
    _login_as(world.exhibitor_org)
    assert client.post(f"/api/meetings/{meeting['id']}/accept", json={}).status_code == 200

    again = client.post(f"/api/meetings/{meeting['id']}/accept", json={})
    assert again.status_code == 409
    assert _code(again) == "INVALID_TRANSITION"


def test_reject_records_reason_and_clears_awaiting(client, db_factory):
    world = _seed_world(db_factory)
    meeting = _apply(client, world, world.buyer_org, world.exhibitor_org).json()

    _login_as(world.exhibitor_org)
    r = client.post(
        f"/api/meetings/{meeting['id']}/reject",
        json={"reason_code": "interest_mismatch", "reason_text": "분야가 다릅니다"},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "rejected"
    assert body["rejected_reason_code"] == "interest_mismatch"
    assert body["rejected_by_org_id"] == world.exhibitor_org
    assert body["awaiting_org_id"] is None
    assert body["rejected_at"] is not None


def test_reject_other_reason_requires_text(client, db_factory):
    world = _seed_world(db_factory)
    meeting = _apply(client, world, world.buyer_org, world.exhibitor_org).json()

    _login_as(world.exhibitor_org)
    r = client.post(
        f"/api/meetings/{meeting['id']}/reject", json={"reason_code": "other", "reason_text": "  "}
    )
    assert r.status_code == 422
    assert _code(r) == "REASON_REQUIRED"


def test_reject_rejects_unknown_reason_code(client, db_factory):
    world = _seed_world(db_factory)
    meeting = _apply(client, world, world.buyer_org, world.exhibitor_org).json()
    _login_as(world.exhibitor_org)
    r = client.post(f"/api/meetings/{meeting['id']}/reject", json={"reason_code": "made_up"})
    assert r.status_code == 422  # Pydantic Literal이 어휘를 강제한다


def test_proposed_meeting_is_cancellable_only_by_requester(client, db_factory):
    """수신측이 취소를 쓰면 거절과 같은 일을 다른 감사 컬럼으로 하게 된다 — reject로 보낸다."""
    world = _seed_world(db_factory)
    meeting = _apply(client, world, world.buyer_org, world.exhibitor_org).json()

    _login_as(world.exhibitor_org)
    denied = client.post(
        f"/api/meetings/{meeting['id']}/cancel", json={"reason_code": "internal_change"}
    )
    assert denied.status_code == 403
    assert _code(denied) == "NOT_CANCELLABLE_PARTY"

    _login_as(world.buyer_org)
    allowed = client.post(
        f"/api/meetings/{meeting['id']}/cancel", json={"reason_code": "internal_change"}
    )
    assert allowed.status_code == 200
    assert allowed.json()["cancelled_by"] == "buyer"
    assert allowed.json()["cancelled_by_org_id"] == world.buyer_org


def test_accepted_meeting_is_cancellable_by_either_side(client, db_factory):
    world = _seed_world(db_factory)
    meeting = _apply(client, world, world.buyer_org, world.exhibitor_org).json()
    _login_as(world.exhibitor_org)
    client.post(f"/api/meetings/{meeting['id']}/accept", json={})

    r = client.post(
        f"/api/meetings/{meeting['id']}/cancel",
        json={"reason_code": "schedule_conflict"},
    )
    assert r.status_code == 200
    assert r.json()["status"] == "cancelled"
    assert r.json()["cancelled_by"] == "exhibitor"


def test_cancel_other_reason_requires_text(client, db_factory):
    world = _seed_world(db_factory)
    meeting = _apply(client, world, world.buyer_org, world.exhibitor_org).json()
    _login_as(world.buyer_org)
    r = client.post(f"/api/meetings/{meeting['id']}/cancel", json={"reason_code": "other"})
    assert r.status_code == 422
    assert _code(r) == "REASON_REQUIRED"


def test_cancelled_meeting_cannot_be_cancelled_again(client, db_factory):
    world = _seed_world(db_factory)
    meeting = _apply(client, world, world.buyer_org, world.exhibitor_org).json()
    _login_as(world.buyer_org)
    client.post(f"/api/meetings/{meeting['id']}/cancel", json={"reason_code": "internal_change"})

    again = client.post(
        f"/api/meetings/{meeting['id']}/cancel", json={"reason_code": "internal_change"}
    )
    assert again.status_code == 409
    assert _code(again) == "INVALID_TRANSITION"


# =============================================================================
# 동시성 — 상태 전이의 stale-read 레이스 (이종 크로스리뷰 CT-1~3 / HI-1 / HI-2)
# =============================================================================
# 세 함수(accept/reject/cancel) 모두 "읽고 → 검증 → (advisory lock) → UPDATE" 구조였고, 검증이
# **읽은 시점의 값**으로만 이뤄지면 그 사이 다른 트랜잭션이 커밋한 변화를 못 본 채 그대로 덮어쓴다.
# FOR UPDATE 재로드를 매 요청이 실제로 동시에 돌게 만들지 않고도 검증하려고, "T1이 먼저 읽는다 →
# 그 직후(락을 잡기 전) T2가 끼어들어 커밋한다 → T1이 진행한다" 순서를 monkeypatch로 강제한다.
def test_accept_after_concurrent_reject_returns_409_not_stale_overwrite(
    client, db_factory, monkeypatch
):
    """T1(accept)이 advisory lock을 잡기 **직전** T2(reject)가 커밋해버리면, T1은 stale proposed
    값으로 그대로 accepted를 덮어쓰면 안 된다 — FOR UPDATE 재검증이 INVALID_TRANSITION으로 막고,
    거절 상태·감사 컬럼이 그대로 남아 있어야 한다."""
    from app.matching import slot_booking
    from app.meetings import service as meetings_service

    world = _seed_world(db_factory)
    meeting = _apply(client, world, world.buyer_org, world.exhibitor_org).json()
    meeting_id = meeting["id"]

    real_lock = slot_booking.meeting_write_lock
    fired = {"done": False}

    def racing_lock(db, **kwargs):
        if not fired["done"]:
            fired["done"] = True
            # T2 — 별도 세션으로 같은 미팅을 먼저 거절하고 커밋한다.
            db2 = db_factory()
            try:
                meetings_service.reject_meeting(
                    db2,
                    principal=Principal(
                        member_id=str(uuid.uuid4()), organization_id=world.exhibitor_org
                    ),
                    meeting_id=meeting_id,
                    reason_code="interest_mismatch",
                    reason_text=None,
                )
            finally:
                db2.close()
        return real_lock(db, **kwargs)

    monkeypatch.setattr(slot_booking, "meeting_write_lock", racing_lock)

    _login_as(world.exhibitor_org)
    r = client.post(f"/api/meetings/{meeting_id}/accept", json={})
    assert r.status_code == 409
    assert _code(r) == "INVALID_TRANSITION"

    db = db_factory()
    try:
        stored = db.get(Meeting, meeting_id)
        # T2의 거절이 그대로 살아 있다 — T1이 stale 값으로 덮어써 accepted+거절 감사 컬럼이
        # 섞이는 사고가 나지 않았다.
        assert stored.status == "rejected"
        assert stored.rejected_reason_code == "interest_mismatch"
        assert stored.rejected_by_org_id == world.exhibitor_org
    finally:
        db.close()


def test_concurrent_reject_and_cancel_serialize_one_wins(client, db_factory, monkeypatch):
    """T1(exhibitor reject)이 상태를 읽은 직후 T2(buyer cancel)가 먼저 커밋해버리면, T1은 그
    사실을 못 본 채 자기 감사 컬럼을 얹으면 안 된다 — 취소만 살아남고 거절 컬럼은 비어 있어야
    한다(감사 컬럼 오염 방지)."""
    from app.meetings import service as meetings_service

    world = _seed_world(db_factory)
    meeting = _apply(client, world, world.buyer_org, world.exhibitor_org).json()
    meeting_id = meeting["id"]

    real_assert_transition = meetings_service._assert_transition
    fired = {"done": False}

    def racing_assert_transition(meeting_obj, target):
        if not fired["done"]:
            fired["done"] = True
            # T2 — proposed 미팅의 신청측(buyer)이 별도 세션으로 먼저 취소하고 커밋한다.
            db2 = db_factory()
            try:
                meetings_service.cancel_meeting(
                    db2,
                    principal=Principal(
                        member_id=str(uuid.uuid4()), organization_id=world.buyer_org
                    ),
                    meeting_id=meeting_id,
                    reason_code="internal_change",
                    reason_text=None,
                )
            finally:
                db2.close()
        return real_assert_transition(meeting_obj, target)

    monkeypatch.setattr(meetings_service, "_assert_transition", racing_assert_transition)

    _login_as(world.exhibitor_org)
    r = client.post(
        f"/api/meetings/{meeting_id}/reject",
        json={"reason_code": "interest_mismatch", "reason_text": "분야가 다릅니다"},
    )
    assert r.status_code == 409
    assert _code(r) == "INVALID_TRANSITION"

    db = db_factory()
    try:
        stored = db.get(Meeting, meeting_id)
        # 취소(T2)만 커밋됐고, 진 쪽(T1, reject)의 감사 컬럼은 전혀 얹히지 않았다.
        assert stored.status == "cancelled"
        assert stored.cancelled_by == "buyer"
        assert stored.rejected_reason_code is None
        assert stored.rejected_by_org_id is None
    finally:
        db.close()


def test_second_accept_on_shared_venue_gets_409_not_500(client, db_factory):
    """서로 다른 org 쌍의 proposed 미팅 두 건이 같은(단일) 공용 장소·겹치는 시간을 노릴 때,
    순차 accept의 둘째는 advisory venue lock 덕에 직렬화되어 409 VENUE_TAKEN으로 끝나야 한다
    (org advisory lock만으로는 서로 다른 org 쌍을 직렬화 못 해 DB EXCLUDE가 500으로 튀는 게
    HI-1의 우려였다 — venue advisory lock이 이미 그 직렬화 지점을 잡고 있는지 확인하는 회귀
    테스트)."""
    world = _seed_world(db_factory, provision_zone_tables=1)
    other_buyer = _extra_buyer(db_factory, world)

    # 서로 다른 org 쌍이 같은 테이블·같은 시간을 경합하도록 참가사를 하나 더 만든다.
    n = next(_seq)
    db = db_factory()
    try:
        org = Organization(name_ko=f"추가참가사{n}")
        db.add(org)
        db.flush()
        db.add(Member(organization_id=org.id, name="담당", email=f"exh{n}@example.com"))
        db.add(
            OrganizationEventRole(
                event_id=world.event_id,
                organization_id=org.id,
                is_exhibitor=True,
                application_status="approved",
            )
        )
        db.commit()
        second_exhibitor = str(org.id)
    finally:
        db.close()

    first = _apply(
        client, world, world.buyer_org, world.exhibitor_org, venue_type="zone_table"
    ).json()
    second = _apply(
        client, world, other_buyer, second_exhibitor, venue_type="zone_table"
    ).json()
    # 풀에 테이블이 하나뿐이라 둘 다 같은 venue를 받았어야 한다(proposed는 점유하지 않으므로).
    assert first["venue_type"] == "zone_table"
    assert second["venue_type"] == "zone_table"

    _login_as(world.exhibitor_org)
    assert client.post(f"/api/meetings/{first['id']}/accept", json={}).status_code == 200

    _login_as(second_exhibitor)
    clash = client.post(f"/api/meetings/{second['id']}/accept", json={})
    assert clash.status_code == 409
    assert _code(clash) == "VENUE_TAKEN"


# =============================================================================
# 조회 — 목록·단건·소유권
# =============================================================================
def test_non_participant_gets_403_and_missing_gets_404(client, db_factory):
    world = _seed_world(db_factory)
    meeting = _apply(client, world, world.buyer_org, world.exhibitor_org).json()

    outsider = _extra_buyer(db_factory, world)
    _login_as(outsider)
    r = client.get(f"/api/meetings/{meeting['id']}")
    assert r.status_code == 403
    assert _code(r) == "NOT_PARTICIPANT"

    assert client.get(f"/api/meetings/{uuid.uuid4()}").status_code == 404
    # 형식이 틀린 id도 존재 여부를 가리지 않고 404(자원 열거 차단).
    assert client.get("/api/meetings/not-a-uuid").status_code == 404


def test_list_filters_by_status_and_paginates(client, db_factory):
    world = _seed_world(db_factory)
    other_buyer = _extra_buyer(db_factory, world)
    first = _apply(client, world, world.buyer_org, world.exhibitor_org).json()
    _apply(client, world, other_buyer, world.exhibitor_org, slot_ids=[SLOT_C])

    _login_as(world.exhibitor_org)
    assert client.post(f"/api/meetings/{first['id']}/accept", json={}).status_code == 200

    all_rows = client.get("/api/meetings", params={"event_id": world.event_id}).json()
    assert all_rows["total"] == 2

    accepted = client.get(
        "/api/meetings", params={"event_id": world.event_id, "status": ["accepted"]}
    ).json()
    assert accepted["total"] == 1
    assert accepted["items"][0]["id"] == first["id"]

    both = client.get(
        "/api/meetings",
        params={"event_id": world.event_id, "status": ["accepted", "proposed"]},
    ).json()
    assert both["total"] == 2

    page = client.get(
        "/api/meetings", params={"event_id": world.event_id, "limit": 1, "offset": 1}
    ).json()
    assert len(page["items"]) == 1 and page["total"] == 2


def test_counterpart_fields_are_viewer_relative(client, db_factory):
    world = _seed_world(db_factory)
    meeting = _apply(client, world, world.buyer_org, world.exhibitor_org).json()

    _login_as(world.exhibitor_org)
    seller_view = client.get(f"/api/meetings/{meeting['id']}").json()
    assert seller_view["counterpart_org_id"] == world.buyer_org

    _login_as(world.buyer_org)
    buyer_view = client.get(f"/api/meetings/{meeting['id']}").json()
    assert buyer_view["counterpart_org_id"] == world.exhibitor_org


# =============================================================================
# 조회 — 표시 로케일(?locale=en)
# =============================================================================
#: 로케일이 바꾸는 필드는 이 둘뿐이다 — 나머지는 ko 응답과 한 글자도 다르면 안 된다.
_LOCALIZED_FIELDS = {"counterpart_name", "venue_label"}


def _set_name_en(db_factory, org_id: str, name_en: str) -> None:
    db = db_factory()
    try:
        org = db.get(Organization, org_id)
        assert org is not None
        org.name_en = name_en
        db.commit()
    finally:
        db.close()


def test_locale_en_localizes_counterpart_name_and_booth_label_only(client, db_factory):
    """``?locale=en`` — 상대 기업명은 영문명, 부스 라벨은 홀 번호 표기. 저장값·나머지 필드는 그대로."""
    world = _seed_world(db_factory)
    _set_name_en(db_factory, world.exhibitor_org, "Hanbit Defense")
    meeting = _apply(client, world, world.buyer_org, world.exhibitor_org).json()
    # 쓰기 응답은 로케일을 받지 않는다 — 기존 한국어 계약 그대로다.
    assert (meeting["counterpart_name"], meeting["venue_label"]) == ("한빛디펜스", "7홀 A-12")

    _login_as(world.buyer_org)
    path = f"/api/meetings/{meeting['id']}"
    default = client.get(path).json()
    # 생략·ko·모르는 값은 전부 같은 한국어 응답으로 수렴한다(422가 아니다).
    assert client.get(path, params={"locale": "ko"}).json() == default
    assert client.get(path, params={"locale": "ja"}).json() == default
    assert (default["counterpart_name"], default["venue_label"]) == ("한빛디펜스", "7홀 A-12")

    english = client.get(path, params={"locale": "en"}).json()
    assert (english["counterpart_name"], english["venue_label"]) == ("Hanbit Defense", "Hall 7 A-12")
    assert {k: v for k, v in english.items() if k not in _LOCALIZED_FIELDS} == {
        k: v for k, v in default.items() if k not in _LOCALIZED_FIELDS
    }

    listed = client.get(
        "/api/meetings", params={"event_id": world.event_id, "locale": "en"}
    ).json()["items"]
    assert [(m["counterpart_name"], m["venue_label"]) for m in listed] == [
        ("Hanbit Defense", "Hall 7 A-12")
    ]

    # 읽기 시점 변환이다 — 장소 행의 저장 라벨(멱등키)은 한국어 규칙 그대로 남아 있어야 한다.
    db = db_factory()
    try:
        stored = db.execute(
            select(MeetingVenue.label).where(MeetingVenue.id == meeting["venue_id"])
        ).scalar_one()
    finally:
        db.close()
    assert stored == "7홀 A-12"


def test_locale_en_renders_unassigned_booth_label_with_exhibitor_english_name(client, db_factory):
    """부스 미배정 저장 라벨("{기업명} 부스")은 en에서 "{영문 기업명} Booth" — 어느 쪽이 봐도 같다.

    부스 주인은 참가사다. 참가사 본인이 볼 때 상대(counterpart)는 바이어지만 라벨의 이름은 여전히
    참가사 영문명이어야 한다(상대 이름으로 만들면 "바이어 부스"가 된다).
    """
    world = _seed_world(db_factory, with_booth=False)
    _set_name_en(db_factory, world.exhibitor_org, "Hanbit Defense")
    meeting = _apply(client, world, world.buyer_org, world.exhibitor_org).json()
    assert meeting["venue_label"] == "한빛디펜스 부스"

    for viewer in (world.buyer_org, world.exhibitor_org):
        _login_as(viewer)
        english = client.get(f"/api/meetings/{meeting['id']}", params={"locale": "en"}).json()
        assert english["venue_label"] == "Hanbit Defense Booth"


def test_locale_en_falls_back_to_korean_name_when_english_name_is_missing(client, db_factory):
    """영문명이 없는 기업은 en에서도 국문명으로 보인다 — 번역 누락이 아니라 데이터가 없는 것."""
    world = _seed_world(db_factory, with_booth=False)
    meeting = _apply(client, world, world.buyer_org, world.exhibitor_org).json()

    _login_as(world.buyer_org)
    english = client.get(f"/api/meetings/{meeting['id']}", params={"locale": "en"}).json()
    assert english["counterpart_name"] == "한빛디펜스"
    assert english["venue_label"] == "한빛디펜스 Booth"


def test_locale_en_leaves_operator_named_venue_labels_alone(client, db_factory):
    """매칭존 테이블 라벨은 운영자가 붙인 이름이다 — 시스템이 만든 부스 라벨만 옮긴다."""
    world = _seed_world(db_factory, provision_zone_tables=2)
    meeting = _apply(
        client, world, world.buyer_org, world.exhibitor_org,
        venue_type="zone_table", venue_label="T-02",
    ).json()

    _login_as(world.buyer_org)
    english = client.get(f"/api/meetings/{meeting['id']}", params={"locale": "en"}).json()
    assert (english["venue_type"], english["venue_label"]) == ("zone_table", "T-02")


def test_has_review_and_attended_are_viewer_relative(client, db_factory):
    """attended는 **상대**가 남긴 리뷰가 말한다 — 상대의 counterpart_noshow가 내 노쇼다."""
    world = _seed_world(db_factory)
    meeting = _apply(client, world, world.buyer_org, world.exhibitor_org).json()

    db = db_factory()
    try:
        # 참가사가 "상대(바이어)가 오지 않았다"고 신고한다.
        db.add(
            PostMeetingReview(
                meeting_id=meeting["id"],
                reviewer_org_id=world.exhibitor_org,
                counterpart_noshow=True,
            )
        )
        db.commit()
    finally:
        db.close()

    _login_as(world.buyer_org)
    buyer_view = client.get(f"/api/meetings/{meeting['id']}").json()
    assert buyer_view["has_review"] is False  # 바이어는 아직 안 썼다
    assert buyer_view["attended"] is False  # 상대가 바이어의 노쇼를 신고했다

    _login_as(world.exhibitor_org)
    seller_view = client.get(f"/api/meetings/{meeting['id']}").json()
    assert seller_view["has_review"] is True
    assert seller_view["attended"] is None  # 바이어 리뷰가 없어 참가사 참석 여부는 알 수 없다


def test_self_noshow_marks_own_attended_false(client, db_factory):
    """"내가 불참"(self_noshow)은 상대 리뷰 없이도 본인 attended를 False로 확정한다."""
    world = _seed_world(db_factory)
    meeting = _apply(client, world, world.buyer_org, world.exhibitor_org).json()

    db = db_factory()
    try:
        # 참가사가 "내가(참가사가) 불참했다"고 스스로 신고한다 — 바이어는 아직 아무 리뷰도 안 썼다.
        db.add(
            PostMeetingReview(
                meeting_id=meeting["id"],
                reviewer_org_id=world.exhibitor_org,
                self_noshow=True,
            )
        )
        db.commit()
    finally:
        db.close()

    _login_as(world.exhibitor_org)
    seller_view = client.get(f"/api/meetings/{meeting['id']}").json()
    assert seller_view["attended"] is False  # 본인 신고가 상대 리뷰 없이도 확정한다

    _login_as(world.buyer_org)
    buyer_view = client.get(f"/api/meetings/{meeting['id']}").json()
    # 참가사 리뷰는 남아 있다(counterpart_noshow=False 기본값) — "내가 불참"만 신고했을 뿐 바이어의
    # 불참까지 신고한 게 아니므로, 바이어 자신의 attended는 그 리뷰 기준으로 True(기존 동작 그대로).
    assert buyer_view["attended"] is True


# =============================================================================
# 참석자 지정
# =============================================================================
def test_participants_replace_own_org_members_only(client, db_factory):
    world = _seed_world(db_factory)
    meeting = _apply(client, world, world.buyer_org, world.exhibitor_org).json()

    _login_as(world.buyer_org)
    assert client.put(
        f"/api/meetings/{meeting['id']}/participants",
        json={"member_ids": [world.buyer_member]},
    ).status_code == 200

    _login_as(world.exhibitor_org)
    assert client.put(
        f"/api/meetings/{meeting['id']}/participants",
        json={"member_ids": [world.exhibitor_member]},
    ).status_code == 200

    db = db_factory()
    try:
        rows = db.execute(
            select(MeetingParticipant.member_id).where(
                MeetingParticipant.meeting_id == meeting["id"]
            )
        ).scalars().all()
        # 참가사가 자기 명단을 바꿔도 바이어 참석자는 그대로 남는다.
        assert {str(m) for m in rows} == {world.buyer_member, world.exhibitor_member}
    finally:
        db.close()


def test_participants_reject_other_org_member(client, db_factory):
    world = _seed_world(db_factory)
    meeting = _apply(client, world, world.buyer_org, world.exhibitor_org).json()

    _login_as(world.buyer_org)
    r = client.put(
        f"/api/meetings/{meeting['id']}/participants",
        json={"member_ids": [world.exhibitor_member]},
    )
    assert r.status_code == 422
    # 권한 거부(NOT_PARTICIPANT, 403)와 다른 코드 — 이건 입력 검증이다.
    assert _code(r) == "MEMBER_NOT_IN_ORG"


def test_participants_empty_list_clears_own_attendees(client, db_factory):
    world = _seed_world(db_factory)
    meeting = _apply(client, world, world.buyer_org, world.exhibitor_org).json()
    _login_as(world.buyer_org)
    client.put(
        f"/api/meetings/{meeting['id']}/participants", json={"member_ids": [world.buyer_member]}
    )

    assert client.put(
        f"/api/meetings/{meeting['id']}/participants", json={"member_ids": []}
    ).status_code == 200

    db = db_factory()
    try:
        count = db.execute(
            select(MeetingParticipant).where(MeetingParticipant.meeting_id == meeting["id"])
        ).scalars().all()
        assert count == []
    finally:
        db.close()


# =============================================================================
# 알림 발화 — 커밋 경계 포함
# =============================================================================
def _notifications(db_factory, meeting_id: str) -> list[tuple[str, str]]:
    db = db_factory()
    try:
        rows = db.execute(
            select(Notification.type, Notification.recipient_org_id).where(
                Notification.meeting_id == meeting_id
            )
        ).all()
        return sorted((t, str(o)) for t, o in rows)
    finally:
        db.close()


def test_pending_application_notifies_recipient_only(client, db_factory):
    world = _seed_world(db_factory)
    meeting = _apply(client, world, world.buyer_org, world.exhibitor_org).json()
    assert _notifications(db_factory, meeting["id"]) == [
        ("meeting_requested", world.exhibitor_org)
    ]


def test_immediate_confirmation_notifies_both_sides(client, db_factory):
    """즉시 확정은 양쪽 다 "확정됐다"를 받아야 한다 — 상대 기업명이 서로 달라 2회 호출."""
    world = _seed_world(db_factory, buyer_subtype="hosted")
    meeting = _apply(client, world, world.exhibitor_org, world.buyer_org).json()
    assert _notifications(db_factory, meeting["id"]) == sorted(
        [("meeting_accepted", world.exhibitor_org), ("meeting_accepted", world.buyer_org)]
    )


def test_accept_notifies_requester_only(client, db_factory):
    world = _seed_world(db_factory)
    meeting = _apply(client, world, world.buyer_org, world.exhibitor_org).json()
    _login_as(world.exhibitor_org)
    client.post(f"/api/meetings/{meeting['id']}/accept", json={})

    assert _notifications(db_factory, meeting["id"]) == sorted(
        [("meeting_requested", world.exhibitor_org), ("meeting_accepted", world.buyer_org)]
    )


def test_cancel_notifies_the_other_side(client, db_factory):
    world = _seed_world(db_factory)
    meeting = _apply(client, world, world.buyer_org, world.exhibitor_org).json()
    _login_as(world.buyer_org)
    client.post(f"/api/meetings/{meeting['id']}/cancel", json={"reason_code": "internal_change"})

    assert ("meeting_cancelled", world.exhibitor_org) in _notifications(db_factory, meeting["id"])


def test_reject_notifies_the_requester_only(client, db_factory):
    """거절 통지는 **신청한 쪽**(buyer)에게만 간다 — 거절한 쪽(exhibitor)은 자기 행동을 다시
    통지받을 필요가 없다(GitHub #4)."""
    world = _seed_world(db_factory)
    meeting = _apply(client, world, world.buyer_org, world.exhibitor_org).json()

    _login_as(world.exhibitor_org)
    r = client.post(f"/api/meetings/{meeting['id']}/reject", json={"reason_code": "interest_mismatch"})
    assert r.status_code == 200

    assert _notifications(db_factory, meeting["id"]) == sorted(
        [("meeting_requested", world.exhibitor_org), ("meeting_rejected", world.buyer_org)]
    )


def test_reject_dispatches_in_app_and_email(client, db_factory):
    """거절 통지는 인앱·이메일 양쪽으로 나간다(수락·취소와 같은 채널 팬아웃, ADR-0010)."""
    world = _seed_world(db_factory)
    meeting = _apply(client, world, world.buyer_org, world.exhibitor_org).json()

    _login_as(world.exhibitor_org)
    client.post(f"/api/meetings/{meeting['id']}/reject", json={"reason_code": "interest_mismatch"})

    db = db_factory()
    try:
        notification = db.execute(
            select(Notification).where(
                Notification.meeting_id == meeting["id"], Notification.type == "meeting_rejected"
            )
        ).scalar_one()
        assert notification.recipient_org_id == world.buyer_org
        # 사유를 payload에 담지 않는다(1차 미노출, GitHub #4 권고).
        assert "reason" not in (notification.payload or {})
        channels = {
            d.channel
            for d in db.execute(
                select(NotificationDispatch).where(
                    NotificationDispatch.notification_id == notification.id
                )
            ).scalars().all()
        }
        assert channels == {"in_app", "email"}
    finally:
        db.close()


def test_reject_notification_failure_does_not_roll_back_transition(client, db_factory, monkeypatch):
    """알림이 터져도 거절은 거절이다 — cancel과 동일한 안전망(notify_after_commit)."""
    world = _seed_world(db_factory)
    meeting = _apply(client, world, world.buyer_org, world.exhibitor_org).json()

    from app.notifications import service as notification_service

    def _boom(*args, **kwargs):
        raise RuntimeError("SMTP 폭발")

    monkeypatch.setattr(notification_service, "notify_meeting_rejected", _boom)

    _login_as(world.exhibitor_org)
    r = client.post(f"/api/meetings/{meeting['id']}/reject", json={"reason_code": "interest_mismatch"})
    assert r.status_code == 200
    assert r.json()["status"] == "rejected"

    db = db_factory()
    try:
        stored = db.get(Meeting, meeting["id"])
        assert stored.status == "rejected"  # 커밋된 전이가 살아 있다
        assert stored.rejected_reason_code == "interest_mismatch"
    finally:
        db.close()


def test_notification_failure_does_not_roll_back_transition(client, db_factory, monkeypatch):
    """알림이 터져도 취소는 취소다 — 통지 실패로 도메인 사실을 되돌리지 않는다."""
    world = _seed_world(db_factory)
    meeting = _apply(client, world, world.buyer_org, world.exhibitor_org).json()

    from app.notifications import service as notification_service

    def _boom(*args, **kwargs):
        raise RuntimeError("SMTP 폭발")

    monkeypatch.setattr(notification_service, "notify_meeting_cancelled", _boom)

    _login_as(world.buyer_org)
    r = client.post(
        f"/api/meetings/{meeting['id']}/cancel", json={"reason_code": "internal_change"}
    )
    assert r.status_code == 200
    assert r.json()["status"] == "cancelled"

    db = db_factory()
    try:
        stored = db.get(Meeting, meeting["id"])
        assert stored.status == "cancelled"  # 커밋된 전이가 살아 있다
        assert stored.cancelled_reason_code == "internal_change"
    finally:
        db.close()


# =============================================================================
# 마이그레이션 up/down 왕복 (데이터 없는 클린 DB)
# =============================================================================
def test_migration_up_down_roundtrip(empty_db_url):
    """mt001meet01이 깨끗이 내려갔다 다시 올라오는지 — EXCLUDE/부분 인덱스 포함.

    ``meetings_active_pair_uniq``는 mt001meet01이 만들었지만 mt002pair01(#11)이 head에서 다시
    DROP한다 — 그래서 head에서는 **없는 게 정상**이다(쌍 단위 유일성 제한 제거, 시각 단위 EXCLUDE는
    그대로 유지).
    """
    from alembic import command
    from alembic.config import Config

    from app.config import settings

    original = settings.database_url
    settings.database_url = empty_db_url
    cfg = Config("alembic.ini")
    engine = create_engine(empty_db_url, future=True)
    try:
        command.upgrade(cfg, "head")
        with engine.connect() as c:
            # head = mt002pair01까지 적용된 상태 — #11로 쌍 단위 유일성 인덱스는 이미 DROP됐다.
            assert c.execute(
                text("SELECT to_regclass('public.meetings_active_pair_uniq')")
            ).scalar_one() is None
            excl = c.execute(
                text(
                    "SELECT conname FROM pg_constraint WHERE conrelid = 'meetings'::regclass"
                    " AND contype = 'x' ORDER BY conname"
                )
            ).scalars().all()
            assert excl == [
                "meetings_buyer_slot_excl",
                "meetings_exhibitor_slot_excl",
                "meetings_venue_slot_excl",
            ]
            # 슬롯 길이 진실원천 단일화 — settings 쪽 컬럼은 사라져야 한다.
            assert c.execute(
                text(
                    "SELECT count(*) FROM information_schema.columns WHERE table_name ="
                    " 'event_schedule_settings' AND column_name = 'slot_minutes'"
                )
            ).scalar_one() == 0
            assert c.execute(
                text(
                    "SELECT column_default FROM information_schema.columns"
                    " WHERE table_name = 'events' AND column_name = 'timezone'"
                )
            ).scalar_one().startswith("'Asia/Seoul'")

        command.downgrade(cfg, "orggrant0001")
        with engine.connect() as c:
            assert c.execute(
                text("SELECT to_regclass('public.meetings_active_pair_uniq')")
            ).scalar_one() is None
            assert c.execute(
                text(
                    "SELECT count(*) FROM information_schema.columns WHERE table_name = 'meetings'"
                    " AND column_name = 'awaiting_org_id'"
                )
            ).scalar_one() == 0
            # downgrade는 settings.slot_minutes를 되살린다(기본 30).
            assert c.execute(
                text(
                    "SELECT count(*) FROM information_schema.columns WHERE table_name ="
                    " 'event_schedule_settings' AND column_name = 'slot_minutes'"
                )
            ).scalar_one() == 1

        command.upgrade(cfg, "head")  # 재적용도 가능해야 한다
        with engine.connect() as c:
            assert c.execute(
                text("SELECT to_regclass('public.meetings_active_pair_uniq')")
            ).scalar_one() is None

        # mt002pair01 자체의 up/down 왕복 — mt001meet01까지만 내리면 인덱스가 되살아나 있어야
        # 하고, 거기서 다시 head로 올리면 사라져야 한다.
        command.downgrade(cfg, "mt001meet01")
        with engine.connect() as c:
            assert c.execute(
                text("SELECT to_regclass('public.meetings_active_pair_uniq')")
            ).scalar_one() is not None
        command.upgrade(cfg, "head")
        with engine.connect() as c:
            assert c.execute(
                text("SELECT to_regclass('public.meetings_active_pair_uniq')")
            ).scalar_one() is None
    finally:
        engine.dispose()
        settings.database_url = original
