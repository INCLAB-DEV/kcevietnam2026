"""서브 운영자(sub, 무역관) 콘솔 읽기 경로 — 관할 스코프·거버넌스 차단 회귀 테스트(2026-09-17).

배경: sub가 로그인하면 ``/organizer``(매칭 현황 대시보드)에 착지하는데, 그 화면이 부르는
``GET .../ops-metrics``가 master 전용이라 403 → 프론트가 서버 오류 화면으로 무너졌다. 기업 디테일도
master 전용 ``assignment-schedule``에 기대고 있었다. ADR-0012의 읽기(master+sub)·거버넌스(master)
구분에 맞춰 다음을 고정한다:

- **운영 대시보드(ops-metrics)**: sub에게 개방하되 **자기가 관리하는 바이어의 매칭 활동**만 —
  다른 sub의 바이어·미팅·리뷰는 절대 안 섞이고, 참가사 축(참가사 참가자·포화배정 이력)은 빠진다.
  master 출력은 그대로(scope='event'). 바이어가 0명인 신규 sub는 오류가 아니라 0/빈 목록.
- **기업 디테일 일정(organizations/{id}/schedule)**: 관할 읽기 — 자기 바이어·국내기업은 200, 다른
  sub의 바이어는 403. 참가사 일정을 sub가 열어도 자기 바이어와의 미팅만 보인다.
- **배정(거버넌스)**: 강제배정·재트리거·포화배정 생성/조회/확정/폐기, 행사 전역 배정 그리드는 계속
  master 전용 — sub는 403.
- **발송 이력(notifications)**: sub에겐 수신 기업이 관할인 행만.

전부 override 없이 **실 가드 배선**(StubSessionAuthenticator + 행사별 디렉터리)으로 돈다 — sub의
organizer_id는 ``resolve_organizer_id``가 실제 organizers 행에서 찾는다(시드한 관리 운영자와 같은 행).
"""

from __future__ import annotations

import itertools
import uuid
from datetime import date, datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.auth.organizer_guard import (
    InMemoryEventOperatorDirectory,
    StubSessionAuthenticator,
    get_authenticator,
    get_operator_directory,
)
from app.db import get_session
from app.main import app
from app.models import (
    BuyerAttendee,
    BuyerProfile,
    Event,
    Meeting,
    Member,
    Notification,
    NotificationDispatch,
    Organization,
    OrganizationEventRole,
    Organizer,
    PostMeetingReview,
    Registrant,
    SaturationBatchRun,
)

_seq = itertools.count(1)


# =============================================================================
# 픽스처 — 실 가드 배선(test_admin_ops_metrics_api.py의 wired_client와 같은 관례)
# =============================================================================
@pytest.fixture()
def db_factory(migrated_db: str):
    engine = create_engine(migrated_db, future=True)
    TestSession = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)
    yield TestSession
    engine.dispose()


@pytest.fixture()
def wired_client(db_factory):
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
    app.dependency_overrides[get_authenticator] = StubSessionAuthenticator
    yield TestClient(app, raise_server_exceptions=False)
    app.dependency_overrides.clear()


