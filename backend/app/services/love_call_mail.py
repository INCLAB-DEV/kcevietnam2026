"""러브콜 메일 초안 — 확정된 회의록만을 근거로 상대 기업에 보낼 후속 제안 메일을 생성한다(#13).

`structuring.OpenAIStructurer` 와 같은 패턴이다: OpenAI Chat Completions + structured outputs
(json_schema, strict). 어댑터 토글도 같은 ``settings.structurer_backend`` / 모델도 같은
``settings.structurer_model`` 을 쓴다 — "회의록을 재료로 쓰는 OpenAI 생성" 이라는 같은 계열의
기능이라 토글을 하나로 유지한다. 전용 env 를 새로 만들면 배포에서 그 변수를 빠뜨렸을 때 기능이
조용히 템플릿 메일로 죽는다(fake 초안은 예외를 던지지 않으므로 아무도 못 알아챈다).

**비공개 유출 방지는 타입으로 한다(구조적 배제).**
AI 에 넘어가는 입력은 ``LoveCallContext`` 하나뿐이고, 이 dataclass 에는 공개 가능한 값만 담긴다 —
양측 기업명·역할 + 보고문서 3섹션(핵심 논의사항/합의 사항/후속 액션). 만족도·Follow-up Intent·
Fit Assessment·전사 원문·녹음 키는 **필드 자체가 없어서** 프롬프트에 실릴 방법이 없다. 보고서
내보내기(D6)가 ``ReportMeta`` 로 같은 일을 하는 것과 같은 원칙이고, ``build_love_call_context``
가 마지막 게이트로 ``love_call_signal.assert_no_private_fields`` 를 한 번 더 통과시킨다.

메일은 **한국어 본문 + 영어 본문 병기**로 만든다. 알림 이메일(notifications/channels.py
``render_email``)이 이미 한/영 병기라 하우스 스타일이 같고, 상대가 해외 바이어면 한국어 단독
메일은 기능으로서 성립하지 않는다. 두 본문은 ``compose_body`` 가 편집 가능한 **문자열 하나**로
합친다 — 사용자는 텍스트박스 한 칸만 고치면 되고(미리보기=발송본 동일), AI 실패 시 "빈 편집기"
폴백도 그대로 성립한다.
"""

from __future__ import annotations

import json
import logging
from dataclasses import asdict, dataclass, field
from typing import Protocol

from app.config import Settings
from app.config import settings as _SETTINGS
from app.domain import love_call_signal
from app.services.openai_clients import shared_openai_client

logger = logging.getLogger(__name__)

def _subject_prefix() -> str:
    """제목 접두 — 알림 메일(`[{brand}] ...`)과 같은 표기로 수신함에서 한 서비스로 묶여 보이게 한다.

    settings.email_brand_name을 호출 시점에 읽는다(import 시점 고정 금지 — 테스트 monkeypatch·
    행사별 값 교체가 즉시 반영되게).
    """
    return f"[{_SETTINGS.email_brand_name}]"

# 한국어/영어 본문 사이 구분선. 사용자가 편집기에서 한쪽을 통째로 지우기 쉽게 눈에 띄는 한 줄로 둔다.
BODY_DIVIDER = "─────────────────────────"


class LoveCallMailError(RuntimeError):
    """러브콜 메일 초안 생성 실패 — 사용자에게 그대로 보여주고 수동 작성 경로를 연다."""


@dataclass(frozen=True)
class LoveCallContext:
    """AI 에 넘기는 입력 전부. **공개 가능한 값만** 담는다(비공개 필드는 존재 자체가 없다).

    discussion/agreements/actions 는 확정된 보고문서 3섹션 그대로다. 비어 있는 섹션은
    ``build_love_call_context`` 가 걸러내므로 AI 가 "없는 항목"을 지어낼 여지를 줄인다.
    """

    sender_org_name: str
    sender_role: str  # '참가사' | '바이어'
    recipient_org_name: str
    recipient_role: str
    discussion: list[str] = field(default_factory=list)
    agreements: list[str] = field(default_factory=list)
    actions: list[str] = field(default_factory=list)

    def has_report(self) -> bool:
        return bool(self.discussion or self.agreements or self.actions)


@dataclass(frozen=True)
class LoveCallMailDraft:
    """사용자 검수 전 초안. subject/body 는 화면에서 그대로 편집되고, 발송본은 편집 결과다."""

    subject: str
    body: str


def role_label(is_exhibitor: bool) -> str:
    """역할 표기 — CONTEXT.md 의 기존 용어(참가사/바이어)를 그대로 쓴다."""
    return "참가사" if is_exhibitor else "바이어"


