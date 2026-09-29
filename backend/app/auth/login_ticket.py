"""login-ticket — 약관 동의 단계를 잇는 짧은 수명의 일회성 티켓(F-AU-001, #23 slice A).

접힌 로그인 트랜잭션에서 **최초 진입자**는 검증·매핑까지 끝낸 뒤 약관 동의 화면으로
넘어간다. 그 사이의 상태(누구인지·어디로 갈지)를 클라이언트가 들고 다니되 변조하지
못하게, 서버가 발급한 **불투명 티켓** 하나로 묶는다. ``/login/start``가 발급하고
``/login/complete``가 소진한다.

설계는 형제 모듈 ``deeplink_token``과 동일한 deep module 패턴이다:
- **저장소(store)와 시계(clock)를 주입**받는다. 기본은 in-memory + UTC now. DB 백엔드로
  교체해도 발급/검증 계약은 그대로다.
- 티켓 원문은 저장하지 않는다 — **SHA-256 해시(ticket_id)** 만 보관. 검증은 동작
  (허용/거부)만 노출하고 내부 포맷을 호출자에게 숨긴다.
- **일회성**: 소진은 ``try_consume``로 원자적으로 처리해 재사용을 막는다(TOCTOU 차단).

딥링크 토큰과 달리 신원의 닻이 아니라 **이미 검증된 진입 상태의 단기 보관함**이다 —
payload에 회원ID·역할·게이트·라우트를 담고, 동의가 끝나면 그 payload로 세션을 발급한다.
그래서 수명이 짧다(기본 10분).
"""

from __future__ import annotations

import hashlib
import secrets
import threading
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from enum import Enum
from typing import Any, Protocol

# 기본 티켓 수명 — 약관 화면을 읽고 동의하는 데 필요한 짧은 시간(10분). 발급 시 override 가능.
DEFAULT_TTL = timedelta(minutes=10)

# 발급 티켓 엔트로피(bytes). secrets.token_urlsafe는 base64url로 약 1.3배 길이가 된다.
_TICKET_BYTES = 32


def _utcnow() -> datetime:
    """주입 가능한 기본 시계 — timezone-aware UTC."""
    return datetime.now(timezone.utc)


class TicketRejection(str, Enum):
    """티켓 검증 거부 사유 — 호출자(엔드포인트/UI)가 다음 안내를 정하는 데 쓴다.

    딥링크 토큰의 RejectionCode와 같은 닫힌 집합(forged/expired/consumed)이지만, 별도
    모듈로 둬 두 흐름의 결합을 만들지 않는다(접힌 트랜잭션의 ticket_invalid.reason).
    """

    FORGED = "forged"  # 알 수 없는 티켓 — 발급된 적 없거나 변조됨
    EXPIRED = "expired"  # 만료 시각 경과
    CONSUMED = "consumed"  # 일회성 티켓이 이미 1회 소진됨


@dataclass(frozen=True)
class TicketRecord:
    """저장소에 보관되는 발급 티켓의 상태. 원문이 아니라 해시(ticket_id)로 키잉된다."""

    payload: dict[str, Any]  # 검증 성공 시 반환할 진입 상태(member_id·role·gate·route·roles)
    expires_at: datetime  # 이 시각 이후 검증은 EXPIRED
    consumed: bool = False  # 일회성 — 1회 검증 성공 후 True


@dataclass(frozen=True)
class TicketResult:
    """검증 결과 — 허용이면 payload, 거부면 rejection 사유. 둘 중 하나만 채워진다."""

    allowed: bool
    payload: dict[str, Any] | None = None
    rejection: TicketRejection | None = None

    @classmethod
    def allow(cls, payload: dict[str, Any]) -> TicketResult:
        return cls(allowed=True, payload=payload)

    @classmethod
    def reject(cls, code: TicketRejection) -> TicketResult:
        return cls(allowed=False, rejection=code)


class TicketStore(Protocol):
    """발급 티켓 저장소 계약. in-memory가 기본, DB 백엔드로 교체 가능."""

    def put(self, ticket_id: str, record: TicketRecord) -> None:
        """발급된 티켓 레코드를 ticket_id(해시) 키로 저장한다."""
        ...

    def get(self, ticket_id: str) -> TicketRecord | None:
        """ticket_id로 레코드를 조회한다. 없으면 None(= 위조/미발급)."""
        ...

    def try_consume(self, ticket_id: str) -> bool:
        """일회성 티켓을 **원자적으로** 소진한다 — 동시 호출 시 정확히 1명만 True.

        consumed False→True 전이를 한 연산으로 처리해 read/check/update 사이의 경쟁
        (두 동시 요청이 모두 허용되는 TOCTOU)을 막는다. DB 구현은 단일 문
        (``UPDATE ... WHERE NOT consumed RETURNING``)으로 같은 보장을 제공해야 한다.

        Returns:
            이 호출이 소진의 승자면 True. 미발급이거나 이미 소진됐으면 False.
        """
        ...


