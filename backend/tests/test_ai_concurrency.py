"""AI 동시성 하드닝(1차) 외부 동작 테스트 — 행사 당일 '미팅이 한꺼번에 끝나는' 순간의 실패 모드를 잠근다.

잠그는 것:
- 녹음 업로드 상한: 설정(기본 200MB, 2026-10-02 25MB에서 상향)을 넘으면 저장·작업 접수 전에 413
  ``audio_too_large``. 크기를 아는 업로드는 아예 읽지 않고, 모르는 경우에도 상한 + 1바이트 넘게 읽지 않는다
  (스트리밍 상한·S3 키·접수 상한은 test_transcription_intake.py가 더 자세히 잠근다).
- 전사 작업은 전용 풀에서 돈다: 접수(202)는 작업을 기다리지 않고, 작업이 OpenAI를 기다리는 동안 요청
  커넥션은 이미 풀에 돌아가 있다. 동시에 도는 작업 수는 설정된 상한을 넘지 않는다(넘치는 건 큐에서 대기).
- 동기 채팅 호출(구조화·러브콜 초안)은 자리 상한이 있다: 꽉 차면 구조화는 제한 시간 안에 503 ``ai_busy``,
  러브콜은 직접 작성 폴백. OpenAI 실패는 구조화 502 ``ai_failed``(500 아님), 러브콜은 예외 원문을 내보내지
  않는다.
- 자리 대기 상한(2026-10-06 교차리뷰 HIGH): 채팅·업로드 자리 모두, 이미 상한만큼 기다리는 중이면 줄을 서지 않고
  **즉시** 바쁨(구조화·업로드 503 ``ai_busy``, 러브콜은 직접 작성 폴백) — 기다리는 요청이 AnyIO 스레드를 다 먹지
  않게. 상한 미만이면 예전처럼 제한 시간까지 기다린다. 대기 수는 자리를 얻든·시간이 다 되든·예외가 나든 0으로
  돌아오고, 장치를 비우면(``shutdown_ai_workers``) 함께 0에서 다시 시작한다.
- 채팅 호출을 기다리는 동안 요청 세션의 커넥션을 쥐고 있지 않다(``release_connection``) — 닫힌 세션은 다시
  써도 되고(새 커넥션), 의존성 정리의 close()가 한 번 더 불려도 무해하다.
- lifespan 종료가 전사 풀을 닫는다.

외부 호출은 0건이다(fake·게이트 어댑터). 커넥션 점유 검증만 격리 Postgres(``migrated_db``)를 쓴다.
"""

from __future__ import annotations

import io
import logging
import os
import threading
import time
import uuid
from contextlib import ExitStack, contextmanager
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest
from fastapi import Depends, Header
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text
from sqlalchemy.orm import Session, sessionmaker

from app.api import reviews
from app.api.deps import (
    get_audio_preprocessor,
    get_job_store,
    get_love_call_drafter,
    get_org_directory,
    get_repository,
    get_storage,
    get_structurer,
    get_transcriber,
)
from app.auth.principal import Principal, get_current_principal
from app.config import settings
from app.db import get_session, release_connection
from app.domain.review_provenance_binding import MatchingType
from app.main import app
from app.repositories.base import MeetingView
from app.repositories.memory import InMemoryRepository
from app.services import ai_concurrency
from app.services.ai_concurrency import (
    AiBusyError,
    ai_chat_slot,
    ai_chat_waiters,
    shutdown_ai_workers,
    transcription_upload_slot,
    transcription_upload_waiters,
)
from app.services.audio_preprocessing import PassthroughAudioPreprocessor
from app.services.love_call_mail import FakeLoveCallMailDrafter
from app.services.org_directory import StaticOrgDirectory
from app.services.storage import FakeStorage
from app.services.structuring import FakeStructurer
from app.services.transcription import FakeTranscriber
from app.services.transcription_jobs import InMemoryTranscriptionJobStore
from tests.conftest import header_principal

ORG_A = "org-exhibitor"
ORG_B = "org-buyer"
MEETING = "meeting-1"
GATE_TIMEOUT = 10  # 게이트가 회귀로 안 풀려도 테스트가 영원히 매달리지 않게


def _h(org: str) -> dict:
    return {"X-Org-Id": org}


def _audio(size: int, name: str = "meeting.m4a") -> dict:
    return {"audio": (name, b"\x00" * size, "audio/m4a")}


# =============================================================================
# 공통 배선 — 인메모리 저장소 + fake 어댑터. 각 테스트가 필요한 어댑터만 갈아끼운다.
# =============================================================================
@pytest.fixture(autouse=True)
def _fresh_ai_workers():
    """풀·세마포어는 지연 생성 싱글턴이다 — 설정을 바꾼 테스트가 만든 인스턴스를 다음 테스트로 넘기지 않는다."""
    shutdown_ai_workers(wait=False)
    yield
    shutdown_ai_workers(wait=False)


@pytest.fixture
def repo() -> InMemoryRepository:
    r = InMemoryRepository()
    r.add_meeting(
        MeetingView(
            meeting_id=MEETING,
            event_id="event-1",
            exhibitor_org_id=ORG_A,
            buyer_org_id=ORG_B,
            matching_type=MatchingType.AI,
            ai_score=0.9,
            ai_score_reasons=["제품 적합성"],
        )
    )
    return r


@pytest.fixture
def job_store() -> InMemoryTranscriptionJobStore:
    return InMemoryTranscriptionJobStore()


@pytest.fixture
def storage() -> FakeStorage:
    return FakeStorage()


@pytest.fixture
def client(repo, job_store, storage):
    app.dependency_overrides[get_repository] = lambda: repo
    app.dependency_overrides[get_job_store] = lambda: job_store
    app.dependency_overrides[get_storage] = lambda: storage
    app.dependency_overrides[get_transcriber] = lambda: FakeTranscriber()
    app.dependency_overrides[get_structurer] = lambda: FakeStructurer()
    # 업로드는 가짜 오디오 바이트라 ffmpeg 대신 원본을 조각 하나로 넘기는 대역을 쓴다(실 변환은
    # test_recording_transcription.py가 따로 잠근다).
    app.dependency_overrides[get_audio_preprocessor] = lambda: PassthroughAudioPreprocessor()
    app.dependency_overrides[get_current_principal] = header_principal
    yield TestClient(app)
    app.dependency_overrides.clear()


def _transcribe(client, files, org=ORG_A, meeting=MEETING):
    return client.post(f"/meetings/{meeting}/review/step2/transcribe", files=files, headers=_h(org))


def _poll(client, job_id, org=ORG_A, meeting=MEETING) -> dict:
    return client.get(
        f"/meetings/{meeting}/review/step2/transcribe/{job_id}", headers=_h(org)
    ).json()


def _wait_until(predicate, timeout=5.0, interval=0.01) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(interval)
    return predicate()


# =============================================================================
# (a) 업로드 상한 — 413 audio_too_large, 저장·접수 전, 상한 + 1바이트 이상 읽지 않음
# =============================================================================
class _CountingReader(io.BytesIO):
    """read()로 실제로 꺼내 간 바이트 수를 센다 — '얼마나 읽었나'를 외부에서 검증하기 위한 스파이."""

    def __init__(self, payload: bytes) -> None:
        super().__init__(payload)
        self.bytes_read = 0

    def read(self, size: int | None = -1) -> bytes:
        chunk = super().read(size)
        self.bytes_read += len(chunk)
        return chunk


