"""리뷰 Step2 저장 → "회의록 정리 완료" 알림 트리거 연결 테스트 (F-MY-002 × F-NT-001, ADR-0010).

app/api/reviews.py의 save_step2가 notifications.service.notify_review_ready를 실제로 호출하는지
검증한다. 리뷰 저장 자체는 test_api_reviews.py와 동일하게 InMemoryRepository로 격리하고,
get_session만 오버라이드해 알림 사이드이펙트가 실 DB(격리 테스트 DB)에 반영되는지 확인한다.

두 번째 테스트(알림 DB 미가용)는 Postgres 없이도 항상 돈다 — save_step2가 get_session 기본값
(연결 불가한 로컬 DATABASE_URL)을 쓸 때도 알림 발송 실패가 리뷰 저장을 막지 않는다는 "우아한
열화" 설계를 회귀 방지한다(reviews.py의 try/except 계약).
"""

from __future__ import annotations

import itertools
from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from app.api.deps import get_repository, get_storage, get_structurer, get_transcriber
from app.auth.principal import get_current_principal
from app.db import get_session
from app.domain.review_provenance_binding import MatchingType
from app.main import app
from app.models import Event, Meeting, Notification, Organization
from app.repositories.base import MeetingView
from app.repositories.memory import InMemoryRepository
from app.services.storage import FakeStorage
from app.services.structuring import FakeStructurer
from app.services.transcription import FakeTranscriber
from tests.conftest import header_principal

_seq = itertools.count(1)


def _h(org: str) -> dict:
    """테스트 주체 지정 — override된 principal 의존성이 이 헤더를 읽는다(실 인증 경로 아님)."""
    return {"X-Org-Id": org}


def _step2_body() -> dict:
    return {
        "report": {"discussion": ["논의사항"], "agreements": [], "actions": []},
        "finalize": True,
    }


# =============================================================================
# DB 있음 — 실제로 review_ready 알림 행이 생기는지(트리거 연결 검증)
# =============================================================================
@pytest.fixture()
def db_factory(migrated_db: str):
    engine = create_engine(migrated_db, future=True)
    TestSession = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)
    yield TestSession
    engine.dispose()


def _seed_meeting(db_factory) -> dict:
    """meeting_id는 notifications.meeting_id의 실 FK 대상이라 실제 meetings 행으로 seed해야 한다."""
    n = next(_seq)
    db = db_factory()
    try:
        ev = Event(name="DX Korea 2026", slug=f"nt-trigger-{n}")
        org_a = Organization(name_ko="셀러기업")
        org_b = Organization(name_ko="바이어기업")
        db.add_all([ev, org_a, org_b])
        db.flush()
        meeting = Meeting(
            event_id=ev.id, exhibitor_org_id=org_a.id, buyer_org_id=org_b.id,
            matching_type="open", status="accepted",
            # 확정 미팅은 일정이 필수다(mt001meet01 CHECK).
            scheduled_start=datetime(2026, 9, 16, 10, 0, tzinfo=timezone.utc),
            scheduled_end=datetime(2026, 9, 16, 10, 30, tzinfo=timezone.utc),
        )
        db.add(meeting)
        db.commit()
        return {"event_id": ev.id, "org_a": org_a.id, "org_b": org_b.id, "meeting_id": meeting.id}
    finally:
        db.close()


@pytest.fixture()
def db_client(db_factory):
    def _override_session():
        db = db_factory()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_session] = _override_session
    app.dependency_overrides[get_current_principal] = header_principal
    yield TestClient(app, raise_server_exceptions=False)
    app.dependency_overrides.pop(get_session, None)
    app.dependency_overrides.pop(get_current_principal, None)
    app.dependency_overrides.pop(get_repository, None)
    app.dependency_overrides.pop(get_transcriber, None)
    app.dependency_overrides.pop(get_structurer, None)
    app.dependency_overrides.pop(get_storage, None)


