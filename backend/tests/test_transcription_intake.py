"""녹음 접수(2026-10-02) — 상한 200MB로 올리면서 메모리·대기열이 폭주하지 않게 묶은 장치들을 잠근다.

잠그는 것:
- 업로드는 통째로 메모리에 올리지 않는다: 저장소에는 ``read(n)``으로 당겨 가는 스트림이 넘어가고, 크기를 모르는
  업로드도 상한 + 1바이트를 넘게 읽지 않고 413으로 끊는다(반쯤 쓴 원본은 남지 않는다).
- S3 키 = ``meetings/{event_id}/{meeting_id}/{org_id}/{uuid}-{파일명}`` — 행사별 수명주기 규칙이 걸리게 행사 ID가
  맨 앞, 파일명은 경로 구분자·제어문자를 바꾸고 80자로 자른다(확장자 유지) — 키가 S3 상한(1024바이트)을 넘지 않는다.
- 업로드 동시 처리 상한·대기열 깊이 상한을 넘으면 S3에 올리기 전에 503 ``ai_busy``. 접수가 어디서 실패하든
  잡아 둔 대기열 칸은 돌려준다. 작업이 끝나면 칸이 비어 다시 받는다.
- 폴링 응답의 실패 문구: 저장값 중 '녹음이 너무 길다' 고정 문구만 그대로, 나머지(예전 원문 등)는 일반 문구.
"""

from __future__ import annotations

import io
import threading
import time

import pytest
from fastapi.testclient import TestClient
from starlette.datastructures import Headers, UploadFile

from app.api import reviews
from app.api.deps import (
    get_audio_preprocessor,
    get_job_store,
    get_repository,
    get_storage,
    get_structurer,
    get_transcriber,
)
from app.auth.principal import Principal, get_current_principal
from app.config import settings
from app.domain.review_provenance_binding import MatchingType
from app.main import app
from app.repositories.base import MeetingView
from app.repositories.memory import InMemoryRepository
from app.services import ai_concurrency
from app.services.ai_concurrency import shutdown_ai_workers, transcription_upload_slot
from app.services.audio_preprocessing import PassthroughAudioPreprocessor
from app.services.storage import FakeStorage
from app.services.structuring import FakeStructurer
from app.services.transcription import FakeTranscriber
from app.services.transcription_jobs import (
    TRANSCRIPTION_FAILED_MESSAGE,
    InMemoryTranscriptionJobStore,
    audio_too_long_message,
)
from tests.conftest import header_principal

ORG = "org-exhibitor"
MEETING = "meeting-1"
EVENT = "event-1"
GATE_TIMEOUT = 10


@pytest.fixture(autouse=True)
def _fresh_ai_workers():
    shutdown_ai_workers(wait=False)
    yield
    shutdown_ai_workers(wait=False)


@pytest.fixture
def repo() -> InMemoryRepository:
    r = InMemoryRepository()
    r.add_meeting(
        MeetingView(
            meeting_id=MEETING, event_id=EVENT, exhibitor_org_id=ORG, buyer_org_id="org-buyer",
            matching_type=MatchingType.AI, ai_score=0.9, ai_score_reasons=[],
        )
    )
    return r


@pytest.fixture
def job_store() -> InMemoryTranscriptionJobStore:
    return InMemoryTranscriptionJobStore()


class _CountingStorage(FakeStorage):
    def __init__(self) -> None:
        super().__init__()
        self.put_calls = 0

    def put_fileobj(self, key, fileobj, *, content_type="application/octet-stream"):
        self.put_calls += 1
        return super().put_fileobj(key, fileobj, content_type=content_type)


@pytest.fixture
def storage() -> _CountingStorage:
    return _CountingStorage()


