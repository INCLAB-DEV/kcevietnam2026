"""녹음 전처리 — ffprobe로 길이를 보고, ffmpeg로 모노 16kHz WAV(PCM)로 바꾸며 일정 길이로 자른다.

왜 자르나(2026-10-02 운영 모델 gpt-4o-transcribe 실측): 1400초가 넘는 녹음은 통째로 거부되고, 20분짜리는
접수되지만 앞 약 8분만 전사된 채 나머지가 **조용히** 빠졌다. 같은 20분을 5분 조각으로 나눠 조각마다 전사하면
끝까지 나왔다. 그래서 전사 작업은 이 모듈로 녹음을 조각낸 뒤 조각별로 전사한다(app.services.
recording_transcription).

변환 결과는 조각 5분 ≈ 9.6MB(16kHz·16bit·모노 PCM)라 원본 크기(최대 200MB)와 무관하게 OpenAI 파일 상한(25MB)
안에 든다(조각을 13분 넘게 잡으면 넘는다).

왜 MP3가 아니라 WAV인가(2026-10-02 운영 ffmpeg 7.1.5 실측): MP3로 자르면 두 번째 조각부터 앞 약 0.22초가
잘려(start_time 0.256s) 경계마다 첫 음절이 빠졌다 — 6분 녹음의 6분째 첫 문장이 전사에서 사라짐. FLAC은 조각에
원래 타임스탬프가 남아 길이 메타데이터가 틀렸다(60초 조각이 360초로 표기) — 길이를 메타데이터로 판정하는
모델이 긴 녹음의 뒤쪽 조각을 거부할 수 있다. PCM WAV는 샘플 단위로 정확히 잘리고(300.0008s/60.0014s) 헤더 길이도
정확하다. ffmpeg는 입력 형식을 확장자가 아니라 내용으로 판별하므로 m4a·mp3·wav·webm·3gp 등을 그대로 받는다.

ffmpeg·ffprobe는 시스템 패키지다(backend/Dockerfile 런타임 단계에서 설치) — 파이썬 의존성이 아니다. 없으면
``AudioPreprocessError``로 실패하고, 작업은 고정 실패 문구로 끝난다(원인은 서버 로그).
"""

from __future__ import annotations

import csv
import logging
import math
import shutil
import subprocess
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

logger = logging.getLogger(__name__)

FFMPEG = "ffmpeg"
FFPROBE = "ffprobe"

# 조각 최소 길이(초). 녹음 길이가 조각 길이의 배수(예: 정확히 10분)면 ffmpeg segment가 길이 0.02초짜리 빈 꼬리
# 조각을 하나 더 만든다 — 그대로 보내면 OpenAI가 400("Audio file might be corrupted or unsupported")을 낸다
# (2026-10-02 실측). 1초 미만 조각은 건너뛴다.
MIN_CHUNK_SECONDS = 1.0

# 변환 목표 — 말소리 전사에 충분한 모노 16kHz, 16bit PCM(WAV). 왜 WAV인지는 모듈 독스트링.
_TARGET_SAMPLE_RATE = 16000
_TARGET_CODEC = "pcm_s16le"

# 길이 판정 여유(초). 변환 결과 합계는 코덱·컨테이너 단위 반올림으로 원래 길이보다 살짝 길게 잡힐 수 있다 — 상한에
# 딱 맞는 녹음이 이 오차로 거절되지 않게 한다. 상한을 실제로 넘는 녹음은 '상한 + 1초'에서 잘려 오므로 확실히 넘는다.
_DURATION_TOLERANCE_SECONDS = 0.5

# ffprobe 1회 상한(초) — 로컬 파일의 헤더만 읽으므로 보통 1초 안이다. 넘으면 비정상 입력으로 본다.
_PROBE_TIMEOUT_SECONDS = 60

# 변환을 낮은 우선순위로 돌린다 — 서버(2 vCPU)에서 같은 CPU를 쓰는 uvicorn·Next·Postgres가 변환 몇 건 때문에
# 굼떠지지 않게. 우선순위를 낮추는 건 권한 없이 된다(컨테이너의 비root 사용자도 가능).
_NICENESS = "10"

SEGMENT_LIST_NAME = "segments.csv"
CHUNK_PATTERN = "chunk-%03d.wav"

Runner = Callable[[Sequence[str], float], subprocess.CompletedProcess]


