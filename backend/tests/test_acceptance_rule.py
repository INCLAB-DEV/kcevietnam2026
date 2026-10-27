"""acceptance-rule 단위 테스트 — 유형별 수락 규칙(ADR-0005, 2026-09-15 정정)의 외부 동작 검증.

구현 세부가 아니라 **관찰 가능한 결과**(어떤 받는 쪽·채널이면 어떤 진입 상태)를 본다.
앱 코드 그린필드의 첫 테스트 패턴 기준선(F-OP-005 Testing Decisions).

2026-09-15 정정(발주자 QA B3, 같은 날 재정정으로 범위 확장): 운영자가 직접 트리거하는 두 채널
(FORCED 단건 강제배정 · AI_SATURATION 일괄 확정)은 받는 쪽 유형 무관 항상 accepted다. 이 파일의
"전 채널 동일" 계열 단언은 이 두 채널을 뺀 나머지(OPEN·AI_RETRIGGER·ON_SITE)에서만 성립하도록
갈라졌다.
"""

import pytest

from app.matching.acceptance_rule import (
    Channel,
    EntryState,
    ForcedConfirmationError,
    RecipientType,
    recipient_type_from_buyer_subtype,
    resolve_entry_state,
    validate_requested_state,
)

# 운영자가 직접 트리거하는 채널 — 받는 쪽 유형 무관 항상 accepted(2026-09-15 정정·재정정).
OPERATOR_OVERRIDE_CHANNELS = [Channel.FORCED, Channel.AI_SATURATION]
# 참가자/AI가 자율로 만드는 채널 — 받는 쪽 유형이 그대로 결정.
AUTONOMOUS_CHANNELS = [c for c in Channel if c not in OPERATOR_OVERRIDE_CHANNELS]
ALL_CHANNELS = list(Channel)


# --- 초청 바이어 수신 → 전 채널 accepted -------------------------------------
@pytest.mark.parametrize("channel", ALL_CHANNELS)
def test_hosted_buyer_always_accepted(channel):
    assert resolve_entry_state(RecipientType.HOSTED_BUYER, channel) is EntryState.ACCEPTED


# --- 일반 바이어 수신: 자율 채널은 proposed, 운영자 개입 채널은 accepted ------
@pytest.mark.parametrize("channel", AUTONOMOUS_CHANNELS)
def test_general_buyer_proposed_in_autonomous_channels(channel):
    assert resolve_entry_state(RecipientType.GENERAL_BUYER, channel) is EntryState.PROPOSED


@pytest.mark.parametrize("channel", OPERATOR_OVERRIDE_CHANNELS)
def test_general_buyer_accepted_in_operator_override_channels(channel):
    # 강제 배정(단건)·전체 포화배정 확정(일괄) — 발주자 QA B3: "무조건 확정".
    # 일반 바이어 수신도 예외 없이 accepted.
    assert resolve_entry_state(RecipientType.GENERAL_BUYER, channel) is EntryState.ACCEPTED


# --- Exhibitor 수신: 자율 채널은 proposed, 운영자 개입 채널은 accepted -------
@pytest.mark.parametrize("channel", AUTONOMOUS_CHANNELS)
def test_exhibitor_proposed_in_autonomous_channels(channel):
    # Open·단일 재트리거·현장 — 모두 proposed.
    assert resolve_entry_state(RecipientType.EXHIBITOR, channel) is EntryState.PROPOSED


@pytest.mark.parametrize("channel", OPERATOR_OVERRIDE_CHANNELS)
def test_exhibitor_accepted_in_operator_override_channels(channel):
    assert resolve_entry_state(RecipientType.EXHIBITOR, channel) is EntryState.ACCEPTED


# --- provenance 독립: 자율 채널끼리는 같은 받는 쪽 유형이면 결과 동일 ---------
@pytest.mark.parametrize(
    "recipient_type",
    [RecipientType.HOSTED_BUYER, RecipientType.GENERAL_BUYER, RecipientType.EXHIBITOR],
)
def test_result_independent_of_provenance_within_autonomous_channels(recipient_type):
    results = {resolve_entry_state(recipient_type, c) for c in AUTONOMOUS_CHANNELS}
    assert len(results) == 1, "자율 채널 안에서는 받는 쪽 유형별 결과가 채널과 무관해야 한다"


# --- 운영자 개입 채널: 받는 쪽 유형 무관 항상 accepted(2026-09-15 정정·재정정) -
@pytest.mark.parametrize("channel", OPERATOR_OVERRIDE_CHANNELS)
@pytest.mark.parametrize(
    "recipient_type",
    [RecipientType.HOSTED_BUYER, RecipientType.GENERAL_BUYER, RecipientType.EXHIBITOR],
)
def test_operator_override_channel_always_accepted_regardless_of_recipient(recipient_type, channel):
    assert resolve_entry_state(recipient_type, channel) is EntryState.ACCEPTED


# --- 운영자 개입 채널의 강제확정은 이제 허용된다(정정 전엔 거부됐다) ----------
@pytest.mark.parametrize("channel", OPERATOR_OVERRIDE_CHANNELS)
def test_general_buyer_forced_confirmation_now_allowed(channel):
    # 정정 전: ForcedConfirmationError. 정정 후: 규칙과 일치하므로 그대로 통과.
    assert (
        validate_requested_state(RecipientType.GENERAL_BUYER, channel, EntryState.ACCEPTED)
        is EntryState.ACCEPTED
    )