class _World:
    """한 행사 + master 1 + sub A/B(각자 바이어 보유) + 바이어 없는 신규 sub + 참가사 2곳.

    회원ID는 테스트마다 유일하게 만든다 — migrated_db는 세션 스코프 공유 DB라 organizers.member_id가
    다른 테스트와 겹치면 resolve_organizer_id가 엉뚱한 행을 집는다.
    """

    def __init__(self, db_factory) -> None:
        tag = uuid.uuid4().hex[:8]
        self.db_factory = db_factory
        self.event_id = self._event()
        self.master_member = f"mbr-master-{tag}"
        self.sub_a_member = f"mbr-sub-a-{tag}"
        self.sub_b_member = f"mbr-sub-b-{tag}"
        self.sub_new_member = f"mbr-sub-new-{tag}"
        self.sub_a = self._organizer(self.sub_a_member)
        self.sub_b = self._organizer(self.sub_b_member)

        self.ex1 = self._org_role(is_exhibitor=True, application_status="approved", name="참가사1")
        self.ex2 = self._org_role(is_exhibitor=True, application_status="approved", name="참가사2")
        self.buyer_a = self._org_role(
            is_buyer=True, application_status="approved", managing=self.sub_a, name="A바이어"
        )
        self.buyer_a_pending = self._org_role(
            is_buyer=True, application_status="submitted", managing=self.sub_a, name="A바이어(대기)"
        )
        self.buyer_b = self._org_role(
            is_buyer=True, application_status="approved", managing=self.sub_b, name="B바이어"
        )
        self.buyer_unmanaged = self._org_role(is_buyer=True, application_status="approved", name="무관리바이어")

        # 미팅 — A바이어 2건(참가사1 확정, 참가사2 완료+리뷰), B바이어 1건(참가사1), 무관리 1건(참가사2).
        self.m_a1 = self._meeting(self.ex1, self.buyer_a, status="accepted")
        self.m_a2 = self._meeting(self.ex2, self.buyer_a, status="completed")
        self.m_b1 = self._meeting(self.ex1, self.buyer_b, status="accepted")
        self.m_u1 = self._meeting(self.ex2, self.buyer_unmanaged, status="completed")
        self._review(self.m_a2, self.buyer_a, counterpart_noshow=False)
        self._review(self.m_a2, self.ex2, counterpart_noshow=True)
        self._review(self.m_u1, self.buyer_unmanaged, counterpart_noshow=False)

        # master 전용 원천 — 명단 스냅샷(registrants)·포화배정 이력. sub 응답엔 안 나와야 한다.
        self._registrant("exhibitor")
        self._registrant("buyer")
        self._saturation_run()

    @property
    def directory(self) -> InMemoryEventOperatorDirectory:
        return InMemoryEventOperatorDirectory(
            {
                (self.master_member, self.event_id): "master",
                (self.sub_a_member, self.event_id): "sub",
                (self.sub_b_member, self.event_id): "sub",
                (self.sub_new_member, self.event_id): "sub",
            }
        )

    @staticmethod
    def auth(member_id: str) -> dict[str, str]:
        return {"Authorization": f"Bearer access-{member_id}-1"}

    # --- 시드 -------------------------------------------------------------------
    def _event(self) -> str:
        db = self.db_factory()
        try:
            ev = Event(
                name="서브 콘솔 행사",
                slug=f"sub-console-{next(_seq)}-{uuid.uuid4().hex[:8]}",
                exhibition_start=date(2026, 10, 20),
                exhibition_end=date(2026, 10, 21),
                slot_minutes=30,
                timezone="Asia/Seoul",
            )
            db.add(ev)
            db.commit()
            return str(ev.id)
        finally:
            db.close()

    def _organizer(self, member_id: str) -> str:
        db = self.db_factory()
        try:
            o = Organizer(name=f"운영자 {member_id}", email=f"{member_id}@example.com", member_id=member_id)
            db.add(o)
            db.commit()
            return str(o.id)
        finally:
            db.close()

    def _org_role(self, *, name, is_exhibitor=False, is_buyer=False, application_status="registered", managing=None):
        db = self.db_factory()
        try:
            org = Organization(name_ko=name)
            db.add(org)
            db.flush()
            role = OrganizationEventRole(
                organization_id=org.id, event_id=self.event_id, is_exhibitor=is_exhibitor, is_buyer=is_buyer,
                application_status=application_status, managing_organizer_id=managing,
            )
            db.add(role)
            db.flush()
            if is_buyer:
                profile = BuyerProfile(org_event_role_id=role.id)
                db.add(profile)
                db.flush()
                db.add(BuyerAttendee(buyer_profile_id=profile.id, first_name=name, last_name="담당", sort_order=0))
            db.commit()
            return str(org.id)
        finally:
            db.close()

    def _meeting(self, exhibitor_org_id, buyer_org_id, *, status) -> str:
        db = self.db_factory()
        try:
            start = datetime(2026, 10, 20, 0, 0, tzinfo=timezone.utc) + timedelta(minutes=30 * next(_seq))
            m = Meeting(
                event_id=self.event_id, exhibitor_org_id=exhibitor_org_id, buyer_org_id=buyer_org_id,
                matching_type="forced", status=status,
                scheduled_start=start, scheduled_end=start + timedelta(minutes=30),
            )
            db.add(m)
            db.commit()
            return str(m.id)
        finally:
            db.close()

    def _review(self, meeting_id, reviewer_org_id, *, counterpart_noshow) -> None:
        db = self.db_factory()
        try:
            db.add(
                PostMeetingReview(
                    meeting_id=meeting_id, reviewer_org_id=reviewer_org_id, counterpart_noshow=counterpart_noshow
                )
            )
            db.commit()
        finally:
            db.close()

    def _registrant(self, role_hint) -> None:
        db = self.db_factory()
        try:
            db.add(
                Registrant(
                    event_id=self.event_id, organizer_member_id=f"reg-{uuid.uuid4().hex[:10]}",
                    role_hint=role_hint, raw={},
                )
            )
            db.commit()
        finally:
            db.close()

    def _saturation_run(self) -> None:
        db = self.db_factory()
        try:
            db.add(SaturationBatchRun(event_id=self.event_id, run_number=1, status="draft", min_guaranteed_slots=10))
            db.commit()
        finally:
            db.close()


