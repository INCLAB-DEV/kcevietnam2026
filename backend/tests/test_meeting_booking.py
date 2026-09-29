"""meeting-booking 가드 테스트 (F1 하드닝) — entry_state/matching_type 불변식을 ``book_meeting``
스스로 방어하는지 검증한다(``app.matching.meeting_booking``).

기존 호출부(``create_meeting``·``assignment_service``의 forced/saturation)는 전부
``resolve_entry_state``로 계산한 올바른 값을 넘기므로 정상 경로는 이 가드에 절대 걸리지 않아야
한다 — 여기서 보는 건 "규칙을 거스른 entry_state를 강제로 넘기면 거부되는가"다(ADR-0005).

동시성 로직(락→겹침→(쌍,시각) 중복→INSERT) 자체의 술어 단위 테스트는 ``test_slot_booking.py``의 영역이다 —
F1의 대다수는 그 앞단(락 밖) 순수 방어 가드만 다룬다. 다만 맨 아래 F5 테스트 한 건은 실제 두 커넥션
으로 advisory lock 대기를 재현해, 락→(쌍,시각) 중복 검사의 방어가 실행 경로에서도 지켜지는지 확인한다.
"""

from __future__ import annotations

import itertools
import threading
import time
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.matching.acceptance_rule import EntryState
from app.matching.meeting_booking import MeetingError, book_meeting
from app.models import Event, MeetingVenue, Organization, OrganizationEventRole

_seq = itertools.count(1)
BASE = datetime(2031, 3, 10, 10, 0, tzinfo=timezone.utc)  # 어떤 테스트 데이터와도 안 겹치는 먼 미래


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
    """행사 + 참가사 + 장소 하나(커밋). 바이어는 subtype별로 테스트마다 ``_seed_buyer``로 만든다."""
    n = next(_seq)
    event = Event(name="DX Korea 2026", slug=f"meeting-booking-{n}")
    exhibitor = Organization(name_ko="셀러")
    db.add_all([event, exhibitor])
    db.flush()
    venue = MeetingVenue(event_id=event.id, venue_type="zone_table", label=f"T-{n:03d}")
    db.add(venue)
    db.commit()
    return {"event_id": str(event.id), "exhibitor": str(exhibitor.id), "venue": str(venue.id)}


def _seed_buyer(db, event_id: str, *, subtype: str | None) -> str:
    org = Organization(name_ko="바이어")
    db.add(org)
    db.flush()
    db.add(
        OrganizationEventRole(
            organization_id=org.id,
            event_id=event_id,
            is_buyer=True,
            buyer_subtype=subtype,
            application_status="approved",
        )
    )
    db.commit()
    return str(org.id)


def _book(db, world, *, buyer_org_id, entry_state, matching_type, requested_by):
    return book_meeting(
        db,
        event_id=world["event_id"],
        exhibitor_org_id=world["exhibitor"],
        buyer_org_id=buyer_org_id,
        start=BASE,
        end=BASE + timedelta(minutes=30),
        resolve_venue=lambda: db.get(MeetingVenue, world["venue"]),
        entry_state=entry_state,
        matching_type=matching_type,
        requested_by=requested_by,
    )


# =============================================================================
# 정상 경로 — 기존 3개 호출부가 실제로 넘기는 조합은 전부 통과해야 한다
# =============================================================================
def test_general_buyer_proposed_via_open_passes(db, world):
    # create_meeting: 참가사가 일반 바이어에게 신청 -> 수신측 일반 바이어 -> proposed.
    buyer = _seed_buyer(db, world["event_id"], subtype="pre_registered")
    meeting = _book(
        db, world, buyer_org_id=buyer, entry_state=EntryState.PROPOSED,
        matching_type="open", requested_by="exhibitor",
    )
    assert meeting.status == "proposed"


def test_hosted_buyer_accepted_via_open_passes(db, world):
    buyer = _seed_buyer(db, world["event_id"], subtype="hosted")
    meeting = _book(
        db, world, buyer_org_id=buyer, entry_state=EntryState.ACCEPTED,
        matching_type="open", requested_by="exhibitor",
    )
    assert meeting.status == "accepted"