def build_love_call_context(
    report: dict | None,
    *,
    sender_org_name: str,
    sender_role: str,
    recipient_org_name: str,
    recipient_role: str,
) -> LoveCallContext:
    """저장된 보고문서 dict 에서 **3섹션만** 뽑아 AI 입력을 만든다.

    report 에 다른 키(비공개 평가 등)가 섞여 들어와도 여기서 버려진다 — 화이트리스트 추출이다.
    """
    sections = report or {}

    def _lines(key: str) -> list[str]:
        raw = sections.get(key) or []
        return [str(item).strip() for item in raw if str(item).strip()]

    ctx = LoveCallContext(
        sender_org_name=sender_org_name,
        sender_role=sender_role,
        recipient_org_name=recipient_org_name,
        recipient_role=recipient_role,
        discussion=_lines("discussion"),
        agreements=_lines("agreements"),
        actions=_lines("actions"),
    )
    # 마지막 게이트 — 비공개 필드가 한 개라도 문맥에 섞이면 즉시 실패(회귀 방지).
    love_call_signal.assert_no_private_fields(asdict(ctx))
    return ctx


def fallback_subject(ctx: LoveCallContext) -> str:
    """AI 없이도 쓸 수 있는 정형 제목 — AI 실패 시 빈 편집기와 함께 이 제목을 채워 준다."""
    return (
        f"{_subject_prefix()} {ctx.recipient_org_name} 담당자님께 드리는 미팅 후속 제안"
        f" / Follow-up proposal from {ctx.sender_org_name}"
    )


def normalize_subject(subject: str, ctx: LoveCallContext) -> str:
    """AI 가 만든 제목에 서비스 접두를 붙인다(이미 있으면 그대로). 비면 정형 제목으로 폴백."""
    cleaned = " ".join(subject.split())
    if not cleaned:
        return fallback_subject(ctx)
    prefix = _subject_prefix()
    if cleaned.startswith(prefix):
        return cleaned
    return f"{prefix} {cleaned}"


def compose_body(body_ko: str, body_en: str) -> str:
    """한/영 본문을 편집 가능한 문자열 하나로 합친다. 한쪽이 비면 있는 쪽만 남긴다."""
    parts = [p.strip() for p in (body_ko, body_en) if p and p.strip()]
    return f"\n\n{BODY_DIVIDER}\n\n".join(parts)


_SYSTEM = """당신은 K-콘텐츠 전시회 비즈매칭에서 미팅을 마친 기업이 상대 기업에 보내는 후속 제안
메일(러브콜)을 대신 써 주는 어시스턴트입니다. 주어진 회의록을 근거로 정중하고 구체적인 비즈니스
메일을 작성하세요.

반드시 지킬 것:
- **회의록에 적힌 내용만 근거로 씁니다.** 회의록에 없는 수치·일정·가격·물량·계약조건·실적·
  회사 소개를 지어내지 마세요. 근거가 없으면 그 문장을 쓰지 마세요.
- 과장 표현(업계 최고, 독보적, 세계 유일 등)과 확정되지 않은 약속(보장합니다, 반드시 등)을
  쓰지 마세요.
- 회의록에 없는 섹션은 언급하지 마세요. 합의 사항이 없으면 합의한 척하지 않습니다.
- 상대 담당자의 개인정보(이름·직함·연락처)는 주어지지 않습니다. 추측해서 쓰지 마세요.
- 금액 제안·독점 계약·법적 구속력이 있는 문구는 쓰지 마세요.

형식:
- subject: 메일 제목 한 줄. 상대 기업명과 미팅 후속이라는 맥락이 드러나게. 대괄호 접두는 붙이지
  마세요(서비스가 붙입니다).
- body_ko: 한국어 본문. 인사 → 미팅에 대한 감사 → 논의한 내용 요약(회의록 근거) → 합의·후속
  액션 확인 → 함께하고 싶다는 제안과 다음 단계 제안 → 맺음말 순서의 자연스러운 편지. 불릿을
  써도 되지만 전체가 편지로 읽혀야 합니다. 보내는 사람 서명란은 회사명까지만 쓰고 개인 이름은
  비워 두세요.
- body_en: 위 한국어 본문과 같은 내용의 영어 본문. 번역투가 아닌 자연스러운 비즈니스 영어로.
  한국어 본문에 없는 내용을 추가하지 마세요.

이 메일은 사용자가 화면에서 검토·수정한 뒤 발송합니다. 그대로 보내도 될 완성된 문장으로 쓰세요."""

_OUTPUT_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "subject": {"type": "string"},
        "body_ko": {"type": "string"},
        "body_en": {"type": "string"},
    },
    "required": ["subject", "body_ko", "body_en"],
}


def render_user_prompt(ctx: LoveCallContext) -> str:
    """AI 에 실제로 실리는 user 메시지. **이 문자열이 곧 유출 경계다** — 테스트가 여기를 잠근다."""
    lines = [
        f"보내는 기업: {ctx.sender_org_name} ({ctx.sender_role})",
        f"받는 기업: {ctx.recipient_org_name} ({ctx.recipient_role})",
        "",
        "회의록(확정본):",
    ]
    for title, items in (
        ("핵심 논의사항", ctx.discussion),
        ("합의 사항", ctx.agreements),
        ("후속 액션", ctx.actions),
    ):
        if not items:
            continue
        lines.append(f"[{title}]")
        lines.extend(f"- {item}" for item in items)
        lines.append("")
    return "\n".join(lines).strip()