def test_step2_save_creates_review_ready_notification(db_client, db_factory):
    seeded = _seed_meeting(db_factory)
    repo = InMemoryRepository()
    repo.add_meeting(
        MeetingView(
            meeting_id=seeded["meeting_id"],
            event_id=seeded["event_id"],
            exhibitor_org_id=seeded["org_a"],
            buyer_org_id=seeded["org_b"],
            matching_type=MatchingType.OPEN,
        )
    )
    app.dependency_overrides[get_repository] = lambda: repo
    app.dependency_overrides[get_transcriber] = lambda: FakeTranscriber()
    app.dependency_overrides[get_structurer] = lambda: FakeStructurer()
    app.dependency_overrides[get_storage] = lambda: FakeStorage()

    org = seeded["org_a"]
    meeting_id = seeded["meeting_id"]
    db_client.post(f"/meetings/{meeting_id}/review/step1", json={"proceeded": "proceeded"}, headers=_h(org))
    resp = db_client.post(f"/meetings/{meeting_id}/review/step2", json=_step2_body(), headers=_h(org))
    assert resp.status_code == 200

    db = db_factory()
    try:
        rows = db.execute(
            select(Notification).where(
                Notification.type == "review_ready", Notification.recipient_org_id == org
            )
        ).scalars().all()
    finally:
        db.close()
    assert len(rows) == 1
    assert rows[0].meeting_id == meeting_id
    assert rows[0].payload["counterpart_org_name"] == "바이어기업"


def test_repeated_step2_save_does_not_duplicate_notification(db_client, db_factory):
    seeded = _seed_meeting(db_factory)
    repo = InMemoryRepository()
    repo.add_meeting(
        MeetingView(
            meeting_id=seeded["meeting_id"],
            event_id=seeded["event_id"],
            exhibitor_org_id=seeded["org_a"],
            buyer_org_id=seeded["org_b"],
            matching_type=MatchingType.OPEN,
        )
    )
    app.dependency_overrides[get_repository] = lambda: repo
    app.dependency_overrides[get_transcriber] = lambda: FakeTranscriber()
    app.dependency_overrides[get_structurer] = lambda: FakeStructurer()
    app.dependency_overrides[get_storage] = lambda: FakeStorage()

    org = seeded["org_a"]
    meeting_id = seeded["meeting_id"]
    db_client.post(f"/meetings/{meeting_id}/review/step1", json={"proceeded": "proceeded"}, headers=_h(org))
    db_client.post(f"/meetings/{meeting_id}/review/step2", json=_step2_body(), headers=_h(org))
    # 재저장(초안 수정 후 재확정 등) — 회의록 정리 완료 통지는 미팅당 1행(멱등, ADR-0010).
    resp = db_client.post(f"/meetings/{meeting_id}/review/step2", json=_step2_body(), headers=_h(org))
    assert resp.status_code == 200

    db = db_factory()
    try:
        rows = db.execute(
            select(Notification).where(
                Notification.type == "review_ready", Notification.recipient_org_id == org
            )
        ).scalars().all()
    finally:
        db.close()
    assert len(rows) == 1


# =============================================================================
# DB 없음(기본 get_session, 연결 불가) — 알림 발송 실패가 리뷰 저장을 막지 않는다(항상 실행).
# =============================================================================
def test_step2_save_succeeds_even_if_notification_db_unreachable():
    repo = InMemoryRepository()
    repo.add_meeting(
        MeetingView(
            meeting_id="mtg-noresolve",
            event_id="ev-1",
            exhibitor_org_id="org-a",
            buyer_org_id="org-b",
            matching_type=MatchingType.OPEN,
        )
    )
    app.dependency_overrides[get_repository] = lambda: repo
    app.dependency_overrides[get_transcriber] = lambda: FakeTranscriber()
    app.dependency_overrides[get_structurer] = lambda: FakeStructurer()
    app.dependency_overrides[get_storage] = lambda: FakeStorage()
    app.dependency_overrides[get_current_principal] = header_principal
    try:
        client = TestClient(app, raise_server_exceptions=False)
        client.post(
            "/meetings/mtg-noresolve/review/step1",
            json={"proceeded": "proceeded"},
            headers=_h("org-a"),
        )
        resp = client.post(
            "/meetings/mtg-noresolve/review/step2", json=_step2_body(), headers=_h("org-a")
        )
        assert resp.status_code == 200
        assert resp.json()["review"]["report_sections"]["discussion"] == ["논의사항"]
    finally:
        app.dependency_overrides.clear()
