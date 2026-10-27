"""dx-korea-verify — DX Korea 인증 API(아이디/비번 → 회원ID)를 감싸는 어댑터(ADR-0007/0008).

**왜 어댑터인가.** DX Korea 인증 API 규격(엔드포인트·인증방식·회원ID 반환)이 아직
미확정이다(F-AU-001 Out of Scope의 미해결 블로커). 그래서 실호출 로직을 직접 흩뿌리지
않고 **하나의 포트(Protocol) 뒤에 격리**한다. 규격이 확정되면 ``StubDxKoreaVerifier``를
실 HTTP 구현으로 **교체만** 하면 되고, 호출자(``login``·세션 발급)와 계약 테스트는 불변이다.

**관찰 가능한 계약**(F-AU-001 Testing Decisions):
- 아이디/비번이 맞으면 → 그 사람의 **회원ID**(주관사 명단 멱등 upsert 주키)를 돌려준다.
- 틀리거나 막힌 계정이면 → **거부 사유**(왜 못 들어오는지)를 돌려준다.
- 어댑터는 토큰 내부 포맷·HTTP 세부를 밖으로 흘리지 않는다 — 성공/실패 분기만 노출.

신원의 닻은 "딥링크"가 아니라 "주관사가 보유한 DX Korea 회원 계정"이다(D2). 그래서 이
검증을 통과해야만 적재 레코드 매핑·세션 발급으로 넘어간다.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Protocol, runtime_checkable


class RejectionReason(str, Enum):
    """검증 거부 사유 — 사용자에게 "무엇을 고쳐야 할지" 안내하는 1차 축(User Story 10).

    어댑터는 업스트림의 원시 에러를 이 닫힌 집합으로 환산해 노출한다. HTTP 상태코드·
    업스트림 메시지 원문 같은 구현 세부는 경계 밖으로 새지 않는다.
    """

    INVALID_CREDENTIALS = "invalid_credentials"  # 아이디 또는 비밀번호 불일치
    ACCOUNT_LOCKED = "account_locked"  # 잠긴/정지된 계정 — 비번이 맞아도 진입 불가
    UPSTREAM_UNAVAILABLE = "upstream_unavailable"  # DX Korea 인증 API 응답 불가(일시 장애)


@dataclass(frozen=True, slots=True)
class VerifyOk:
    """검증 성공 — 주관사 명단의 멱등 upsert 주키인 **회원ID**를 담는다.

    이 회원ID로 ``registrant_mapping``이 적재 레코드를 찾고, 같은 키로 NABI 계정(Cognito)을
    연결한다(NABI 계정 ↔ 회원ID ↔ registrants 동일 키).
    """

    member_id: str


@dataclass(frozen=True, slots=True)
class VerifyRejected:
    """검증 실패 — 거부 사유. 사유에 따라 호출자가 사용자 안내를 분기한다."""

    reason: RejectionReason


# 검증 결과 = 성공(회원ID) 또는 거부(사유). 호출자는 isinstance로 분기한다.
VerifyResult = VerifyOk | VerifyRejected


@runtime_checkable
class DxKoreaVerifier(Protocol):
    """DX Korea 인증 어댑터 포트 — 아이디/비번을 검증해 회원ID를 돌려준다.

    실구현(HTTP 호출)도 스텁도 이 한 인터페이스를 만족한다. 호출자는 이 타입에만
    의존하므로 규격 확정 시 구현 교체가 호출자에 영향을 주지 않는다(교체 가능성 — D6).
    """

    def verify(self, username: str, password: str) -> VerifyResult:
        """아이디/비번 1회 검증.

        Returns:
            성공 시 ``VerifyOk(member_id)``, 실패 시 ``VerifyRejected(reason)``.
            예외를 던지지 않고 결과로 분기를 표현한다(업스트림 장애도 사유로 환산).
        """
        ...


class StubDxKoreaVerifier:
    """규격 확정 전까지 쓰는 인메모리 스텁 — 계약(성공/실패 분기)만 만족한다.

    실 HTTP 호출 없이 "맞는 자격증명 → 회원ID", "틀림 → 거부", "잠김 → 거부", "장애 → 거부"를
    재현한다. 6/17 컨셉 데모의 목업 검증과 계약 테스트에 쓰인다(Out of Scope: 데모는 목업).

    실구현으로 교체되면 이 클래스는 테스트 더블로만 남는다.
    """

    def __init__(
        self,
        *,
        credentials: dict[tuple[str, str], str] | None = None,
        locked_usernames: set[str] | None = None,
        available: bool = True,
    ) -> None:
        """Args:
        credentials: (아이디, 비번) → 회원ID 매핑. 맞으면 그 회원ID로 성공.
        locked_usernames: 잠긴 계정 아이디 집합. 비번이 맞아도 ACCOUNT_LOCKED로 거부.
        available: False면 업스트림 장애를 흉내내 전건 UPSTREAM_UNAVAILABLE로 거부.
        """
        self._credentials = dict(credentials or {})
        self._locked = set(locked_usernames or set())
        self._available = available

    def verify(self, username: str, password: str) -> VerifyResult:
        if not self._available:
            # 업스트림 장애 — 자격증명 옳고 그름을 판단하기 전에 거부한다.
            return VerifyRejected(RejectionReason.UPSTREAM_UNAVAILABLE)

        member_id = self._credentials.get((username, password))
        if member_id is None:
            # 아이디 또는 비번 불일치 — 어느 쪽이 틀렸는지는 일부러 구분하지 않는다(열거 공격 완화).
            return VerifyRejected(RejectionReason.INVALID_CREDENTIALS)

        if username in self._locked:
            # 자격증명은 맞지만 잠긴 계정 — 진입 차단.
            return VerifyRejected(RejectionReason.ACCOUNT_LOCKED)

        return VerifyOk(member_id=member_id)
