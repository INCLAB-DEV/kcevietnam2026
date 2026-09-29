"""jwks-cache 계약 테스트 — CognitoJwks의 TTL 캐시/강제 재fetch/정적 오버라이드(F-AU-001, 실 Cognito 배선).

fetcher·clock을 주입해 네트워크 없이 캐시 동작(만료 전 재사용, 만료 후 재fetch, force_refresh,
정적 오버라이드 우선, issuer 미설정 시 빈 키셋)을 결정적으로 검증한다. 스레드 안전성(원자적
``_snapshot`` 교체 + 락)은 실 스레드로 동시 호출을 몰아 검증한다(크로스벤더 보안 리뷰 반영).
"""

from __future__ import annotations

import threading
import time

from app.auth.jwks_cache import CognitoJwks

ISSUER = "https://cognito-idp.ap-northeast-2.amazonaws.com/pool-XYZ"


class _FakeClock:
    """수동으로 시간을 흘려보내는 테스트용 단조 시계."""

    def __init__(self) -> None:
        self.now = 0.0

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


def _counting_fetcher(calls: list[str]):
    def _fetch(url: str) -> dict:
        calls.append(url)
        return {"keys": [{"kid": f"k-{len(calls)}"}]}

    return _fetch


def test_fetches_on_first_call_and_caches_within_ttl():
    calls: list[str] = []
    clock = _FakeClock()
    provider = CognitoJwks(ISSUER, ttl_seconds=900, fetcher=_counting_fetcher(calls), clock=clock)

    first = provider.keys()
    clock.advance(100)  # TTL(900) 안 — 재fetch 없이 캐시 재사용
    second = provider.keys()

    assert first == second
    assert calls == [f"{ISSUER}/.well-known/jwks.json"]


def test_refetches_after_ttl_expires():
    calls: list[str] = []
    clock = _FakeClock()
    provider = CognitoJwks(ISSUER, ttl_seconds=60, fetcher=_counting_fetcher(calls), clock=clock)

    first = provider.keys()
    clock.advance(61)  # TTL 만료
    second = provider.keys()

    assert len(calls) == 2
    assert first != second  # 재fetch라 다른 키(카운팅 fetcher가 매번 다른 kid를 낸다)


def test_force_refresh_bypasses_ttl_immediately():
    calls: list[str] = []
    clock = _FakeClock()
    provider = CognitoJwks(ISSUER, ttl_seconds=900, fetcher=_counting_fetcher(calls), clock=clock)

    provider.keys()
    provider.keys(force_refresh=True)  # TTL 안이라도 강제 재fetch(kid-miss 재시도 경로)

    assert len(calls) == 2


def test_static_override_never_calls_fetcher():
    calls: list[str] = []
    override = {"keys": [{"kid": "static"}]}
    provider = CognitoJwks(
        ISSUER, fetcher=_counting_fetcher(calls), static_override=override
    )

    assert provider.keys() == override
    assert provider.keys(force_refresh=True) == override  # force여도 오버라이드 우선
    assert calls == []


def test_missing_issuer_returns_empty_keys_without_fetching():
    calls: list[str] = []
    provider = CognitoJwks(None, fetcher=_counting_fetcher(calls))

    assert provider.keys() == {"keys": []}
    assert calls == []


# =============================================================================
# 스레드 안전성 — 원자적 _snapshot 교체 + 락(크로스벤더 보안 리뷰 반영)
# =============================================================================
def test_concurrent_keys_calls_fetch_only_once_and_agree_on_result():
    """여러 스레드가 동시에 첫 keys()를 부르면, fetch는 1회만 나고 전원이 같은 결과를 받는다.

    ``threading.Barrier``로 N개 스레드를 ``keys()`` 진입 직전까지 같은 순간에 몰아세운다(락 획득
    경쟁의 레이스 창을 최대화). 락으로 보호되는 fetch 구간이 올바르다면 단 1개 스레드만 fetcher를
    부르고, 나머지는 락 획득 후 더블체크에서 그 결과를 재사용해야 한다 — fetcher 안에 작은 지연을
    둬 "동시에 여러 스레드가 fetch에 들어가면" 중복 호출이 드러나게 한다. 수정 전 코드
    (``_cached``/``_fetched_at`` 개별 필드, 락 없음)라면 8개 스레드가 각자 fetcher를 부르거나
    "새 캐시 + 옛 시각" 같은 불일치 스냅샷을 관측할 수 있었다.
    """
    calls: list[str] = []
    call_lock = threading.Lock()
    start_barrier = threading.Barrier(8)

    def _fetch(url: str) -> dict:
        with call_lock:
            calls.append(url)
        time.sleep(0.05)  # 락을 쥔 채 머무는 시간을 늘려, 락이 없다면 다른 스레드가 끼어들 창을 만든다
        return {"keys": [{"kid": "concurrent-fetch"}]}

    provider = CognitoJwks(ISSUER, ttl_seconds=900, fetcher=_fetch)
    results: list[dict] = [None] * 8  # type: ignore[list-item]

    def _worker(i: int) -> None:
        start_barrier.wait(timeout=5)  # keys() 진입 직전까지 8개 스레드를 정렬 — 락 경쟁 레이스 최대화
        results[i] = provider.keys()

    threads = [threading.Thread(target=_worker, args=(i,)) for i in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=5)

    assert len(calls) == 1  # 락이 없었다면 8개 스레드가 각자 fetch했을 것 — thundering herd 방지 확인
    assert all(r == {"keys": [{"kid": "concurrent-fetch"}]} for r in results)