class AudioPreprocessError(RuntimeError):
    """ffprobe/ffmpeg 실행 실패 — 도구 없음, 시간 초과, 깨진·지원하지 않는 입력, 오디오 스트림 없음 등."""


class AudioTooLongError(Exception):
    """녹음이 길이 상한(config.transcription_max_audio_seconds)을 넘는다 — 사용자에게 고정 문구로 알린다."""

    def __init__(self, duration_seconds: float, max_seconds: float) -> None:
        super().__init__(f"녹음 길이 {duration_seconds:.0f}초 > 상한 {max_seconds:.0f}초")
        self.duration_seconds = duration_seconds
        self.max_seconds = max_seconds


@dataclass(frozen=True)
class AudioChunk:
    """전사에 보낼 조각 하나. ``duration_seconds``가 None이면 길이를 모른다(대역 전처리기)."""

    path: Path
    index: int
    duration_seconds: float | None


class AudioPreprocessor(Protocol):
    def probe_duration(self, path: Path) -> float | None:
        """녹음 길이(초). 컨테이너에 길이 정보가 없으면(브라우저 webm 녹음 등) None."""
        ...

    def split(
        self, path: Path, out_dir: Path, *, chunk_seconds: float, max_seconds: float
    ) -> list[AudioChunk]:
        """전사용으로 변환·분할한 조각들(순서대로). 1초 미만 조각은 빠진다.

        변환 결과의 길이 합계가 ``max_seconds``를 넘으면 ``AudioTooLongError`` — ``probe_duration``이 길이를
        못 준 녹음도 여기서 걸린다.
        """
        ...


def _run(cmd: Sequence[str], timeout: float) -> subprocess.CompletedProcess:
    # stdin을 닫아 둔다 — ffmpeg는 표준입력을 대화형 명령으로 읽으려 해서, 서버 프로세스의 stdin을 물면 멈출 수 있다.
    return subprocess.run(
        list(cmd), stdin=subprocess.DEVNULL, capture_output=True, timeout=timeout, check=False
    )


def _stderr_tail(proc: subprocess.CompletedProcess, limit: int = 500) -> str:
    raw = proc.stderr or b""
    text = raw.decode("utf-8", errors="replace") if isinstance(raw, bytes) else str(raw)
    return text.strip()[-limit:]


