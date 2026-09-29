"""deeplink-token — 딥링크 진입 토큰 발급·검증을 캡슐화하는 deep module(F-AU-001, #20).

사용자는 긴 랜덤·만료·일회성 토큰이 박힌 딥링크로 `/login`에 도착한다. 이 모듈은 토큰의
**외부 동작**만 책임진다 — 발급(issue)하면 불투명 문자열을 주고, 검증(verify)하면 진입을
허용하거나(유효) 사유 코드와 함께 거부한다(만료·위조·소진).

설계 경계(ADR-0008 / F-AU-001 D6 — 소스 교체 가능):
- **저장소(store)와 시계(clock)를 주입**받는다. 기본은 in-memory + UTC now. 추후 DB 백엔드
  TokenStore 구현으로 갈아끼우면 발급/검증 로직·계약은 그대로 유지된다.
- 토큰 원문은 저장하지 않는다. **SHA-256 해시(token_id)** 만 보관 — 저장소가 새도 원문 복원
  불가. 검증은 동작(허용/거부)만 노출하고 내부 포맷은 호출자에게 숨긴다.

신원의 닻은 토큰 자체가 아니라 뒤따르는 DX Korea 아이디/비번 검증이다(F-AU-001 D2). 이
모듈은 진입 컨텍스트(어느 명단 레코드를 가리키는 링크인가)를 토큰에 묶어두는 역할까지만 한다.
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

# 기본 토큰 수명 — 전시회 진입 링크라 비교적 길게(2주). 발급 시 개별 override 가능.
DEFAULT_TTL = timedelta(days=14)

# 발급 토큰 엔트로피(bytes). secrets.token_urlsafe는 base64url로 약 1.3배 길이가 된다.
_TOKEN_BYTES = 32


def _utcnow() -> datetime:
    """주입 가능한 기본 시계 — timezone-aware UTC."""
    return datetime.now(timezone.utc)


class RejectionCode(str, Enum):
    """검증 거부 사유 — 호출자(엔드포인트/UI)가 다음 안내를 정하는 데 쓴다(F-AU-001 US11)."""

    FORGED = "forged"  # 알 수 없는 토큰 — 발급된 적 없거나 변조됨
    EXPIRED = "expired"  # 만료 시각 경과
    CONSUMED = "consumed"  # 일회성 토큰이 이미 1회 소진됨


@dataclass(frozen=True)
class TokenRecord:
    """저장소에 보관되는 발급 토큰의 상태. 원문이 아니라 해시(token_id)로 키잉된다."""

    context: dict[str, Any]  # 검증 성공 시 반환할 진입 컨텍스트(명단 레코드 포인터 등)
    expires_at: datetime  # 이 시각 이후 검증은 EXPIRED
    consumed: bool = False  # 일회성 — 1회 검증 성공 후 True


@dataclass(frozen=True)
class VerificationResult:
    """검증 결과 — 허용이면 context, 거부면 rejection 사유. 둘 중 하나만 채워진다."""

    allowed: bool
    context: dict[str, Any] | None = None
    rejection: RejectionCode | None = None

    @classmethod
    def allow(cls, context: dict[str, Any]) -> VerificationResult:
        return cls(allowed=True, context=context)

    @classmethod
    def reject(cls, code: RejectionCode) -> VerificationResult:
        return cls(allowed=False, rejection=code)


class TokenStore(Protocol):
    """발급 토큰 저장소 계약. in-memory가 기본, DB 백엔드로 교체 가능(F-AU-001 D6)."""

    def put(self, token_id: str, record: TokenRecord) -> None:
        """발급된 토큰 레코드를 token_id(해시) 키로 저장한다."""
        ...

    def get(self, token_id: str) -> TokenRecord | None:
        """token_id로 레코드를 조회한다. 없으면 None(= 위조/미발급)."""
        ...

    def try_consume(self, token_id: str) -> bool:
        """일회성 토큰을 **원자적으로** 소진한다 — 동시 호출 시 정확히 1명만 True.

        consumed False→True 전이를 한 연산으로 처리해 read/check/update 사이의
        경쟁(두 동시 요청이 모두 허용되는 TOCTOU)을 막는다. 이 원자성은 일회성
        보장의 핵심이다 — DB 구현은 `UPDATE ... WHERE NOT consumed RETURNING` 등
        단일 문으로 같은 보장을 제공해야 한다.

        Returns:
            이 호출이 소진의 승자면 True. 미발급이거나 이미 소진됐으면 False.
        """
        ...


@dataclass
class InMemoryTokenStore:
    """프로세스 메모리 저장소 — 데모·테스트·단일 인스턴스용 기본 구현.

    영속성이 필요해지면 같은 TokenStore 계약을 따르는 DB 구현으로 교체한다(발급/검증 불변).
    소진은 락으로 원자화 — sync 엔드포인트가 스레드풀에서 동시 실행돼도 일회성을 보장한다.
    """

    _records: dict[str, TokenRecord] = field(default_factory=dict)
    _lock: threading.Lock = field(default_factory=threading.Lock)

    def put(self, token_id: str, record: TokenRecord) -> None:
        with self._lock:
            self._records[token_id] = record

    def get(self, token_id: str) -> TokenRecord | None:
        with self._lock:
            return self._records.get(token_id)

    def try_consume(self, token_id: str) -> bool:
        with self._lock:
            record = self._records.get(token_id)
            if record is None or record.consumed:
                return False
            self._records[token_id] = TokenRecord(
                context=record.context, expires_at=record.expires_at, consumed=True
            )
            return True


def _hash_token(raw_token: str) -> str:
    """토큰 원문 → 저장소 키(SHA-256 hex). 원문은 어디에도 보관하지 않는다."""
    return hashlib.sha256(raw_token.encode("utf-8")).hexdigest()


class DeepLinkTokenService:
    """딥링크 토큰 발급·검증 서비스. 저장소·시계를 주입받아 I/O와 시간을 경계 밖으로 뺀다."""

    def __init__(
        self,
        store: TokenStore | None = None,
        clock: Callable[[], datetime] = _utcnow,
        default_ttl: timedelta = DEFAULT_TTL,
    ) -> None:
        self._store = store if store is not None else InMemoryTokenStore()
        self._clock = clock
        self._default_ttl = default_ttl

    def issue(
        self, context: dict[str, Any], ttl: timedelta | None = None
    ) -> str:
        """진입 컨텍스트에 묶인 새 딥링크 토큰을 발급한다.

        Args:
            context: 검증 성공 시 그대로 반환할 진입 컨텍스트(명단 레코드 포인터 등).
            ttl: 토큰 수명. 미지정 시 기본(DEFAULT_TTL).

        Returns:
            딥링크 URL에 실어 보낼 불투명 토큰 원문. 호출자는 이 문자열만 다룬다.
        """
        raw_token = secrets.token_urlsafe(_TOKEN_BYTES)
        expires_at = self._clock() + (ttl if ttl is not None else self._default_ttl)
        self._store.put(
            _hash_token(raw_token),
            TokenRecord(context=dict(context), expires_at=expires_at),
        )
        return raw_token

    def verify(self, raw_token: str) -> VerificationResult:
        """토큰을 검증하고 진입을 허용/거부한다. 성공 시 일회성 토큰을 소진한다.

        거부 우선순위: 위조(미발급) → 소진(재사용) → 만료. 재사용은 만료 여부와 무관하게
        CONSUMED로 보고해 "이미 쓴 링크"임을 명확히 한다(일회성 보장).

        소진은 store.try_consume로 **원자적**으로 처리한다 — 같은 토큰이 동시에 들어와도
        정확히 1명만 허용된다(TOCTOU 차단). 동시 호출에서 진 쪽은 CONSUMED로 거부된다.

        Args:
            raw_token: 딥링크로 들어온 토큰 원문.

        Returns:
            허용이면 context를 담은 결과, 거부면 RejectionCode를 담은 결과.
        """
        token_id = _hash_token(raw_token)
        record = self._store.get(token_id)

        if record is None:
            return VerificationResult.reject(RejectionCode.FORGED)
        if record.consumed:
            return VerificationResult.reject(RejectionCode.CONSUMED)
        if self._clock() >= record.expires_at:
            return VerificationResult.reject(RejectionCode.EXPIRED)

        # 원자적 소진 — 동시 검증 경쟁에서 진 쪽(또는 이미 소진)은 False → CONSUMED.
        if not self._store.try_consume(token_id):
            return VerificationResult.reject(RejectionCode.CONSUMED)
        return VerificationResult.allow(dict(record.context))
