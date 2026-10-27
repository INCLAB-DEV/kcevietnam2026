"""부하 테스트용 AI 지연 스텁(FAKE_AI_LATENCY_SECONDS) — fake 전사기·구조화기에만 걸린다.

잠그는 것:
- 기본 0초 — 설정하지 않으면 fake도 자지 않는다(테스트·로컬 속도 그대로).
- fake일 때는 호출마다 설정한 만큼 잔다(전사는 조각마다, 구조화는 호출마다).
- openai 어댑터는 이 설정을 받지 않는다 — 값을 크게 줘도 운영 경로에는 아무 영향이 없다.
- 환경변수 이름은 ``FAKE_AI_LATENCY_SECONDS``다(접두사 없음).
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from app.config import Settings
from app.services import structuring, transcription
from app.services.factory import build_structurer, build_transcriber
from app.services.openai_clients import reset_shared_clients
from app.services.structuring import FakeStructurer, OpenAIStructurer
from app.services.transcription import FakeTranscriber, OpenAIWhisperTranscriber


@pytest.fixture
def sleeps(monkeypatch) -> list[float]:
    recorded: list[float] = []
    monkeypatch.setattr(transcription.time, "sleep", recorded.append)
    monkeypatch.setattr(structuring.time, "sleep", recorded.append)
    return recorded


@pytest.fixture(autouse=True)
def _fresh_clients():
    reset_shared_clients()
    yield
    reset_shared_clients()


def _settings(**overrides) -> Settings:
    return Settings(_env_file=None, **overrides)


def test_default_is_zero_and_fakes_do_not_sleep(sleeps):
    s = _settings()
    assert s.fake_ai_latency_seconds == 0
    build_transcriber(s).transcribe(b"x", filename="chunk-000.mp3")
    build_structurer(s).structure("메모")
    assert sleeps == []


def test_fake_adapters_sleep_per_call(sleeps):
    s = _settings(fake_ai_latency_seconds=2.5)
    transcriber = build_transcriber(s)
    structurer = build_structurer(s)
    assert isinstance(transcriber, FakeTranscriber) and isinstance(structurer, FakeStructurer)

    for i in range(3):  # 조각 3개
        transcriber.transcribe(b"x", filename=f"chunk-00{i}.mp3")
    structurer.structure("전사문")

    assert sleeps == [2.5, 2.5, 2.5, 2.5]


def test_env_var_name(monkeypatch):
    monkeypatch.setenv("FAKE_AI_LATENCY_SECONDS", "1.5")
    assert Settings(_env_file=None).fake_ai_latency_seconds == 1.5


def test_negative_latency_is_rejected():
    with pytest.raises(ValueError):
        _settings(fake_ai_latency_seconds=-1)


def test_openai_adapters_ignore_the_latency_setting(sleeps):
    s = _settings(
        transcriber_backend="openai",
        structurer_backend="openai",
        openai_api_key="sk-test-fake-latency",
        fake_ai_latency_seconds=30,
    )
    transcriber = build_transcriber(s)
    structurer = build_structurer(s)
    assert isinstance(transcriber, OpenAIWhisperTranscriber) and isinstance(structurer, OpenAIStructurer)

    # 네트워크 직전만 대역으로 — 실제 호출 경로(transcribe/structure)를 그대로 태운다.
    transcriber._client = SimpleNamespace(
        audio=SimpleNamespace(transcriptions=SimpleNamespace(create=lambda **kw: SimpleNamespace(text="전사")))
    )
    payload = (
        '{"discussion": [], "agreements": [], "actions": [], "fit_suggestion": "normal", '
        '"fit_reason_seed": "", "fit_reason_tags": [], "transcript_turns": []}'
    )
    structurer._client = SimpleNamespace(
        chat=SimpleNamespace(
            completions=SimpleNamespace(
                create=lambda **kw: SimpleNamespace(
                    choices=[SimpleNamespace(message=SimpleNamespace(content=payload))]
                )
            )
        )
    )

    assert transcriber.transcribe(b"x", filename="chunk-000.mp3") == "전사"
    structurer.structure("전사")
    assert sleeps == []  # 운영(openai) 경로는 지연 스텁과 무관하다
