"""OP-005 배정 스케줄 읽기 엔드포인트 테스트(F-OP-005 Phase 6).

``GET /api/admin/events/{event_id}/assignment-schedule`` — 배정 콘솔 그리드(frontend
AssignmentScheduleData)가 그대로 그릴 수 있는 조합 응답. test_admin_ops_metrics_api.py와 동일
관례(로컬 시드 헬퍼, StubSessionAuthenticator 배선 확인)를 따른다. 여기서 지켜야 할 건:

- 기업 로스터가 discover 프로젝션(booth·keywords·buyer_subtype)을 그대로 반영하는가, 그리고
  **승인 여부와 무관하게** 전부 나오는가(슈퍼관리자 자유도 최대 — discover와의 핵심 차이)
- 행사일이 exhibition_start/end에서 파생되는가(하드코딩 아님)
- 미팅 시각이 slotId 형식("YYYY-MM-DDTHH:MM", 행사 로컬 타임존)으로 나오는가
- 참가사 불가슬롯은 반영되고 바이어는 키 자체가 없는가(저장소 비대칭)
- attended/has_review가 리뷰 유무·내용을 정직하게 반영하는가(리뷰 없으면 None)
- 등록순(application_order)이 created_at 오름차순인가
- master 전용 게이팅
"""

from __future__ import annotations

import itertools
import uuid
from datetime import date, datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.admin.guard import EventOperatorPrincipal, require_event_operator
from app.auth.organizer_guard import (
    EventMasterPrincipal,
    InMemoryEventOperatorDirectory,
    StubSessionAuthenticator,
    get_authenticator,
    get_operator_directory,
    require_event_master,
)
from app.db import get_session
from app.main import app
from app.models import (
    Booth,
    BuyerAttendee,
    BuyerProfile,
    Event,
    ExhibitorAttendee,
    ExhibitorProfile,
    Hall,
    Meeting,
    MeetingVenue,
    Organization,
    OrganizationEventRole,
    PostMeetingReview,
)

_seq = itertools.count(1)


# =============================================================================
# 픽스처 (test_admin_ops_metrics_api.py와 동일 관례)
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
        member_id="mbr-org-01", event_id=event_id
    )
    app.dependency_overrides[require_event_operator] = lambda: EventOperatorPrincipal(
        member_id="mbr-org-01", event_id=event_id, permission_level="master", organizer_id=str(uuid.uuid4())
    )


# --- 시드 헬퍼 -----------------------------------------------------------------
def _seed_event(db_factory, **overrides) -> str:
    n = next(_seq)
    db = db_factory()
    try:
        slug = overrides.pop("slug", f"assign-sched-{n}-{uuid.uuid4().hex[:8]}")
        ev = Event(name=overrides.pop("name", "DX Korea 2026"), slug=slug, **overrides)
        db.add(ev)
        db.commit()
        return str(ev.id)
    finally:
        db.close()


def _seed_org_role(
    db_factory,
    event_id,
    *,
    is_exhibitor=False,
    is_buyer=False,
    application_status="registered",
    buyer_subtype=None,
    created_at=None,
) -> str:
    db = db_factory()
    try:
        n = next(_seq)
        org = Organization(name_ko=f"테스트기업{n}")
        db.add(org)
        db.flush()
        role = OrganizationEventRole(
            organization_id=org.id,
            event_id=event_id,
            is_exhibitor=is_exhibitor,
            is_buyer=is_buyer,
            application_status=application_status,
            buyer_subtype=buyer_subtype,
        )
        if created_at is not None:
            role.created_at = created_at
        db.add(role)
        db.commit()
        return str(org.id), str(role.id)
    finally:
        db.close()


