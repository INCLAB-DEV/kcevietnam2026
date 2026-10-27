"""구조화(structuring) — raw 전사/메모 → 보고문서 3섹션 + Fit 제안.

PRD D4: AI 는 요약이 아니라 능동 작성 도우미. 미팅 내용을 핵심 논의사항/합의 사항/후속 액션
으로 구조화하고, 동시에 Fit Assessment(잘맞음/보통/안맞음)를 추론해 *제안*한다(사용자 검수 전).
AI 키는 backend 에만(ADR-0008). OpenAI Chat Completions + structured outputs(json_schema)를 쓴다.
"""

from __future__ import annotations

import json
import logging
import time
from dataclasses import dataclass, field
from typing import Protocol

from app.domain.review_capture import FitRating, ReportSections
from app.services.openai_clients import shared_openai_client

logger = logging.getLogger(__name__)

# Fit 사유 시드 카테고리 (PRD D10) — AI 사후 태깅의 출발점. 사용자 입력을 가두지 않는다.
FIT_REASON_SEED_CATEGORIES = [
    "예산",
    "기술 성숙도",
    "도입 시기",
    "생산능력",
    "인증·규격",
    "제품 적합성",
    "보안등급",
    "수출통제",
]

_OUTPUT_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "discussion": {"type": "array", "items": {"type": "string"}},
        "agreements": {"type": "array", "items": {"type": "string"}},
        "actions": {"type": "array", "items": {"type": "string"}},
        "fit_suggestion": {"type": "string", "enum": ["good", "normal", "bad"]},
        "fit_reason_seed": {"type": "string"},
        "fit_reason_tags": {"type": "array", "items": {"type": "string"}},
        # 화자별 전사 turns — 텍스트 기반 AI 추정(음성 diarization 아님). who: us(업로더 본인 기업)/them(상대).
        "transcript_turns": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "who": {"type": "string", "enum": ["us", "them"]},
                    "text": {"type": "string"},
                },
                "required": ["who", "text"],
            },
        },
    },
    "required": [
        "discussion",
        "agreements",
        "actions",
        "fit_suggestion",
        "fit_reason_seed",
        "fit_reason_tags",
        "transcript_turns",
    ],
}

_SYSTEM = """당신은 K-콘텐츠 전시회 비즈매칭 미팅의 내부 보고문서 작성을 돕는 어시스턴트입니다.
참가사/바이어가 입력한 미팅 내용(녹음 전사본 또는 메모)을 다음 세 섹션으로 구조화하세요.

- discussion(핵심 논의사항): 어떤 제품·기술·요구사항을 논의했는가
- agreements(합의 사항): 무엇을 합의·약속했는가
- actions(후속 액션): 다음에 누가 무엇을 언제까지 하기로 했는가

각 섹션은 간결한 항목들의 배열입니다. 입력에 없는 내용을 지어내지 마세요.

또한 미팅 내용에서 상대 기업과의 적합도(Fit Assessment)를 추론해 *제안*하세요:
- fit_suggestion: good(잘맞음)/normal(보통)/bad(안맞음)
- fit_reason_seed: 그렇게 본 근거를 한두 문장으로 (사용자가 검수·수정할 초안)
- fit_reason_tags: 근거에 해당하는 카테고리들 (시드: 예산, 기술 성숙도, 도입 시기, 생산능력,
  인증·규격, 제품 적합성, 보안등급, 수출통제). 해당 없으면 빈 배열.

Fit 관련 출력은 비공개 내부 판단이며 보고문서 본문에는 들어가지 않습니다.

마지막으로 전사 원문을 화자별 turns 로 추정·라벨링하세요(transcript_turns):
- who: us(입력을 올린 우리 기업/본인 측 발화) 또는 them(상대 기업 발화).
- text: 해당 발화의 원문 그대로(요약·교정 금지). 화자가 바뀔 때마다 새 turn 으로 나눕니다.
이는 음성 분리(diarization)가 아니라 **텍스트 기반 AI 추정**입니다. 화자가 불분명하면 맥락으로
추정하되 원문 내용은 바꾸지 마세요. 입력이 한 덩어리 메모라면 의미 단위로 나눠 추정하세요."""


@dataclass(frozen=True)
class TranscriptTurn:
    """화자별 전사 한 발화. who 는 AI 텍스트 추정(us=본인 기업/them=상대). 비공개(업로더 전용)."""

    who: str  # "us" | "them"
    text: str


@dataclass(frozen=True)
class StructuredResult:
    """구조화 결과 — 보고 본문(공개 가능) + Fit 제안 + 화자별 전사(둘 다 비공개, 사용자 검수 전)."""

    report: ReportSections
    fit_suggestion: FitRating | None
    fit_reason_seed: str
    fit_reason_tags: list[str]
    transcript_turns: list[TranscriptTurn] = field(default_factory=list)


class Structurer(Protocol):
    def structure(self, raw_text: str, *, counterpart_org: str = "") -> StructuredResult:
        ...


