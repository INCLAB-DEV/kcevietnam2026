"""acceptance-rule — 받는 쪽 유형 + 채널 → 진입 상태(ADR-0005, 2026-09-15 정정).

여러 PRD(F-MT-001·F-OP-003·F-OP-005)가 공유하는 수락 규칙의 단일 기준선.
**순수 함수** — DB·시간·I/O 의존 없음. forced-assignment·saturation-allocation이 호출(위임)한다.

핵심 규칙(ADR-0005):
- 수락 여부는 **받는 쪽 유형**으로 결정되며 **provenance(누가 만들었나)와 독립**이다 — 단
  **운영자 개입 채널(FORCED·AI_SATURATION)은 예외**(아래 정정 참고).
- 초청 바이어(Hosted) 수신 → 즉시 확정(accepted), 거부 단계 없음(전 채널).
- 일반 바이어(사전등록·현장) 수신 → 수락대기(proposed). **단 FORCED·AI_SATURATION은 예외** —
  즉시 확정.
- Exhibitor 수신 → 수락대기(proposed). **단 FORCED·AI_SATURATION은 예외** — 즉시 확정.

> ⚠ **정정(2026-09-15, 발주자 QA 지적 B3)**: 이전엔 "운영자에게 일반 바이어/Exhibitor 강제
> 확정 권한은 없다 — FORCED도 받는 쪽 유형만 본다"였다(ADR-0005 원문, F-OP-005 D2). 발주자가
> QA 문서에서 "관리자가 강제 배정하면 무조건 확정으로 바뀐다"를 명시적으로 요구해 이 규칙을
> 뒤집었다. 처음엔 FORCED(단건 강제배정)만 고쳤으나, 발주자가 후속 확인에서 **"운영자가
> 트리거하는 배정은 단건·일괄 모두 무조건 확정"** 이라고 범위를 명확히 해 **AI_SATURATION(전체
> 포화배정, 일괄)도 동일하게** 정정한다 — **FORCED·AI_SATURATION 두 채널은 받는 쪽 유형과
> 무관하게 항상 accepted**. "운영자가 정하면 그 자리에서 확정"이라는 원칙이 단건이든 일괄
> 확정 버튼이든 똑같이 적용된다. 일반 바이어·Exhibitor에게 수락대기(proposed)를 요구하는
> 원래 규칙은 **참가자·AI가 자율로 만드는 채널(OPEN·AI_RETRIGGER·ON_SITE)에는 그대로 남는다**
> — "동의 없이 일정이 잡히지 않는다"는 참가자가 서로 주고받는 신청(OPEN)에는 여전히 적용되고,
> 운영자가 명시적으로 개입한(단건·일괄 불문) 건에만 예외가 생긴다. ADR-0005 문서·F-OP-005
> PRD도 같은 근거로 정정했다(ADR-0010의 타임존 정정과 같은 형식).
"""

from __future__ import annotations

from enum import Enum


class RecipientType(str, Enum):
    """배정을 **받는 쪽**의 유형. 수락 규칙을 결정하는 1차 축."""

    HOSTED_BUYER = "hosted_buyer"  # 초청 바이어 — 의무 미팅, 즉시 확정
    GENERAL_BUYER = "general_buyer"  # 일반 바이어(사전등록·현장) — 수락대기
    EXHIBITOR = "exhibitor"  # 참가사 — 채널에 따라 수락대기/자동확정


class Channel(str, Enum):
    """미팅이 만들어진 채널. ``_OPERATOR_OVERRIDE_CHANNELS``(아래)에 속하면 받는 쪽 유형 무관 항상
    즉시확정이다(2026-09-15 정정) — 그 외는 받는 쪽 유형이 결정."""

    OPEN = "open"  # 참가사/바이어가 직접 신청 — 받는 쪽 유형이 그대로 결정
    AI_SATURATION = "ai_saturation"  # AI 전체 포화배정(일괄) — 운영자 확정 버튼, 항상 즉시확정
    AI_RETRIGGER = "ai_retrigger"  # 단일 기업 빈슬롯 보충 재트리거 — 받는 쪽 유형이 그대로 결정
    FORCED = "forced"  # 운영자가 대상을 골라 강제 배정(단건) — 항상 즉시확정
    ON_SITE = "on_site"  # 현장 생성 — 받는 쪽 유형이 그대로 결정


#: 운영자가 직접 트리거하는 채널 — 받는 쪽 유형과 무관하게 항상 accepted(2026-09-15 정정,
#: 발주자 QA B3). 단건(FORCED)·일괄(AI_SATURATION) 둘 다 "운영자가 정하면 그 자리에서 확정"
#: 원칙이 동일하게 적용된다. 참가자/AI가 자율로 만드는 나머지 채널은 여기 없다.
_OPERATOR_OVERRIDE_CHANNELS = frozenset({Channel.FORCED, Channel.AI_SATURATION})