class TestUploadLimit:
    def test_oversized_recording_rejected_413_before_reading_storing_or_queueing(
        self, client, monkeypatch, storage, job_store
    ):
        monkeypatch.setattr(settings, "transcription_max_upload_bytes", 1024)
        wrapped: list[int] = []
        original = reviews._CappedUpload
        monkeypatch.setattr(
            reviews, "_CappedUpload", lambda *a, **kw: wrapped.append(1) or original(*a, **kw)
        )

        resp = _transcribe(client, _audio(1025))

        assert resp.status_code == 413
        assert resp.json()["detail"]["code"] == "audio_too_large"
        # 크기를 아는 업로드(multipart 파서가 기록)는 본문을 한 바이트도 다시 읽지 않고 거른다.
        assert wrapped == []
        assert storage._objects == {}  # 원본 보관 안 함
        assert job_store._jobs == {}  # 작업 접수 안 함
        assert ai_concurrency.queued_transcriptions() == 0  # 대기열 칸도 잡지 않았다

    def test_recording_exactly_at_limit_is_accepted(self, client, monkeypatch):
        monkeypatch.setattr(settings, "transcription_max_upload_bytes", 1024)
        resp = _transcribe(client, _audio(1024))
        assert resp.status_code == 202

    def test_default_limit_is_200mb(self):
        """녹음을 서버가 줄이고 조각내 전사하므로 OpenAI 파일 상한(25MB)이 아니라 200MB다(BFF·Caddy와 같이 맞춘다)."""
        from app.config import Settings

        assert Settings(_env_file=None).transcription_max_upload_bytes == 200 * 1024 * 1024

    def test_capped_upload_stops_within_limit_plus_one_byte(self):
        """크기를 모르는 업로드도 상한을 넘는 순간 멈춘다 — 통째로 메모리에 올리지 않는다."""
        spy = _CountingReader(b"\x01" * 10_000)
        capped = reviews._CappedUpload(spy, 1000)
        with pytest.raises(reviews._UploadTooLarge):
            while capped.read(256):
                pass
        assert spy.bytes_read <= 1000 + 1

    def test_capped_upload_read_without_size_takes_at_most_limit_plus_one(self):
        spy = _CountingReader(b"\x01" * 10_000)
        with pytest.raises(reviews._UploadTooLarge):
            reviews._CappedUpload(spy, 1000).read()
        assert spy.bytes_read == 1001

    def test_capped_upload_returns_whole_payload_within_limit(self):
        payload = bytes(range(256)) * 4
        capped = reviews._CappedUpload(io.BytesIO(payload), len(payload))
        chunks = []
        while chunk := capped.read(100):
            chunks.append(chunk)
        assert b"".join(chunks) == payload


# =============================================================================
# (c) 전사 풀 상한 — 동시에 도는 작업은 설정값까지만, 넘치는 건 큐에서 pending
# =============================================================================
class _GatedTranscriber:
    """게이트가 열릴 때까지 '전사 중'으로 머무는 fake — 동시 실행 수를 재고, 받은 오디오 바이트를 기록한다.

    시작을 기다릴 때 sleep으로 추측하지 않고 ``wait_started(n)``(Condition)으로 정확히 n건이 시작될 때까지 기다린다.
    """

    def __init__(self) -> None:
        self.gate = threading.Event()
        self._cond = threading.Condition()
        self.started = 0
        self.running = 0
        self.max_running = 0
        self.received: list[bytes] = []
        self.finished = threading.Event()

    def transcribe(self, audio_bytes: bytes, *, filename: str, language: str = "ko") -> str:
        with self._cond:
            self.started += 1
            self.running += 1
            self.max_running = max(self.max_running, self.running)
            self.received.append(audio_bytes)
            self._cond.notify_all()
        try:
            self.gate.wait(timeout=GATE_TIMEOUT)
            return f"전사 결과 {filename} ({len(audio_bytes)} bytes)"
        finally:
            with self._cond:
                self.running -= 1
            self.finished.set()

    def wait_started(self, n: int, timeout: float = 5.0) -> bool:
        with self._cond:
            return self._cond.wait_for(lambda: self.started >= n, timeout=timeout)


class TestTranscriptionPool:
    def test_at_most_configured_jobs_run_at_once_and_the_rest_wait_queued(self, client, monkeypatch):
        monkeypatch.setattr(settings, "transcription_max_concurrency", 3)
        gated = _GatedTranscriber()
        app.dependency_overrides[get_transcriber] = lambda: gated
        try:
            started_at = time.monotonic()
            jobs = [_transcribe(client, _audio(16, f"rec-{i}.m4a")) for i in range(4)]
            # 접수 4건은 작업을 기다리지 않고 바로 202 — 작업은 아직 하나도 안 끝났다.
            assert [r.status_code for r in jobs] == [202] * 4
            assert all(r.json()["status"] == "pending" for r in jobs)
            assert time.monotonic() - started_at < GATE_TIMEOUT / 2

            assert gated.wait_started(3), "상한(3)만큼은 바로 시작돼야 한다"
            # '4번째는 시작하지 않았다'를 시간으로 추측하지 않고 풀의 상태로 확인한다: 일꾼 스레드는 정확히
            # 3개(상한 — 넘으면 4번째 접수 때 스레드가 바로 하나 더 생긴다), 셋 다 게이트에 묶여 있고,
            # 4번째 작업은 풀의 대기열에 그대로 있다.
            executor = ai_concurrency._transcription_executor
            assert executor is not None
            assert len(executor._threads) == 3
            assert executor._work_queue.qsize() == 1
            assert gated.started == 3 and gated.running == 3
            # 4건 모두 아직 pending — 3건은 전사 중, 1건은 큐에서 순서를 기다린다.
            assert [_poll(client, r.json()["job_id"])["status"] for r in jobs] == ["pending"] * 4
        finally:
            gated.gate.set()

        assert _wait_until(
            lambda: all(_poll(client, r.json()["job_id"])["status"] == "done" for r in jobs)
        )
        assert gated.started == 4
        assert gated.max_running == 3


# =============================================================================
# 대기열 만료 — 너무 오래 기다린 작업은 OpenAI를 부르지 않고 실패로 끝낸다
# =============================================================================
class _ScriptedClock:
    """reviews._clock 대역 — 접수 시각과 시작 시각을 정해 준다(첫 값들을 차례로, 마지막 값은 계속)."""

    def __init__(self, *values: float) -> None:
        self._values = list(values)

    def __call__(self) -> float:
        return self._values.pop(0) if len(self._values) > 1 else self._values[0]


class _SpyStorage(FakeStorage):
    def __init__(self, calls: list[str]) -> None:
        super().__init__()
        self._calls = calls

    def download_to_file(self, key, path) -> None:
        self._calls.append("storage.download")
        super().download_to_file(key, path)