@pytest.fixture
def client(repo, job_store, storage):
    app.dependency_overrides[get_repository] = lambda: repo
    app.dependency_overrides[get_job_store] = lambda: job_store
    app.dependency_overrides[get_storage] = lambda: storage
    app.dependency_overrides[get_transcriber] = lambda: FakeTranscriber()
    app.dependency_overrides[get_structurer] = lambda: FakeStructurer()
    app.dependency_overrides[get_audio_preprocessor] = lambda: PassthroughAudioPreprocessor()
    app.dependency_overrides[get_current_principal] = header_principal
    yield TestClient(app, raise_server_exceptions=False)
    app.dependency_overrides.clear()


def _upload(client, data: bytes = b"\x00" * 32, name: str = "meeting.m4a"):
    return client.post(
        f"/meetings/{MEETING}/review/step2/transcribe",
        files={"audio": (name, data, "audio/m4a")},
        headers={"X-Org-Id": ORG},
    )


def _poll(client, job_id) -> dict:
    return client.get(
        f"/meetings/{MEETING}/review/step2/transcribe/{job_id}", headers={"X-Org-Id": ORG}
    ).json()


def _wait_until(predicate, timeout=5.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.01)
    return predicate()


# =============================================================================
# 스트리밍 — 통째로 메모리에 올리지 않는다
# =============================================================================
class _RecordingFile(io.BytesIO):
    """밑단 업로드 파일 — 몇 바이트씩 읽혔는지 기록한다. ``seekable=False``면 크기를 잴 수 없는 스트림이 된다."""

    def __init__(self, payload: bytes, *, seekable: bool = True) -> None:
        super().__init__(payload)
        self._can_seek = seekable
        self.read_sizes: list[int | None] = []
        self.bytes_read = 0

    def read(self, size: int | None = -1) -> bytes:
        self.read_sizes.append(size)
        chunk = super().read(size)
        self.bytes_read += len(chunk)
        return chunk

    def seek(self, *args):
        if not self._can_seek:
            raise io.UnsupportedOperation("seek")
        return super().seek(*args)

    def tell(self):
        if not self._can_seek:
            raise io.UnsupportedOperation("tell")
        return super().tell()


class _DummySession:
    """라우트가 업로드 전에 부르는 ``release_connection``을 받는 최소 세션 — 이 더블은 아무것도 쓰지 않는다.

    ``new``·``dirty``·``deleted``·``info``는 ``release_connection``이 놓기 전에 "커밋하지 않은 쓰기"가 없는지 보는
    자리라 전부 비어 있다(app.db._has_unsaved_writes).
    """

    new = dirty = deleted = ()

    @property
    def info(self) -> dict:
        return {}

    def close(self) -> None:
        pass


def _call_route(upload: UploadFile, *, storage, job_store, repo):
    """라우트 함수를 직접 부른다 — TestClient(multipart 파서)는 항상 크기를 기록하므로, '크기를 모르는 업로드'는
    이렇게만 재현된다."""
    return reviews.transcribe_and_structure(
        meeting_id=MEETING,
        audio=upload,
        language="ko",
        principal=Principal(member_id="m-1", organization_id=ORG),
        repo=repo,
        transcriber=FakeTranscriber(),
        structurer=FakeStructurer(),
        storage=storage,
        preprocessor=PassthroughAudioPreprocessor(),
        job_store=job_store,
        db=_DummySession(),
    )