def _to_result(payload: dict) -> StructuredResult:
    fit_raw = payload.get("fit_suggestion")
    try:
        fit = FitRating(fit_raw) if fit_raw else None
    except ValueError:
        fit = None
    return StructuredResult(
        report=ReportSections(
            discussion=list(payload.get("discussion", [])),
            agreements=list(payload.get("agreements", [])),
            actions=list(payload.get("actions", [])),
        ),
        fit_suggestion=fit,
        fit_reason_seed=payload.get("fit_reason_seed", ""),
        fit_reason_tags=list(payload.get("fit_reason_tags", [])),
        transcript_turns=[
            TranscriptTurn(who=t.get("who", "us"), text=t.get("text", ""))
            for t in payload.get("transcript_turns", [])
            if t.get("text")
        ],
    )


class FakeStructurer:
    """결정적 구조화 — 외부호출 없이 테스트/데모. 주입 payload 가 있으면 그걸 사용.

    ``latency_seconds``(부하 테스트용, config.fake_ai_latency_seconds)를 주면 호출마다 그만큼 잔다. 기본 0.
    """

    def __init__(self, payload: dict | None = None, *, latency_seconds: float = 0) -> None:
        self._payload = payload
        self._latency = latency_seconds

    def structure(self, raw_text: str, *, counterpart_org: str = "") -> StructuredResult:
        if self._latency > 0:
            time.sleep(self._latency)
        if self._payload is not None:
            return _to_result(self._payload)
        # raw_text 를 줄 단위로 나눠 단순 분배(데모/테스트용 placeholder).
        lines = [ln.strip() for ln in raw_text.splitlines() if ln.strip()] or [raw_text.strip()]
        return StructuredResult(
            report=ReportSections(
                discussion=lines[:1] or [],
                agreements=lines[1:2],
                actions=lines[2:3],
            ),
            fit_suggestion=FitRating.NORMAL,
            fit_reason_seed="(데모) 입력 기반 자동 제안",
            fit_reason_tags=["제품 적합성"],
            # 데모 화자 추정 — 줄 단위로 us/them 교대(실제론 OpenAI 구조화 모델이 맥락 기반 추정).
            transcript_turns=[
                TranscriptTurn(who="us" if i % 2 == 0 else "them", text=ln)
                for i, ln in enumerate(lines)
            ],
        )


class OpenAIStructurer:
    """OpenAI 구조화 + Fit 제안. Chat Completions + structured outputs(json_schema, strict)."""

    def __init__(
        self,
        api_key: str,
        model: str = "gpt-5.4-mini",
        *,
        timeout: float = 180.0,
        max_retries: int = 0,
    ) -> None:
        if not api_key:
            raise RuntimeError("OPENAI 키 없음 — OpenAI 구조화를 쓸 수 없습니다")
        # 클라이언트는 프로세스 공유본(채팅용)을 쓴다 — 공유 캐시는 타임아웃·재시도별로 갈리므로 러브콜 초안
        # (60초·재시도 1)·전사 작업 구조화(300초·재시도 0)와 섞이지 않는다. 기본값은 config와 같고 실제 값은
        # factory가 settings에서 넘긴다(openai_clients 모듈 docstring 참고).
        try:
            self._client = shared_openai_client(
                "chat", api_key=api_key, timeout=timeout, max_retries=max_retries
            )
        except ModuleNotFoundError as exc:  # pragma: no cover - infra extra
            raise RuntimeError(
                "openai 미설치 — `uv pip install '.[infra]'` 후 사용하세요"
            ) from exc
        self._api_key = api_key
        self._model = model

    def with_limits(self, *, timeout: float, max_retries: int) -> OpenAIStructurer:
        """같은 키·모델로 타임아웃·재시도만 바꾼 구조화기(클라이언트는 그 설정의 공유본)."""
        return OpenAIStructurer(self._api_key, self._model, timeout=timeout, max_retries=max_retries)

    def structure(self, raw_text: str, *, counterpart_org: str = "") -> StructuredResult:  # pragma: no cover - 외부호출
        prefix = f"상대 기업: {counterpart_org}\n\n" if counterpart_org else ""
        response = self._client.chat.completions.create(
            model=self._model,
            messages=[
                {"role": "system", "content": _SYSTEM},
                {"role": "user", "content": f"{prefix}미팅 내용:\n{raw_text}"},
            ],
            response_format={
                "type": "json_schema",
                "json_schema": {
                    "name": "structured_meeting",
                    "schema": _OUTPUT_SCHEMA,
                    "strict": True,
                },
            },
        )
        logger.info("openai usage structure model=%s usage=%s", self._model, getattr(response, "usage", None))
        text = response.choices[0].message.content or "{}"
        return _to_result(json.loads(text))


def for_full_transcript(structurer: Structurer, *, timeout: float, max_retries: int) -> Structurer:
    """녹음 전사 작업용 구조화기 — 전사 원문 전체를 transcript_turns로 다시 출력해 텍스트 메모 정리보다 훨씬
    오래 걸린다(30분 회의면 수천~1만 토큰). 텍스트 구조화 상한을 그대로 쓰면 긴 회의에서 타임아웃으로 잘린다.

    OpenAI 구조화기는 같은 모델·키로 타임아웃·재시도만 전사 작업용으로 바꾼 인스턴스로 바꾸고, 그런 개념이 없는
    구현(fake·테스트 대역)은 그대로 돌려준다 — ``get_structurer``를 override한 테스트 대역이 전사 작업까지 그대로
    흐른다.
    """
    if isinstance(structurer, OpenAIStructurer):
        return structurer.with_limits(timeout=timeout, max_retries=max_retries)
    return structurer