class TestQueuedJobExpiry:
    def _wire_spies(self, calls: list[str], storage: FakeStorage) -> None:
        class _SpyTranscriber:
            def transcribe(self, audio_bytes, *, filename, language="ko"):
                calls.append("transcribe")
                return "전사"

        class _SpyStructurer(FakeStructurer):
            def structure(self, raw_text, *, counterpart_org=""):
                calls.append("structure")
                return super().structure(raw_text, counterpart_org=counterpart_org)

        app.dependency_overrides[get_transcriber] = lambda: _SpyTranscriber()
        app.dependency_overrides[get_structurer] = lambda: _SpyStructurer()
        app.dependency_overrides[get_storage] = lambda: storage

    def test_job_that_waited_longer_than_max_age_fails_without_calling_openai(self, client, monkeypatch):
        calls: list[str] = []
        self._wire_spies(calls, _SpyStorage(calls))
        # 접수 1000초 → 시작 1000+601초: 기본 상한 600초(10분)를 넘겨 기다렸다.
        monkeypatch.setattr(reviews, "_clock", _ScriptedClock(1000.0, 1000.0 + 601))

        job_id = _transcribe(client, _audio(16)).json()["job_id"]
        assert _wait_until(lambda: _poll(client, job_id)["status"] != "pending")

        assert _poll(client, job_id) == {
            "status": "error",
            "draft": None,
            "error": _GENERIC_FAILURE,
            "error_code": "failed",
        }
        assert calls == []  # 원본도 내려받지 않고, 전사·구조화(OpenAI)도 부르지 않았다

    def test_job_within_max_age_runs_normally(self, client, monkeypatch):
        calls: list[str] = []
        self._wire_spies(calls, _SpyStorage(calls))
        monkeypatch.setattr(reviews, "_clock", _ScriptedClock(1000.0, 1000.0 + 599))

        job_id = _transcribe(client, _audio(16)).json()["job_id"]
        assert _wait_until(lambda: _poll(client, job_id)["status"] == "done")
        assert calls == ["storage.download", "transcribe", "structure"]

    def test_max_age_is_configurable_and_defaults_to_10_minutes(self, client, monkeypatch):
        """기본 600초 — 대기 600초 + 작업 최악 실행 1140초 = 1740초 ≤ 화면 폴링 1800초.

        작업 최악 실행(교차리뷰 H4 반영) = 실행 마감 600초 + 마감 직전에 시작한 마지막 조각(120 × 2 = 240초)
        + 구조화(300 × 1 = 300초) = 1140초. 마감은 조각을 보내기 전에만 확인하고, 전사가 끝나면 구조화는 항상 한다.
        마감 확인 전 단계(ffprobe 60초 + ffmpeg 300초)는 마감 안에 들어간다(config 주석).
        """
        from app.config import Settings

        defaults = Settings(_env_file=None)
        assert defaults.transcription_job_max_age_seconds == 600
        chunk_worst = defaults.openai_transcription_chunk_timeout_seconds * (
            defaults.openai_transcription_max_retries + 1
        )
        structuring_worst = defaults.openai_transcription_timeout_seconds * (
            defaults.openai_structuring_max_retries + 1
        )
        worst_case_run = defaults.transcription_job_deadline_seconds + chunk_worst + structuring_worst
        assert (chunk_worst, structuring_worst, worst_case_run) == (240, 300, 1140)
        assert 60 + defaults.transcription_ffmpeg_timeout_seconds < defaults.transcription_job_deadline_seconds
        assert defaults.transcription_job_max_age_seconds + worst_case_run <= 1800

        calls: list[str] = []
        self._wire_spies(calls, _SpyStorage(calls))
        monkeypatch.setattr(settings, "transcription_job_max_age_seconds", 10)
        monkeypatch.setattr(reviews, "_clock", _ScriptedClock(1000.0, 1011.0))

        job_id = _transcribe(client, _audio(16)).json()["job_id"]
        assert _wait_until(lambda: _poll(client, job_id)["status"] != "pending")
        assert _poll(client, job_id)["status"] == "error"
        assert calls == []


# =============================================================================
# 원본 키는 업로드마다 고유 — 같은 이름으로 다시 올려도 기다리던 작업의 원본이 바뀌지 않는다
# =============================================================================
class TestAudioKeyPerUpload:
    def test_queued_job_transcribes_its_own_upload_even_if_the_same_name_is_uploaded_again(
        self, client, storage, monkeypatch
    ):
        monkeypatch.setattr(settings, "transcription_max_concurrency", 1)
        gated = _GatedTranscriber()
        app.dependency_overrides[get_transcriber] = lambda: gated
        uploads = [b"first-recording", b"second", b"third-take"]
        try:
            first = _transcribe(client, {"audio": ("meeting.m4a", uploads[0], "audio/m4a")}).json()
            assert gated.wait_started(1)  # 첫 작업이 하나뿐인 자리를 쥐고 있다
            # 같은 파일명으로 두 번 더 올린다 — 둘 다 대기열에서 기다린다.
            queued = [
                _transcribe(client, {"audio": ("meeting.m4a", data, "audio/m4a")}).json()
                for data in uploads[1:]
            ]
        finally:
            gated.gate.set()

        jobs = [first, *queued]
        assert _wait_until(lambda: all(_poll(client, j["job_id"])["status"] == "done" for j in jobs))
        # 각 작업이 자기 업로드를 전사했다 — 예전처럼 키가 같았다면 2번째 작업은 3번째 업로드를 읽었다.
        assert gated.received == uploads
        keys = [_poll(client, j["job_id"])["draft"]["audio_s3_key"] for j in jobs]
        assert len(set(keys)) == 3
        # 행사 ID가 맨 앞 — 행사별 S3 수명주기(접두사 meetings/{event_id}/)로 보관 기간을 건다.
        assert all(
            k.startswith(f"meetings/event-1/{MEETING}/{ORG_A}/") and k.endswith("-meeting.m4a") for k in keys
        )
        assert {storage.get(k) for k in keys} == set(uploads)

    def test_slash_in_filename_does_not_split_the_key_path(self, client, storage):
        job = _transcribe(client, {"audio": ("../evil/name.m4a", b"x", "audio/m4a")}).json()
        assert _wait_until(lambda: _poll(client, job["job_id"])["status"] == "done")
        key = _poll(client, job["job_id"])["draft"]["audio_s3_key"]
        assert key.count("/") == 4  # meetings/{event}/{meeting}/{org}/{uuid}-{name}
        assert key.endswith("-.._evil_name.m4a")


# =============================================================================
# 전사 작업 실패 — 사용자에게는 고정 문구만, 원인(공급자 오류 본문·키 조각)은 서버 로그에만
# =============================================================================
_PROVIDER_ERROR = (
    "Error code: 401 - {'error': {'message': 'Incorrect API key provided: sk-****abcd', "
    "'type': 'invalid_request_error'}} (request_id=req_abc123)"
)
_GENERIC_FAILURE = "녹음 정리에 실패했어요. 잠시 후 다시 시도해 주세요."
_LEAK_MARKERS = ("sk-****", "abcd", "req_abc123", "Incorrect API key", "invalid_request_error", "401")


class _LeakyTranscriber:
    def transcribe(self, audio_bytes: bytes, *, filename: str, language: str = "ko") -> str:
        raise RuntimeError(_PROVIDER_ERROR)


class _LeakyStructurer:
    def structure(self, raw_text: str, *, counterpart_org: str = ""):
        raise RuntimeError(_PROVIDER_ERROR)


class _LeakyStorage(FakeStorage):
    def get(self, key: str) -> bytes:
        raise RuntimeError(_PROVIDER_ERROR)

    def download_to_file(self, key, path) -> None:
        raise RuntimeError(_PROVIDER_ERROR)


