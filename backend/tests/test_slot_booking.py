"""슬롯/장소 점유 술어 + 락 키 테스트 (``app.matching.slot_booking``).

이 모듈은 **가용성 계산과 쓰기 가드의 공통 술어**다. 두 경로가 다른 조건을 쓰기 시작하면 "화면엔
비었는데 누르면 409"(또는 더 나쁜 이중예약)가 생기므로, 여기서 술어의 경계를 직접 못 박는다:

- 점유는 ``status='accepted'`` **만**. proposed/cancelled/completed는 자리를 차지하지 않는다.
- 구간은 ``[)`` 반열림 — 09:00~09:30과 09:30~10:00은 **겹치지 않는다**.
- SQL 술어(``has_accepted_overlap``)와 파이썬 술어(``overlaps``)가 같은 답을 내야 한다.
  전자는 쓰기 가드가, 후자는 그리드 색칠이 쓰기 때문이다.

락은 **키 정렬**이 데드락 회피의 전부다. org 키가 venue 키보다 항상 먼저 정렬되는지도 확인한다 —
장소 락을 org 락보다 나중에 따로 잡는 경로(``service._resolve_venue``)가 그 성질에 기대고 있다.

마지막으로 **DB EXCLUDE가 최후 방어선으로 실제 동작하는지** 확인한다. 앞단 술어가 잡았어야 할
충돌을 놓쳐도 데이터가 깨지지 않는다는 보장이라, 앱 로직과 독립으로 검증할 가치가 있다.
"""

from __future__ import annotations

import itertools
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import sessionmaker

from app.matching import slot_booking
from app.models import Event, Meeting, MeetingVenue, Organization

_seq = itertools.count(1)

BASE = datetime(2030, 9, 16, 10, 0, tzinfo=timezone.utc)  # 어떤 테스트 데이터와도 안 겹치는 먼 미래


@pytest.fixture()
def db_factory(migrated_db: str):
    engine = create_engine(migrated_db, future=True)
    TestSession = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)
    yield TestSession
    engine.dispose()


@pytest.fixture()
def db(db_factory):
    session = db_factory()
    yield session
    session.rollback()
    session.close()


@pytest.fixture()
def world(db):
    """행사 + 참가사/바이어 + 장소 하나. 커밋해서 술어 쿼리가 볼 수 있게 한다."""
    n = next(_seq)
    event = Event(name="DX Korea 2026", slug=f"booking-{n}")
    exhibitor = Organization(name_ko="셀러")
    buyer = Organization(name_ko="바이어")
    db.add_all([event, exhibitor, buyer])
    db.flush()
    venue = MeetingVenue(event_id=event.id, venue_type="zone_table", label=f"T-{n:03d}")
    db.add(venue)
    db.commit()
    return {
        "event_id": str(event.id),
        "exhibitor": str(exhibitor.id),
        "buyer": str(buyer.id),
        "venue": str(venue.id),
    }


def _meeting(db, world, *, start=BASE, minutes=30, status="accepted", venue=True) -> Meeting:
    meeting = Meeting(
        event_id=world["event_id"],
        exhibitor_org_id=world["exhibitor"],
        buyer_org_id=world["buyer"],
        venue_id=world["venue"] if venue else None,
        matching_type="open",
        status=status,
        scheduled_start=start,
        scheduled_end=start + timedelta(minutes=minutes),
    )
    db.add(meeting)
    db.commit()
    return meeting


# =============================================================================
# 락 키 — 정렬이 데드락 회피의 전부다
# =============================================================================
def test_lock_keys_are_sorted_and_deduplicated():
    keys = slot_booking.lock_keys(event_id="E", org_ids=["z-org", "a-org", "z-org"])
    assert keys == ["mtslot:E:a-org", "mtslot:E:z-org"]


def test_org_keys_always_sort_before_venue_keys():
    """장소 락을 org 락보다 **나중에** 따로 잡아도 전역 획득 순서가 유지되는 근거."""
    keys = slot_booking.lock_keys(event_id="E", org_ids=["zzz"], venue_id="aaa")
    assert keys == ["mtslot:E:zzz", "mtvenue:E:aaa"]


def test_lock_keys_input_order_does_not_matter():
    """두 트랜잭션이 같은 org 쌍을 반대 순서로 넘겨도 같은 순서로 잡는다 — 서로 기다리는 고리가 없다."""
    forward = slot_booking.lock_keys(event_id="E", org_ids=["a", "b"])
    backward = slot_booking.lock_keys(event_id="E", org_ids=["b", "a"])
    assert forward == backward


def test_meeting_write_lock_acquires_transaction_scoped_locks(db, world):
    keys = slot_booking.meeting_write_lock(
        db, event_id=world["event_id"], org_ids=[world["exhibitor"], world["buyer"]]
    )
    assert len(keys) == 2

    held = db.execute(
        text("SELECT count(*) FROM pg_locks WHERE locktype = 'advisory' AND pid = pg_backend_pid()")
    ).scalar_one()
    assert held == 2

    # 트랜잭션 종료와 함께 자동 해제 — 해제 코드를 쓰지 않으므로 예외 경로에서도 락이 새지 않는다.
    db.rollback()
    released = db.execute(
        text("SELECT count(*) FROM pg_locks WHERE locktype = 'advisory' AND pid = pg_backend_pid()")
    ).scalar_one()
    assert released == 0