class TestStreamingUpload:
    def test_upload_of_unknown_size_is_capped_while_streaming(self, monkeypatch, repo, job_store, storage):
        monkeypatch.setattr(settings, "transcription_max_upload_bytes", 1000)
        raw = _RecordingFile(b"\x01" * 50_000, seekable=False)
        upload = UploadFile(file=raw, size=None, filename="meeting.m4a",
                            headers=Headers({"content-type": "audio/m4a"}))

        with pytest.raises(reviews.HTTPException) as excinfo:
            _call_route(upload, storage=storage, job_store=job_store, repo=repo)

        assert excinfo.value.status_code == 413
        assert excinfo.value.detail["code"] == "audio_too_large"
        assert raw.bytes_read <= 1001  # 50KB를 끝까지 읽지 않았다
        assert storage._objects == {}  # 반쯤 쓴 원본은 남지 않는다
        assert job_store._jobs == {}
        assert ai_concurrency.queued_transcriptions() == 0  # 대기열 칸도 돌려줬다

    def test_known_size_over_limit_is_rejected_without_reading(self, monkeypatch, repo, job_store, storage):
        monkeypatch.setattr(settings, "transcription_max_upload_bytes", 1000)
        raw = _RecordingFile(b"\x01" * 5_000, seekable=False)
        upload = UploadFile(file=raw, size=5_000, filename="meeting.m4a")

        with pytest.raises(reviews.HTTPException) as excinfo:
            _call_route(upload, storage=storage, job_store=job_store, repo=repo)

        assert excinfo.value.status_code == 413
        assert raw.read_sizes == []
        assert storage.put_calls == 0

    def test_size_is_measured_by_seeking_when_parser_did_not_record_it(self, monkeypatch, repo, job_store, storage):
        monkeypatch.setattr(settings, "transcription_max_upload_bytes", 1000)
        raw = _RecordingFile(b"\x01" * 5_000, seekable=True)
        upload = UploadFile(file=raw, size=None, filename="meeting.m4a")

        with pytest.raises(reviews.HTTPException):
            _call_route(upload, storage=storage, job_store=job_store, repo=repo)

        assert raw.read_sizes == []  # 끝 위치로 쟀다 — 본문은 읽지 않았다
        assert storage.put_calls == 0

    def test_accepted_upload_is_streamed_to_storage_in_bounded_reads(self, repo, job_store, storage):
        payload = bytes(range(256)) * 12_000  # 약 3MB
        raw = _RecordingFile(payload)
        upload = UploadFile(file=raw, size=None, filename="meeting.m4a",
                            headers=Headers({"content-type": "audio/m4a"}))

        accepted = _call_route(upload, storage=storage, job_store=job_store, repo=repo)

        assert accepted.status == "pending"
        # 저장소가 조금씩 당겨 갔다 — 크기 없는 read()(=통째로) 호출이 없고, 한 번에 1MB + 1바이트를 넘지 않는다.
        assert raw.read_sizes and all(s is not None and 0 < s <= 1024 * 1024 + 1 for s in raw.read_sizes)
        assert len(raw.read_sizes) >= 3
        (key,) = storage._objects
        assert storage.get(key) == payload  # 바이트는 그대로 보관됐다
        assert _wait_until(lambda: job_store.get(accepted.job_id).status == "done")

    def test_route_hands_storage_a_stream_not_bytes(self, client, monkeypatch):
        received: list[object] = []

        class _TypeSpy(FakeStorage):
            def put_fileobj(self, key, fileobj, *, content_type="application/octet-stream"):
                received.append(fileobj)
                return super().put_fileobj(key, fileobj, content_type=content_type)

        spy = _TypeSpy()
        app.dependency_overrides[get_storage] = lambda: spy
        assert _upload(client).status_code == 202
        (fileobj,) = received
        assert not isinstance(fileobj, (bytes, bytearray, memoryview))
        assert hasattr(fileobj, "read")