class TestTranscriptionFailureIsGeneric:
    @pytest.mark.parametrize(
        "failing",
        ["transcriber", "structurer", "storage"],
    )
    def test_failed_job_shows_only_the_generic_message_and_logs_the_cause(
        self, client, job_store, caplog, monkeypatch, failing
    ):
        # 같은 프로세스에서 앞선 테스트가 마이그레이션(migrated_db)을 돌리면 migrations/env.py의
        # fileConfig(disable_existing_loggers 기본 True)가 이미 만들어진 app.* 로거를 꺼 버린다 — 테스트
        # 환경만의 일이다(운영은 마이그레이션을 별도 프로세스로 돌린다). 이 테스트 동안만 다시 켠다.
        monkeypatch.setattr(logging.getLogger("app.api.reviews"), "disabled", False)
        caplog.set_level(logging.ERROR, logger="app.api.reviews")
        if failing == "transcriber":
            app.dependency_overrides[get_transcriber] = lambda: _LeakyTranscriber()
        elif failing == "structurer":
            app.dependency_overrides[get_structurer] = lambda: _LeakyStructurer()
        else:
            app.dependency_overrides[get_storage] = lambda: _LeakyStorage()

        job_id = _transcribe(client, _audio(16)).json()["job_id"]
        assert _wait_until(lambda: _poll(client, job_id)["status"] != "pending")

        resp = client.get(f"/meetings/{MEETING}/review/step2/transcribe/{job_id}", headers=_h(ORG_A))
        assert resp.json()["status"] == "error"
        assert resp.json()["error"] == _GENERIC_FAILURE
        for marker in _LEAK_MARKERS:
            assert marker not in resp.text
        # 저장되는 값도 고정 문구다 — DB(작업 행)에도 공급자 오류 본문이 남지 않는다.
        assert job_store.get(job_id).error == _GENERIC_FAILURE
        # 원인은 서버 로그에 그대로 남는다(장애 분석용).
        assert any(
            r.exc_info and _PROVIDER_ERROR in str(r.exc_info[1]) for r in caplog.records
        ), "원인 예외가 서버 로그에 남지 않았다"

    def test_legacy_rows_with_raw_error_text_are_not_passed_through(self, client, job_store):
        """이 패치 이전에 예외 원문을 그대로 저장한 작업 행도, 폴링 응답에서는 고정 문구로 나간다."""
        job = job_store.create(MEETING, ORG_A)
        job_store.fail(job.job_id, _PROVIDER_ERROR)

        resp = client.get(f"/meetings/{MEETING}/review/step2/transcribe/{job.job_id}", headers=_h(ORG_A))
        assert resp.json() == {
            "status": "error",
            "draft": None,
            "error": _GENERIC_FAILURE,
            "error_code": "failed",
        }
        for marker in _LEAK_MARKERS:
            assert marker not in resp.text

    def test_pending_and_done_jobs_carry_no_error(self, client):
        job_id = _transcribe(client, _audio(16)).json()["job_id"]
        assert _wait_until(lambda: _poll(client, job_id)["status"] == "done")
        assert _poll(client, job_id)["error"] is None


# =============================================================================
# (d)(e) 구조화 — 자리 상한 503 ai_busy(제한 시간 안에), OpenAI 실패 502 ai_failed
# =============================================================================
class _FailingStructurer:
    def structure(self, raw_text: str, *, counterpart_org: str = ""):
        raise TimeoutError("Request timed out. (request_id=req_abc123, key=sk-****abcd)")


def _structure(client, org=ORG_A):
    return client.post(
        f"/meetings/{MEETING}/review/step2/structure",
        json={"text": "사거리 연장 논의\n기술제안서 송부 합의"},
        headers=_h(org),
    )


class TestStructureUnderLoad:
    def test_returns_503_ai_busy_within_acquire_timeout_when_all_slots_are_taken(
        self, client, monkeypatch
    ):
        monkeypatch.setattr(settings, "ai_chat_max_concurrency", 1)
        monkeypatch.setattr(settings, "ai_chat_acquire_timeout_seconds", 0.05)

        with ai_chat_slot():  # 다른 요청이 마지막 자리를 쥐고 OpenAI를 기다리는 상황
            started = time.monotonic()
            resp = _structure(client)
            elapsed = time.monotonic() - started

        assert resp.status_code == 503
        assert resp.json()["detail"]["code"] == "ai_busy"
        assert elapsed < 2  # 제한 시간(0.05초) 근처에서 바로 거절 — 무한정 줄 서지 않는다

        # 자리가 나면 같은 요청이 그대로 성공한다(거절 경로가 자리를 새지 않는다).
        assert _structure(client).status_code == 200

    def test_openai_failure_is_clean_502_ai_failed_not_500(self, client):
        app.dependency_overrides[get_structurer] = lambda: _FailingStructurer()
        resp = _structure(client)

        assert resp.status_code == 502
        detail = resp.json()["detail"]
        assert detail["code"] == "ai_failed"
        # 예외 원문(요청 ID·키 조각)은 응답에 실리지 않는다 — 로그에만 남는다.
        assert "req_abc123" not in resp.text and "sk-****" not in resp.text

    def test_default_slot_wait_is_short(self):
        """자리 대기 중에도 요청은 AnyIO 스레드 토큰(전체 40)을 쥔다 — 기본 대기는 5초로 짧게."""
        from app.config import Settings

        assert Settings(_env_file=None).ai_chat_acquire_timeout_seconds == 5

    def test_failure_releases_the_chat_slot(self, client, monkeypatch):
        monkeypatch.setattr(settings, "ai_chat_max_concurrency", 1)
        monkeypatch.setattr(settings, "ai_chat_acquire_timeout_seconds", 0.05)
        app.dependency_overrides[get_structurer] = lambda: _FailingStructurer()
        assert _structure(client).status_code == 502
        # 실패한 호출이 자리를 반납했어야 다음 요청이 busy가 아니라 정상 처리된다.
        app.dependency_overrides[get_structurer] = lambda: FakeStructurer()
        assert _structure(client).status_code == 200


# =============================================================================
# (d) 러브콜 초안 — 자리 상한·AI 실패 모두 직접 작성 폴백, 예외 원문 비노출
# =============================================================================
REPORT = {
    "discussion": ["애니메이션 IP 4편 동남아 배급 조건 논의"],
    "agreements": ["샘플 에피소드 송부"],
    "actions": ["다음 주 견적서 전달"],
}


class _LeakyFailingDrafter:
    def draft(self, ctx):
        raise RuntimeError("Error code: 401 - Incorrect API key provided: sk-****abcd")


@pytest.fixture
def love_call_client(client):
    app.dependency_overrides[get_love_call_drafter] = lambda: FakeLoveCallMailDrafter()
    app.dependency_overrides[get_org_directory] = lambda: StaticOrgDirectory(
        names={ORG_A: "누리스튜디오", ORG_B: "VinaContent"},
        emails={ORG_B: ["buyer@example.com"]},
    )
    client.post(
        f"/meetings/{MEETING}/review/step1",
        json={"proceeded": "proceeded", "satisfaction": 4, "follow_up_intent": "yes"},
        headers=_h(ORG_A),
    )
    client.post(
        f"/meetings/{MEETING}/review/step2",
        json={"report": REPORT, "fit_rating": "good", "fit_reason": "", "finalize": True},
        headers=_h(ORG_A),
    )
    return client


def _draft(client):
    return client.post(f"/meetings/{MEETING}/love-call/mail/draft", headers=_h(ORG_A))


class TestLoveCallDraftUnderLoad:
    def test_busy_falls_back_to_manual_editor_with_generic_reason(self, love_call_client, monkeypatch):
        monkeypatch.setattr(settings, "ai_chat_max_concurrency", 1)
        monkeypatch.setattr(settings, "ai_chat_acquire_timeout_seconds", 0.05)

        with ai_chat_slot():
            resp = _draft(love_call_client)

        assert resp.status_code == 200  # 사용자는 막히지 않고 직접 쓰기로 이어진다
        body = resp.json()
        assert body["ai_generated"] is False
        assert body["body"] == ""
        assert "AI 요청이 많아" in body["error"]

    def test_raw_exception_text_never_reaches_the_user(self, love_call_client):
        app.dependency_overrides[get_love_call_drafter] = lambda: _LeakyFailingDrafter()
        resp = _draft(love_call_client)

        assert resp.status_code == 200
        body = resp.json()
        assert body["ai_generated"] is False
        assert body["error"] == "AI 초안 생성에 실패했어요. 잠시 후 다시 시도하거나 직접 작성해 주세요."
        assert "sk-****" not in resp.text and "401" not in body["error"]


# =============================================================================
# 자리 대기 상한(2026-10-06 교차리뷰 HIGH) — 채팅·업로드 자리 공통. 이미 상한만큼 기다리면 줄을 서지 않고 즉시
# 바쁨, 대기 수는 모든 경로에서 0으로 돌아온다(비밀번호 해시 자리와 같은 규약 — test_login_concurrency.TestWaiterCap)
# =============================================================================
WAIT_LIMIT = 5  # 자리 대기 제한(초) — 즉시 거절이면 이보다 훨씬 빨라야 한다

