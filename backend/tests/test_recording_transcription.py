"""녹음 전처리·조각 전사(2026-10-02) — 긴 녹음이 조용히 잘리지 않게 ffmpeg로 줄이고 5분 조각으로 나눠 전사한다.

배경(운영 모델 gpt-4o-transcribe 실측): 1400초 넘는 녹음은 거부, 20분짜리는 앞 8분만 전사되고 나머지가 조용히
빠졌다. 5분 조각으로 나누면 끝까지 나왔다. 길이가 조각 길이의 배수면 ffmpeg가 0.02초짜리 빈 꼬리 조각을 만들어
OpenAI가 400을 냈다.

잠그는 것:
- ffmpeg 명령(모노·16kHz PCM WAV, 조각 길이, 타임스탬프 리셋, 상한 + 1초까지만 변환)과 분할 목록 해석,
  1초 미만 조각 건너뛰기, 변환 결과 합계로 보는 길이 상한(길이 정보 없는 녹음 대비) — 가짜 실행기로.
- 조각을 순서대로 하나씩 전사해 이어 붙인다. ffprobe 길이가 상한을 넘으면 변환·전사 없이 거절. 조각을 보내기
  전마다 실행 마감을 확인한다. 임시 디렉터리는 성공·실패와 무관하게 지운다. 잘림 의심은 경고 로그(내용 없이).
- 작업 단위: 길이 초과는 '너무 길다' 고정 문구(폴링 응답에 그대로), 마감 초과는 일반 실패 문구.
- 실제 ffmpeg(없으면 skip): 11분 → 300/300/60초 3조각, 정확히 10분 → 빈 꼬리 없이 2조각, 길이 메타데이터 없는
  webm도 상한을 넘으면 거절.
"""

from __future__ import annotations

import logging
import shutil
import subprocess
import tempfile
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.api import reviews
from app.api.deps import (
    get_audio_preprocessor,
    get_job_store,
    get_repository,
    get_storage,
    get_structurer,
    get_transcriber,
)
from app.auth.principal import get_current_principal
from app.config import settings
from app.domain.review_provenance_binding import MatchingType
from app.main import app
from app.repositories.base import MeetingView
from app.repositories.memory import InMemoryRepository
from app.services.ai_concurrency import shutdown_ai_workers
from app.services.audio_preprocessing import (
    AudioChunk,
    AudioPreprocessError,
    AudioTooLongError,
    FfmpegAudioPreprocessor,
    PassthroughAudioPreprocessor,
)
from app.services.recording_transcription import (
    WORKDIR_PREFIX,
    TranscriptionDeadlineExceeded,
    transcribe_recording,
)
from app.services.storage import FakeStorage
from app.services.structuring import FakeStructurer
from app.services.transcription import FakeTranscriber
from app.services.transcription_jobs import (
    TRANSCRIPTION_FAILED_MESSAGE,
    InMemoryTranscriptionJobStore,
    audio_too_long_message,
)
from tests.conftest import header_principal

HAS_FFMPEG = shutil.which("ffmpeg") is not None and shutil.which("ffprobe") is not None
needs_ffmpeg = pytest.mark.skipif(not HAS_FFMPEG, reason="ffmpeg/ffprobe 미설치 — 실 변환 테스트 skip")
# 실제 오디오는 pytest tmp_path(최근 실행 몇 개를 남겨 둔다)가 아니라 테스트가 끝나면 지워지는 임시 디렉터리에
# 만든다 — 생성한 녹음 파일을 남기지 않는다. isolated_tmp가 tempfile.tempdir를 바꿔도 영향받지 않게 미리 잡아 둔다.
_SYSTEM_TMP = tempfile.gettempdir()


@pytest.fixture
def audio_dir():
    with tempfile.TemporaryDirectory(prefix="nabi-test-audio-", dir=_SYSTEM_TMP) as workdir:
        yield Path(workdir)