def test_buyer_initiated_open_to_exhibitor_recipient_passes(db, world):
    # create_meeting: 바이어가 참가사에게 신청 -> 수신측 참가사, OPEN이라 accepted 예외 없음 -> proposed.
    buyer = _seed_buyer(db, world["event_id"], subtype="hosted")
    meeting = _book(
        db, world, buyer_org_id=buyer, entry_state=EntryState.PROPOSED,
        matching_type="open", requested_by="buyer",
    )
    assert meeting.status == "proposed"


def test_hosted_buyer_accepted_via_forced_passes(db, world):
    # create_forced_meeting: 운영자 강제배정, 초청 바이어는 항상 즉시확정.
    buyer = _seed_buyer(db, world["event_id"], subtype="hosted")
    meeting = _book(
        db, world, buyer_org_id=buyer, entry_state=EntryState.ACCEPTED,
        matching_type="forced", requested_by="organizer",
    )
    assert meeting.status == "accepted"


def test_general_buyer_accepted_via_forced_passes(db, world):
    # 2026-09-15 정정(발주자 QA B3) — FORCED는 받는 쪽 유형 무관 항상 accepted.
    # 이전엔 일반 바이어 수신이 proposed였다(회귀 방지).
    buyer = _seed_buyer(db, world["event_id"], subtype="pre_registered")
    meeting = _book(
        db, world, buyer_org_id=buyer, entry_state=EntryState.ACCEPTED,
        matching_type="forced", requested_by="organizer",
    )
    assert meeting.status == "accepted"


def test_general_buyer_proposed_via_forced_now_rejected(db, world):
    # FORCED 채널에서 proposed를 지정하려는 시도는 이제 규칙 위반(항상 accepted여야 한다).
    buyer = _seed_buyer(db, world["event_id"], subtype="pre_registered")
    with pytest.raises(MeetingError) as exc:
        _book(
            db, world, buyer_org_id=buyer, entry_state=EntryState.PROPOSED,
            matching_type="forced", requested_by="organizer",
        )
    assert exc.value.code == "ENTRY_STATE_INVALID"


def test_general_buyer_accepted_via_saturation_passes(db, world):
    # confirm_saturation_run: matching_type='ai'. 2026-09-15 재정정(발주자 QA B3 범위 확인) —
    # 전체 포화배정도 Forced와 동일하게 받는 쪽 유형 무관 항상 accepted. 이전엔 proposed였다.
    buyer = _seed_buyer(db, world["event_id"], subtype="pre_registered")
    meeting = _book(
        db, world, buyer_org_id=buyer, entry_state=EntryState.ACCEPTED,
        matching_type="ai", requested_by="organizer",
    )
    assert meeting.status == "accepted"


def test_general_buyer_proposed_via_saturation_now_rejected(db, world):
    # AI_SATURATION 채널에서 proposed를 지정하려는 시도는 이제 규칙 위반(항상 accepted여야 한다).
    buyer = _seed_buyer(db, world["event_id"], subtype="pre_registered")
    with pytest.raises(MeetingError) as exc:
        _book(
            db, world, buyer_org_id=buyer, entry_state=EntryState.PROPOSED,
            matching_type="ai", requested_by="organizer",
        )
    assert exc.value.code == "ENTRY_STATE_INVALID"


def test_hosted_buyer_accepted_via_saturation_passes(db, world):
    buyer = _seed_buyer(db, world["event_id"], subtype="hosted")
    meeting = _book(
        db, world, buyer_org_id=buyer, entry_state=EntryState.ACCEPTED,
        matching_type="ai", requested_by="organizer",
    )
    assert meeting.status == "accepted"