@pytest.fixture()
def world(db_factory, wired_client) -> _World:
    w = _World(db_factory)
    app.dependency_overrides[get_operator_directory] = lambda: w.directory
    return w


# =============================================================================
# 운영 대시보드(ops-metrics) — sub 관할 스코프
# =============================================================================
def test_ops_metrics_sub_sees_only_own_buyers_activity(wired_client, world):
    resp = wired_client.get(
        f"/api/admin/events/{world.event_id}/ops-metrics", headers=world.auth(world.sub_a_member)
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()

    assert body["scope"] == "jurisdiction"
    # 등록 규모 = 관할 바이어 역할 수(승인 무관 2곳). 명단 스냅샷(registrants)·참가사 축은 싣지 않는다.
    assert body["roster"] == {"exhibitor_registrants": 0, "buyer_registrants": 2}
    participants = {(p["org_id"], p["role"]): p["approved"] for p in body["participants"]}
    assert participants == {(world.buyer_a, "buyer"): True, (world.buyer_a_pending, "buyer"): False}

    # 미팅 — A바이어가 낀 2건만. B바이어·무관리 바이어 미팅은 안 섞인다.
    assert {m["id"] for m in body["meetings"]} == {world.m_a1, world.m_a2}
    assert all(m["buyer_org_id"] == world.buyer_a for m in body["meetings"])
    # 리뷰 — 관할 미팅(m_a2)에 달린 양측 리뷰만. 무관리 미팅(m_u1) 리뷰는 제외.
    assert sorted((r["meeting_id"], r["reviewer_org_id"]) for r in body["reviews"]) == sorted(
        [(world.m_a2, world.buyer_a), (world.m_a2, world.ex2)]
    )
    # 포화배정 이력은 거버넌스 기록 — sub에겐 비운다. 운영시간(행사 설정)은 그대로.
    assert body["saturation_runs"] == []
    assert body["schedule"]["event_days"] == 2

    leaked = {world.buyer_b, world.buyer_unmanaged}
    assert not leaked & {p["org_id"] for p in body["participants"]}
    assert not leaked & {m["buyer_org_id"] for m in body["meetings"]}


def test_ops_metrics_sub_b_does_not_see_sub_a(wired_client, world):
    resp = wired_client.get(
        f"/api/admin/events/{world.event_id}/ops-metrics", headers=world.auth(world.sub_b_member)
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert {m["id"] for m in body["meetings"]} == {world.m_b1}
    assert {p["org_id"] for p in body["participants"]} == {world.buyer_b}
    assert body["reviews"] == []


def test_ops_metrics_new_sub_without_buyers_gets_empty_not_error(wired_client, world):
    """관할 바이어가 0명인 신규 sub — organizers 행이 아직 없어도(첫 요청에서 get-or-create) 200 + 빈 값."""
    resp = wired_client.get(
        f"/api/admin/events/{world.event_id}/ops-metrics", headers=world.auth(world.sub_new_member)
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["scope"] == "jurisdiction"
    assert body["roster"] == {"exhibitor_registrants": 0, "buyer_registrants": 0}
    assert body["participants"] == []
    assert body["meetings"] == []
    assert body["reviews"] == []
    assert body["saturation_runs"] == []


def test_ops_metrics_master_output_unchanged(wired_client, world):
    resp = wired_client.get(
        f"/api/admin/events/{world.event_id}/ops-metrics", headers=world.auth(world.master_member)
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["scope"] == "event"
    assert body["roster"] == {"exhibitor_registrants": 1, "buyer_registrants": 1}
    assert len(body["participants"]) == 6  # 참가사 2 + 바이어 4 — 관할 필터 없음
    assert {m["id"] for m in body["meetings"]} == {world.m_a1, world.m_a2, world.m_b1, world.m_u1}
    assert len(body["reviews"]) == 3
    assert [r["run_number"] for r in body["saturation_runs"]] == [1]


# =============================================================================
# 기업 디테일 일정(organizations/{id}/schedule) — 관할 읽기
# =============================================================================
def _schedule(client, world, org_id, member_id):
    return client.get(
        f"/api/admin/events/{world.event_id}/organizations/{org_id}/schedule", headers=world.auth(member_id)
    )


def test_org_schedule_sub_reads_own_buyer(wired_client, world):
    resp = _schedule(wired_client, world, world.buyer_a, world.sub_a_member)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert {m["id"] for m in body["meetings"]} == {world.m_a1, world.m_a2}
    assert [c["org_id"] for c in body["buyers"]] == [world.buyer_a]
    assert {c["org_id"] for c in body["exhibitors"]} == {world.ex1, world.ex2}  # 미팅 상대만
    assert set(body["contacts_by_org_id"]) == {world.buyer_a}  # 참가사는 담당자 미입력 — 키 없음
    assert [d["id"] for d in body["dates"]] == ["2026-10-20", "2026-10-21"]


def test_org_schedule_sub_reads_exhibitor_but_only_meetings_with_own_buyers(wired_client, world):
    """참가사(공유 열람 풀)는 열리지만, 일정은 자기 바이어와의 미팅만 — B바이어 미팅·기업명이 새면 안 된다."""
    resp = _schedule(wired_client, world, world.ex1, world.sub_a_member)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert {m["id"] for m in body["meetings"]} == {world.m_a1}
    assert [c["org_id"] for c in body["exhibitors"]] == [world.ex1]
    assert [c["org_id"] for c in body["buyers"]] == [world.buyer_a]
    assert world.buyer_b not in body["contacts_by_org_id"]
    assert world.buyer_b not in body["application_order"]


def test_org_schedule_sub_forbidden_for_other_subs_buyer(wired_client, world):
    assert _schedule(wired_client, world, world.buyer_b, world.sub_a_member).status_code == 403
    assert _schedule(wired_client, world, world.buyer_unmanaged, world.sub_a_member).status_code == 403


def test_org_schedule_unknown_org_404(wired_client, world):
    assert _schedule(wired_client, world, str(uuid.uuid4()), world.sub_a_member).status_code == 404
    assert _schedule(wired_client, world, "not-a-uuid", world.master_member).status_code == 404


def test_org_schedule_master_sees_all_meetings_of_org(wired_client, world):
    resp = _schedule(wired_client, world, world.ex1, world.master_member)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert {m["id"] for m in body["meetings"]} == {world.m_a1, world.m_b1}
    assert {c["org_id"] for c in body["buyers"]} == {world.buyer_a, world.buyer_b}


def test_org_detail_read_matches_schedule_jurisdiction(wired_client, world):
    """기업 디테일의 신청서(프로필) 읽기 — 같은 관할 규칙(자기 바이어·참가사 200, 남의 바이어 403)."""
    base = f"/api/admin/events/{world.event_id}/organizations"
    sub_a = world.auth(world.sub_a_member)
    assert wired_client.get(f"{base}/{world.buyer_a}", headers=sub_a).status_code == 200
    assert wired_client.get(f"{base}/{world.ex2}", headers=sub_a).status_code == 200
    assert wired_client.get(f"{base}/{world.buyer_b}", headers=sub_a).status_code == 403


# =============================================================================
# 거버넌스 — 배정 쓰기·행사 전역 배정 그리드는 계속 master 전용
# =============================================================================
def test_assignment_governance_endpoints_stay_master_only_for_sub(wired_client, world):
    base = f"/api/admin/events/{world.event_id}"
    sub_a = world.auth(world.sub_a_member)
    body = {
        "exhibitor_org_id": world.ex2,
        "buyer_org_id": world.buyer_a,
        "venue_id": str(uuid.uuid4()),
        "slot_ids": ["2026-10-21T10:00"],
    }
    run_id = str(uuid.uuid4())
    denied = [
        wired_client.get(f"{base}/assignment-schedule", headers=sub_a),
        wired_client.post(f"{base}/forced-assignments", json=body, headers=sub_a),
        wired_client.post(f"{base}/retrigger-assignments", json=body, headers=sub_a),
        wired_client.post(f"{base}/saturation-runs", headers=sub_a),
        wired_client.get(f"{base}/saturation-runs/{run_id}", headers=sub_a),
        wired_client.post(f"{base}/saturation-runs/{run_id}/confirm", headers=sub_a),
        wired_client.post(f"{base}/saturation-runs/{run_id}/discard", headers=sub_a),
        wired_client.get(f"{base}/organizers", headers=sub_a),
    ]
    assert [r.status_code for r in denied] == [403] * len(denied)

    # master는 같은 거버넌스 읽기를 그대로 통과한다(가드가 막는 게 sub뿐이라는 확인).
    master = world.auth(world.master_member)
    assert wired_client.get(f"{base}/assignment-schedule", headers=master).status_code == 200
    assert wired_client.get(f"{base}/organizers", headers=master).status_code == 200


# =============================================================================
# 발송 이력(notifications) — sub는 관할 수신 기업만
# =============================================================================
def _seed_notification(db_factory, event_id, org_id) -> None:
    db = db_factory()
    try:
        n = next(_seq)
        member = Member(organization_id=org_id, name=f"수신{n}", email=f"sub-notif-{n}-{uuid.uuid4().hex[:6]}@example.com")
        db.add(member)
        db.flush()
        notification = Notification(event_id=event_id, recipient_org_id=org_id, type="application_approved", payload={})
        db.add(notification)
        db.flush()
        db.add(NotificationDispatch(notification_id=notification.id, member_id=member.id, channel="in_app", status="sent"))
        db.commit()
    finally:
        db.close()


def test_notification_logs_scoped_to_sub_jurisdiction(wired_client, db_factory, world):
    for org_id in (world.ex1, world.buyer_a, world.buyer_b):
        _seed_notification(db_factory, world.event_id, org_id)
    url = f"/api/admin/events/{world.event_id}/notifications"

    sub_rows = wired_client.get(url, headers=world.auth(world.sub_a_member))
    assert sub_rows.status_code == 200, sub_rows.text
    assert {r["recipient_org_id"] for r in sub_rows.json()["items"]} == {world.ex1, world.buyer_a}

    master_rows = wired_client.get(url, headers=world.auth(world.master_member))
    assert {r["recipient_org_id"] for r in master_rows.json()["items"]} == {world.ex1, world.buyer_a, world.buyer_b}