def test_lock_with_no_targets_is_a_noop(db, world):
    assert slot_booking.meeting_write_lock(db, event_id=world["event_id"]) == []


# =============================================================================
# 겹침 술어 — 반열림 구간 + accepted만
# =============================================================================
@pytest.mark.parametrize(
    "offset_minutes, duration, expected, why",
    [
        (0, 30, True, "완전히 같은 구간"),
        (15, 30, True, "뒤쪽 절반이 겹침"),
        (-15, 30, True, "앞쪽 절반이 겹침"),
        (10, 10, True, "기존 구간에 완전히 포함"),
        (-15, 60, True, "기존 구간을 완전히 덮음"),
        (30, 30, False, "바로 뒤에 붙음 — [) 반열림이라 안 겹침"),
        (-30, 30, False, "바로 앞에 붙음"),
        (60, 30, False, "완전히 떨어짐"),
    ],
)
def test_accepted_overlap_boundaries(db, world, offset_minutes, duration, expected, why):
    _meeting(db, world)  # 10:00~10:30 확정
    start = BASE + timedelta(minutes=offset_minutes)

    got = slot_booking.has_accepted_overlap(
        db,
        event_id=world["event_id"],
        org_ids=[world["exhibitor"], world["buyer"]],
        start=start,
        end=start + timedelta(minutes=duration),
    )
    assert got is expected, why


@pytest.mark.parametrize("status", ["proposed", "rejected", "cancelled", "completed"])
def test_only_accepted_meetings_occupy_a_slot(db, world, status):
    """proposed가 점유하면 "같은 시간에 여러 신청을 받아두고 하나만 수락"이 불가능해진다."""
    _meeting(db, world, status=status)

    assert not slot_booking.has_accepted_overlap(
        db,
        event_id=world["event_id"],
        org_ids=[world["exhibitor"], world["buyer"]],
        start=BASE,
        end=BASE + timedelta(minutes=30),
    )


def test_overlap_is_scoped_to_the_event(db, world, db_factory):
    """다른 행사의 확정 미팅이 이 행사의 슬롯을 막지 않는다."""
    _meeting(db, world)
    assert not slot_booking.has_accepted_overlap(
        db,
        event_id=str(__import__("uuid").uuid4()),
        org_ids=[world["exhibitor"], world["buyer"]],
        start=BASE,
        end=BASE + timedelta(minutes=30),
    )


def test_overlap_matches_either_side_of_the_pair(db, world):
    """참가사든 바이어든 한쪽만 걸려도 점유다 — 사람은 동시에 두 미팅에 못 앉는다."""
    _meeting(db, world)
    for org in (world["exhibitor"], world["buyer"]):
        assert slot_booking.has_accepted_overlap(
            db,
            event_id=world["event_id"],
            org_ids=[org],
            start=BASE,
            end=BASE + timedelta(minutes=30),
        )


def test_exclude_meeting_id_skips_the_row_itself(db, world):
    """자기 자신은 자기 슬롯을 막지 않는다 — 시간 이동 같은 미래 경로가 기대는 성질."""
    meeting = _meeting(db, world)
    assert not slot_booking.has_accepted_overlap(
        db,
        event_id=world["event_id"],
        org_ids=[world["exhibitor"], world["buyer"]],
        start=BASE,
        end=BASE + timedelta(minutes=30),
        exclude_meeting_id=str(meeting.id),
    )


def test_empty_org_list_is_never_occupied(db, world):
    _meeting(db, world)
    assert not slot_booking.has_accepted_overlap(
        db, event_id=world["event_id"], org_ids=[], start=BASE, end=BASE + timedelta(minutes=30)
    )


# =============================================================================
# 장소 점유
# =============================================================================
def test_venue_overlap_follows_the_same_rules(db, world):
    _meeting(db, world)

    assert slot_booking.has_venue_overlap(
        db, venue_id=world["venue"], start=BASE, end=BASE + timedelta(minutes=30)
    )
    # 붙어 있는 다음 칸은 비어 있다.
    assert not slot_booking.has_venue_overlap(
        db,
        venue_id=world["venue"],
        start=BASE + timedelta(minutes=30),
        end=BASE + timedelta(minutes=60),
    )


def test_busy_venue_ids_agrees_with_has_venue_overlap(db, world):
    """목록용 배치 쿼리와 단건 술어가 같은 답을 내야 한다(그리드 색칠 ↔ 쓰기 가드)."""
    _meeting(db, world)
    end = BASE + timedelta(minutes=30)

    busy = slot_booking.busy_venue_ids(db, venue_ids=[world["venue"]], start=BASE, end=end)
    assert busy == {world["venue"]}
    assert (world["venue"] in busy) is slot_booking.has_venue_overlap(
        db, venue_id=world["venue"], start=BASE, end=end
    )