# =============================================================================
# 규칙 위반 entry_state는 거부 — 미래/실수 호출부를 가정한 방어
# =============================================================================
def test_general_buyer_forced_confirmation_rejected(db, world):
    buyer = _seed_buyer(db, world["event_id"], subtype="pre_registered")
    with pytest.raises(MeetingError) as exc:
        _book(
            db, world, buyer_org_id=buyer, entry_state=EntryState.ACCEPTED,
            matching_type="open", requested_by="exhibitor",
        )
    assert exc.value.code == "ENTRY_STATE_INVALID"
    assert exc.value.status_code == 500


def test_hosted_buyer_downgrade_to_proposed_rejected(db, world):
    buyer = _seed_buyer(db, world["event_id"], subtype="hosted")
    with pytest.raises(MeetingError) as exc:
        _book(
            db, world, buyer_org_id=buyer, entry_state=EntryState.PROPOSED,
            matching_type="forced", requested_by="organizer",
        )
    assert exc.value.code == "ENTRY_STATE_INVALID"


def test_exhibitor_recipient_forced_accept_outside_saturation_rejected(db, world):
    # requested_by='buyer' -> 수신측 참가사. FORCED/OPEN 등 AI_SATURATION 아닌 채널에서
    # 참가사 자동확정은 규칙 위반(포화배정만 예외).
    buyer = _seed_buyer(db, world["event_id"], subtype="hosted")
    with pytest.raises(MeetingError) as exc:
        _book(
            db, world, buyer_org_id=buyer, entry_state=EntryState.ACCEPTED,
            matching_type="open", requested_by="buyer",
        )
    assert exc.value.code == "ENTRY_STATE_INVALID"


def test_role_missing_buyer_defaults_to_general_but_forced_still_accepts(db, world):
    # OrganizationEventRole이 없는 org(잘못된 buyer_org_id) -> 보수적으로 일반 바이어 취급.
    # 2026-09-15 정정 전에는 이 경우도 accepted 강제 지정이 거부됐지만, 이제 FORCED 채널은
    # 받는 쪽 유형과 무관하게 항상 accepted이므로 일반 바이어 취급이어도 그대로 통과한다.
    orphan = Organization(name_ko="역할없음")
    db.add(orphan)
    db.commit()
    meeting = _book(
        db, world, buyer_org_id=str(orphan.id), entry_state=EntryState.ACCEPTED,
        matching_type="forced", requested_by="organizer",
    )
    assert meeting.status == "accepted"


def test_role_missing_buyer_defaults_to_general_and_rejects_forced_proposed(db, world):
    # 같은 전제(역할 없음 -> 일반 바이어 취급)에서 FORCED 채널에 proposed를 지정하려는 시도는
    # 여전히 거부된다(FORCED는 이제 accepted 고정, 그 반대 방향은 규칙 위반).
    orphan = Organization(name_ko="역할없음2")
    db.add(orphan)
    db.commit()
    with pytest.raises(MeetingError) as exc:
        _book(
            db, world, buyer_org_id=str(orphan.id), entry_state=EntryState.PROPOSED,
            matching_type="forced", requested_by="organizer",
        )
    assert exc.value.code == "ENTRY_STATE_INVALID"


# =============================================================================
# matching_type이 스키마 CHECK 허용값 밖이면 INSERT 전에 거부(F2 — 500 누수 방지)
# =============================================================================
def test_unknown_matching_type_rejected_before_insert(db, world):
    buyer = _seed_buyer(db, world["event_id"], subtype="pre_registered")
    with pytest.raises(MeetingError) as exc:
        _book(
            db, world, buyer_org_id=buyer, entry_state=EntryState.PROPOSED,
            matching_type="bogus", requested_by="exhibitor",
        )
    assert exc.value.code == "MATCHING_TYPE_INVALID"
    assert exc.value.status_code == 500