def _fill_exhibitor_profile(db_factory, role_id, event_id, *, unavailable_slots=None) -> None:
    db = db_factory()
    try:
        hall = Hall(event_id=event_id, hall_no="7", hall_name="7홀")
        db.add(hall)
        db.flush()
        booth = Booth(hall_id=hall.id, code="A-12")
        db.add(booth)
        db.flush()
        profile = ExhibitorProfile(
            org_event_role_id=role_id,
            booth_id=booth.id,
            unavailable_meeting_slots=unavailable_slots,
        )
        db.add(profile)
        db.flush()
        db.add(
            ExhibitorAttendee(
                exhibitor_profile_id=profile.id,
                first_name_ko="담당",
                last_name_ko="김",
                title_ko="매니저",
                sort_order=0,
            )
        )
        db.commit()
    finally:
        db.close()


def _fill_buyer_profile(db_factory, role_id) -> None:
    db = db_factory()
    try:
        profile = BuyerProfile(org_event_role_id=role_id)
        db.add(profile)
        db.flush()
        db.add(
            BuyerAttendee(
                buyer_profile_id=profile.id,
                first_name="철수",
                last_name="박",
                job_title="구매담당",
                sort_order=0,
            )
        )
        db.commit()
    finally:
        db.close()


def _seed_venue(db_factory, event_id, *, venue_type="zone_table", label="T-01") -> str:
    db = db_factory()
    try:
        v = MeetingVenue(event_id=event_id, venue_type=venue_type, label=label)
        db.add(v)
        db.commit()
        return str(v.id)
    finally:
        db.close()


def _seed_meeting(db_factory, event_id, exhibitor_org_id, buyer_org_id, **overrides) -> str:
    db = db_factory()
    try:
        m = Meeting(
            event_id=event_id,
            exhibitor_org_id=exhibitor_org_id,
            buyer_org_id=buyer_org_id,
            matching_type=overrides.pop("matching_type", "forced"),
            status=overrides.pop("status", "accepted"),
            **overrides,
        )
        db.add(m)
        db.commit()
        return str(m.id)
    finally:
        db.close()


def _seed_review(
    db_factory, meeting_id, reviewer_org_id, *, counterpart_noshow=False, self_noshow=False
) -> None:
    db = db_factory()
    try:
        db.add(
            PostMeetingReview(
                meeting_id=meeting_id,
                reviewer_org_id=reviewer_org_id,
                counterpart_noshow=counterpart_noshow,
                self_noshow=self_noshow,
            )
        )
        db.commit()
    finally:
        db.close()


