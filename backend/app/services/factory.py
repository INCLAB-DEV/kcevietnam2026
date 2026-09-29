"""설정 backend 토글로 어댑터를 고른다. 'fake' = 외부호출 없음(로컬/테스트/데모)."""

from __future__ import annotations

from app.config import Settings
from app.config import settings as _SETTINGS
from app.services.storage import FakeStorage, S3Storage, Storage
from app.services.structuring import FakeStructurer, OpenAIStructurer, Structurer
from app.services.transcription import FakeTranscriber, OpenAIWhisperTranscriber, Transcriber


def build_transcriber(settings: Settings | None = None) -> Transcriber:
    s = settings or _SETTINGS
    if s.transcriber_backend == "openai":
        return OpenAIWhisperTranscriber(s.openai_api_key or "", model=s.whisper_model)
    return FakeTranscriber()


def build_structurer(settings: Settings | None = None) -> Structurer:
    s = settings or _SETTINGS
    if s.structurer_backend == "openai":
        return OpenAIStructurer(s.openai_api_key or "", model=s.structurer_model)
    return FakeStructurer()


def build_storage(settings: Settings | None = None) -> Storage:
    s = settings or _SETTINGS
    if s.storage_backend == "s3":
        return S3Storage(s.s3_bucket or "", region=s.aws_region)
    return FakeStorage()
