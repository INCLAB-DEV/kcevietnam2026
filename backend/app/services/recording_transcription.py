"""녹음 1건 → 전사문 — 내려받기 → 길이 확인 → 변환·분할 → 조각별 전사 → 순서대로 이어 붙이기.

전사 작업 본체(``app.api.reviews._run_transcription_job``)가 전사 전용 풀 스레드에서 부른다. 조각을 나누는 이유와
변환 형식은 ``app.services.audio_preprocessing`` 참고.

- 원본은 저장소(S3)에서 **임시 디렉터리의 파일**로 내려받는다 — 최대 200MB를 메모리에 올리지 않는다. 전사기에는
  조각(5분 ≈ 9.6MB WAV)만 바이트로 넘긴다.
- 조각은 차례대로 하나씩 보낸다(작업 하나가 OpenAI 동시 호출을 여러 개 쥐지 않게 — 동시성은 전사 풀 크기가 정한다).
  보내기 전마다 작업 실행 마감(``deadline``)을 확인해 넘었으면 ``TranscriptionDeadlineExceeded``로 멈춘다.
- 임시 디렉터리는 성공·실패·예외와 무관하게 항상 지운다(``TemporaryDirectory``). 원본은 조각을 만든 직후 먼저
  지워, 조각을 전사하는 동안(수 분) 디스크를 덜 쓴다.
"""

from __future__ import annotations

import logging
import tempfile
import time
from collections.abc import Callable
from pathlib import Path

from app.services.audio_preprocessing import AudioChunk, AudioPreprocessor, AudioTooLongError

logger = logging.getLogger(__name__)

# 작업 임시 디렉터리 이름 접두사 — 운영 중 남은 게 있는지(정리 누락) 눈으로 찾기 쉽게.
WORKDIR_PREFIX = "nabi-transcribe-"

# 잘림 의심 경고 기준 — 조각 길이 대비 글자 수가 이보다 적으면 로그로 남긴다(전사 결과는 그대로 쓴다). 한국어
# 대화는 보통 초당 4~7자다. 통째 전사가 앞 8분만 남기고 조용히 잘렸던 것(2026-10-02 실측) 같은 일이 조각
# 단위에서 다시 생기면 알아챌 수 있게 한다. 짧은 조각(마지막 자투리)과 무음 구간은 오탐이 나므로 1분 이상만 본다.
_SUSPICIOUS_CHARS_PER_SECOND = 1.0
_SUSPICIOUS_MIN_CHUNK_SECONDS = 60.0

# 원본 임시 파일 확장자 길이 상한 — 확장자는 사람이 로그로 볼 때의 힌트일 뿐(ffmpeg는 내용으로 형식을 판별한다).
_MAX_SUFFIX_CHARS = 10


class TranscriptionDeadlineExceeded(RuntimeError):
    """작업 실행 마감(config.transcription_job_deadline_seconds)을 넘겼다 — 다음 조각·구조화를 시작하지 않는다."""


def check_deadline(deadline: float, clock: Callable[[], float], *, job_id: str, step: str) -> None:
    """``clock()``이 마감을 넘었으면 ``TranscriptionDeadlineExceeded``. 조각을 보내기 전마다 부른다(구조화 전엔
    부르지 않는다 — 전사가 끝났으면 구조화는 항상 한다, reviews._run_transcription_job)."""
    now = clock()
    if now > deadline:
        raise TranscriptionDeadlineExceeded(
            f"전사 작업 실행 마감 초과 — {step} 전에 {now - deadline:.0f}초 지남 (job_id={job_id})"
        )


def _source_suffix(filename: str) -> str:
    suffix = Path(filename).suffix
    return suffix if 1 < len(suffix) <= _MAX_SUFFIX_CHARS and suffix[1:].isalnum() else ""


def _warn_if_suspiciously_short(text: str, chunk: AudioChunk, total: int, job_id: str) -> None:
    duration = chunk.duration_seconds
    if duration is None or duration < _SUSPICIOUS_MIN_CHUNK_SECONDS:
        return
    chars = len(text.strip())
    if chars < duration * _SUSPICIOUS_CHARS_PER_SECOND:
        # 전사 내용은 로그에 남기지 않는다(회의 내용) — 길이만.
        logger.warning(
            "조각 전사가 길이에 비해 짧다 — 잘림 또는 무음 가능성 (job_id=%s, 조각 %d/%d, %.0f초, %d자)",
            job_id,
            chunk.index + 1,
            total,
            duration,
            chars,
        )


def transcribe_recording(
    storage,
    audio_key: str,
    *,
    filename: str,
    language: str,
    transcriber,
    preprocessor: AudioPreprocessor,
    chunk_seconds: float,
    max_audio_seconds: float,
    deadline: float,
    clock: Callable[[], float] = time.monotonic,
    job_id: str = "",
) -> str:
    """보관된 녹음 하나를 조각내 전사하고, 조각 전사문을 순서대로 이어 붙여 돌려준다.

    Raises:
        AudioTooLongError: 녹음이 ``max_audio_seconds``를 넘는다(ffprobe 길이, 또는 변환 결과 합계).
        TranscriptionDeadlineExceeded: 조각을 보내기 전 ``clock()``이 ``deadline``을 넘었다.
        그 밖의 예외(저장소·ffmpeg·전사기)는 그대로 올라간다 — 호출부가 고정 실패 문구로 바꾼다.
    """
    started = clock()
    with tempfile.TemporaryDirectory(prefix=WORKDIR_PREFIX, ignore_cleanup_errors=True) as workdir:
        work = Path(workdir)
        source = work / f"source{_source_suffix(filename)}"
        storage.download_to_file(audio_key, source)

        duration = preprocessor.probe_duration(source)
        if duration is not None and duration > max_audio_seconds:
            raise AudioTooLongError(duration, max_audio_seconds)

        chunks = preprocessor.split(
            source, work / "chunks", chunk_seconds=chunk_seconds, max_seconds=max_audio_seconds
        )
        if all(chunk.path != source for chunk in chunks):
            source.unlink(missing_ok=True)

        texts: list[str] = []
        for chunk in chunks:
            check_deadline(
                deadline, clock, job_id=job_id, step=f"조각 {chunk.index + 1}/{len(chunks)} 전사"
            )
            text = transcriber.transcribe(
                chunk.path.read_bytes(), filename=chunk.path.name, language=language
            )
            _warn_if_suspiciously_short(text, chunk, len(chunks), job_id)
            texts.append(text.strip())

    transcript = "\n".join(t for t in texts if t)
    logger.info(
        "녹음 전사 완료 (job_id=%s, 조각 %d개, 길이 %s초, %d자, %.1f초 걸림)",
        job_id,
        len(chunks),
        f"{duration:.0f}" if duration is not None else "?",
        len(transcript),
        clock() - started,
    )
    return transcript