class LoveCallMailDrafter(Protocol):
    def draft(self, ctx: LoveCallContext) -> LoveCallMailDraft:
        """초안 1건을 만든다. 실패하면 예외를 던진다(호출부가 사용자에게 노출 + 수동 경로 개방)."""
        ...


class FakeLoveCallMailDrafter:
    """외부 호출 없는 결정적 초안 — 테스트/로컬 기본값.

    회의록 문장을 그대로 인용해 조립한다: "본문이 회의록에서 나왔는가"를 테스트가 검증할 수 있고,
    키 없는 로컬에서도 미리보기→발송 흐름 전체를 밟아볼 수 있다.
    """

    def draft(self, ctx: LoveCallContext) -> LoveCallMailDraft:
        if not ctx.has_report():
            raise LoveCallMailError("회의록 내용이 없어 초안을 만들 수 없습니다")

        def _block(title: str, items: list[str]) -> str:
            return f"{title}\n" + "\n".join(f"- {i}" for i in items) if items else ""

        ko = "\n\n".join(
            p
            for p in (
                f"{ctx.recipient_org_name} 담당자님, 안녕하세요.",
                f"{ctx.sender_org_name}({ctx.sender_role})입니다. 지난 미팅에서 나눠 주신 이야기에 감사드립니다.",
                _block("논의한 내용", ctx.discussion),
                _block("합의한 사항", ctx.agreements),
                _block("후속 액션", ctx.actions),
                "논의한 내용을 바탕으로 다음 단계를 함께 이어가고 싶습니다. 편하신 일정 알려주시면 맞추겠습니다.",
                f"감사합니다.\n{ctx.sender_org_name} 드림",
            )
            if p
        )
        en = "\n\n".join(
            p
            for p in (
                f"Dear {ctx.recipient_org_name} team,",
                f"This is {ctx.sender_org_name}. Thank you for the time you gave us at our recent meeting.",
                _block("What we discussed", ctx.discussion),
                _block("What we agreed", ctx.agreements),
                _block("Next steps", ctx.actions),
                "We would be glad to take the next step together. Please let us know a time that works for you.",
                f"Best regards,\n{ctx.sender_org_name}",
            )
            if p
        )
        subject = f"{ctx.recipient_org_name} 담당자님께 — 미팅 후속 제안 드립니다"
        return LoveCallMailDraft(
            subject=normalize_subject(subject, ctx), body=compose_body(ko, en)
        )


class OpenAILoveCallMailDrafter:
    """OpenAI 초안 생성. Chat Completions + structured outputs(json_schema, strict)."""

    def __init__(
        self,
        api_key: str,
        model: str = "gpt-5.4-mini",
        *,
        timeout: float = 60.0,
        max_retries: int = 1,
    ) -> None:
        if not api_key:
            raise LoveCallMailError("OPENAI 키 없음 — AI 메일 생성을 쓸 수 없습니다")
        # 채팅용 공유 클라이언트를 쓴다 — 캐시가 타임아웃별로 갈리므로 짧은 편지용 상한(60초)이 구조화
        # (180초·300초) 클라이언트와 섞이지 않는다.
        try:
            self._client = shared_openai_client(
                "chat", api_key=api_key, timeout=timeout, max_retries=max_retries
            )
        except ModuleNotFoundError as exc:  # pragma: no cover - infra extra
            raise LoveCallMailError(
                "openai 미설치 — `uv pip install '.[infra]'` 후 사용하세요"
            ) from exc
        self._model = model

    def draft(self, ctx: LoveCallContext) -> LoveCallMailDraft:  # pragma: no cover - 외부호출
        if not ctx.has_report():
            raise LoveCallMailError("회의록 내용이 없어 초안을 만들 수 없습니다")
        response = self._client.chat.completions.create(
            model=self._model,
            messages=[
                {"role": "system", "content": _SYSTEM},
                {"role": "user", "content": render_user_prompt(ctx)},
            ],
            response_format={
                "type": "json_schema",
                "json_schema": {
                    "name": "love_call_mail",
                    "schema": _OUTPUT_SCHEMA,
                    "strict": True,
                },
            },
        )
        logger.info("openai usage love_call_mail model=%s usage=%s", self._model, getattr(response, "usage", None))
        payload = json.loads(response.choices[0].message.content or "{}")
        body = compose_body(payload.get("body_ko", ""), payload.get("body_en", ""))
        if not body.strip():
            raise LoveCallMailError("AI 가 빈 본문을 돌려줬습니다")
        return LoveCallMailDraft(
            subject=normalize_subject(payload.get("subject", ""), ctx), body=body
        )


def build_love_call_mail_drafter(settings: Settings | None = None) -> LoveCallMailDrafter:
    """어댑터 선택 — 구조화(structurer)와 같은 토글/모델을 공유한다(모듈 docstring 참고)."""
    s = settings or _SETTINGS
    if s.structurer_backend == "openai":
        return OpenAILoveCallMailDrafter(
            s.openai_api_key or "",
            model=s.structurer_model,
            timeout=s.openai_chat_timeout_seconds,
            max_retries=s.openai_chat_max_retries,
        )
    return FakeLoveCallMailDrafter()