def test_busy_venue_ids_with_empty_input(db, world):
    assert slot_booking.busy_venue_ids(db, venue_ids=[], start=BASE, end=BASE) == set()


# =============================================================================
# SQL 술어 ↔ 파이썬 술어 일치
# =============================================================================
@pytest.mark.parametrize("offset_minutes", [-60, -30, -15, 0, 15, 30, 60])
def test_python_and_sql_predicates_agree(db, world, offset_minutes):
    """``overlaps()``(그리드 색칠)와 SQL WHERE(쓰기 가드)가 모든 경계에서 같은 답을 낸다."""
    _meeting(db, world)
    start = BASE + timedelta(minutes=offset_minutes)
    end = start + timedelta(minutes=30)

    from_sql = slot_booking.has_accepted_overlap(
        db,
        event_id=world["event_id"],
        org_ids=[world["exhibitor"], world["buyer"]],
        start=start,
        end=end,
    )
    busy = slot_booking.accepted_busy_slot_starts(
        db,
        event_id=world["event_id"],
        org_ids=[world["exhibitor"], world["buyer"]],
        start=start,
        end=end,
    )
    from_python = any(slot_booking.overlaps(start, end, b0, b1) for b0, b1 in busy)

    assert from_sql is from_python


def test_overlaps_is_half_open():
    a, b = BASE, BASE + timedelta(minutes=30)
    assert slot_booking.overlaps(a, b, a, b)
    assert not slot_booking.overlaps(a, b, b, b + timedelta(minutes=30))
    assert not slot_booking.overlaps(b, b + timedelta(minutes=30), a, b)


# =============================================================================
# DB EXCLUDE — 최후 방어선
# =============================================================================
def _other_buyer(db, world, *, start, minutes=30, status="accepted") -> Meeting:
    """같은 참가사 × **다른** 바이어의 미팅.

    같은 쌍으로 두 건을 만들면 D9(활성 쌍 유일성)가 먼저 걸려 EXCLUDE를 관찰할 수 없다 —
    슬롯 점유 제약만 따로 보려면 쌍은 달라야 하고 org 하나는 공유해야 한다.
    """
    other = Organization(name_ko="다른바이어")
    db.add(other)
    db.flush()
    meeting = Meeting(
        event_id=world["event_id"],
        exhibitor_org_id=world["exhibitor"],
        buyer_org_id=other.id,
        matching_type="open",
        status=status,
        scheduled_start=start,
        scheduled_end=start + timedelta(minutes=minutes),
    )
    db.add(meeting)
    return meeting


def test_db_rejects_a_second_overlapping_accepted_meeting(db, world):
    """앱 술어를 우회해도 데이터는 깨지지 않는다 — EXCLUDE 제약이 직접 막는지 확인."""
    _meeting(db, world)
    _other_buyer(db, world, start=BASE + timedelta(minutes=15))

    with pytest.raises(IntegrityError, match="meetings_exhibitor_slot_excl"):
        db.commit()
    db.rollback()


def test_db_allows_adjacent_accepted_meetings(db, world):
    """반열림 구간이라 등을 맞댄 미팅은 허용돼야 한다 — 제약이 과하게 막으면 하루가 반쪽 난다."""
    _meeting(db, world)
    _other_buyer(db, world, start=BASE + timedelta(minutes=30))

    db.commit()  # 예외 없이 통과해야 한다


def test_db_rejects_overlapping_venue_bookings(db, world):
    """같은 장소·같은 시간에 두 미팅 — 참가사가 달라도 자리가 하나뿐이다."""
    _meeting(db, world)  # world["venue"] 사용

    other_exhibitor = Organization(name_ko="다른참가사")
    other_buyer = Organization(name_ko="또다른바이어")
    db.add_all([other_exhibitor, other_buyer])
    db.flush()
    db.add(
        Meeting(
            event_id=world["event_id"],
            exhibitor_org_id=other_exhibitor.id,
            buyer_org_id=other_buyer.id,
            venue_id=world["venue"],
            matching_type="open",
            status="accepted",
            scheduled_start=BASE + timedelta(minutes=15),
            scheduled_end=BASE + timedelta(minutes=45),
        )
    )
    with pytest.raises(IntegrityError, match="meetings_venue_slot_excl"):
        db.commit()
    db.rollback()


def test_db_allows_two_proposed_meetings_in_the_same_slot(db, world):
    """EXCLUDE의 WHERE에 'accepted만'이 새겨져 있는지 — 제안 단계의 경합은 허용된다."""
    other = Organization(name_ko="다른바이어")
    db.add(other)
    db.flush()

    for buyer_id in (world["buyer"], str(other.id)):
        db.add(
            Meeting(
                event_id=world["event_id"],
                exhibitor_org_id=world["exhibitor"],
                buyer_org_id=buyer_id,
                matching_type="open",
                status="proposed",
                scheduled_start=BASE,
                scheduled_end=BASE + timedelta(minutes=30),
            )
        )
    db.commit()  # 같은 슬롯에 제안 두 건 공존