class FfmpegAudioPreprocessor:
    """ffprobe/ffmpeg 하위 프로세스로 길이 확인·변환·분할. ``runner``는 테스트가 가짜 실행기로 갈아끼운다."""

    def __init__(
        self,
        *,
        timeout_seconds: float = 300,
        runner: Runner | None = None,
        ffmpeg: str = FFMPEG,
        ffprobe: str = FFPROBE,
        lower_priority: bool = True,
    ) -> None:
        self._timeout = timeout_seconds
        self._runner = runner or _run
        self._ffmpeg = ffmpeg
        self._ffprobe = ffprobe
        nice = shutil.which("nice") if lower_priority else None
        self._nice_prefix: list[str] = [nice, "-n", _NICENESS] if nice else []

    def _exec(self, cmd: list[str], *, timeout: float, what: str) -> subprocess.CompletedProcess:
        try:
            proc = self._runner(cmd, timeout)
        except FileNotFoundError as exc:
            raise AudioPreprocessError(f"{what}: 실행 파일 없음({cmd[0]}) — ffmpeg 설치 확인") from exc
        except subprocess.TimeoutExpired as exc:
            raise AudioPreprocessError(f"{what}: {timeout:.0f}초 안에 끝나지 않았다") from exc
        if proc.returncode != 0:
            raise AudioPreprocessError(f"{what} 실패(exit {proc.returncode}): {_stderr_tail(proc)}")
        return proc

    def probe_duration(self, path: Path) -> float | None:
        cmd = [
            self._ffprobe,
            "-v", "error",
            "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1",
            str(path),
        ]
        proc = self._exec(cmd, timeout=_PROBE_TIMEOUT_SECONDS, what="ffprobe")
        raw = proc.stdout.decode("utf-8", errors="replace") if isinstance(proc.stdout, bytes) else str(proc.stdout)
        text = raw.strip()
        try:
            value = float(text)
        except ValueError:
            return None  # "N/A" — 길이 메타데이터가 없는 컨테이너(MediaRecorder webm 등). split이 대신 판정한다.
        return value if math.isfinite(value) and value > 0 else None

    def split(
        self, path: Path, out_dir: Path, *, chunk_seconds: float, max_seconds: float
    ) -> list[AudioChunk]:
        out_dir.mkdir(parents=True, exist_ok=True)
        listing = out_dir / SEGMENT_LIST_NAME
        cmd = [
            *self._nice_prefix,
            self._ffmpeg,
            "-hide_banner", "-nostdin", "-loglevel", "error", "-y",
            "-i", str(path),
            # 첫 오디오 스트림만(휴대폰 동영상·webm 영상 트랙은 버린다). 오디오가 없으면 ffmpeg가 실패한다.
            "-vn", "-map", "0:a:0",
            "-ac", "1", "-ar", str(_TARGET_SAMPLE_RATE),
            "-c:a", _TARGET_CODEC,
            # 상한 + 1초까지만 변환한다 — 길이 정보가 없는 녹음도 상한을 넘는지 판정할 수 있고, 몇 시간짜리 파일이
            # 들어와도 변환 작업량이 상한 길이로 묶인다.
            "-t", f"{max_seconds + 1:g}",
            "-f", "segment",
            "-segment_time", f"{chunk_seconds:g}",
            # 조각마다 타임스탬프를 0부터 — 조각을 독립된 파일로 전사한다.
            "-reset_timestamps", "1",
            "-segment_list", str(listing),
            "-segment_list_type", "csv",
            str(out_dir / CHUNK_PATTERN),
        ]
        self._exec(cmd, timeout=self._timeout, what="ffmpeg 변환·분할")

        segments = _read_segment_list(listing, out_dir)
        total = sum(duration for _, duration in segments)
        if total > max_seconds + _DURATION_TOLERANCE_SECONDS:
            raise AudioTooLongError(total, max_seconds)

        kept = [(p, d) for p, d in segments if d >= MIN_CHUNK_SECONDS]
        for p, d in segments:
            if d < MIN_CHUNK_SECONDS:
                logger.info("1초 미만 조각 건너뜀 (%s, %.3f초)", p.name, d)
        if not kept:
            raise AudioPreprocessError("변환 결과에 전사할 오디오가 없다(1초 미만)")
        return [AudioChunk(path=p, index=i, duration_seconds=d) for i, (p, d) in enumerate(kept)]


def _read_segment_list(listing: Path, out_dir: Path) -> list[tuple[Path, float]]:
    """ffmpeg segment 목록(csv: ``파일명,시작초,끝초``) → [(조각 경로, 길이초)] — ffmpeg가 만든 순서 그대로."""
    try:
        with open(listing, newline="", encoding="utf-8") as fh:
            rows = [row for row in csv.reader(fh) if row]
    except OSError as exc:
        raise AudioPreprocessError(f"분할 목록을 읽지 못했다: {exc}") from exc
    segments: list[tuple[Path, float]] = []
    for row in rows:
        try:
            name, start, end = row[0], float(row[1]), float(row[2])
        except (IndexError, ValueError) as exc:
            raise AudioPreprocessError(f"분할 목록 형식 오류: {row!r}") from exc
        chunk = out_dir / Path(name).name  # 목록의 이름은 조각 파일명 — 경로가 섞여 와도 이 디렉터리 밖은 보지 않는다
        if not chunk.is_file():
            raise AudioPreprocessError(f"분할 목록의 조각 파일이 없다: {chunk.name}")
        segments.append((chunk, max(0.0, end - start)))
    return segments


class PassthroughAudioPreprocessor:
    """ffmpeg 없이 원본을 조각 하나로 그대로 넘기는 대역 — 테스트용(가짜 오디오 바이트로 라우트·작업 흐름만 볼 때).

    ``duration_seconds``를 주면 그 길이로 보고한다(길이 상한 판정 검증용). 운영 배선(deps.get_audio_preprocessor)
    에는 들어가지 않는다 — 통째 전사는 긴 녹음을 조용히 자르는 바로 그 동작이다.
    """

    def __init__(self, duration_seconds: float | None = None) -> None:
        self._duration = duration_seconds

    def probe_duration(self, path: Path) -> float | None:
        return self._duration

    def split(
        self, path: Path, out_dir: Path, *, chunk_seconds: float, max_seconds: float
    ) -> list[AudioChunk]:
        return [AudioChunk(path=path, index=0, duration_seconds=self._duration)]