# =============================================================================
# 가짜 실행기 — ffmpeg 대신 조각 파일과 분할 목록(csv)을 만들어 준다
# =============================================================================
class _FakeRunner:
    """subprocess 실행기 대역. ffprobe에는 정해 둔 stdout을, ffmpeg에는 정해 둔 조각들을 디스크에 써 준다."""

    def __init__(self, *, probe_stdout: bytes = b"660.000000\n", segments=(), returncode: int = 0,
                 stderr: bytes = b"", raises: BaseException | None = None) -> None:
        self.probe_stdout = probe_stdout
        self.segments = list(segments)  # [(파일명, 시작초, 끝초)]
        self.returncode = returncode
        self.stderr = stderr
        self.raises = raises
        self.calls: list[tuple[list[str], float]] = []

    def __call__(self, cmd, timeout):
        cmd = list(cmd)
        self.calls.append((cmd, timeout))
        if self.raises is not None:
            raise self.raises
        tool = Path(next(c for c in cmd if c.endswith(("ffmpeg", "ffprobe")))).name
        if tool == "ffprobe":
            return subprocess.CompletedProcess(cmd, self.returncode, stdout=self.probe_stdout, stderr=self.stderr)
        if self.returncode == 0:
            listing = Path(cmd[cmd.index("-segment_list") + 1])
            out_dir = listing.parent
            rows = []
            for name, start, end in self.segments:
                (out_dir / name).write_bytes(f"mp3:{name}".encode())
                rows.append(f"{name},{start:.6f},{end:.6f}")
            listing.write_text("\n".join(rows) + "\n", encoding="utf-8")
        return subprocess.CompletedProcess(cmd, self.returncode, stdout=b"", stderr=self.stderr)


def _split(runner, tmp_path, *, chunk_seconds=300, max_seconds=3600):
    source = tmp_path / "source.m4a"
    source.write_bytes(b"\x00" * 16)
    pre = FfmpegAudioPreprocessor(timeout_seconds=123, runner=runner, lower_priority=False)
    return pre.split(source, tmp_path / "chunks", chunk_seconds=chunk_seconds, max_seconds=max_seconds)