# =============================================================================
# S3 키 — 행사 ID 접두사 + 길이 안전한 파일명
# =============================================================================
class TestAudioKey:
    def test_key_layout_starts_with_event_id(self, client, job_store):
        job_id = _upload(client, name="회의 녹음 2026-10-20.m4a").json()["job_id"]
        assert _wait_until(lambda: _poll(client, job_id)["status"] == "done")
        key = _poll(client, job_id)["draft"]["audio_s3_key"]
        prefix, rest = key.rsplit("/", 1)
        assert prefix == f"meetings/{EVENT}/{MEETING}/{ORG}"
        uid, name = rest.split("-", 1)
        assert len(uid) == 32 and int(uid, 16) >= 0
        assert name == "회의 녹음 2026-10-20.m4a"

    @pytest.mark.parametrize(
        ("filename", "expected"),
        [
            ("a/b\\c.m4a", "a_b_c.m4a"),
            ("line\nbreak\t.m4a", "line_break_.m4a"),
            ("", "recording"),
            (None, "recording"),
            ("   ", "recording"),
            ("정상.wav", "정상.wav"),
        ],
    )
    def test_filename_is_sanitized(self, filename, expected):
        assert reviews._safe_audio_filename(filename) == expected

    def test_long_filename_is_truncated_to_80_chars_keeping_the_extension(self):
        name = reviews._safe_audio_filename("가" * 300 + ".m4a")
        assert len(name) == 80 and name.endswith(".m4a")
        no_ext = reviews._safe_audio_filename("x" * 500)
        assert no_ext == "x" * 80
        weird_ext = reviews._safe_audio_filename("y" * 100 + "." + "z" * 50)
        assert len(weird_ext) == 80

    def test_worst_case_key_fits_s3_limit(self):
        uuid_like = "0" * 36
        key = reviews._audio_key(
            event_id=uuid_like, meeting_id=uuid_like, org_id=uuid_like, filename="😀" * 500 + ".m4a"
        )
        assert len(key.encode("utf-8")) <= 1024
        assert key.startswith(f"meetings/{uuid_like}/{uuid_like}/{uuid_like}/")


# =============================================================================
# 접수 상한 — 업로드 동시 처리 / 대기열 깊이 → 503 ai_busy (S3에 올리기 전)
# =============================================================================
class _GatedTranscriber:
    def __init__(self) -> None:
        self.gate = threading.Event()
        self.started = threading.Semaphore(0)

    def transcribe(self, audio_bytes, *, filename, language="ko"):
        self.started.release()
        self.gate.wait(timeout=GATE_TIMEOUT)
        return "전사"


class TestIntakeLimits:
    def test_upload_slot_limit_returns_503_ai_busy_before_storing(self, client, monkeypatch, storage, job_store):
        monkeypatch.setattr(settings, "transcription_max_concurrent_uploads", 1)
        monkeypatch.setattr(settings, "transcription_upload_acquire_timeout_seconds", 0.05)

        with transcription_upload_slot():  # 다른 업로드가 마지막 자리를 쥐고 S3로 올리는 중
            started = time.monotonic()
            resp = _upload(client)
            elapsed = time.monotonic() - started

        assert resp.status_code == 503
        assert resp.json()["detail"]["code"] == "ai_busy"
        assert elapsed < 2
        assert storage.put_calls == 0 and job_store._jobs == {}
        assert ai_concurrency.queued_transcriptions() == 0  # 잡았던 대기열 칸은 돌려줬다
        # 자리가 나면 같은 업로드가 그대로 접수된다.
        assert _upload(client).status_code == 202

    def test_queue_depth_limit_returns_503_ai_busy_before_storing(self, client, monkeypatch, storage):
        monkeypatch.setattr(settings, "transcription_max_concurrency", 1)
        monkeypatch.setattr(settings, "transcription_max_queue_depth", 2)
        gated = _GatedTranscriber()
        app.dependency_overrides[get_transcriber] = lambda: gated
        try:
            first = _upload(client)
            assert first.status_code == 202
            assert gated.started.acquire(timeout=5)  # 1건은 전사 중
            second = _upload(client)  # 1건은 대기열에서 기다린다
            assert second.status_code == 202
            assert ai_concurrency.queued_transcriptions() == 2

            third = _upload(client)
            assert third.status_code == 503
            assert third.json()["detail"]["code"] == "ai_busy"
            assert storage.put_calls == 2  # 세 번째는 S3에 올리지도 않았다
        finally:
            gated.gate.set()

        jobs = [first.json()["job_id"], second.json()["job_id"]]
        assert _wait_until(lambda: all(_poll(client, j)["status"] == "done" for j in jobs))
        assert _wait_until(lambda: ai_concurrency.queued_transcriptions() == 0)
        assert _upload(client).status_code == 202  # 칸이 비면 다시 받는다

    def test_reservation_is_released_when_storing_fails(self, client):
        class _BrokenStorage(FakeStorage):
            def put_fileobj(self, key, fileobj, *, content_type="application/octet-stream"):
                raise RuntimeError("S3 down")

        app.dependency_overrides[get_storage] = lambda: _BrokenStorage()
        assert _upload(client).status_code == 500
        assert ai_concurrency.queued_transcriptions() == 0

    @pytest.mark.parametrize("failing", ["job_structurer", "submit"])
    def test_reservation_is_released_when_submitting_the_job_fails(self, client, monkeypatch, failing):
        """교차리뷰 LOW — 작업을 풀에 넣는 단계(인자 계산 포함)에서 예외가 나도 대기열 칸이 새지 않는다.

        예전엔 ``reservation.submit(...)``과 그 인자(``for_full_transcript``·``counterpart_of``)가 칸을 돌려주는 try
        밖에 있었다 — 여기서 12번 새면 재시작 전까지 모든 업로드가 503이었다.
        """
        def boom(*args, **kwargs):
            raise RuntimeError(f"{failing} 실패(테스트)")

        if failing == "job_structurer":
            monkeypatch.setattr(reviews, "for_full_transcript", boom)
        else:
            monkeypatch.setattr(ai_concurrency, "submit_transcription", boom)

        for _ in range(3):
            assert _upload(client).status_code == 500
        assert ai_concurrency.queued_transcriptions() == 0

        monkeypatch.undo()
        assert _upload(client).status_code == 202  # 칸이 그대로 남아 있어 다시 받는다

    def test_defaults(self):
        from app.config import Settings

        defaults = Settings(_env_file=None)
        assert defaults.transcription_upload_acquire_timeout_seconds == 15  # 교차리뷰 M1(5 → 15초)
        assert defaults.transcription_max_concurrent_uploads == 4
        assert defaults.transcription_max_queue_depth == 9
        assert defaults.transcription_max_audio_seconds == 2700  # 45분(2026-10-02 결정)
        assert defaults.transcription_chunk_seconds == 300
        assert defaults.openai_transcription_chunk_timeout_seconds == 120
        assert defaults.openai_transcription_max_retries == 1


