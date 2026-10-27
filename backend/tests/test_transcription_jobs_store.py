"""SqlTranscriptionJobStore 통합 테스트 — DB 영속 왕복 검증(#42/#44 후속, 전사잡 영속화).

인메모리 시절(``InMemoryTranscriptionJobStore``)엔 프로세스 메모리 dict라 프로세스가 바뀌면
(재시작·다중 ECS 태스크) 상태가 사라졌다. ``SqlTranscriptionJobStore``는 메서드마다 새 세션을
열고 커밋한다 — 이 테스트는 create/get/complete/fail 각 호출이 "새 세션"(=다른 프로세스를
흉내)에서도 직전 상태를 그대로 보는지 확인해 그 불변식을 지킨다.

``db_session``(격리 DB + 세이브포인트 롤백, tests/conftest.py)과 같은 커넥션에
``SqlTranscriptionJobStore``의 ``SessionLocal``을 묶어(monkeypatch), 실 dev DB를 오염시키지
않으면서도 진짜 Postgres 위에서 검증한다.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import update
from sqlalchemy.orm import Session

import app.services.transcription_jobs as job_store_module
from app.domain.review_provenance_binding import MatchingType
from app.models import Event, Meeting, Organization
from app.models import TranscriptionJob as TranscriptionJobRow
from app.services.transcription_jobs import TRANSCRIPTION_FAILED_MESSAGE, SqlTranscriptionJobStore


@pytest.fixture
def sql_job_store(db_session: Session, monkeypatch) -> SqlTranscriptionJobStore:
    """SqlTranscriptionJobStore가 여는 세션을 db_session과 같은 커넥션/세이브포인트에 묶는다.

    conftest.py의 join_transaction_mode="create_savepoint" 패턴과 동일 — 저장소 메서드의
    db.commit()은 세이브포인트만 release하고, db_session 픽스처 종료 시 외부 트랜잭션이
    통째로 롤백돼 격리 테스트 DB(migrated_db)에 흔적을 남기지 않는다.
    """
    connection = db_session.connection()
    monkeypatch.setattr(
        job_store_module,
        "SessionLocal",
        lambda: Session(bind=connection, join_transaction_mode="create_savepoint"),
    )
    return SqlTranscriptionJobStore()


@pytest.fixture
def meeting(db_session: Session) -> Meeting:
    """transcription_jobs.meeting_id/org_id FK 대상 — 실 meetings/organizations 행."""
    event = Event(name="TestEvent", slug=f"test-event-{uuid.uuid4().hex[:8]}")
    exhibitor = Organization(name_ko="참가사")
    buyer = Organization(name_ko="바이어")
    db_session.add_all([event, exhibitor, buyer])
    db_session.flush()
    m = Meeting(
        event_id=event.id,
        exhibitor_org_id=exhibitor.id,
        buyer_org_id=buyer.id,
        matching_type=MatchingType.AI.value,
    )
    db_session.add(m)
    db_session.flush()
    return m


def test_create_persists_pending_job(sql_job_store: SqlTranscriptionJobStore, meeting: Meeting):
    job = sql_job_store.create(str(meeting.id), str(meeting.exhibitor_org_id))
    assert job.status == "pending"
    assert job.job_id  # DB가 생성한 UUID
    assert job.meeting_id == str(meeting.id)
    assert job.org_id == str(meeting.exhibitor_org_id)


def test_get_rereads_across_separate_sessions(sql_job_store: SqlTranscriptionJobStore, meeting: Meeting):
    # create/get 이 각각 새 세션을 여는데도(=다른 프로세스가 폴링하는 상황의 시뮬레이션) 같은
    # 행을 본다 — 인메모리 dict였다면 다른 프로세스에선 애초에 존재하지 않았을 상태.
    job = sql_job_store.create(str(meeting.id), str(meeting.exhibitor_org_id))
    fetched = sql_job_store.get(job.job_id)
    assert fetched is not None
    assert fetched.job_id == job.job_id
    assert fetched.status == "pending"
    assert fetched.draft is None
    assert fetched.error is None


def test_complete_persists_draft_and_status(sql_job_store: SqlTranscriptionJobStore, meeting: Meeting):
    job = sql_job_store.create(str(meeting.id), str(meeting.exhibitor_org_id))
    sql_job_store.complete(job.job_id, {"transcript": "사거리 연장 논의", "report": {"discussion": ["x"]}})
    fetched = sql_job_store.get(job.job_id)
    assert fetched.status == "done"
    assert fetched.draft == {"transcript": "사거리 연장 논의", "report": {"discussion": ["x"]}}


def test_fail_persists_error_and_status(sql_job_store: SqlTranscriptionJobStore, meeting: Meeting):
    job = sql_job_store.create(str(meeting.id), str(meeting.exhibitor_org_id))
    sql_job_store.fail(job.job_id, "전사 엔진 타임아웃")
    fetched = sql_job_store.get(job.job_id)
    assert fetched.status == "error"
    assert fetched.error == "전사 엔진 타임아웃"


def test_get_unknown_uuid_returns_none(sql_job_store: SqlTranscriptionJobStore, meeting: Meeting):
    assert sql_job_store.get(str(uuid.uuid4())) is None


def test_get_malformed_id_returns_none_not_500(sql_job_store: SqlTranscriptionJobStore, meeting: Meeting):
    # job_id 는 URL 경로 파라미터(신뢰 불가) — UUID 형식이 아니면 Postgres 파싱 에러(500) 대신
    # 미조회(404 유도)로 처리돼야 한다.
    assert sql_job_store.get("does-not-exist") is None


def test_fail_pending_created_before_only_touches_stale_pending_rows(
    sql_job_store: SqlTranscriptionJobStore, meeting: Meeting, db_session: Session
):
    """시작 시 고아 정리(app.main) — cutoff 이전에 만들어진 pending만 실패로, 끝난 작업·이후 작업은 그대로.

    created_at은 server_default now()라 같은 트랜잭션 안의 행은 시각이 같다 — 정리 대상 여부를 시각으로
    가르도록 행의 created_at을 직접 앞뒤로 옮겨 둔다.
    """
    cutoff = datetime.now(timezone.utc)
    stale = sql_job_store.create(str(meeting.id), str(meeting.exhibitor_org_id))
    done = sql_job_store.create(str(meeting.id), str(meeting.exhibitor_org_id))
    sql_job_store.complete(done.job_id, {"report": "끝"})
    fresh = sql_job_store.create(str(meeting.id), str(meeting.exhibitor_org_id))
    for job_id, created_at in (
        (stale.job_id, cutoff - timedelta(hours=1)),
        (done.job_id, cutoff - timedelta(hours=1)),
        (fresh.job_id, cutoff + timedelta(hours=1)),
    ):
        db_session.execute(
            update(TranscriptionJobRow).where(TranscriptionJobRow.id == job_id).values(created_at=created_at)
        )
    db_session.flush()

    assert sql_job_store.fail_pending_created_before(cutoff, TRANSCRIPTION_FAILED_MESSAGE) == 1

    after = {j: sql_job_store.get(j) for j in (stale.job_id, done.job_id, fresh.job_id)}
    assert (after[stale.job_id].status, after[stale.job_id].error) == ("error", TRANSCRIPTION_FAILED_MESSAGE)
    assert after[done.job_id].status == "done"
    assert after[fresh.job_id].status == "pending"
