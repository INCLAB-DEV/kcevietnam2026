"""meeting-state 단위 테스트 — 미팅 상태 전이표(app.matching.meeting_state)의 단일 소스 검증.

**순수 모듈** — DB·시계 픽스처를 쓰지 않는다(migrated_db/db_session 금지). 전이표가 세 군데에
흩어지면 조용한 불일치가 생기므로, 여기서는 전이표 그 자체를 전수(全數)로 고정한다: 25개 조합
(ALL_STATUSES × ALL_STATUSES) 전부를 돌며 LEGAL_TRANSITIONS에 없는 조합은 반드시 거부되는지 본다.
"""

from __future__ import annotations

import pytest

from app.matching.meeting_state import (
    ACCEPTED,
    ACTIVE_STATUSES,
    ALL_STATUSES,
    CANCELLED,
    COMPLETED,
    IllegalTransitionError,
    LEGAL_TRANSITIONS,
    PROPOSED,
    REJECTED,
    TERMINAL_STATUSES,
    assert_transition,
    can_transition,
    is_active,
    is_terminal,
)

# =============================================================================
# 전이표 자체를 고정(회귀 방지)
# =============================================================================
# 이 표가 바뀌면 참가자 API·운영자 콘솔·스케줄러 세 경로의 동작이 동시에 바뀐다 —
# 의도치 않은 변경을 여기서 바로 잡아낸다.
EXPECTED_TRANSITIONS = {
    PROPOSED: frozenset({ACCEPTED, REJECTED, CANCELLED}),
    ACCEPTED: frozenset({CANCELLED, COMPLETED}),
    REJECTED: frozenset(),
    CANCELLED: frozenset(),
    COMPLETED: frozenset(),
}


def test_legal_transitions_pinned():
    assert LEGAL_TRANSITIONS == EXPECTED_TRANSITIONS


def test_all_statuses_pinned():
    # meetings.status CHECK 제약과 같은 값집합 — 순서까지 고정할 필요는 없지만 집합은 고정한다.
    assert set(ALL_STATUSES) == {PROPOSED, ACCEPTED, REJECTED, CANCELLED, COMPLETED}


def test_terminal_and_active_status_sets():
    assert TERMINAL_STATUSES == {REJECTED, CANCELLED, COMPLETED}
    assert ACTIVE_STATUSES == {PROPOSED, ACCEPTED}


# =============================================================================
# 전 조합(25개) 전수 검증
# =============================================================================
ALL_PAIRS = [(current, target) for current in ALL_STATUSES for target in ALL_STATUSES]


@pytest.mark.parametrize(("current", "target"), ALL_PAIRS)
def test_can_transition_matches_legal_table_exhaustively(current, target):
    expected = target in LEGAL_TRANSITIONS[current]
    assert can_transition(current, target) is expected


@pytest.mark.parametrize(("current", "target"), ALL_PAIRS)
def test_assert_transition_matches_can_transition_exhaustively(current, target):
    if can_transition(current, target):
        assert_transition(current, target)  # 예외 없이 통과해야 한다.
    else:
        with pytest.raises(IllegalTransitionError):
            assert_transition(current, target)


# =============================================================================
# IllegalTransitionError: current/target 보존 + 메시지 세 갈래
# =============================================================================
def test_illegal_transition_error_carries_current_and_target():
    with pytest.raises(IllegalTransitionError) as exc_info:
        assert_transition(PROPOSED, COMPLETED)
    err = exc_info.value
    assert err.current == PROPOSED
    assert err.target == COMPLETED


def test_illegal_transition_error_message_for_terminal_current():
    # current가 종료 상태 — "종료 상태라 더 이상 바뀌지 않는다" 갈래.
    with pytest.raises(IllegalTransitionError, match="종료 상태"):
        assert_transition(COMPLETED, ACCEPTED)


def test_illegal_transition_error_message_for_unknown_current():
    # current가 LEGAL_TRANSITIONS에 아예 없는 상태 — "알 수 없는 상태다" 갈래.
    with pytest.raises(IllegalTransitionError, match="알 수 없는 상태"):
        assert_transition("draft", PROPOSED)


def test_illegal_transition_error_message_for_disallowed_target():
    # current는 알려져 있고 종료 상태도 아니지만 target이 허용 목록 밖 — 안내 갈래.
    with pytest.raises(IllegalTransitionError, match="갈 수 있는 상태는"):
        assert_transition(PROPOSED, COMPLETED)


# =============================================================================
# 알 수 없는 상태 문자열 — KeyError가 아니라 False/예외로 처리
# =============================================================================
def test_unknown_status_string_does_not_raise_key_error():
    # LEGAL_TRANSITIONS.get(...)을 쓰므로 KeyError 없이 False가 나와야 한다.
    assert can_transition("draft", PROPOSED) is False
    assert can_transition(PROPOSED, "draft") is False


def test_unknown_status_string_raises_illegal_transition_not_key_error():
    with pytest.raises(IllegalTransitionError):
        assert_transition("draft", PROPOSED)


# =============================================================================
# is_terminal / is_active
# =============================================================================
@pytest.mark.parametrize("status", [REJECTED, CANCELLED, COMPLETED])
def test_is_terminal_true_for_terminal_statuses(status):
    assert is_terminal(status) is True


@pytest.mark.parametrize("status", [PROPOSED, ACCEPTED])
def test_is_terminal_false_for_active_statuses(status):
    assert is_terminal(status) is False


def test_is_terminal_false_for_unknown_status():
    assert is_terminal("draft") is False


@pytest.mark.parametrize("status", [PROPOSED, ACCEPTED])
def test_is_active_true_for_active_statuses(status):
    assert is_active(status) is True


@pytest.mark.parametrize("status", [REJECTED, CANCELLED, COMPLETED])
def test_is_active_false_for_terminal_statuses(status):
    assert is_active(status) is False


def test_is_active_false_for_unknown_status():
    assert is_active("draft") is False
