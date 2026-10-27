"""POST /api/auth/deeplink/verify 엔드포인트 테스트 — FastAPI 경유 동작 검증(#20).

Next.js가 DB 직접 접근 없이 호출하는 경계(ADR-0008 경계 B)를 TestClient로 재현한다.
엔드포인트가 토큰 모듈을 올바르게 노출하는지(허용→200+컨텍스트, 거부→401+사유) 본다.
"""

from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from app.auth.deeplink_token import DeepLinkTokenService
from app.auth.router import get_deeplink_service
from app.main import app


class FakeClock:
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
    return DeepLinkTokenService(clock=clock, default_ttl=timedelta(hours=1))


@pytest.fixture
def client(service: DeepLinkTokenService) -> TestClient:
    # 엔드포인트의 토큰 서비스를 테스트가 제어하는 인스턴스로 교체(발급도 같은 store로).
    app.dependency_overrides[get_deeplink_service] = lambda: service
    yield TestClient(app)
    app.dependency_overrides.clear()


def test_valid_token_returns_context(client, service):
    token = service.issue({"registrant_id": "r-9", "event_id": "e-1"})

    resp = client.post("/api/auth/deeplink/verify", json={"token": token})

    assert resp.status_code == 200
    assert resp.json()["context"] == {"registrant_id": "r-9", "event_id": "e-1"}


def test_forged_token_rejected_with_reason(client):
    resp = client.post("/api/auth/deeplink/verify", json={"token": "bogus"})

    assert resp.status_code == 401
    assert resp.json()["detail"]["reason"] == "forged"


def test_expired_token_rejected_with_reason(client, service, clock):
    token = service.issue({"registrant_id": "r-1"}, ttl=timedelta(minutes=10))
    clock.advance(timedelta(minutes=11))

    resp = client.post("/api/auth/deeplink/verify", json={"token": token})

    assert resp.status_code == 401
    assert resp.json()["detail"]["reason"] == "expired"


def test_one_time_token_reuse_rejected_via_endpoint(client, service):
    token = service.issue({"registrant_id": "r-1"})

    first = client.post("/api/auth/deeplink/verify", json={"token": token})
    second = client.post("/api/auth/deeplink/verify", json={"token": token})

    assert first.status_code == 200
    assert second.status_code == 401
    assert second.json()["detail"]["reason"] == "consumed"


def test_empty_token_is_rejected_by_validation(client):
    resp = client.post("/api/auth/deeplink/verify", json={"token": ""})
    assert resp.status_code == 422  # pydantic min_length 검증
