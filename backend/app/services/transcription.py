"""전사(transcription) — 녹음 파일 → 텍스트.

구조화 모델(OpenAI Chat Completions)은 오디오를 직접 처리하지 못하므로 전사는 별도 엔진을 쓴다. 메모리(정확도 우선 —
속도 위해 다운그레이드 금지)에 따라 기본값은 OpenAI Whisper large(whisper-1)로 두고,
self-host 시 large-v3 등으로 교체한다. 테스트/로컬은 FakeTranscriber 로 외부호출 없이 동작.
"""

from __future__ import annotations

from typing import Protocol


class Transcriber(Protocol):
    def transcribe(self, audio_bytes: bytes, *, filename: str, language: str = "ko") -> str:
        """오디오 바이트를 텍스트로 전사한다."""
        ...


class FakeTranscriber:
    """외부 호출 없는 결정적 전사 — 테스트/로컬/데모용.

    미리 주입한 스크립트가 있으면 그걸, 없으면 파일명 기반 placeholder 를 돌려준다.
    """

    def __init__(self, scripted: str | None = None) -> None:
        self._scripted = scripted

    def transcribe(self, audio_bytes: bytes, *, filename: str, language: str = "ko") -> str:
        if self._scripted is not None:
            return self._scripted
        return f"[전사 placeholder] {filename} ({len(audio_bytes)} bytes)"


class OpenAIWhisperTranscriber:
    """OpenAI Whisper 전사 (large = whisper-1). 키는 backend 에만(ADR-0008).

    openai 패키지는 optional-extra(infra). 미설치/미설정 시 명확히 실패한다(조용한 폴백 금지).
    """

    def __init__(self, api_key: str, model: str = "whisper-1") -> None:
        if not api_key:
            raise RuntimeError("OPENAI 키 없음 — Whisper 전사를 쓸 수 없습니다")
        try:
            from openai import OpenAI
        except ModuleNotFoundError as exc:  # pragma: no cover - infra extra
            raise RuntimeError(
                "openai 미설치 — `uv pip install '.[infra]'` 후 사용하세요"
            ) from exc
        self._client = OpenAI(api_key=api_key)
        self._model = model

    def transcribe(self, audio_bytes: bytes, *, filename: str, language: str = "ko") -> str:  # pragma: no cover - 외부호출
        import io

        buf = io.BytesIO(audio_bytes)
        buf.name = filename  # OpenAI SDK 가 확장자로 포맷 판별
        result = self._client.audio.transcriptions.create(
            model=self._model, file=buf, language=language
        )
        return result.text