# =============================================================================
# 폴링 응답의 실패 문구 — 고정 문구만 통과
# =============================================================================
class TestUserFacingError:
    def test_too_long_message_passes_through_and_raw_text_does_not(self, client, job_store):
        too_long = job_store.create(MEETING, ORG)
        job_store.fail(too_long.job_id, audio_too_long_message(settings.transcription_max_audio_seconds))
        legacy = job_store.create(MEETING, ORG)
        job_store.fail(legacy.job_id, "Error code: 401 - Incorrect API key provided: sk-****abcd")

        assert _poll(client, too_long.job_id)["error"] == "녹음이 너무 길어요(최대 45분). 45분 이하로 나눠서 다시 올려 주세요."
        assert _poll(client, legacy.job_id)["error"] == TRANSCRIPTION_FAILED_MESSAGE

    def test_error_code_names_the_failure_kind_for_localized_screens(self, client, job_store):
        """문구는 한국어 고정이라, en 화면은 ``error_code``로 자기 카탈로그 문구를 고른다.

        코드는 문구와 **같은 판정**에서 나온다 — 원문이 새지 않는 것도 같다(레거시 행은 ``failed``).
        """
        too_long = job_store.create(MEETING, ORG)
        job_store.fail(too_long.job_id, audio_too_long_message(settings.transcription_max_audio_seconds))
        legacy = job_store.create(MEETING, ORG)
        job_store.fail(legacy.job_id, "Error code: 401 - Incorrect API key provided: sk-****abcd")
        pending = job_store.create(MEETING, ORG)

        assert _poll(client, too_long.job_id)["error_code"] == "audio_too_long"
        assert _poll(client, legacy.job_id)["error_code"] == "failed"
        # 실패가 아니면 코드도 없다.
        assert _poll(client, pending.job_id)["error_code"] is None