@pytest.mark.parametrize("channel", OPERATOR_OVERRIDE_CHANNELS)
def test_exhibitor_forced_confirmation_now_allowed(channel):
    assert (
        validate_requested_state(RecipientType.EXHIBITOR, channel, EntryState.ACCEPTED)
        is EntryState.ACCEPTED
    )


@pytest.mark.parametrize("channel", OPERATOR_OVERRIDE_CHANNELS)
def test_operator_override_channel_proposed_request_now_rejected(channel):
    # 반대 방향: 운영자 개입 채널에서 proposed를 요구하면 이제 거부된다(규칙은 항상 accepted).
    with pytest.raises(ForcedConfirmationError):
        validate_requested_state(RecipientType.GENERAL_BUYER, channel, EntryState.PROPOSED)


def test_validate_passes_when_request_matches_rule():
    # 규칙과 일치하는 요청은 그대로 통과(거부하지 않음).
    assert (
        validate_requested_state(RecipientType.HOSTED_BUYER, Channel.FORCED, EntryState.ACCEPTED)
        is EntryState.ACCEPTED
    )
    assert (
        validate_requested_state(RecipientType.GENERAL_BUYER, Channel.OPEN, EntryState.PROPOSED)
        is EntryState.PROPOSED
    )
    assert (
        validate_requested_state(
            RecipientType.EXHIBITOR, Channel.AI_SATURATION, EntryState.ACCEPTED
        )
        is EntryState.ACCEPTED
    )


def test_hosted_buyer_downgrade_to_proposed_rejected():
    # 초청 바이어를 수락대기로 끌어내리는 시도는 여전히 규칙 위반으로 거부(자율 채널에서도).
    with pytest.raises(ForcedConfirmationError):
        validate_requested_state(
            RecipientType.HOSTED_BUYER, Channel.OPEN, EntryState.PROPOSED
        )


# --- OPEN 채널은 원 규칙 불변 — 운영자 개입 경계가 흐려지지 않게 고정 ---------
def test_open_channel_general_buyer_still_proposed():
    # 참가사·바이어가 서로 주고받는 일반 신청(OPEN)은 여전히 신청→상대 수락 구조.
    assert resolve_entry_state(RecipientType.GENERAL_BUYER, Channel.OPEN) is EntryState.PROPOSED


def test_open_channel_exhibitor_still_proposed():
    assert resolve_entry_state(RecipientType.EXHIBITOR, Channel.OPEN) is EntryState.PROPOSED


def test_ai_retrigger_channel_unchanged():
    # 단일 기업 빈슬롯 보충 재트리거는 운영자 개입 채널이 아니다 — 받는 쪽 유형별 규칙 그대로.
    assert resolve_entry_state(RecipientType.GENERAL_BUYER, Channel.AI_RETRIGGER) is EntryState.PROPOSED
    assert resolve_entry_state(RecipientType.HOSTED_BUYER, Channel.AI_RETRIGGER) is EntryState.ACCEPTED


# --- buyer_subtype → 받는 쪽 유형 환산 ---------------------------------------
@pytest.mark.parametrize(
    ("subtype", "expected"),
    [
        ("hosted", RecipientType.HOSTED_BUYER),
        ("pre_registered", RecipientType.GENERAL_BUYER),
        ("on_site", RecipientType.GENERAL_BUYER),
    ],
)
def test_recipient_type_from_buyer_subtype(subtype, expected):
    assert recipient_type_from_buyer_subtype(subtype) is expected


def test_recipient_type_from_unknown_subtype_raises():
    with pytest.raises(ValueError):
        recipient_type_from_buyer_subtype("nonexistent")


# --- 통합: buyer_subtype에서 출발해 진입 상태까지 (실사용 경로) ---------------
def test_pre_registered_buyer_via_forced_is_accepted():
    # 2026-09-15 정정 전엔 proposed였다 — 발주자 QA B3로 FORCED는 항상 accepted.
    recipient = recipient_type_from_buyer_subtype("pre_registered")
    assert resolve_entry_state(recipient, Channel.FORCED) is EntryState.ACCEPTED


def test_pre_registered_buyer_via_saturation_is_accepted():
    # 2026-09-15 재정정 전엔 proposed였다 — 전체 포화배정도 Forced와 동일하게 항상 accepted.
    recipient = recipient_type_from_buyer_subtype("pre_registered")
    assert resolve_entry_state(recipient, Channel.AI_SATURATION) is EntryState.ACCEPTED


def test_pre_registered_buyer_via_open_is_still_proposed():
    # 운영자 개입 채널이 아니면 원래 규칙 그대로 — 회귀 방지.
    recipient = recipient_type_from_buyer_subtype("pre_registered")
    assert resolve_entry_state(recipient, Channel.OPEN) is EntryState.PROPOSED


def test_hosted_buyer_via_saturation_is_accepted():
    recipient = recipient_type_from_buyer_subtype("hosted")
    assert resolve_entry_state(recipient, Channel.AI_SATURATION) is EntryState.ACCEPTED
