"""OP-001 운영 대시보드 실 DB 집계 엔드포인트 테스트(F-OP-001 / 이슈 #53).

``GET /api/admin/events/{event_id}/ops-metrics`` — FastAPI는 이 행사의 원시 사실(등록자 수·참가자·
미팅·리뷰·운영시간·포화배정 실행 이력)만 추려 돌려준다. 비율·상태묶음·시간대 버킷 계산은 여기서
검증하지 않는다 — 그건 frontend/lib/organizer/ops-metrics.ts의 aggregateOpsMetrics가 이미
단위테스트로 지키는 몫이다(ops-metrics.test.ts). 여기서 지켜야 할 건:

- 참가자 역할 분기(is_exhibitor∧is_buyer → 두 행)와 approved 판정(ADR-0009)이 DB 그대로 나오는가
- 미팅 시각이 행사 로컬 타임존(KST)으로 변환되는가(안 그러면 FE 시간대 집계가 9시간 밀린다)
- 리뷰가 **이 행사의 미팅에 달린 것만** 나오는가(다른 행사 리뷰가 새지 않는가)
- 등록자 수(roster)가 이 행사·role_hint로만 집계되는가('both'는 양쪽에 잡힌다)
- 포화배정 실행 이력이 회차순으로 나오는가
- 가드 — 읽기라 master+sub(require_event_operator). sub는 관할 스코프(scope='jurisdiction')로
  열린다(2026-09-17, 상세 검증은 test_admin_sub_operator_console.py). 토큰 없으면 401.

가드는 test_admin_api.py와 같은 방식(override)으로, 배선 확인만 실 StubSessionAuthenticator +
InMemoryEventOperatorDirectory(같은 파일 내 로컬 헬퍼)로 한다.
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
    Event,
    Meeting,
    Organization,
    OrganizationEventRole,
    PostMeetingReview,
    Registrant,
    SaturationBatchRun,
)

_seq = itertools.count(1)


# =============================================================================
# 픽스처 (test_admin_meeting_ops.py와 동일 관례 — 이 파일 전용 로컬 복제)
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
        slug = overrides.pop("slug", f"ops-metrics-{n}-{uuid.uuid4().hex[:8]}")
        ev = Event(name=overrides.pop("name", "DX Korea 2026"), slug=slug, **overrides)
        db.add(ev)
        db.commit()
        return str(ev.id)
    finally:
        db.close()


def _seed_org_role(db_factory, event_id, *, is_exhibitor=False, is_buyer=False, application_status="registered") -> str:
    db = db_factory()
    try:
        org = Organization(name_ko="테스트기업")
        db.add(org)
        db.flush()
        db.add(
            OrganizationEventRole(
                organization_id=org.id, event_id=event_id, is_exhibitor=is_exhibitor, is_buyer=is_buyer,
                application_status=application_status,
            )
        )
        db.commit()
        return str(org.id)
    finally:
        db.close()


def _seed_meeting(db_factory, event_id, exhibitor_org_id, buyer_org_id, **overrides) -> str:
    db = db_factory()
    try:
        m = Meeting(
            event_id=event_id, exhibitor_org_id=exhibitor_org_id, buyer_org_id=buyer_org_id,
            matching_type=overrides.pop("matching_type", "open"),
            status=overrides.pop("status", "accepted"), **overrides,
        )
        db.add(m)
        db.commit()
        return str(m.id)
    finally:
        db.close()


def _seed_review(db_factory, meeting_id, reviewer_org_id, *, counterpart_noshow=False) -> None:
    db = db_factory()
    try:
        db.add(
            PostMeetingReview(meeting_id=meeting_id, reviewer_org_id=reviewer_org_id, counterpart_noshow=counterpart_noshow)
        )
        db.commit()
    finally:
        db.close()


def _seed_registrant(db_factory, event_id, role_hint, *, member_id: str | None = None) -> None:
    n = next(_seq)
    db = db_factory()
    try:
        db.add(
            Registrant(
                event_id=event_id, organizer_member_id=member_id or f"reg-member-{n}",
                role_hint=role_hint, raw={},
            )
        )
        db.commit()
    finally:
        db.close()


def _seed_saturation_run(db_factory, event_id, *, run_number, status="draft", min_guaranteed_slots=10) -> None:
    db = db_factory()
    try:
        db.add(
            SaturationBatchRun(
                event_id=event_id, run_number=run_number, status=status, min_guaranteed_slots=min_guaranteed_slots,
            )
        )
        db.commit()
    finally:
        db.close()


# =============================================================================
# 본선 — 원시 집계 shape·정확성
# =============================================================================
def test_ops_metrics_returns_raw_facts_for_fe_aggregation(client, db_factory):
    event_id = _seed_event(
        db_factory, exhibition_start=date(2026, 9, 16), exhibition_end=date(2026, 9, 18), slot_minutes=20,
    )

    # 참가자 — approved 2, 미승인 1(exhibitor), approved buyer 2, 양쪽 역할(both) 1건.
    ex1 = _seed_org_role(db_factory, event_id, is_exhibitor=True, application_status="approved")
    ex2 = _seed_org_role(db_factory, event_id, is_exhibitor=True, application_status="approved")  # 미팅 0건
    ex_pending = _seed_org_role(db_factory, event_id, is_exhibitor=True, application_status="submitted")
    buyer1 = _seed_org_role(db_factory, event_id, is_buyer=True, application_status="approved")
    buyer2 = _seed_org_role(db_factory, event_id, is_buyer=True, application_status="approved")
    both_org = _seed_org_role(db_factory, event_id, is_exhibitor=True, is_buyer=True, application_status="approved")

    # 미팅 — UTC 01:30 시드(행사 타임존 Asia/Seoul 변환 시 10:30이어야 한다).
    utc_start = datetime(2026, 9, 16, 1, 30, tzinfo=timezone.utc)
    m1 = _seed_meeting(
        db_factory, event_id, ex1, buyer1, status="accepted",
        scheduled_start=utc_start, scheduled_end=utc_start + timedelta(minutes=30),
    )
    m2 = _seed_meeting(db_factory, event_id, ex1, buyer2, status="completed")  # 리뷰 2건(정상+노쇼)
    _seed_meeting(db_factory, event_id, both_org, buyer1, status="cancelled")  # 취소 — 리뷰 없음

    _seed_review(db_factory, m2, buyer1, counterpart_noshow=False)
    _seed_review(db_factory, m2, ex1, counterpart_noshow=True)

    # 등록자(명단) — exhibitor 1 + both 1 = 2, buyer 1 + both 1 = 2.
    _seed_registrant(db_factory, event_id, "exhibitor")
    _seed_registrant(db_factory, event_id, "buyer")
    _seed_registrant(db_factory, event_id, "both")

    # 포화배정 실행 — 회차 역순으로 심어 정렬을 실제로 검증.
    _seed_saturation_run(db_factory, event_id, run_number=2, status="draft", min_guaranteed_slots=12)
    _seed_saturation_run(db_factory, event_id, run_number=1, status="confirmed", min_guaranteed_slots=10)

    # 다른 행사 — 이 행사로 새지 않아야 하는 리뷰/등록자/미팅.
    other_event = _seed_event(db_factory, name="다른 행사")
    other_ex = _seed_org_role(db_factory, other_event, is_exhibitor=True, application_status="approved")
    other_buyer = _seed_org_role(db_factory, other_event, is_buyer=True, application_status="approved")
    other_meeting = _seed_meeting(db_factory, other_event, other_ex, other_buyer, status="completed")
    _seed_review(db_factory, other_meeting, other_buyer, counterpart_noshow=False)
    _seed_registrant(db_factory, other_event, "exhibitor")

    _as_master(event_id)
    resp = client.get(f"/api/admin/events/{event_id}/ops-metrics")
    assert resp.status_code == 200
    body = resp.json()

    # master는 행사 전역(scope='event') — sub 관할 스코프와 구분되는 응답 표식.
    assert body["scope"] == "event"

    # roster — 이 행사만, role_hint 'both'는 양쪽에 잡힌다.
    assert body["roster"] == {"exhibitor_registrants": 2, "buyer_registrants": 2}

    # participants — is_exhibitor∧is_buyer는 두 행, approved는 application_status 그대로.
    participants = {(p["org_id"], p["role"]): p["approved"] for p in body["participants"]}
    assert participants[(ex1, "exhibitor")] is True
    assert participants[(ex2, "exhibitor")] is True
    assert participants[(ex_pending, "exhibitor")] is False
    assert participants[(buyer1, "buyer")] is True
    assert participants[(buyer2, "buyer")] is True
    assert participants[(both_org, "exhibitor")] is True
    assert participants[(both_org, "buyer")] is True
    assert len(body["participants"]) == 7  # 다른 행사 참가자 안 섞임

    # meetings — 이 행사 3건만, 시각은 KST(+09:00)로 변환.
    meetings = {m["id"]: m for m in body["meetings"]}
    assert len(meetings) == 3
    assert meetings[m1]["status"] == "accepted"
    assert meetings[m1]["exhibitor_org_id"] == ex1
    assert meetings[m1]["buyer_org_id"] == buyer1
    assert meetings[m1]["scheduled_start"].startswith("2026-09-16T10:30:00")
    assert meetings[m1]["scheduled_start"].endswith("+09:00")
    assert meetings[m2]["status"] == "completed"

    # reviews — 이 행사의 미팅(m2)에 달린 2건만, 다른 행사 리뷰는 안 보인다.
    reviews = body["reviews"]
    assert len(reviews) == 2
    assert {r["meeting_id"] for r in reviews} == {m2}
    noshow_flags = {r["counterpart_noshow"] for r in reviews}
    assert noshow_flags == {True, False}

    # schedule — slot_minutes는 events(단일 진실원천), 운영시간은 기본값(HH:MM, 초 없음),
    # event_days는 exhibition_start/end에서 파생(9/16~9/18 = 3일).
    # slot_gap_minutes 는 FE가 하루 슬롯 총량을 stride 로 나누는 데 쓴다(mt003gap0001) — 기본 0.
    # lunch_* 는 이 시드에 점심이 없어 "00:00" 폴백(AssignmentScheduleSettingsOut 과 같은 관례) —
    # FE slotTimes 는 이 값을 빈 구간으로 해석해 아무 칸도 건너뛰지 않는다.
    assert body["schedule"] == {
        "operating_start": "09:00", "operating_end": "18:00", "slot_minutes": 20,
        "slot_gap_minutes": 0, "lunch_start": "00:00", "lunch_end": "00:00", "event_days": 3,
    }

    # saturation_runs — run_number 오름차순.
    runs = body["saturation_runs"]
    assert [r["run_number"] for r in runs] == [1, 2]
    assert runs[0]["status"] == "confirmed"
    assert runs[0]["min_guaranteed_slots"] == 10
    assert runs[1]["status"] == "draft"
    assert runs[1]["min_guaranteed_slots"] == 12


def test_ops_metrics_no_exhibition_dates_gives_zero_event_days(client, db_factory):
    """exhibition_start/end 미설정(일정 미확정 단계)이면 event_days=0 — 하드코딩 폴백 금지."""
    event_id = _seed_event(db_factory)
    _as_master(event_id)
    resp = client.get(f"/api/admin/events/{event_id}/ops-metrics")
    assert resp.status_code == 200
    assert resp.json()["schedule"]["event_days"] == 0


# =============================================================================
# 가드 — 읽기(master+sub, require_event_operator), 실 배선 확인
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


def test_ops_metrics_opens_to_sub_as_jurisdiction_scope_through_real_guard_wiring(wired_client, db_factory):
    """sub 착지 화면(/organizer)이 403으로 무너지던 결함의 회귀 방지 — sub는 관할 스코프로 200.

    이전엔 master 전용이라 sub 로그인 직후 대시보드가 서버 오류 화면이 됐다. 관할 범위 자체(다른 sub
    바이어가 안 섞이는가)는 test_admin_sub_operator_console.py가 지킨다.
    """
    event_id = _seed_event(db_factory, name="배선 확인용")
    app.dependency_overrides[get_operator_directory] = lambda: _directory(event_id)

    sub_resp = wired_client.get(
        f"/api/admin/events/{event_id}/ops-metrics", headers={"Authorization": "Bearer access-mbr-sub-1"}
    )
    assert sub_resp.status_code == 200
    assert sub_resp.json()["scope"] == "jurisdiction"

    master_resp = wired_client.get(
        f"/api/admin/events/{event_id}/ops-metrics", headers={"Authorization": "Bearer access-mbr-master-1"}
    )
    assert master_resp.status_code == 200
    assert master_resp.json()["scope"] == "event"


def test_ops_metrics_rejects_non_operator_through_real_guard_wiring(wired_client, db_factory):
    """배정 없는 회원(참가자 등)은 여전히 403 — 개방은 이 행사의 운영자(master/sub)까지만."""
    event_id = _seed_event(db_factory, name="배선 확인용(비운영자)")
    app.dependency_overrides[get_operator_directory] = lambda: _directory(event_id)

    resp = wired_client.get(
        f"/api/admin/events/{event_id}/ops-metrics", headers={"Authorization": "Bearer access-mbr-buyer-1"}
    )
    assert resp.status_code == 403


def test_ops_metrics_no_token_401_through_real_guard_wiring(wired_client, db_factory):
    event_id = _seed_event(db_factory, name="배선 확인용2")
    app.dependency_overrides[get_operator_directory] = lambda: _directory(event_id)

    resp = wired_client.get(f"/api/admin/events/{event_id}/ops-metrics")
    assert resp.status_code == 401
