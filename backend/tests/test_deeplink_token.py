"""deeplink-token 단위 테스트 — 외부 동작(허용/거부·일회성)만 검증(F-AU-001, #20).

토큰 내부 포맷·해시·저장소 키를 들여다보지 않는다. 발급→검증의 관찰 가능한 결과만 본다
(F-AU-001 Testing Decisions: "토큰 내부 포맷이 아니라 외부 동작").

시간은 주입한 mutable 시계로 제어해 만료를 결정적으로 재현한다 — sleep·실시간 의존 없음.
"""

import threading
from datetime import datetime, timedelta, timezone

import pytest

from app.auth.deeplink_token import (
    DeepLinkTokenService,
    RejectionCode,
)


class FakeClock:
    """주입용 가짜 시계 — advance로 시간을 앞으로 밀어 만료를 재현한다."""

    def __init__(self, now: datetime) -> None:
        self._now = now

    def __call__(self) -> datetime:
        return self._now

    def advance(self, delta: timedelta) -> None:
        self._now += delta


@pytest.fixture
def clock() -> FakeClock:
    return FakeClock(datetime(2026, 9, 1, 9, 0, tzinfo=timezone.utc))


@pytest.fixture
def service(clock: FakeClock) -> DeepLinkTokenService:
    # 기본 in-memory 저장소 + 주입 시계. TTL은 테스트별로 issue에서 지정.
    return DeepLinkTokenService(clock=clock, default_ttl=timedelta(hours=1))


# --- 유효 토큰 → 허용 + 진입 컨텍스트 반환 -----------------------------------
def test_valid_token_allows_entry_and_returns_context(service):
    token = service.issue({"registrant_id": "r-123", "event_id": "e-1"})
    result = service.verify(token)

    assert result.allowed is True
    assert result.rejection is None
    assert result.context == {"registrant_id": "r-123", "event_id": "e-1"}


# --- 위조/미발급 토큰 → 거부 + FORGED ----------------------------------------
def test_unknown_token_rejected_as_forged(service):
    result = service.verify("never-issued-this-token")

    assert result.allowed is False
    assert result.rejection is RejectionCode.FORGED


def test_tampered_token_rejected_as_forged(service):
    token = service.issue({"registrant_id": "r-1"})
    result = service.verify(token + "tampered")

    assert result.allowed is False
    assert result.rejection is RejectionCode.FORGED


# --- 만료 토큰 → 거부 + EXPIRED ----------------------------------------------
def test_expired_token_rejected(service, clock):
    token = service.issue({"registrant_id": "r-1"}, ttl=timedelta(minutes=30))
    clock.advance(timedelta(minutes=31))

    result = service.verify(token)

    assert result.allowed is False
    assert result.rejection is RejectionCode.EXPIRED


def test_token_valid_right_before_expiry(service, clock):
    token = service.issue({"registrant_id": "r-1"}, ttl=timedelta(minutes=30))
    clock.advance(timedelta(minutes=29))

    assert service.verify(token).allowed is True


def test_token_rejected_exactly_at_expiry(service, clock):
    token = service.issue({"registrant_id": "r-1"}, ttl=timedelta(minutes=30))
    clock.advance(timedelta(minutes=30))  # 만료 시각 == now → 거부

    result = service.verify(token)
    assert result.allowed is False
    assert result.rejection is RejectionCode.EXPIRED


# --- 일회성: 1회 소진 후 재사용 거부 -----------------------------------------
def test_one_time_token_consumed_after_first_use(service):
    token = service.issue({"registrant_id": "r-1"})

    first = service.verify(token)
    second = service.verify(token)

    assert first.allowed is True
    assert second.allowed is False
    assert second.rejection is RejectionCode.CONSUMED


def test_concurrent_verification_allows_exactly_one(service):
    # 동시 검증 경쟁(TOCTOU)에서도 일회성 보장 — 정확히 1개 요청만 허용.
    token = service.issue({"registrant_id": "r-1"})
    results = []
    barrier = threading.Barrier(8)

    def attempt():
        barrier.wait()  # 8개 스레드를 동시에 출발시켜 경쟁을 최대화
        results.append(service.verify(token))

    threads = [threading.Thread(target=attempt) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    allowed = [r for r in results if r.allowed]
    assert len(allowed) == 1, "동시 검증에서도 정확히 1회만 허용돼야 한다"
    assert all(
        r.rejection is RejectionCode.CONSUMED for r in results if not r.allowed
    )


def test_consumed_token_stays_consumed_on_repeated_reuse(service):
    token = service.issue({"registrant_id": "r-1"})
    service.verify(token)

    for _ in range(3):
        assert service.verify(token).rejection is RejectionCode.CONSUMED


def test_consumed_reported_even_after_expiry(service, clock):
    # 소진된 토큰은 만료돼도 CONSUMED로 보고 — "이미 쓴 링크"임을 우선 안내.
    token = service.issue({"registrant_id": "r-1"}, ttl=timedelta(minutes=30))
    assert service.verify(token).allowed is True
    clock.advance(timedelta(hours=2))

    assert service.verify(token).rejection is RejectionCode.CONSUMED


# --- 토큰 간 격리: 한 토큰 소진이 다른 토큰에 영향 없음 -----------------------
def test_tokens_are_independent(service):
    token_a = service.issue({"registrant_id": "a"})
    token_b = service.issue({"registrant_id": "b"})

    service.verify(token_a)  # a 소진

    result_b = service.verify(token_b)
    assert result_b.allowed is True
    assert result_b.context == {"registrant_id": "b"}


# --- 발급 토큰은 매번 다르다(예측 불가) — 외부 관찰 가능한 속성 ---------------
def test_issued_tokens_are_unique(service):
    tokens = {service.issue({"i": i}) for i in range(50)}
    assert len(tokens) == 50


# --- 반환 컨텍스트는 복사본 — 호출자가 바꿔도 저장본 불변 ---------------------
def test_returned_context_is_isolated_copy(service):
    token = service.issue({"registrant_id": "r-1", "roles": "exhibitor"})
    result = service.verify(token)
    result.context["registrant_id"] = "HACKED"

    # 같은 토큰은 소진됐으니, 새 토큰으로 원본 컨텍스트가 오염되지 않았는지 확인.
    token2 = service.issue({"registrant_id": "r-2"})
    assert service.verify(token2).context == {"registrant_id": "r-2"}
