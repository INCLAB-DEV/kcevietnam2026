"""jwks-cache — Cognito 유저풀 JWKS를 동적으로 가져와 TTL 캐시한다(F-AU-001, 실 Cognito 배선).

``principal.get_jwks_provider()``가 프로세스 단일 인스턴스로 들고 있어, 매 요청마다 네트워크를
때리지 않는다. 정적 오버라이드(``static_override``, 보통 ``settings.cognito_jwks_json``)가 있으면
그것만 돌려준다(오프라인 테스트·데모/고정 JWKS 경로 보존 — 네트워크를 전혀 만지지 않는다). 없으면
``issuer``의 ``.well-known/jwks.json``을 fetch해 TTL 동안 캐시한다. ``issuer``도 없으면(인증 미구성)
빈 키셋(``{"keys": []}``)을 낸다 — 여기서 예외를 던지면 "인증 미구성" 판정을 이 모듈이 떠안게 된다
(그 판정은 ``principal.get_current_principal`` 소관). 빈 키셋을 받은 검증자는 kid를 못 찾아 자연히
거부하므로 조용한 통과는 아니다.

키 회전 대응: TTL 만료 시 재fetch는 이 클래스가 스스로 한다. 회전 직후의 kid-miss(캐시가 옛 키만
들고 있을 때)는 이 모듈이 아니라 호출자(``cognito_pool.verify_session_token``)가
``keys(force_refresh=True)``로 1회 재시도한다 — 캐시는 "언제 다시 가져올지"만 안다.

스레드 안전성: FastAPI의 동기 라우트는 threadpool에서 돌아 여러 요청이 동시에 같은
``CognitoJwks`` 인스턴스의 ``keys()``를 부를 수 있다(``get_jwks_provider()``가 프로세스 단일
인스턴스). ``(캐시, fetch시각)``을 개별 필드로 나눠 들고 있으면 한 스레드가 ``_cached``만 갱신하고
``_fetched_at``을 아직 안 갱신한 찰나에 다른 스레드가 TTL 판정을 하다가 "새 키 + 옛 시각" 같은
불일치 스냅샷을 읽는 레이스가 난다. 그래서 두 값을 ``_snapshot`` 튜플 하나로 묶어 **한 번에
교체**한다(CPython에서 단일 참조 재할당은 원자적). fetch 자체(네트워크 호출 + 스냅샷 교체)는
``_lock``으로 감싸 동시 요청이 중복으로 issuer를 때리지 않게 하고(thundering herd 방지), 락 진입
직후 더블체크로 그새 다른 스레드가 이미 갱신했으면 재사용한다.
"""

from __future__ import annotations

import json
import threading
import time
import urllib.request
from typing import Any, Callable

Fetcher = Callable[[str], dict[str, Any]]
Clock = Callable[[], float]


def _urllib_fetch(url: str) -> dict[str, Any]:
    """stdlib만으로 JWKS를 가져온다(신규 의존성 없음) — 실배포 fetch 경로."""
    with urllib.request.urlopen(url, timeout=5) as resp:  # noqa: S310 - 고정 https issuer만 호출
        return json.loads(resp.read())


class CognitoJwks:
    """유저풀 JWKS 제공자 — TTL 캐시 + 정적 오버라이드.

    ``keys()``를 호출할 때까지 네트워크를 만지지 않는다(생성 자체는 순수) — FastAPI 의존성으로
    매 요청 주입돼도 안전하다.
    """

    def __init__(
        self,
        issuer: str | None,
        *,
        ttl_seconds: int = 900,
        fetcher: Fetcher = _urllib_fetch,
        clock: Clock = time.monotonic,
        static_override: dict[str, Any] | None = None,
    ) -> None:
        self._issuer = issuer
        self._ttl_seconds = ttl_seconds
        self._fetcher = fetcher
        self._clock = clock
        self._static_override = static_override
        # (캐시된 키셋, fetch 시각) 한 튜플로 묶어 원자적으로 교체한다 — 부분 갱신 스냅샷 금지.
        self._snapshot: tuple[dict[str, Any], float] | None = None
        self._lock = threading.Lock()

    def keys(self, *, force_refresh: bool = False) -> dict[str, Any]:
        """유저풀 JWKS(``{"keys": [...]}``)를 돌려준다.

        우선순위: 정적 오버라이드 → (TTL 안이면) 캐시 → issuer 없음이면 빈 키셋 → fetch.
        """
        if self._static_override is not None:
            return self._static_override

        # 락 없이 한 번 읽는다 — 스냅샷은 단일 참조라 항상 일관된(캐시,시각) 쌍이다(원자적 교체).
        snapshot = self._snapshot
        if not force_refresh and snapshot is not None:
            cached, fetched_at = snapshot
            if self._clock() - fetched_at < self._ttl_seconds:
                return cached

        if self._issuer is None:
            # 인증 미구성 — fetch할 issuer가 없다. 빈 키셋으로 검증자가 자연히 거부하게 둔다.
            return {"keys": []}

        with self._lock:
            # 더블체크 — 락 대기 중 다른 스레드가 이미 갱신했으면 그 스냅샷을 그대로 재사용하고,
            # 중복으로 issuer를 다시 때리지 않는다(thundering herd 방지).
            snapshot = self._snapshot
            if not force_refresh and snapshot is not None:
                cached, fetched_at = snapshot
                if self._clock() - fetched_at < self._ttl_seconds:
                    return cached
            cached = self._fetcher(f"{self._issuer}/.well-known/jwks.json")
            self._snapshot = (cached, self._clock())  # 원자적 교체 — 한 번에 갈아끼운다
            return cached