class TestFfmpegCommandAndSegmentList:
    def test_converts_to_mono_16k_pcm_wav_segments_capped_at_max_plus_one_second(self, audio_dir):
        runner = _FakeRunner(segments=[("chunk-000.wav", 0, 300.024), ("chunk-001.wav", 300.024, 360.0)])
        chunks = _split(runner, audio_dir, chunk_seconds=300, max_seconds=3600)

        (cmd, timeout), = runner.calls
        assert timeout == 123  # ffmpeg 상한(config.transcription_ffmpeg_timeout_seconds)
        joined = " ".join(cmd)
        for flag in (
            "-nostdin", "-vn", "-map 0:a:0", "-ac 1", "-ar 16000", "-c:a pcm_s16le",
            "-t 3601", "-f segment", "-segment_time 300", "-reset_timestamps 1", "-segment_list_type csv",
        ):
            assert flag in joined, flag
        assert cmd[-1].endswith("chunk-%03d.wav")
        assert [(c.path.name, c.index) for c in chunks] == [("chunk-000.wav", 0), ("chunk-001.wav", 1)]
        assert chunks[0].duration_seconds == pytest.approx(300.024)

    def test_runs_at_lower_cpu_priority_when_nice_is_available(self, audio_dir):
        if shutil.which("nice") is None:
            pytest.skip("nice 없음")
        runner = _FakeRunner(segments=[("chunk-000.wav", 0, 10.0)])
        source = audio_dir / "source.m4a"
        source.write_bytes(b"\x00")
        FfmpegAudioPreprocessor(runner=runner).split(source, audio_dir / "c", chunk_seconds=300, max_seconds=60)
        cmd = runner.calls[0][0]
        assert Path(cmd[0]).name == "nice" and cmd[1:3] == ["-n", "10"]

    def test_empty_trailing_segment_is_skipped(self, audio_dir):
        """정확히 10분 녹음 → ffmpeg가 0.057초짜리 꼬리 조각을 만든다(실측) — 보내면 OpenAI 400이라 건너뛴다."""
        runner = _FakeRunner(segments=[
            ("chunk-000.wav", 0.0, 300.024),
            ("chunk-001.wav", 300.024, 600.012),
            ("chunk-002.wav", 600.012, 600.069),
        ])
        chunks = _split(runner, audio_dir)
        assert [c.path.name for c in chunks] == ["chunk-000.wav", "chunk-001.wav"]
        assert [c.index for c in chunks] == [0, 1]

    def test_only_sub_second_audio_is_an_error(self, audio_dir):
        runner = _FakeRunner(segments=[("chunk-000.wav", 0.0, 0.4)])
        with pytest.raises(AudioPreprocessError):
            _split(runner, audio_dir)

    def test_converted_total_over_limit_is_too_long(self, audio_dir):
        """길이 정보가 없는 녹음(브라우저 webm)도 변환 결과 합계로 상한을 판정한다 — '상한 + 1초'에서 잘려 온다."""
        runner = _FakeRunner(segments=[("chunk-000.wav", 0.0, 30.0), ("chunk-001.wav", 30.0, 61.0)])
        with pytest.raises(AudioTooLongError) as excinfo:
            _split(runner, audio_dir, chunk_seconds=30, max_seconds=60)
        assert excinfo.value.max_seconds == 60

    def test_frame_rounding_at_the_limit_is_not_too_long(self, audio_dir):
        runner = _FakeRunner(segments=[("chunk-000.wav", 0.0, 30.0), ("chunk-001.wav", 30.0, 60.07)])
        assert len(_split(runner, audio_dir, chunk_seconds=30, max_seconds=60)) == 2

    def test_listed_chunk_missing_on_disk_is_an_error(self, audio_dir):
        class _NoFiles(_FakeRunner):
            def __call__(self, cmd, timeout):
                result = super().__call__(cmd, timeout)
                for f in Path(cmd[cmd.index("-segment_list") + 1]).parent.glob("chunk-*.wav"):
                    f.unlink()
                return result

        with pytest.raises(AudioPreprocessError):
            _split(_NoFiles(segments=[("chunk-000.wav", 0.0, 10.0)]), audio_dir)


class TestProbeAndToolFailures:
    def _probe(self, runner, audio_dir):
        source = audio_dir / "source.m4a"
        source.write_bytes(b"\x00")
        return FfmpegAudioPreprocessor(runner=runner, lower_priority=False).probe_duration(source)

    def test_probe_reads_seconds(self, audio_dir):
        assert self._probe(_FakeRunner(probe_stdout=b"660.000000\n"), audio_dir) == pytest.approx(660.0)

    def test_probe_without_duration_metadata_returns_none(self, audio_dir):
        assert self._probe(_FakeRunner(probe_stdout=b"N/A\n"), audio_dir) is None

    @pytest.mark.parametrize(
        "runner",
        [
            _FakeRunner(raises=FileNotFoundError("ffprobe")),
            _FakeRunner(raises=subprocess.TimeoutExpired("ffprobe", 60)),
            _FakeRunner(returncode=1, stderr=b"moov atom not found"),
        ],
        ids=["tool-missing", "timeout", "bad-input"],
    )
    def test_tool_failures_become_preprocess_errors(self, runner, audio_dir):
        with pytest.raises(AudioPreprocessError):
            self._probe(runner, audio_dir)


# =============================================================================
# 조각 전사 흐름 — 가짜 전처리기로 순서·마감·정리·경고를 본다
# =============================================================================
class _ScriptedPreprocessor:
    """정해 둔 길이와 조각들(바이트·길이)을 돌려주는 대역. 조각 파일은 out_dir에 실제로 쓴다."""

    def __init__(self, *, duration: float | None, chunks: list[tuple[bytes, float | None]]) -> None:
        self.duration = duration
        self.chunk_specs = chunks
        self.split_calls = 0
        self.source_seen: Path | None = None

    def probe_duration(self, path: Path) -> float | None:
        self.source_seen = path
        return self.duration

    def split(self, path, out_dir, *, chunk_seconds, max_seconds):
        self.split_calls += 1
        out_dir.mkdir(parents=True, exist_ok=True)
        chunks = []
        for i, (data, duration) in enumerate(self.chunk_specs):
            chunk_path = out_dir / f"chunk-{i:03d}.wav"
            chunk_path.write_bytes(data)
            chunks.append(AudioChunk(path=chunk_path, index=i, duration_seconds=duration))
        return chunks