# =============================================================================
# 본선
# =============================================================================
def test_assignment_schedule_returns_grid_shape_for_fe(client, db_factory):
    event_id = _seed_event(
        db_factory,
        exhibition_start=date(2026, 9, 16),
        exhibition_end=date(2026, 9, 17),
        slot_minutes=30,
        timezone="Asia/Seoul",
    )

    t0 = datetime(2026, 1, 1, tzinfo=timezone.utc)
    ex_id, ex_role_id = _seed_org_role(
        db_factory, event_id, is_exhibitor=True, application_status="approved", created_at=t0
    )
    _fill_exhibitor_profile(db_factory, ex_role_id, event_id, unavailable_slots=["2026-09-16T14:30"])

    buyer_id, buyer_role_id = _seed_org_role(
        db_factory,
        event_id,
        is_buyer=True,
        application_status="submitted",  # 미승인 — 그래도 로스터에 나와야 한다(슈퍼관리자 자유도 최대)
        buyer_subtype="hosted",
        created_at=t0 + timedelta(seconds=1),
    )
    _fill_buyer_profile(db_factory, buyer_role_id)

    venue_id = _seed_venue(db_factory, event_id, venue_type="zone_table", label="T-07")

    # 미팅 — UTC 01:00(9/16) 시드, 행사 타임존(KST, +9h)에서 10:00이어야 slotId가 "...T10:00".
    utc_start = datetime(2026, 9, 16, 1, 0, tzinfo=timezone.utc)
    m1 = _seed_meeting(
        db_factory,
        event_id,
        ex_id,
        buyer_id,
        status="accepted",
        matching_type="forced",
        venue_id=venue_id,
        scheduled_start=utc_start,
        scheduled_end=utc_start + timedelta(minutes=60),
        requested_by=None,
    )
    # 리뷰 없음 — attended/has_review는 정직하게 None/False.
    m2 = _seed_meeting(
        db_factory, event_id, ex_id, buyer_id, status="completed", matching_type="ai",
        scheduled_start=utc_start + timedelta(hours=2), scheduled_end=utc_start + timedelta(hours=2, minutes=30),
    )
    _seed_review(db_factory, m2, buyer_id, counterpart_noshow=True)  # 참가사가 안 왔다는 신고

    _as_master(event_id)
    resp = client.get(f"/api/admin/events/{event_id}/assignment-schedule")
    assert resp.status_code == 200, resp.text
    body = resp.json()

    # 행사일 — exhibition_start/end에서 파생, 라벨/요일 포맷 확인.
    assert body["dates"] == [
        {"id": "2026-09-16", "label": "9/16", "weekday": "수"},
        {"id": "2026-09-17", "label": "9/17", "weekday": "목"},
    ]

    # 운영시간 — 기본값(스케줄 행 미생성 시 09:00~18:00, 점심 NULL→"00:00"), slot_minutes는 events.
    # slot_gap_minutes/max_meeting_minutes 는 mt003gap0001 로 추가 — FE slotTimes 가 stride 로 걷고
    # 슬롯 선택기가 "최대 N칸" 대신 분 상한을 쓰려면 이 두 값이 응답에 실려야 한다. 기본 0/90.
    assert body["settings"] == {
        "start_time": "09:00", "end_time": "18:00", "slot_minutes": 30,
        "lunch_start": "00:00", "lunch_end": "00:00",
        "slot_gap_minutes": 0, "max_meeting_minutes": 90, "min_slots": 10,
    }

    # 로스터 — 미승인 바이어도 나온다(discover와 달리 승인 필터 없음). booth·buyer_subtype 반영.
    assert len(body["exhibitors"]) == 1
    ex_card = body["exhibitors"][0]
    assert ex_card["org_id"] == ex_id
    assert ex_card["role"] == "exhibitor"
    assert ex_card["booth"] == {"hall_no": "7", "hall_name": "7홀", "code": "A-12"}

    assert len(body["buyers"]) == 1
    buyer_card = body["buyers"][0]
    assert buyer_card["org_id"] == buyer_id
    assert buyer_card["buyer_subtype"] == "hosted"

    # 등록순 — created_at 오름차순 1부터.
    assert body["application_order"][ex_id] == 1
    assert body["application_order"][buyer_id] == 2

    # 미팅 — slotId 형식(행사 로컬 타임존), venue_label, attended/has_review.
    meetings = {m["id"]: m for m in body["meetings"]}
    assert meetings[m1]["slot_id"] == "2026-09-16T10:00"
    assert meetings[m1]["duration_minutes"] == 60
    assert meetings[m1]["venue_label"] == "T-07"
    assert meetings[m1]["matching_type"] == "forced"
    assert meetings[m1]["has_review"] is False
    assert meetings[m1]["attended"] is None  # 리뷰 없음 — 지어내지 않는다

    assert meetings[m2]["has_review"] is True
    assert meetings[m2]["attended"] is False  # 노쇼 신고

    # 불가슬롯 — 참가사만 실 저장소가 있다. 바이어는 키 자체가 없다.
    assert body["unavailable_by_org_id"][ex_id] == ["2026-09-16T14:30"]
    assert buyer_id not in body["unavailable_by_org_id"]

    # 담당자 — 첫 참석자.
    assert body["contacts_by_org_id"][ex_id] == {"name": "담당 김", "title": "매니저"}
    assert body["contacts_by_org_id"][buyer_id] == {"name": "철수 박", "title": "구매담당"}