# =============================================================================
# F5(선택) — advisory lock 대기를 실제 두 커넥션으로 재현하는 동시성 통합 테스트.
#
# 위 테스트들은 전부 세션 하나로 book_meeting을 순차 호출해 "결과"만 본다. 이 테스트는 그 결과를
# 만드는 **메커니즘**(pg_advisory_xact_lock이 실제로 두 번째 커넥션을 블로킹하는가)까지 실행으로
# 확인한다 — 세션A가 같은 (참가사,바이어) 쌍의 락을 잡은 채 flush만 하고 commit을 미루는 동안,
# 세션B가 같은 쌍·같은 시각으로 book_meeting을 부르면 advisory lock 대기로 실제 블로킹되어야 하고,
# A가 commit한 뒤에야 B가 풀려나 (쌍,시각) 중복 검사에 걸려 거부돼야 한다 — 락→중복검사의 방어가
# 진짜 두 트랜잭션 사이에서도 지켜진다는 증거.
# =============================================================================
def test_advisory_lock_blocks_concurrent_booking_of_same_pair(db_factory):
    setup = db_factory()
    try:
        n = next(_seq)
        event = Event(name="DX Korea 2026", slug=f"meeting-booking-conc-{n}")
        exhibitor = Organization(name_ko="셀러-conc")
        buyer = Organization(name_ko="바이어-conc")
        setup.add_all([event, exhibitor, buyer])
        setup.flush()
        setup.add(
            OrganizationEventRole(
                organization_id=buyer.id,
                event_id=event.id,
                is_buyer=True,
                buyer_subtype="pre_registered",
                application_status="approved",
            )
        )
        venue = MeetingVenue(event_id=event.id, venue_type="zone_table", label=f"T-conc-{n:03d}")
        setup.add(venue)
        setup.commit()
        event_id, exhibitor_id, buyer_id, venue_id = (
            str(event.id), str(exhibitor.id), str(buyer.id), str(venue.id),
        )
    finally:
        setup.close()

    a_flushed = threading.Event()
    release_a = threading.Event()
    b_finished = threading.Event()
    results: dict = {}

    def _run_a():
        session_a = db_factory()
        try:
            meeting = book_meeting(
                session_a,
                event_id=event_id,
                exhibitor_org_id=exhibitor_id,
                buyer_org_id=buyer_id,
                start=BASE,
                end=BASE + timedelta(minutes=30),
                resolve_venue=lambda: session_a.get(MeetingVenue, venue_id),
                entry_state=EntryState.PROPOSED,
                matching_type="open",
                requested_by="exhibitor",
            )
            results["a_meeting_id"] = str(meeting.id)
            a_flushed.set()
            # A는 advisory lock을 쥔 채(트랜잭션 미종료) B가 락 대기하는 걸 재현할 시간을 준다.
            release_a.wait(timeout=5)
            session_a.commit()
        finally:
            session_a.close()

    def _run_b():
        session_b = db_factory()
        try:
            a_flushed.wait(timeout=5)
            try:
                book_meeting(
                    session_b,
                    event_id=event_id,
                    exhibitor_org_id=exhibitor_id,
                    buyer_org_id=buyer_id,
                    start=BASE,
                    end=BASE + timedelta(minutes=30),
                    resolve_venue=lambda: session_b.get(MeetingVenue, venue_id),
                    entry_state=EntryState.PROPOSED,
                    matching_type="open",
                    requested_by="exhibitor",
                )
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

    # B는 A가 advisory lock을 쥐고 있는 동안 SELECT pg_advisory_xact_lock(...)에서 진짜로 블로킹돼야
    # 한다 — 논리적 레이스가 아니라 실제 대기임을 확인.
    time.sleep(0.3)
    assert not b_finished.is_set(), "B가 A의 advisory lock을 기다리지 않고 먼저 끝났다 — 락이 안 걸렸다"

    release_a.set()
    thread_a.join(timeout=5)
    thread_b.join(timeout=5)

    assert isinstance(results.get("b_error"), MeetingError), (
        "A commit 후 B는 (쌍,시각) 중복 검사에 걸려 거부돼야 한다"
    )
    assert results["b_error"].code == "DUPLICATE_APPLICATION"
    assert results["b_error"].extra.get("existing_meeting_id") == results["a_meeting_id"]