class _RecordingTranscriber:
    def __init__(self, texts: dict[bytes, str] | None = None, fail_on: bytes | None = None) -> None:
        self.texts = texts or {}
        self.fail_on = fail_on
        self.calls: list[tuple[str, bytes, str]] = []
        self.workdir_snapshots: list[list[str]] = []

    def transcribe(self, audio_bytes, *, filename, language="ko"):
        self.calls.append((filename, audio_bytes, language))
        if audio_bytes == self.fail_on:
            raise RuntimeError("전사 실패(테스트)")
        return self.texts.get(audio_bytes, audio_bytes.decode(errors="replace"))


def _stored(data: bytes = b"original-recording") -> tuple[FakeStorage, str]:
    storage = FakeStorage()
    key = "meetings/event-1/meeting-1/org-1/abc-meeting.m4a"
    storage.put(key, data)
    return storage, key


def _run(storage, key, pre, transcriber, *, deadline=float("inf"), clock=time.monotonic, max_seconds=3600):
    return transcribe_recording(
        storage, key, filename="회의 녹음.m4a", language="ko", transcriber=transcriber, preprocessor=pre,
        chunk_seconds=300, max_audio_seconds=max_seconds, deadline=deadline, clock=clock, job_id="job-test",
    )


@pytest.fixture
def isolated_tmp(tmp_path, monkeypatch):
    """작업 임시 디렉터리가 이 테스트 전용 경로에 생기게 한다 — 끝나고 남은 게 있는지 본다."""
    root = tmp_path / "tmp"
    root.mkdir()
    monkeypatch.setattr(tempfile, "tempdir", str(root))
    return root


def _leftover_workdirs(root: Path) -> list[Path]:
    return [p for p in root.iterdir() if p.name.startswith(WORKDIR_PREFIX)]