# 두 자리를 같은 테스트로 잠근다 — 자리(컨텍스트 매니저)·대기 수 조회·지연 생성 함수 이름·설정 이름.
_SLOT_KINDS = {
    "chat": SimpleNamespace(
        slot=ai_chat_slot,
        waiters=ai_chat_waiters,
        getter="_chat_slots",
        size="ai_chat_max_concurrency",
        max_waiters="ai_chat_max_waiters",
        timeout="ai_chat_acquire_timeout_seconds",
    ),
    "upload": SimpleNamespace(
        slot=transcription_upload_slot,
        waiters=transcription_upload_waiters,
        getter="_upload_slots",
        size="transcription_max_concurrent_uploads",
        max_waiters="transcription_upload_max_waiters",
        timeout="transcription_upload_acquire_timeout_seconds",
    ),
}


class _SlotWaiter:
    """다른 스레드에서 자리를 기다리는 요청 하나 — 자리가 나면 잡았다가 바로 놓는다."""

    def __init__(self, slot) -> None:
        self._slot = slot
        self.outcome: str | None = None
        self._thread = threading.Thread(target=self._run, daemon=True)

    def _run(self) -> None:
        try:
            with self._slot():
                self.outcome = "acquired"
        except AiBusyError:
            self.outcome = "busy"

    def start(self) -> _SlotWaiter:
        self._thread.start()
        return self

    def join(self) -> None:
        self._thread.join(timeout=GATE_TIMEOUT)
        assert not self._thread.is_alive()


class _ExplodingSemaphore(threading.BoundedSemaphore):
    """빈 자리는 없고, 기다리기 시작하면 예외가 나는 자리 — '기다리는 도중 예외' 경로를 만든다."""

    def acquire(self, blocking=True, timeout=None):
        if not blocking:
            return False
        raise RuntimeError("대기 중 예외(테스트)")


def _one_slot_one_waiter(monkeypatch, kind) -> None:
    """자리 1개 · 대기 상한 1명 · 대기 제한 5초(즉시 거절이면 이보다 훨씬 빨라야 한다)."""
    monkeypatch.setattr(settings, kind.size, 1)
    monkeypatch.setattr(settings, kind.max_waiters, 1)
    monkeypatch.setattr(settings, kind.timeout, WAIT_LIMIT)


# 스레드 예산을 이루는 여섯 값 — 세 자리(비밀번호 해시·AI 채팅·녹음 업로드)의 자리 수와 대기 상한.
_THREAD_BUDGET_SETTINGS = (
    "password_hash_max_concurrency",
    "password_hash_max_waiters",
    "ai_chat_max_concurrency",
    "ai_chat_max_waiters",
    "transcription_max_concurrent_uploads",
    "transcription_upload_max_waiters",
)


def _code_defaults(monkeypatch):
    """코드에 적힌 기본값 — 프로세스 환경변수가 끼어들지 않게 해당 변수를 지우고 읽는다(대소문자 무관하게 읽힌다)."""
    from app.config import Settings

    for key in list(os.environ):
        if key.lower() in _THREAD_BUDGET_SETTINGS:
            monkeypatch.delenv(key)
    return Settings(_env_file=None)


@contextmanager
def _full_waiting_line(kind):
    """자리 1개는 일하는 중이고 대기 상한 1명도 이미 줄을 선 상태 — 이 안에서 오는 요청은 즉시 거절돼야 한다."""
    with kind.slot():
        waiter = _SlotWaiter(kind.slot).start()
        assert _wait_until(lambda: kind.waiters() == 1)
        yield
    waiter.join()
    assert waiter.outcome == "acquired"  # 줄 서 있던 요청은 자리가 나자 그대로 진행됐다