@dataclass
class InMemoryTicketStore:
    """프로세스 메모리 저장소 — 데모·테스트·단일 인스턴스용 기본 구현.

    영속성이 필요해지면 같은 TicketStore 계약을 따르는 DB 구현으로 교체한다(발급/검증 불변).
    소진은 락으로 원자화 — sync 엔드포인트가 스레드풀에서 동시 실행돼도 일회성을 보장한다.
    """

    _records: dict[str, TicketRecord] = field(default_factory=dict)
    _lock: threading.Lock = field(default_factory=threading.Lock)

    def put(self, ticket_id: str, record: TicketRecord) -> None:
        with self._lock:
            self._records[ticket_id] = record

    def get(self, ticket_id: str) -> TicketRecord | None:
        with self._lock:
            return self._records.get(ticket_id)

    def try_consume(self, ticket_id: str) -> bool:
        with self._lock:
            record = self._records.get(ticket_id)
            if record is None or record.consumed:
                return False
            self._records[ticket_id] = TicketRecord(
                payload=record.payload, expires_at=record.expires_at, consumed=True
            )
            return True


def _hash_ticket(raw_ticket: str) -> str:
    """티켓 원문 → 저장소 키(SHA-256 hex). 원문은 어디에도 보관하지 않는다."""
    return hashlib.sha256(raw_ticket.encode("utf-8")).hexdigest()


class LoginTicketService:
    """로그인 티켓 발급·검증 서비스. 저장소·시계를 주입받아 I/O와 시간을 경계 밖으로 뺀다."""

    def __init__(
        self,
        store: TicketStore | None = None,
        clock: Callable[[], datetime] = _utcnow,
        default_ttl: timedelta = DEFAULT_TTL,
    ) -> None:
        self._store = store if store is not None else InMemoryTicketStore()
        self._clock = clock
        self._default_ttl = default_ttl

    def issue(self, payload: dict[str, Any], ttl: timedelta | None = None) -> str:
        """진입 상태에 묶인 새 로그인 티켓을 발급한다.

        Args:
            payload: 검증 성공 시 그대로 반환할 진입 상태(member_id·role·gate·route·roles).
            ttl: 티켓 수명. 미지정 시 기본(DEFAULT_TTL = 10분).

        Returns:
            클라이언트가 약관 화면을 거쳐 들고 올 불투명 티켓 원문. 호출자는 이 문자열만 다룬다.
        """
        raw_ticket = secrets.token_urlsafe(_TICKET_BYTES)
        expires_at = self._clock() + (ttl if ttl is not None else self._default_ttl)
        self._store.put(
            _hash_ticket(raw_ticket),
            TicketRecord(payload=dict(payload), expires_at=expires_at),
        )
        return raw_ticket

    def verify(self, raw_ticket: str) -> TicketResult:
        """티켓을 검증하고 진입 상태를 반환/거부한다. 성공 시 일회성 티켓을 소진한다.

        거부 우선순위: 위조(미발급) → 소진(재사용) → 만료. 재사용은 만료 여부와 무관하게
        CONSUMED로 보고해 "이미 쓴 티켓"임을 명확히 한다(일회성 보장).

        소진은 store.try_consume로 **원자적**으로 처리한다 — 같은 티켓이 동시에 들어와도
        정확히 1명만 허용된다(TOCTOU 차단). 동시 호출에서 진 쪽은 CONSUMED로 거부된다.

        Args:
            raw_ticket: 클라이언트가 들고 온 티켓 원문.

        Returns:
            허용이면 payload를 담은 결과, 거부면 TicketRejection을 담은 결과.
        """
        ticket_id = _hash_ticket(raw_ticket)
        record = self._store.get(ticket_id)

        if record is None:
            return TicketResult.reject(TicketRejection.FORGED)
        if record.consumed:
            return TicketResult.reject(TicketRejection.CONSUMED)
        if self._clock() >= record.expires_at:
            return TicketResult.reject(TicketRejection.EXPIRED)

        # 원자적 소진 — 동시 검증 경쟁에서 진 쪽(또는 이미 소진)은 False → CONSUMED.
        if not self._store.try_consume(ticket_id):
            return TicketResult.reject(TicketRejection.CONSUMED)
        return TicketResult.allow(dict(record.payload))