class TestChunkedTranscription:
    def test_chunks_are_transcribed_in_order_and_joined(self, isolated_tmp):
        storage, key = _stored()
        pre = _ScriptedPreprocessor(duration=660, chunks=[(b"one", 300), (b"two", 300), (b"three", 60)])
        transcriber = _RecordingTranscriber()

        transcript = _run(storage, key, pre, transcriber)

        assert transcript == "one\ntwo\nthree"
        assert [(name, data) for name, data, _ in transcriber.calls] == [
            ("chunk-000.wav", b"one"), ("chunk-001.wav", b"two"), ("chunk-002.wav", b"three"),
        ]
        assert all(lang == "ko" for _, _, lang in transcriber.calls)
        # 원본은 저장소에서 임시 파일로 내려받아 전처리기에 넘긴다(확장자는 힌트로 남긴다).
        assert pre.source_seen is not None and pre.source_seen.name == "source.m4a"
        assert _leftover_workdirs(isolated_tmp) == []

    def test_empty_chunk_texts_are_not_joined_as_blank_lines(self, isolated_tmp):
        storage, key = _stored()
        pre = _ScriptedPreprocessor(duration=None, chunks=[(b"a", 10), (b"silence", 10), (b"b", 10)])
        transcriber = _RecordingTranscriber(texts={b"silence": "   "})
        assert _run(storage, key, pre, transcriber) == "a\nb"

    def test_recording_longer_than_limit_by_probe_is_rejected_before_converting(self, isolated_tmp):
        storage, key = _stored()
        pre = _ScriptedPreprocessor(duration=3601, chunks=[(b"x", 300)])
        transcriber = _RecordingTranscriber()

        with pytest.raises(AudioTooLongError):
            _run(storage, key, pre, transcriber, max_seconds=3600)

        assert pre.split_calls == 0  # 변환(CPU)도
        assert transcriber.calls == []  # 전사(OpenAI 비용)도 하지 않는다
        assert _leftover_workdirs(isolated_tmp) == []

    def test_deadline_is_checked_before_every_chunk(self, isolated_tmp):
        """마감을 넘기면 다음 조각을 보내지 않는다 — 이미 보낸 조각은 끝까지 기다린 뒤다."""
        storage, key = _stored()
        pre = _ScriptedPreprocessor(duration=900, chunks=[(b"one", 300), (b"two", 300), (b"three", 300)])
        transcriber = _RecordingTranscriber()
        now = {"t": 1000.0}

        class _AdvancingTranscriber(_RecordingTranscriber):
            def transcribe(self, audio_bytes, *, filename, language="ko"):
                now["t"] += 400  # 조각 하나에 400초 걸렸다
                return super().transcribe(audio_bytes, filename=filename, language=language)

        transcriber = _AdvancingTranscriber()
        with pytest.raises(TranscriptionDeadlineExceeded):
            _run(storage, key, pre, transcriber, deadline=1000.0 + 600, clock=lambda: now["t"])

        # 1번(1000초, 마감 전) → 2번(1400초, 마감 전) → 3번 전 1800초 > 1600초: 3번은 보내지 않았다.
        assert [name for name, _, _ in transcriber.calls] == ["chunk-000.wav", "chunk-001.wav"]
        assert _leftover_workdirs(isolated_tmp) == []

    def test_workdir_is_removed_when_a_chunk_fails(self, isolated_tmp):
        storage, key = _stored()
        pre = _ScriptedPreprocessor(duration=600, chunks=[(b"one", 300), (b"boom", 300)])
        with pytest.raises(RuntimeError, match="전사 실패"):
            _run(storage, key, pre, _RecordingTranscriber(fail_on=b"boom"))
        assert _leftover_workdirs(isolated_tmp) == []

    def test_original_is_deleted_right_after_splitting(self, isolated_tmp):
        """원본(최대 200MB)은 조각을 만든 직후 지운다 — 조각을 전사하는 수 분 동안 디스크를 덜 쓴다."""
        storage, key = _stored()
        pre = _ScriptedPreprocessor(duration=60, chunks=[(b"one", 60)])
        seen: list[bool] = []

        class _Probe(_RecordingTranscriber):
            def transcribe(self, audio_bytes, *, filename, language="ko"):
                seen.append(pre.source_seen.exists())
                return super().transcribe(audio_bytes, filename=filename, language=language)

        _run(storage, key, pre, _Probe())
        assert seen == [False]

    def test_suspiciously_short_chunk_logs_a_warning_without_content(self, isolated_tmp, caplog, monkeypatch):
        monkeypatch.setattr(logging.getLogger("app.services.recording_transcription"), "disabled", False)
        caplog.set_level(logging.WARNING, logger="app.services.recording_transcription")
        storage, key = _stored()
        long_text = "가" * 1500  # 300초 조각에 1500자 — 정상
        pre = _ScriptedPreprocessor(duration=600, chunks=[(b"ok", 300), (b"cut", 300), (b"tail", 30)])
        transcriber = _RecordingTranscriber(texts={b"ok": long_text, b"cut": "기밀 짧은 문장", b"tail": "끝"})

        _run(storage, key, pre, transcriber)

        warnings = [r for r in caplog.records if "짧다" in r.getMessage()]
        assert len(warnings) == 1  # 300초에 8자인 2번 조각만(30초 꼬리는 기준 미만이라 보지 않는다)
        message = warnings[0].getMessage()
        assert "job-test" in message and "2/3" in message
        assert "기밀" not in message  # 회의 내용은 로그에 남기지 않는다