def test_assignment_schedule_self_noshow_counts_as_attended_false(client, db_factory):
    """"내가 불참"(self_noshow)도 counterpart_noshow와 똑같이 attended=False로 집계돼야 한다.

    회귀 대상: assignment_review_facts가 counterpart_noshow만 보던 시절엔 self_noshow 리뷰가
    붙은 미팅이 "전부 참석으로 신고됐음"으로 잘못 집계됐다.
    """
    event_id = _seed_event(
        db_factory,
        exhibition_start=date(2026, 9, 16),
        exhibition_end=date(2026, 9, 17),
        slot_minutes=30,
        timezone="Asia/Seoul",
    )
    t0 = datetime(2026, 1, 1, tzinfo=timezone.utc)
    ex_id, _ = _seed_org_role(db_factory, event_id, is_exhibitor=True, application_status="approved", created_at=t0)
    buyer_id, _ = _seed_org_role(
        db_factory, event_id, is_buyer=True, application_status="approved", created_at=t0 + timedelta(seconds=1)
    )

    utc_start = datetime(2026, 9, 16, 3, 0, tzinfo=timezone.utc)
    m = _seed_meeting(
        db_factory, event_id, ex_id, buyer_id, status="completed", matching_type="ai",
        scheduled_start=utc_start, scheduled_end=utc_start + timedelta(minutes=30),
    )
    # 참가사가 자기 리뷰에 "내가 불참"을 신고 — 바이어는 아무 리뷰도 남기지 않았다.
    _seed_review(db_factory, m, ex_id, self_noshow=True)

    _as_master(event_id)
    resp = client.get(f"/api/admin/events/{event_id}/assignment-schedule")
    assert resp.status_code == 200, resp.text
    meetings = {row["id"]: row for row in resp.json()["meetings"]}
    assert meetings[m]["has_review"] is True
    assert meetings[m]["attended"] is False  # self_noshow 단독으로도 노쇼 집계에 반영된다


def test_assignment_schedule_no_exhibition_dates_gives_empty_dates(client, db_factory):
    """exhibition_start/end 미설정(일정 미확정 단계)이면 dates=[] — 하드코딩 폴백 금지."""
    event_id = _seed_event(db_factory)
    _as_master(event_id)
    resp = client.get(f"/api/admin/events/{event_id}/assignment-schedule")
    assert resp.status_code == 200
    body = resp.json()
    assert body["dates"] == []
    assert body["exhibitors"] == []
    assert body["buyers"] == []
    assert body["meetings"] == []


# =============================================================================
# 가드 — master 전용, 실 배선 확인(test_admin_ops_metrics_api.py와 동일 패턴)
# =============================================================================
def _directory(event_id: str) -> InMemoryEventOperatorDirectory:
    return InMemoryEventOperatorDirectory({("mbr-master", event_id): "master", ("mbr-sub", event_id): "sub"})


@pytest.fixture()
def wired_client(db_factory):
    def _override_session():
        db = db_factory()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_session] = _override_session
    app.dependency_overrides[get_authenticator] = StubSessionAuthenticator
    yield TestClient(app, raise_server_exceptions=False)
    app.dependency_overrides.clear()


def test_assignment_schedule_rejects_sub_through_real_guard_wiring(wired_client, db_factory):
    event_id = _seed_event(db_factory, name="배선 확인용")
    app.dependency_overrides[get_operator_directory] = lambda: _directory(event_id)

    sub_resp = wired_client.get(
        f"/api/admin/events/{event_id}/assignment-schedule",
        headers={"Authorization": "Bearer access-mbr-sub-1"},
    )
    assert sub_resp.status_code == 403

    master_resp = wired_client.get(
        f"/api/admin/events/{event_id}/assignment-schedule",
        headers={"Authorization": "Bearer access-mbr-master-1"},
    )
    assert master_resp.status_code == 200


def test_assignment_schedule_no_token_401_through_real_guard_wiring(wired_client, db_factory):
    event_id = _seed_event(db_factory, name="배선 확인용2")
    app.dependency_overrides[get_operator_directory] = lambda: _directory(event_id)

    resp = wired_client.get(f"/api/admin/events/{event_id}/assignment-schedule")
    assert resp.status_code == 401
