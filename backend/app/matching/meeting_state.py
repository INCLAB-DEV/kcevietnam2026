"""meeting-state — 미팅 상태 전이표의 단일 소스 (F-MT-001, ADR-0004/0005).

**순수 모듈** — DB·시간·HTTP 의존 없음. 참가자 API·운영자 콘솔·스케줄러가 상태를 바꾸기 전에
전부 여기를 통과한다. 전이 규칙이 세 군데에 흩어지면 "운영자 콘솔에서만 completed를 취소할 수
있는" 류의 조용한 불일치가 생긴다.

전이표(이게 전부다 — 여기 없는 전이는 전부 거부):

- ``proposed`` → ``accepted`` (수신측 수락) / ``rejected`` (수신측 거절) / ``cancelled`` (신청측 철회)
- ``accepted`` → ``cancelled`` (양측·운영자 취소) / ``completed`` (시간 경과, 스케줄러)
- ``rejected`` · ``cancelled`` · ``completed`` — **종료 상태**. 나가는 전이 없음(되살리기 없음).

거절 vs 취소(CONTEXT.md): **거절**은 수신측이 제안을 받지 않는 것이고, **취소**는 이미 성립했거나
자기가 낸 신청을 무르는 것이다. 둘 다 proposed에서 갈 수 있지만 **누가** 할 수 있는지가 다르며,
그 주체 판정은 상태 전이표가 아니라 호출부(service)의 권한 규칙이 소유한다.
"""

from __future__ import annotations

from typing import Final, Mapping

MeetingStatus = str

PROPOSED: Final = "proposed"
ACCEPTED: Final = "accepted"
REJECTED: Final = "rejected"
CANCELLED: Final = "cancelled"
COMPLETED: Final = "completed"

#: meetings.status CHECK 제약과 같은 값집합(models.Meeting).
ALL_STATUSES: Final[tuple[str, ...]] = (PROPOSED, ACCEPTED, REJECTED, CANCELLED, COMPLETED)

#: 살아있는 상태 — 예전 D9(활성 쌍 유일성, #11로 제거) 부분 unique 인덱스의 WHERE와 같은 집합이었다.
#: 지금도 "미팅이 진행 중인가"를 뜻하는 일반적인 개념으로 쓰인다.
ACTIVE_STATUSES: Final[frozenset[str]] = frozenset({PROPOSED, ACCEPTED})

#: 합법 전이표. 값이 빈 집합이면 종료 상태.
LEGAL_TRANSITIONS: Final[Mapping[str, frozenset[str]]] = {
    PROPOSED: frozenset({ACCEPTED, REJECTED, CANCELLED}),
    ACCEPTED: frozenset({CANCELLED, COMPLETED}),
    REJECTED: frozenset(),
    CANCELLED: frozenset(),
    COMPLETED: frozenset(),
}

#: 종료 상태 — 어떤 전이도 나가지 않는다.
TERMINAL_STATUSES: Final[frozenset[str]] = frozenset(
    status for status, targets in LEGAL_TRANSITIONS.items() if not targets
)


class IllegalTransitionError(Exception):
    """전이표에 없는 상태 변경 시도 — 도메인 위반(호출부가 409로 환산).

    ``current``/``target``을 그대로 들고 있어 호출부가 메시지를 다시 조립하지 않아도 된다.
    """

    def __init__(self, current: str, target: str) -> None:
        self.current = current
        self.target = target
        if current in TERMINAL_STATUSES:
            reason = f"{current!r}은(는) 종료 상태라 더 이상 바뀌지 않는다"
        elif current not in LEGAL_TRANSITIONS:
            reason = f"{current!r}은(는) 알 수 없는 상태다"
        else:
            allowed = ", ".join(sorted(LEGAL_TRANSITIONS[current])) or "없음"
            reason = f"{current!r}에서 갈 수 있는 상태는 {allowed}뿐이다"
        super().__init__(f"미팅 상태를 {current!r} → {target!r}로 바꿀 수 없다 — {reason}.")


def can_transition(current: str, target: str) -> bool:
    """``current`` → ``target``이 합법인가. 알 수 없는 상태는 언제나 False."""
    return target in LEGAL_TRANSITIONS.get(current, frozenset())


def assert_transition(current: str, target: str) -> None:
    """합법 전이가 아니면 :class:`IllegalTransitionError`.

    상태를 바꾸는 **모든** 경로(참가자 API·운영자 취소·completion tick)가 쓰기 직전에 호출한다.
    """
    if not can_transition(current, target):
        raise IllegalTransitionError(current, target)


def is_terminal(status: str) -> bool:
    """더 이상 나가는 전이가 없는 상태인가."""
    return status in TERMINAL_STATUSES


def is_active(status: str) -> bool:
    """살아있는 미팅인가(proposed/accepted)."""
    return status in ACTIVE_STATUSES