# =============================================================================
# 작업 단위 — 길이 초과 고정 문구 / 마감 초과 일반 문구 (라우트 → 전사 풀 → 폴링)
# =============================================================================
MEETING = "meeting-1"
ORG = "org-exhibitor"


@pytest.fixture
def job_client():
    shutdown_ai_workers(wait=False)
    repo = InMemoryRepository()
    repo.add_meeting(
        MeetingView(
            meeting_id=MEETING, event_id="event-1", exhibitor_org_id=ORG, buyer_org_id="org-buyer",
            matching_type=MatchingType.AI, ai_score=0.9, ai_score_reasons=[],
        )
    )
    store = InMemoryTranscriptionJobStore()
    app.dependency_overrides[get_repository] = lambda: repo
    app.dependency_overrides[get_job_store] = lambda: store
    app.dependency_overrides[get_storage] = lambda: FakeStorage()
    app.dependency_overrides[get_transcriber] = lambda: FakeTranscriber()
    app.dependency_overrides[get_structurer] = lambda: FakeStructurer()
    app.dependency_overrides[get_current_principal] = header_principal
    yield TestClient(app)
    app.dependency_overrides.clear()
    shutdown_ai_workers(wait=False)


def _submit_and_settle(client) -> dict:
    resp = client.post(
        f"/meetings/{MEETING}/review/step2/transcribe",
        files={"audio": ("meeting.m4a", b"\x00fake", "audio/m4a")},
        headers={"X-Org-Id": ORG},
    )
    assert resp.status_code == 202
    job_id = resp.json()["job_id"]
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        polled = client.get(
            f"/meetings/{MEETING}/review/step2/transcribe/{job_id}", headers={"X-Org-Id": ORG}
        ).json()
        if polled["status"] != "pending":
            return polled
        time.sleep(0.01)
    raise AssertionError("작업이 끝나지 않았다")


class TestJobOutcomes:
    def test_too_long_recording_fails_with_a_fixed_message_the_user_sees(self, job_client):
        app.dependency_overrides[get_audio_preprocessor] = lambda: PassthroughAudioPreprocessor(
            duration_seconds=settings.transcription_max_audio_seconds + 1
        )
        polled = _submit_and_settle(job_client)
        assert polled["status"] == "error"
        assert polled["error"] == audio_too_long_message(settings.transcription_max_audio_seconds)
        assert "최대 45분" in polled["error"]

    def test_deadline_exceeded_fails_with_the_generic_message(self, job_client, monkeypatch):
        app.dependency_overrides[get_audio_preprocessor] = lambda: PassthroughAudioPreprocessor()
        ticks = iter([0.0, 0.0, 0.0])  # 접수 / 대기 확인 / 마감 기준 — 그 뒤로는 마감을 넘긴 시각
        monkeypatch.setattr(
            reviews, "_clock",
            lambda: next(ticks, settings.transcription_job_deadline_seconds + 1),
        )
        polled = _submit_and_settle(job_client)
        assert polled == {
            "status": "error",
            "draft": None,
            "error": TRANSCRIPTION_FAILED_MESSAGE,
            "error_code": "failed",
        }

    def test_deadline_passing_during_the_last_chunk_still_structures_the_finished_transcript(
        self, job_client, monkeypatch
    ):
        """교차리뷰 H4 — 마감은 조각을 **시작**할지만 가른다. 마지막 조각을 보내는 사이 마감이 지나도, 전사가 끝까지
        끝났으면 구조화해 작업을 완료한다(예전엔 구조화 직전에 마감을 다시 봐서 다 만든 전사문을 버렸다)."""
        deadline = settings.transcription_job_deadline_seconds
        now = {"t": 0.0}
        monkeypatch.setattr(reviews, "_clock", lambda: now["t"])

        class _SlowTranscriber(_RecordingTranscriber):
            def transcribe(self, audio_bytes, *, filename, language="ko"):
                # 조각마다 마감의 2/3씩 걸린다 — 1번(0초 시작)·2번(400초 시작)은 마감 전에 시작하고,
                # 2번이 끝나면 800초로 마감(600초)을 넘긴다.
                now["t"] += deadline * 2 / 3
                return super().transcribe(audio_bytes, filename=filename, language=language)

        structured: list[str] = []

        class _SpyStructurer(FakeStructurer):
            def structure(self, raw_text, *, counterpart_org=""):
                structured.append(raw_text)
                return super().structure(raw_text, counterpart_org=counterpart_org)

        pre = _ScriptedPreprocessor(duration=600, chunks=[(b"first half", 300), (b"second half", 300)])
        app.dependency_overrides[get_audio_preprocessor] = lambda: pre
        app.dependency_overrides[get_transcriber] = lambda: _SlowTranscriber()
        app.dependency_overrides[get_structurer] = lambda: _SpyStructurer()

        polled = _submit_and_settle(job_client)

        assert now["t"] > deadline  # 마감은 실제로 지났다
        assert structured == ["first half\nsecond half"]  # 그래도 구조화는 했다
        assert polled["status"] == "done"
        assert polled["draft"]["transcript"] == "first half\nsecond half"

    def test_chunked_transcript_flows_into_the_draft(self, job_client):
        pre = _ScriptedPreprocessor(duration=600, chunks=[(b"first half", 300), (b"second half", 300)])
        app.dependency_overrides[get_audio_preprocessor] = lambda: pre
        app.dependency_overrides[get_transcriber] = lambda: _RecordingTranscriber()
        polled = _submit_and_settle(job_client)
        assert polled["status"] == "done"
        assert polled["draft"]["transcript"] == "first half\nsecond half"