class TestSlotWaiterCap:
    @pytest.fixture(autouse=True)
    def _no_waiter_left_behind(self):
        """어떤 경로(자리 얻음·시간 초과·예외·즉시 거절)로 끝난 테스트든 대기 수가 0으로 돌아왔는지 본다 — 새면 아무도
        기다리지 않는데도 다음 요청들이 '대기열이 꽉 찼다'로 거절된다. 모듈 픽스처가 장치를 비우기 **전**에 본다."""
        yield
        assert ai_chat_waiters() == 0
        assert transcription_upload_waiters() == 0

    @pytest.fixture(params=sorted(_SLOT_KINDS))
    def kind(self, request, monkeypatch):
        """채팅·업로드 자리 각각 — 자리 1개 · 대기 상한 1명 · 대기 제한 5초로 시작한다."""
        kind = _SLOT_KINDS[request.param]
        _one_slot_one_waiter(monkeypatch, kind)
        return kind

    def test_full_waiting_line_rejects_immediately_without_blocking(self, kind):
        with _full_waiting_line(kind):
            started = time.monotonic()
            with pytest.raises(AiBusyError, match="대기열이 꽉 찼다"):
                with kind.slot():
                    pass
            elapsed = time.monotonic() - started

            assert elapsed < 1  # 대기 제한(5초)을 기다리지 않고 바로 거절 — 스레드를 붙잡지 않는다
            assert kind.waiters() == 1  # 거절된 요청은 대기 수에 남지 않는다
        assert kind.waiters() == 0

    def test_free_slot_is_taken_without_queueing_even_with_no_waiting_allowed(
        self, kind, monkeypatch
    ):
        monkeypatch.setattr(settings, kind.max_waiters, 0)

        with kind.slot():  # 빈 자리는 대기 상한과 무관하게 바로 잡힌다
            assert kind.waiters() == 0
            # 자리가 찼는데 대기를 아예 받지 않으면(상한 0) 기다리지 않고 바로 거절한다.
            started = time.monotonic()
            with pytest.raises(AiBusyError, match="대기열이 꽉 찼다"):
                with kind.slot():
                    pass
            assert time.monotonic() - started < 1

    def test_below_the_cap_requests_queue_and_get_the_slot_in_turn(self, kind, monkeypatch):
        """상한 미만이면 예전 그대로 — 줄을 서서 기다리다 자리가 나면 차례로 받는다."""
        monkeypatch.setattr(settings, kind.max_waiters, 2)

        with kind.slot():
            waiters = [_SlotWaiter(kind.slot).start() for _ in range(2)]
            assert _wait_until(lambda: kind.waiters() == 2)  # 둘 다 줄에 섰다(거절 없음)
        for waiter in waiters:
            waiter.join()

        assert [waiter.outcome for waiter in waiters] == ["acquired", "acquired"]
        assert kind.waiters() == 0

    def test_waiter_count_returns_to_zero_after_timeout(self, kind):
        with kind.slot():
            started = time.monotonic()
            with pytest.raises(AiBusyError, match="상한에 걸렸다"):
                with kind.slot(timeout=0.05):  # 줄에 섰지만 제한 시간 안에 차례가 오지 않았다
                    pass
            # 즉시 거절이 아니라 예전처럼 제한 시간까지 기다렸다.
            assert time.monotonic() - started >= 0.04
            assert kind.waiters() == 0

    def test_waiter_count_returns_to_zero_when_waiting_raises(self, kind, monkeypatch):
        slots = ai_concurrency._Slots(1)
        slots.semaphore = _ExplodingSemaphore(1)
        monkeypatch.setattr(ai_concurrency, kind.getter, lambda: slots)

        with pytest.raises(RuntimeError, match="대기 중 예외"):
            with kind.slot(timeout=1):
                pass

        assert slots.waiting == 0

    def test_waiter_count_stays_zero_and_the_slot_is_returned_when_the_work_raises(self, kind):
        with pytest.raises(ValueError, match="본문 예외"):
            with kind.slot():
                raise ValueError("본문 예외(테스트)")

        assert kind.waiters() == 0
        with kind.slot(timeout=0.01):  # 자리도 돌려줬다
            pass

    def test_shutdown_resets_the_count_and_a_late_old_waiter_does_not_skew_the_new_one(self, kind):
        """``shutdown_ai_workers``가 장치를 비우면 대기 수도 0에서 다시 시작한다. 그 순간 옛 자리를 기다리던 요청이
        나중에 자기 몫을 되돌려도 새 장치의 셈은 어긋나지 않는다(대기 수는 자리와 한 벌 — ``ai_concurrency._Slots``)."""
        with ExitStack() as old_slot:
            old_slot.enter_context(kind.slot())  # 옛 장치의 자리
            old_waiter = _SlotWaiter(kind.slot).start()
            assert _wait_until(lambda: kind.waiters() == 1)

            shutdown_ai_workers(wait=False)
            assert kind.waiters() == 0  # 새 장치는 0에서 시작한다

            with kind.slot():  # 새 장치의 자리 — 옛 장치와 무관하게 바로 잡힌다
                new_waiter = _SlotWaiter(kind.slot).start()
                assert _wait_until(lambda: kind.waiters() == 1)

                old_slot.close()  # 옛 자리를 놓는다 → 옛 대기자가 옛 자리를 받고 끝난다
                old_waiter.join()
                assert old_waiter.outcome == "acquired"
                assert kind.waiters() == 1  # 옛 대기자가 되돌린 몫이 새 장치의 셈을 건드리지 않았다
            new_waiter.join()

        assert new_waiter.outcome == "acquired"
        assert kind.waiters() == 0

    def test_structure_returns_503_ai_busy_immediately_when_the_waiting_line_is_full(
        self, client, monkeypatch
    ):
        chat = _SLOT_KINDS["chat"]
        _one_slot_one_waiter(monkeypatch, chat)

        with _full_waiting_line(chat):
            started = time.monotonic()
            resp = _structure(client)
            elapsed = time.monotonic() - started

        assert resp.status_code == 503
        assert resp.json()["detail"]["code"] == "ai_busy"
        assert elapsed < 1  # 대기 제한(5초)을 기다리지 않았다
        # 줄이 빠지면 같은 요청이 그대로 성공한다(거절 경로가 자리·대기 수를 새지 않는다).
        assert _structure(client).status_code == 200

    def test_love_call_draft_falls_back_to_manual_immediately_when_the_waiting_line_is_full(
        self, love_call_client, monkeypatch
    ):
        chat = _SLOT_KINDS["chat"]
        _one_slot_one_waiter(monkeypatch, chat)

        with _full_waiting_line(chat):
            started = time.monotonic()
            resp = _draft(love_call_client)
            elapsed = time.monotonic() - started

        assert resp.status_code == 200  # 사용자는 막히지 않고 직접 쓰기로 이어진다
        body = resp.json()
        assert body["ai_generated"] is False
        assert body["body"] == ""
        assert "AI 요청이 많아" in body["error"]
        assert elapsed < 1

    def test_upload_returns_503_ai_busy_immediately_before_storing_when_the_waiting_line_is_full(
        self, client, monkeypatch, storage, job_store
    ):
        upload = _SLOT_KINDS["upload"]
        _one_slot_one_waiter(monkeypatch, upload)

        with _full_waiting_line(upload):
            started = time.monotonic()
            resp = _transcribe(client, _audio(16))
            elapsed = time.monotonic() - started

        assert resp.status_code == 503
        assert resp.json()["detail"]["code"] == "ai_busy"
        assert elapsed < 1
        assert storage._objects == {}  # 원본 보관 전에 거절했다
        assert job_store._jobs == {}  # 작업 접수도 안 했다
        assert ai_concurrency.queued_transcriptions() == 0  # 잡았던 대기열 칸은 돌려줬다
        # 줄이 빠지면 같은 업로드가 그대로 접수된다.
        assert _transcribe(client, _audio(16)).status_code == 202

    def test_default_waiter_caps(self, monkeypatch):
        defaults = _code_defaults(monkeypatch)
        assert defaults.ai_chat_max_waiters == 8
        assert defaults.transcription_upload_max_waiters == 5

    def test_default_upload_gate_holds_every_reserved_upload(self, monkeypatch):
        """업로드 자리 + 대기 상한이 전사 대기열 깊이보다 작지 않다.

        업로드는 대기열 칸을 먼저 잡고 업로드 자리로 온다 — 동시에 그 자리에 있을 수 있는 요청은 대기열 깊이만큼이다.
        자리 + 대기 상한이 그보다 작으면 칸까지 받은 업로드가 대기 상한에 걸려 즉시 503을 받고, 사용자는 수백 MB를
        처음부터 다시 올려야 한다.
        """
        defaults = _code_defaults(monkeypatch)
        upload = (
            defaults.transcription_max_concurrent_uploads
            + defaults.transcription_upload_max_waiters
        )
        assert upload >= defaults.transcription_max_queue_depth

    def test_default_thread_budget_stays_under_the_anyio_thread_limit(self, monkeypatch):
        """세 자리(비밀번호 해시·AI 채팅·녹음 업로드)에 묶일 수 있는 스레드의 합이 AnyIO 스레드 40개보다 작다.

        한 자리에 묶이는 요청 수의 최댓값은 자리 수 + 대기 상한이다. 셋이 동시에 가득 차도 다른 API가 쓸 스레드가
        남아야 한다 — 기본값 여섯 개 중 무엇을 올리든 합이 40에 닿으면 여기서 걸린다(산수는 app.config 주석).
        """
        import anyio

        async def _anyio_default_threads() -> float:
            return anyio.to_thread.current_default_thread_limiter().total_tokens

        # 예산의 전제 — 동기 라우트는 AnyIO 기본 스레드 40개에서 돈다(앱은 이 값을 바꾸지 않는다).
        assert anyio.run(_anyio_default_threads) == 40

        defaults = _code_defaults(monkeypatch)
        hashing = defaults.password_hash_max_concurrency + defaults.password_hash_max_waiters
        chat = defaults.ai_chat_max_concurrency + defaults.ai_chat_max_waiters
        upload = (
            defaults.transcription_max_concurrent_uploads
            + defaults.transcription_upload_max_waiters
        )
        assert hashing + chat + upload < 40


