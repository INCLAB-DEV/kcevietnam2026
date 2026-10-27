"""전사(transcription) — 녹음 조각 → 텍스트.

구조화 모델(OpenAI Chat Completions)은 오디오를 직접 처리하지 못하므로 전사는 별도 엔진을 쓴다. 메모리(정확도 우선 —
속도 위해 다운그레이드 금지)에 따라 기본값은 OpenAI Whisper large(whisper-1)로 두고,
self-host 시 large-v3 등으로 교체한다. 테스트/로컬은 FakeTranscriber 로 외부호출 없이 동작.

녹음 파일을 통째로 받지 않는다 — 전사 작업이 ffmpeg로 바꾸고 자른 **조각**(기본 5분 WAV)을 하나씩 넘긴다
(app.services.recording_transcription). 그래서 여기 타임아웃은 조각 하나 기준이다(config 주석).
"""

from __future__ import annotations

import time
from typing import Protocol

from app.services.openai_clients import shared_openai_client


class Transcriber(Protocol):
    def transcribe(self, audio_bytes: bytes, *, filename: str, language: str = "ko") -> str:
        """오디오 바이트를 텍스트로 전사한다."""
        ...


class FakeTranscriber:
    """외부 호출 없는 결정적 전사 — 테스트/로컬/데모용.

    미리 주입한 스크립트가 있으면 그걸, 없으면 파일명 기반 placeholder 를 돌려준다.
    ``latency_seconds``(부하 테스트용, config.fake_ai_latency_seconds)를 주면 호출마다 그만큼 잔다 — 느린 OpenAI를
    흉내 내 대기열·스레드 점유를 재현한다. 기본 0이면 자지 않는다.
    """

    def __init__(self, scripted: str | None = None, *, latency_seconds: float = 0) -> None:
        self._scripted = scripted
        self._latency = latency_seconds

    def transcribe(self, audio_bytes: bytes, *, filename: str, language: str = "ko") -> str:
        if self._latency > 0:
            time.sleep(self._latency)
        if self._scripted is not None:
            return self._scripted
        return f"[전사 placeholder] {filename} ({len(audio_bytes)} bytes)"


class OpenAIWhisperTranscriber:
    """OpenAI Whisper 전사 (large = whisper-1). 키는 backend 에만(ADR-0008).

    openai 패키지는 optional-extra(infra). 미설치/미설정 시 명확히 실패한다(조용한 폴백 금지).
    """

    def __init__(
        self,
        api_key: str,
        model: str = "whisper-1",
        *,
        timeout: float = 120.0,
        max_retries: int = 1,
    ) -> None:
        if not api_key:
            raise RuntimeError("OPENAI 키 없음 — Whisper 전사를 쓸 수 없습니다")
        # 클라이언트는 프로세스 공유본(전사용 — 긴 타임아웃)을 쓴다. 기본값은 config와 같고 실제 값은
        # factory가 settings에서 넘긴다(openai_clients 모듈 docstring 참고).
        try:
            self._client = shared_openai_client(
                "transcription", api_key=api_key, timeout=timeout, max_retries=max_retries
            )
        except ModuleNotFoundError as exc:  # pragma: no cover - infra extra
            raise RuntimeError(
                "openai 미설치 — `uv pip install '.[infra]'` 후 사용하세요"
            ) from exc
        self._model = model

    def transcribe(self, audio_bytes: bytes, *, filename: str, language: str = "ko") -> str:  # pragma: no cover - 외부호출
        import io

        buf = io.BytesIO(audio_bytes)
        buf.name = filename  # OpenAI SDK 가 확장자로 포맷 판별
        result = self._client.audio.transcriptions.create(
            model=self._model, file=buf, language=language
        )
        return result.text
