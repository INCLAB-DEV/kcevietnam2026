"""OpenAIStructurer + factory 배선 테스트 (AI 스택 OpenAI 통일, 2026-09).

실 HTTP 호출은 하지 않는다 — OpenAI() 클라이언트 생성 자체는 네트워크를 타지 않으므로 키
검증(fail-closed)은 그대로 확인하고, API 응답 파싱은 client.chat.completions.create 를
더블로 치환해 검증한다(``ClaudeStructurer`` 시절 패턴과 동일하게 얇게 감싼 파싱 로직만 겨냥).
"""

from __future__ import annotations

import json
from types import SimpleNamespace

import pytest

from app.config import Settings
from app.domain.review_capture import FitRating
from app.services.factory import build_structurer
from app.services.structuring import FakeStructurer, OpenAIStructurer


def test_openai_structurer_requires_api_key() -> None:
    with pytest.raises(RuntimeError, match="OPENAI 키 없음"):
        OpenAIStructurer("")


def _fake_response(payload: dict) -> SimpleNamespace:
    message = SimpleNamespace(content=json.dumps(payload))
    choice = SimpleNamespace(message=message)
    return SimpleNamespace(choices=[choice])


def test_openai_structurer_parses_response_into_structured_result() -> None:
    structurer = OpenAIStructurer("sk-test", model="gpt-5.4-mini")
    payload = {
        "discussion": ["A사 방산 부품 수출 조건 논의"],
        "agreements": ["샘플 발송 후 재협의"],
        "actions": ["다음 주까지 견적서 전달"],
        "fit_suggestion": "good",
        "fit_reason_seed": "생산능력·인증 모두 적합",
        "fit_reason_tags": ["생산능력", "인증·규격"],
        "transcript_turns": [
            {"who": "us", "text": "안녕하세요"},
            {"who": "them", "text": "네 반갑습니다"},
        ],
    }
    captured: dict = {}

    def fake_create(**kwargs):
        captured.update(kwargs)
        return _fake_response(payload)

    structurer._client.chat.completions.create = fake_create  # type: ignore[attr-defined]

    result = structurer.structure("미팅 전사 텍스트", counterpart_org="B사")

    assert result.report.discussion == payload["discussion"]
    assert result.report.agreements == payload["agreements"]
    assert result.report.actions == payload["actions"]
    assert result.fit_suggestion == FitRating.GOOD
    assert result.fit_reason_seed == payload["fit_reason_seed"]
    assert result.fit_reason_tags == payload["fit_reason_tags"]
    assert [t.who for t in result.transcript_turns] == ["us", "them"]

    # 모델·structured outputs 계약이 실제로 실려 나가는지 확인.
    assert captured["model"] == "gpt-5.4-mini"
    assert captured["response_format"]["type"] == "json_schema"
    assert captured["response_format"]["json_schema"]["strict"] is True
    assert "B사" in captured["messages"][1]["content"]


def test_build_structurer_openai_backend_wires_openai_structurer() -> None:
    settings = Settings(
        structurer_backend="openai",
        openai_api_key="sk-test",
        structurer_model="gpt-5.4-mini",
    )
    structurer = build_structurer(settings)
    assert isinstance(structurer, OpenAIStructurer)
    assert structurer._model == "gpt-5.4-mini"  # type: ignore[attr-defined]


def test_build_structurer_fake_backend_default() -> None:
    settings = Settings(structurer_backend="fake")
    assert isinstance(build_structurer(settings), FakeStructurer)