# =============================================================================
# 경로별 OpenAI 타임아웃 — 텍스트 구조화 180초 · 전사 작업 안의 구조화 300초 · 러브콜 초안 60초
# =============================================================================
class TestTimeoutPerPath:
    """각 라우트가 의도한 타임아웃의 클라이언트로 OpenAI를 부르는지 — 실 어댑터를 settings에서 만들게 두고,
    네트워크 직전(``structure``/``draft``)만 가로채 그때 쓰는 클라이언트의 타임아웃을 기록한다.

    전사 작업 안의 구조화는 전사 원문 전체를 transcript_turns로 다시 출력해서, 텍스트 구조화 상한으로는
    30분 회의에서 잘린다 — 그래서 경로마다 따로 잠근다. 설정값은 서로 구별되게 둔다(응답 대기 61/181/301초,
    재시도 chat 2·structuring 3·transcription 4회). 전사 작업 안의 구조화는 응답 대기는 전사 상한, 재시도는
    구조화 공통 값을 쓴다(오디오 전사 호출의 재시도와 따로). 연결 수립 상한은 경로와 무관하게 5초다.
    """

    def test_each_route_calls_openai_with_its_intended_timeout(self, love_call_client, monkeypatch):
        from app.services.love_call_mail import OpenAILoveCallMailDrafter
        from app.services.openai_clients import reset_shared_clients
        from app.services.structuring import OpenAIStructurer

        reset_shared_clients()
        monkeypatch.setattr(settings, "structurer_backend", "openai")
        monkeypatch.setattr(settings, "openai_api_key", "sk-test-timeouts-per-path")
        monkeypatch.setattr(settings, "openai_chat_timeout_seconds", 61)
        monkeypatch.setattr(settings, "openai_structuring_timeout_seconds", 181)
        monkeypatch.setattr(settings, "openai_transcription_timeout_seconds", 301)
        monkeypatch.setattr(settings, "openai_chat_max_retries", 2)
        monkeypatch.setattr(settings, "openai_structuring_max_retries", 3)
        monkeypatch.setattr(settings, "openai_transcription_max_retries", 4)

        seen: list[tuple[str, float, float, int]] = []

        def _limits(client) -> tuple[float, float, int]:
            return (client.timeout.read, client.timeout.connect, client.max_retries)

        def recording_structure(self, raw_text, *, counterpart_org=""):
            seen.append(("structure", *_limits(self._client)))
            return FakeStructurer().structure(raw_text, counterpart_org=counterpart_org)

        def recording_draft(self, ctx):
            seen.append(("draft", *_limits(self._client)))
            return FakeLoveCallMailDrafter().draft(ctx)

        monkeypatch.setattr(OpenAIStructurer, "structure", recording_structure)
        monkeypatch.setattr(OpenAILoveCallMailDrafter, "draft", recording_draft)
        # fake로 고정한 override를 걷어 실 의존성(get_structurer/get_love_call_drafter)이 settings에서 OpenAI
        # 어댑터를 만들게 한다. 전사기·저장소·작업 저장소는 fake 그대로다.
        app.dependency_overrides.pop(get_structurer)
        app.dependency_overrides.pop(get_love_call_drafter)
        try:
            # 1) 텍스트 메모 구조화 → structuring(181초, 재시도 3)
            assert _structure(love_call_client).status_code == 200
            # 2) 녹음 전사 작업 안의 구조화 → 응답 대기는 transcription(301초), 재시도는 structuring(3)
            job_id = _transcribe(love_call_client, _audio(16)).json()["job_id"]
            assert _wait_until(lambda: _poll(love_call_client, job_id)["status"] == "done")
            # 3) 러브콜 초안 → chat(61초, 재시도 2)
            assert _draft(love_call_client).json()["ai_generated"] is True
        finally:
            reset_shared_clients()

        assert seen == [
            ("structure", 181, 5.0, 3),
            ("structure", 301, 5.0, 3),
            ("draft", 61, 5.0, 2),
        ]


# =============================================================================
# (b) 커넥션 점유 — 격리 Postgres. 요청 커넥션이 '전사 대기'·'채팅 대기' 동안 풀에 돌아가 있는가
# =============================================================================
def _session_override(factory):
    def _get_session():
        db = factory()
        try:
            yield db
        finally:
            db.close()

    return _get_session


@pytest.fixture
def pg(migrated_db, monkeypatch):
    """격리 DB 엔진 + 미팅 1건. SQL 저장소·작업 저장소가 이 엔진을 쓰게 SessionLocal 바인딩을 갈아끼운다."""
    from app.models import Event, Meeting, Organization

    engine = create_engine(migrated_db, future=True)
    factory = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)
    monkeypatch.setattr("app.repositories.sql.SessionLocal", factory)
    monkeypatch.setattr("app.services.transcription_jobs.SessionLocal", factory)

    db = factory()
    try:
        event = Event(name="DX Korea 2026", slug=f"ai-concurrency-{uuid.uuid4().hex[:8]}")
        org_a = Organization(name_ko="참가사")
        org_b = Organization(name_ko="바이어")
        db.add_all([event, org_a, org_b])
        db.flush()
        meeting = Meeting(
            event_id=event.id,
            exhibitor_org_id=org_a.id,
            buyer_org_id=org_b.id,
            matching_type=MatchingType.AI.value,
        )
        db.add(meeting)
        db.commit()
        ns = SimpleNamespace(
            engine=engine,
            factory=factory,
            meeting_id=str(meeting.id),
            org_a=str(org_a.id),
            org_b=str(org_b.id),
        )
    finally:
        db.close()
    try:
        yield ns
    finally:
        engine.dispose()


def _principal_via_session(
    x_org_id: str | None = Header(default=None),
    db: Session = Depends(get_session),
) -> Principal:
    """실 ``get_current_principal``처럼 요청 세션으로 한 번 조회한다 — 이 SELECT가 요청 커넥션을 체크아웃해
    'idle in transaction'으로 붙든다(프로덕션과 같은 상태를 만든다)."""
    db.execute(text("SELECT 1"))
    return header_principal(x_org_id=x_org_id, x_member_id=None)


class _GateTranscriberProbe(_GatedTranscriber):
    """전사 대기 중에 풀의 체크아웃 수를 기록한다."""

    def __init__(self, engine) -> None:
        super().__init__()
        self.engine = engine
        self.entered = threading.Event()
        self.checked_out_while_waiting: int | None = None

    def transcribe(self, audio_bytes: bytes, *, filename: str, language: str = "ko") -> str:
        self.checked_out_while_waiting = self.engine.pool.checkedout()
        self.entered.set()
        return super().transcribe(audio_bytes, filename=filename, language=language)