class EntryState(str, Enum):
    """규칙이 반환하는 미팅 진입 상태(스키마 meetings.status의 부분집합)."""

    ACCEPTED = "accepted"  # 즉시 확정 — 받는 쪽 수락 단계 없음
    PROPOSED = "proposed"  # 수락대기 — 받는 쪽이 수락/거절


class ForcedConfirmationError(ValueError):
    """규칙을 거슬러 진입 상태를 강제 지정하려는 시도(예: 운영자 개입 채널이 아닌 곳에서 일반
    바이어를 강제 확정하려는 시도, 또는 FORCED/AI_SATURATION에서 accepted가 아닌 상태를 요구하는
    시도).

    운영자는 수락 상태를 고르지 않는다 — 받는 쪽 유형(과 운영자 개입 채널 예외)이 자동 결정한다
    (ADR-0005, 2026-09-15 정정).
    """


def resolve_entry_state(recipient_type: RecipientType, channel: Channel) -> EntryState:
    """받는 쪽 유형 + 채널 → 진입 상태(ADR-0005, 2026-09-15 정정).

    FORCED·AI_SATURATION(운영자 개입 채널, 단건·일괄)은 받는 쪽 유형과 무관하게 항상 즉시
    확정이다 — 그 외 채널은 종전 규칙(provenance와 독립, 받는 쪽 유형이 결정) 그대로다.

    Args:
        recipient_type: 배정을 받는 쪽의 유형.
        channel: 미팅이 생성된 채널.

    Returns:
        accepted(즉시 확정) 또는 proposed(수락대기).
    """
    if channel in _OPERATOR_OVERRIDE_CHANNELS:
        # 운영자 개입 배정(단건 FORCED·일괄 AI_SATURATION) — 받는 쪽 유형 무관 항상 즉시 확정
        # (발주자 QA 지적 B3, 2026-09-15). ADR-0005 원문의 "일반 바이어/Exhibitor 강제 확정
        # 권한 없음"은 이 두 채널에 한해 폐기됐다 — 참가자/AI 자율 채널에는 여전히 유효.
        return EntryState.ACCEPTED

    if recipient_type is RecipientType.HOSTED_BUYER:
        # 초청 바이어 수신은 전 채널 즉시 확정 — 의무 미팅, 거부 단계 없음.
        return EntryState.ACCEPTED

    # 일반 바이어·Exhibitor 수신 — 운영자 개입 채널(위에서 이미 처리)을 뺀 나머지는 전부
    # 수락대기다: "동의 없이 일정이 잡히지 않는다"는 참가자·AI 자율 채널(OPEN·AI_RETRIGGER·
    # ON_SITE)에 그대로 적용된다.
    return EntryState.PROPOSED


def validate_requested_state(
    recipient_type: RecipientType,
    channel: Channel,
    requested_state: EntryState,
) -> EntryState:
    """운영자/호출자가 지정한 진입 상태를 규칙과 대조해 검증한다.

    규칙이 정한 상태와 다르면(예: 일반 바이어를 강제로 accepted 지정) 거부한다.
    forced-assignment가 "운영자가 수락 상태를 고르지 않는다"를 강제하는 데 쓴다.

    Args:
        recipient_type: 배정을 받는 쪽의 유형.
        channel: 미팅이 생성된 채널.
        requested_state: 호출자가 적용하려는 진입 상태.

    Returns:
        규칙이 정한 진입 상태(요청과 일치할 때).

    Raises:
        ForcedConfirmationError: 요청 상태가 규칙과 충돌할 때.
    """
    resolved = resolve_entry_state(recipient_type, channel)
    if requested_state is not resolved:
        raise ForcedConfirmationError(
            f"{recipient_type.value} 수신({channel.value} 채널)의 진입 상태는 "
            f"{resolved.value}로 자동 결정된다 — {requested_state.value} 강제 지정은 허용되지 않는다."
        )
    return resolved


# 스키마 buyer_subtype('hosted'/'pre_registered'/'on_site') → 받는 쪽 바이어 유형.
_BUYER_SUBTYPE_TO_RECIPIENT = {
    "hosted": RecipientType.HOSTED_BUYER,
    "pre_registered": RecipientType.GENERAL_BUYER,
    "on_site": RecipientType.GENERAL_BUYER,
}


def recipient_type_from_buyer_subtype(buyer_subtype: str) -> RecipientType:
    """스키마 buyer_subtype 값을 수락 규칙의 받는 쪽 유형으로 환산한다.

    'hosted' → 초청 바이어, 'pre_registered'/'on_site' → 일반 바이어.
    바이어가 아닌 받는 쪽(참가사)은 RecipientType.EXHIBITOR를 직접 쓴다.

    Raises:
        ValueError: 알 수 없는 buyer_subtype.
    """
    try:
        return _BUYER_SUBTYPE_TO_RECIPIENT[buyer_subtype]
    except KeyError:
        raise ValueError(f"알 수 없는 buyer_subtype: {buyer_subtype!r}") from None