# =============================================================================
# 실제 ffmpeg — 없으면 skip(백엔드 이미지·로컬엔 있다)
# =============================================================================
def _tone(path: Path, seconds: int, *, extra: list[str] | None = None) -> Path:
    cmd = [
        "ffmpeg", "-hide_banner", "-nostdin", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", f"sine=frequency=440:sample_rate=8000:duration={seconds}",
        *(extra or ["-ac", "1", "-c:a", "pcm_s16le"]),
        str(path),
    ]
    subprocess.run(cmd, check=True, timeout=120)
    return path


@needs_ffmpeg
class TestRealFfmpeg:
    def test_eleven_minutes_becomes_300_300_60_and_is_transcribed_end_to_end(self, audio_dir, isolated_tmp):
        wav = _tone(audio_dir / "eleven.wav", 660)
        storage = FakeStorage()
        with open(wav, "rb") as fh:
            storage.put_fileobj("meetings/event-1/m/o/x-eleven.wav", fh)

        class _NamedTranscriber(_RecordingTranscriber):
            def transcribe(self, audio_bytes, *, filename, language="ko"):
                super().transcribe(audio_bytes, filename=filename, language=language)
                return f"{filename}:{len(audio_bytes)}"

        named = _NamedTranscriber()
        transcript = transcribe_recording(
            storage, "meetings/event-1/m/o/x-eleven.wav", filename="eleven.wav", language="ko",
            transcriber=named, preprocessor=FfmpegAudioPreprocessor(), chunk_seconds=300,
            max_audio_seconds=3600, deadline=float("inf"), job_id="real-ffmpeg",
        )

        names = [name for name, _, _ in named.calls]
        assert names == ["chunk-000.wav", "chunk-001.wav", "chunk-002.wav"]
        sizes = [len(data) for _, data, _ in named.calls]
        # 16kHz·16bit·모노 PCM = 32,000바이트/초 — 5분 ≈ 9.6MB(OpenAI 25MB 상한 안), 1분 ≈ 1.92MB(빈 조각 없음).
        assert 9_500_000 < sizes[0] < 9_700_000 and 9_500_000 < sizes[1] < 9_700_000
        assert 1_900_000 < sizes[2] < 1_950_000
        assert transcript.count("\n") == 2
        assert _leftover_workdirs(isolated_tmp) == []

    def test_chunk_durations_and_format(self, audio_dir):
        wav = _tone(audio_dir / "eleven.wav", 660)
        pre = FfmpegAudioPreprocessor()
        chunks = pre.split(wav, audio_dir / "chunks", chunk_seconds=300, max_seconds=3600)
        assert [round(c.duration_seconds) for c in chunks] == [300, 300, 60]
        probe = subprocess.run(
            ["ffprobe", "-v", "error", "-select_streams", "a:0",
             "-show_entries", "stream=codec_name,channels,sample_rate", "-of", "csv=p=0", str(chunks[0].path)],
            capture_output=True, text=True, check=True,
        )
        assert probe.stdout.strip() == "pcm_s16le,16000,1"
        assert pre.probe_duration(wav) == pytest.approx(660, abs=0.1)
        # 경계가 샘플 단위로 정확해야 한다 — MP3로 자르던 때는 두 번째 조각이 0.256초에서 시작해 앞 약 0.22초가
        # 잘렸다(운영 ffmpeg 7.1.5 실측, 경계마다 첫 음절 누락). WAV 조각은 0초에서 시작하고 길이가 정확하다.
        total = 0.0
        for c in chunks:
            start, dur = subprocess.run(
                ["ffprobe", "-v", "error", "-show_entries", "format=start_time,duration", "-of", "csv=p=0", str(c.path)],
                capture_output=True, text=True, check=True,
            ).stdout.strip().split(",")
            assert float(start if start not in ("", "N/A") else 0) < 0.01
            total += float(dur)
        # 조각 길이 합이 원본과 같아야 경계에서 잃은 소리가 없다(경계 위치가 수십 ms 밀리는 건 손실이 아니다).
        assert total == pytest.approx(660, abs=0.05)

    def test_exact_multiple_of_chunk_length_has_no_empty_tail(self, audio_dir):
        wav = _tone(audio_dir / "ten.wav", 600)
        chunks = FfmpegAudioPreprocessor().split(wav, audio_dir / "chunks", chunk_seconds=300, max_seconds=3600)
        assert [round(c.duration_seconds) for c in chunks] == [300, 300]

    def test_webm_without_duration_metadata_over_the_limit_is_rejected(self, audio_dir):
        encoders = subprocess.run(
            ["ffmpeg", "-hide_banner", "-encoders"], capture_output=True, text=True, check=True
        ).stdout
        if "libopus" not in encoders:
            pytest.skip("libopus 인코더 없음")
        webm = audio_dir / "live.webm"
        # 파이프로 써서 길이 메타데이터가 없는 webm을 만든다(브라우저 MediaRecorder 녹음과 같은 상태).
        with open(webm, "wb") as out:
            subprocess.run(
                ["ffmpeg", "-hide_banner", "-nostdin", "-loglevel", "error", "-f", "lavfi",
                 "-i", "sine=frequency=300:sample_rate=48000:duration=75", "-ac", "1",
                 "-c:a", "libopus", "-b:a", "24k", "-f", "webm", "pipe:1"],
                stdout=out, check=True, timeout=120,
            )
        pre = FfmpegAudioPreprocessor()
        assert pre.probe_duration(webm) is None
        with pytest.raises(AudioTooLongError):
            pre.split(webm, audio_dir / "chunks", chunk_seconds=30, max_seconds=60)
        # 상한 안이면 같은 파일도 그대로 조각난다.
        chunks = pre.split(webm, audio_dir / "chunks-ok", chunk_seconds=30, max_seconds=120)
        assert [round(c.duration_seconds) for c in chunks] == [30, 30, 15]

    def test_garbage_input_is_a_preprocess_error(self, audio_dir):
        junk = audio_dir / "junk.m4a"
        junk.write_bytes(b"\x00" * 64)
        pre = FfmpegAudioPreprocessor()
        with pytest.raises(AudioPreprocessError):
            pre.probe_duration(junk)
        with pytest.raises(AudioPreprocessError):
            pre.split(junk, audio_dir / "chunks", chunk_seconds=300, max_seconds=3600)
