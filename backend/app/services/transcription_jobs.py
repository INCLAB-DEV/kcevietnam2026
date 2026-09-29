"""전사·구조화 비동기 작업 상태 저장 (F-MY-002, #42/#44 후속 — 영속화).

30분 분량 녹음은 전사(Whisper)에 수 분이 걸려 요청을 동기로 묶을 수 없다. transcribe POST 는
작업을 접수(202)하고 BackgroundTask 로 전사·구조화를 돌린다. FE 는 job_id 로 상태를 폴링하고,
완료되면 "회의록 정리 완료" 알림을 띄운다.

예전엔 프로세스 메모리 dict(``TranscriptionJobStore``)였다 — 단일 프로세스 전제라 ECS 다중
태스크에서 접수 프로세스와 폴링 프로세스가 갈리면 깨졌다. ``SqlTranscriptionJobStore``가 DB
(``transcription_jobs`` 테이블, migrations/versions/my002job0001)에 영속해 이 문제를 없앤다 —
프로덕션 기본은 이쪽(``app.api.deps.get_job_store``). ``InMemoryTranscriptionJobStore``는
DB 미설정 로컬/단위테스트용 fake 로 남겨 둔다. draft 는 opaque(Any) 로 들고 스키마에 의존하지
않는다.
"""

from __future__ import annotations

import uuid as uuid_lib
from dataclasses import dataclass
from typing import Any, Literal, Protocol
from uuid import uuid4

from app.db import SessionLocal
from app.models import TranscriptionJob as TranscriptionJobRow

JobStatus = Literal["pending", "done", "error"]


@dataclass
class TranscriptionJob:
    job_id: str
    meeting_id: str
    org_id: str
    status: JobStatus = "pending"
    draft: Any | None = None  # 완료 시 StructureDraftResponse(검수용 초안)
    error: str | None = None


class TranscriptionJobStore(Protocol):
    """전사 작업 저장소 계약. ``deps.get_job_store``/``reviews.py`` 는 이 인터페이스만 안다 —
    인메모리(fake)든 DB(prod)든 호출부는 바뀌지 않는다."""

    def create(self, meeting_id: str, org_id: str) -> TranscriptionJob: ...

    def get(self, job_id: str) -> TranscriptionJob | None: ...

    def complete(self, job_id: str, draft: Any) -> None: ...

    def fail(self, job_id: str, error: str) -> None: ...


class InMemoryTranscriptionJobStore:
    """인메모리 작업 레지스트리(fake) — 단일 프로세스에서만 접수/폴링이 같은 상태를 본다.

    DB 미설정 로컬 실행과, 실 DB 행(meeting_id/org_id가 UUID FK)이 아닌 임의 문자열 fixture를
    쓰는 단위테스트(``tests/test_api_reviews.py``)가 ``get_job_store`` override로 이걸 쓴다.
    """

    def __init__(self) -> None:
        self._jobs: dict[str, TranscriptionJob] = {}

    def create(self, meeting_id: str, org_id: str) -> TranscriptionJob:
        job = TranscriptionJob(job_id=uuid4().hex, meeting_id=meeting_id, org_id=org_id)
        self._jobs[job.job_id] = job
        return job

    def get(self, job_id: str) -> TranscriptionJob | None:
        return self._jobs.get(job_id)

    def complete(self, job_id: str, draft: Any) -> None:
        job = self._jobs.get(job_id)
        if job is not None:
            job.status = "done"
            job.draft = draft

    def fail(self, job_id: str, error: str) -> None:
        job = self._jobs.get(job_id)
        if job is not None:
            job.status = "error"
            job.error = error


def _is_uuid_like(value: str) -> bool:
    try:
        uuid_lib.UUID(value)
        return True
    except (ValueError, AttributeError, TypeError):
        return False


def _to_dto(row: TranscriptionJobRow) -> TranscriptionJob:
    return TranscriptionJob(
        job_id=str(row.id),
        meeting_id=str(row.meeting_id),
        org_id=str(row.org_id),
        status=row.status,
        draft=row.draft,
        error=row.error,
    )


class SqlTranscriptionJobStore:
    """DB 백엔드 작업 레지스트리(프로덕션 기본, ADR-0008). 메서드마다 세션을 열고 닫는다 —
    ``repositories/sql.py``의 ``SqlAlchemyRepository``와 동일 패턴이라, ``lru_cache`` 싱글턴으로
    캐시해도(``deps.get_job_store``) 세션을 붙들고 있지 않아 안전하다.
    """

    def create(self, meeting_id: str, org_id: str) -> TranscriptionJob:
        with SessionLocal() as db:
            row = TranscriptionJobRow(meeting_id=meeting_id, org_id=org_id)
            db.add(row)
            db.commit()
            db.refresh(row)
            return _to_dto(row)

    def get(self, job_id: str) -> TranscriptionJob | None:
        # job_id 는 URL 경로 파라미터(신뢰 불가) — UUID 형식이 아니면 DB에 묻지 않고 바로 미조회
        # 취급한다(안 그러면 Postgres가 uuid 파싱 실패로 500을 던진다. 404가 맞는 응답이다).
        if not _is_uuid_like(job_id):
            return None
        with SessionLocal() as db:
            row = db.get(TranscriptionJobRow, job_id)
            return _to_dto(row) if row else None

    def complete(self, job_id: str, draft: Any) -> None:
        with SessionLocal() as db:
            row = db.get(TranscriptionJobRow, job_id)
            if row is not None:
                row.status = "done"
                row.draft = draft.model_dump(mode="json") if hasattr(draft, "model_dump") else draft
                db.commit()

    def fail(self, job_id: str, error: str) -> None:
        with SessionLocal() as db:
            row = db.get(TranscriptionJobRow, job_id)
            if row is not None:
                row.status = "error"
                row.error = error
                db.commit()