class TestNoConnectionHeldWhileWaitingOnAi:
    def test_transcribe_returns_202_and_holds_no_connection_while_the_job_waits(self, pg):
        from app.repositories.sql import SqlAlchemyRepository
        from app.services.transcription_jobs import SqlTranscriptionJobStore

        probe = _GateTranscriberProbe(pg.engine)
        app.dependency_overrides[get_session] = _session_override(pg.factory)
        app.dependency_overrides[get_current_principal] = _principal_via_session
        app.dependency_overrides[get_repository] = lambda: SqlAlchemyRepository()
        app.dependency_overrides[get_job_store] = lambda: SqlTranscriptionJobStore()
        app.dependency_overrides[get_transcriber] = lambda: probe
        app.dependency_overrides[get_structurer] = lambda: FakeStructurer()
        app.dependency_overrides[get_storage] = lambda: FakeStorage()
        app.dependency_overrides[get_audio_preprocessor] = lambda: PassthroughAudioPreprocessor()
        client = TestClient(app)
        try:
            resp = _transcribe(client, _audio(64), org=pg.org_a, meeting=pg.meeting_id)

            assert resp.status_code == 202
            assert resp.json()["status"] == "pending"
            # 응답은 작업을 기다리지 않았다 — 작업은 지금 '전사(OpenAI) 대기' 중이다.
            assert probe.entered.wait(timeout=5)
            assert not probe.finished.is_set()
            # 그 사이 요청 커넥션(인증 SELECT)은 이미 풀에 돌아갔고, 작업도 커넥션을 쥐고 있지 않다.
            assert probe.checked_out_while_waiting == 0
            assert pg.engine.pool.checkedout() == 0
        finally:
            probe.gate.set()
            app.dependency_overrides.clear()

        job_id = resp.json()["job_id"]
        # 결과 기록(complete)은 작업이 자기 짧은 세션으로 한다 — DB에서 done이 보이고 커넥션은 다시 0.
        assert _wait_until(lambda: SqlTranscriptionJobStore().get(job_id).status == "done")
        assert pg.engine.pool.checkedout() == 0

    def test_structure_releases_request_connection_before_calling_ai(self, pg):
        seen: dict[str, int] = {}

        def principal(x_org_id: str | None = Header(default=None), db: Session = Depends(get_session)):
            db.execute(text("SELECT 1"))
            seen["after_auth"] = pg.engine.pool.checkedout()
            return header_principal(x_org_id=x_org_id, x_member_id=None)

        class _ProbeStructurer(FakeStructurer):
            def structure(self, raw_text: str, *, counterpart_org: str = ""):
                seen["during_ai"] = pg.engine.pool.checkedout()
                return super().structure(raw_text, counterpart_org=counterpart_org)

        repo = InMemoryRepository()
        repo.add_meeting(
            MeetingView(
                meeting_id=MEETING,
                event_id="event-1",
                exhibitor_org_id=ORG_A,
                buyer_org_id=ORG_B,
                matching_type=MatchingType.AI,
                ai_score=None,
                ai_score_reasons=[],
            )
        )
        app.dependency_overrides[get_session] = _session_override(pg.factory)
        app.dependency_overrides[get_current_principal] = principal
        app.dependency_overrides[get_repository] = lambda: repo
        app.dependency_overrides[get_structurer] = lambda: _ProbeStructurer()
        try:
            resp = _structure(TestClient(app))
        finally:
            app.dependency_overrides.clear()

        assert resp.status_code == 200
        assert seen["after_auth"] == 1  # 인증 SELECT가 요청 커넥션을 실제로 쥐었다
        assert seen["during_ai"] == 0  # AI를 기다리는 동안엔 놓았다
        assert pg.engine.pool.checkedout() == 0

    def test_love_call_draft_releases_request_connection_before_calling_ai(self, pg, repo):
        seen: dict[str, int] = {}

        def principal(x_org_id: str | None = Header(default=None), db: Session = Depends(get_session)):
            db.execute(text("SELECT 1"))
            seen["after_auth"] = pg.engine.pool.checkedout()
            return header_principal(x_org_id=x_org_id, x_member_id=None)

        class _ProbeDrafter(FakeLoveCallMailDrafter):
            def draft(self, ctx):
                seen["during_ai"] = pg.engine.pool.checkedout()
                return super().draft(ctx)

        app.dependency_overrides[get_repository] = lambda: repo
        app.dependency_overrides[get_current_principal] = header_principal
        app.dependency_overrides[get_org_directory] = lambda: StaticOrgDirectory(
            names={ORG_A: "누리스튜디오", ORG_B: "VinaContent"}, emails={ORG_B: ["buyer@example.com"]}
        )
        try:
            seeding = TestClient(app)
            seeding.post(
                f"/meetings/{MEETING}/review/step1",
                json={"proceeded": "proceeded", "satisfaction": 4, "follow_up_intent": "yes"},
                headers=_h(ORG_A),
            )
            seeding.post(
                f"/meetings/{MEETING}/review/step2",
                json={"report": REPORT, "fit_rating": "good", "fit_reason": "", "finalize": True},
                headers=_h(ORG_A),
            )
            app.dependency_overrides[get_session] = _session_override(pg.factory)
            app.dependency_overrides[get_current_principal] = principal
            app.dependency_overrides[get_love_call_drafter] = lambda: _ProbeDrafter()
            resp = _draft(TestClient(app))
        finally:
            app.dependency_overrides.clear()

        assert resp.status_code == 200
        assert resp.json()["ai_generated"] is True
        assert seen["after_auth"] == 1
        assert seen["during_ai"] == 0
        assert pg.engine.pool.checkedout() == 0

    def test_released_session_is_reusable_and_double_close_is_harmless(self, pg):
        """닫힌 세션은 다음 쿼리에서 새 커넥션을 받는다 — get_session 정리의 close()가 다시 불려도 무해."""
        db = pg.factory()
        db.execute(text("SELECT 1"))
        assert pg.engine.pool.checkedout() == 1

        release_connection(db)
        assert pg.engine.pool.checkedout() == 0

        assert db.execute(text("SELECT 1")).scalar_one() == 1
        assert pg.engine.pool.checkedout() == 1
        db.close()
        db.close()
        assert pg.engine.pool.checkedout() == 0


# =============================================================================
# lifespan — 종료 시 전사 풀을 닫는다(대기열의 작업은 취소, 실행 중 작업은 끝까지 돈다 — app.main 주석)
# =============================================================================
def test_lifespan_shutdown_closes_transcription_pool():
    future = ai_concurrency.submit_transcription(lambda: "ok")
    assert future.result(timeout=5) == "ok"
    pool = ai_concurrency._transcription_executor
    assert pool is not None

    with TestClient(app):
        pass

    assert ai_concurrency._transcription_executor is None
    assert pool._shutdown is True


# =============================================================================
# lifespan 시작 — 이전 프로세스가 남긴 pending 작업(고아)을 고정 실패 문구로 정리한다
# =============================================================================
class TestOrphanedJobsOnStartup:
    """재시작으로 전사 풀이 사라지면 pending 작업은 영영 안 끝난다 — 시작할 때 바로 실패로 바꿔 화면이 30분
    헛폴링하지 않게 한다. 저장소는 요청과 같은 의존성(get_job_store)을 쓰므로 인메모리로 격리해 검증한다
    (conftest가 테스트 세션 동안 이 정리를 기본으로 꺼 두므로 여기서만 켠다)."""

    def _store_with_jobs(self):
        store = InMemoryTranscriptionJobStore()
        an_hour_ago = datetime.now(timezone.utc) - timedelta(hours=1)
        orphan = store.create(MEETING, ORG_A)
        done = store.create(MEETING, ORG_A)
        store.complete(done.job_id, {"report": "끝난 작업"})
        for job in (orphan, done):
            job.created_at = an_hour_ago  # 이전 프로세스 시절에 만들어진 작업
        return store, orphan, done

    def _start_app_with(self, store, monkeypatch, *, enabled: bool) -> None:
        monkeypatch.setattr(settings, "transcription_fail_orphans_on_startup", enabled)
        app.dependency_overrides[get_job_store] = lambda: store
        try:
            with TestClient(app):
                pass
        finally:
            app.dependency_overrides.clear()

    def test_startup_fails_pending_jobs_left_by_a_previous_process(self, monkeypatch):
        store, orphan, done = self._store_with_jobs()
        self._start_app_with(store, monkeypatch, enabled=True)

        assert (orphan.status, orphan.error) == ("error", _GENERIC_FAILURE)
        assert (done.status, done.draft) == ("done", {"report": "끝난 작업"})  # 끝난 작업은 건드리지 않는다

    def test_switch_off_leaves_pending_jobs_alone(self, monkeypatch):
        store, orphan, _ = self._store_with_jobs()
        self._start_app_with(store, monkeypatch, enabled=False)
        assert orphan.status == "pending"

    def test_cleanup_failure_does_not_block_startup(self, monkeypatch):
        class _BrokenStore(InMemoryTranscriptionJobStore):
            def fail_pending_created_before(self, cutoff, error):
                raise RuntimeError("DB 연결 실패")

        monkeypatch.setattr(settings, "transcription_fail_orphans_on_startup", True)
        app.dependency_overrides[get_job_store] = lambda: _BrokenStore()
        try:
            with TestClient(app) as started:
                assert started.get("/health").json() == {"status": "ok"}
        finally:
            app.dependency_overrides.clear()

    def test_in_memory_store_only_fails_pending_jobs_created_before_the_cutoff(self):
        store = InMemoryTranscriptionJobStore()
        cutoff = datetime.now(timezone.utc)
        before, after, done_before = (store.create(MEETING, ORG_A) for _ in range(3))
        before.created_at = cutoff - timedelta(seconds=1)
        after.created_at = cutoff + timedelta(seconds=1)  # 이 프로세스가 만든 작업
        done_before.created_at = cutoff - timedelta(seconds=1)
        store.complete(done_before.job_id, {"ok": True})

        assert store.fail_pending_created_before(cutoff, _GENERIC_FAILURE) == 1
        assert [before.status, after.status, done_before.status] == ["error", "pending", "done"]
