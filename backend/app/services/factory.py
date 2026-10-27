"""설정 backend 토글로 어댑터를 고른다. 'fake' = 외부호출 없음(로컬/테스트/데모)."""

from __future__ import annotations

from app.config import Settings
from app.config import settings as _SETTINGS
from app.services.audio_preprocessing import AudioPreprocessor, FfmpegAudioPreprocessor
from app.services.storage import FakeStorage, S3Storage, Storage
from app.services.structuring import FakeStructurer, OpenAIStructurer, Structurer
from app.services.transcription import FakeTranscriber, OpenAIWhisperTranscriber, Transcriber


def build_transcriber(settings: Settings | None = None) -> Transcriber:
    s = settings or _SETTINGS
    if s.transcriber_backend == "openai":
        # 녹음은 조각(기본 5분)으로만 보낸다 — 응답 대기는 조각 하나 기준 상한이다(config 주석).
        return OpenAIWhisperTranscriber(
            s.openai_api_key or "",
            model=s.whisper_model,
            timeout=s.openai_transcription_chunk_timeout_seconds,
            max_retries=s.openai_transcription_max_retries,
        )
    # 부하 테스트 지연 스텁은 fake에만 건다 — openai 어댑터는 이 설정을 아예 받지 않는다.
    return FakeTranscriber(latency_seconds=s.fake_ai_latency_seconds)


def build_structurer(settings: Settings | None = None) -> Structurer:
    s = settings or _SETTINGS
    if s.structurer_backend == "openai":
        # 텍스트 메모 구조화용 상한. 전사 작업 안의 구조화는 이 구조화기를 전사 상한으로 바꿔 쓴다
        # (structuring.for_full_transcript, reviews.transcribe_and_structure).
        return OpenAIStructurer(
            s.openai_api_key or "",
            model=s.structurer_model,
            timeout=s.openai_structuring_timeout_seconds,
            max_retries=s.openai_structuring_max_retries,
        )
    return FakeStructurer(latency_seconds=s.fake_ai_latency_seconds)


def build_storage(settings: Settings | None = None) -> Storage:
    s = settings or _SETTINGS
    if s.storage_backend == "s3":
        return S3Storage(s.s3_bucket or "", region=s.aws_region)
    return FakeStorage()


def build_audio_preprocessor(settings: Settings | None = None) -> AudioPreprocessor:
    """녹음 전처리기 — 전사기가 fake여도 항상 실제 ffmpeg를 쓴다(부하 테스트가 변환 CPU 부하까지 재현하도록).

    통째 전사로 돌아가는 토글은 두지 않는다 — 그건 긴 녹음을 조용히 자르던 바로 그 동작이다.
    """
    s = settings or _SETTINGS
    return FfmpegAudioPreprocessor(timeout_seconds=s.transcription_ffmpeg_timeout_seconds)
