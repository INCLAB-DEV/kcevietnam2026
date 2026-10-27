"""boto3 클라이언트 공유(동시성 하드닝 1차 후속) — 요청·첫 로그인마다 클라이언트를 새로 만들지 않는다.

boto3 기본 세션 경유 클라이언트 생성은 thread-safe가 아니다. 업로드·전사·로그인이 모두 스레드풀에서 돌므로
첫 요청이 몰리면 생성이 경합할 수 있었다. 이제 (서비스, 리전)마다 락 아래 전용 Session에서 한 번만 만든다
(app.aws_clients). 쓰는 곳 세 군데를 각각 잠근다:

- 녹음 원본 보관(app.services.storage.S3Storage — deps.get_storage가 요청마다 만든다)
- 명단 원본 보관(app.storage.S3Storage — app.storage.get_storage가 요청마다 만든다)
- Cognito 유저풀(app.auth.cognito_pool.AwsCognitoUserPool — 로그인 경로의 _prod_cognito_pool)

네트워크는 타지 않는다 — ``boto3.Session``을 생성 횟수를 세는 가짜로 바꾼다. 생성에 시간이 걸리게 해 동시 첫
호출 경합 창을 넓힌다(락이 없다면 그 사이 다른 스레드도 '아직 없음'을 보고 각자 만든다).
"""

from __future__ import annotations

import threading
import time
from collections.abc import Callable
from types import SimpleNamespace

import boto3
import pytest

from app.auth import login_router
from app.auth.cognito_pool import AwsCognitoUserPool
from app.aws_clients import reset_shared_boto3_clients
from app.config import Settings, settings
from app.services.factory import build_storage
from app.services.storage import FakeStorage
from app.services.storage import S3Storage as RecordingS3Storage
from app.storage import NullStorage
from app.storage import S3Storage as RosterS3Storage
from app.storage import get_storage as get_roster_storage


@pytest.fixture
def created(monkeypatch):
    """``boto3.Session().client()``가 만든 클라이언트 목록."""
    clients: list[SimpleNamespace] = []
    lock = threading.Lock()

    class _Session:
        def client(self, service_name, region_name=None, config=None):
            time.sleep(0.02)
            client = SimpleNamespace(service=service_name, region=region_name, config=config)
            with lock:
                clients.append(client)
            return client

    monkeypatch.setattr(boto3, "Session", _Session)
    reset_shared_boto3_clients()
    yield clients
    reset_shared_boto3_clients()


def _run_concurrently(fn: Callable[[], object], n: int = 8) -> list[object]:
    """n개 스레드가 동시에(배리어) ``fn``을 처음 부른다 — 결과를 모아 돌려준다."""
    barrier = threading.Barrier(n)
    results: list[object] = []
    lock = threading.Lock()

    def worker() -> None:
        barrier.wait()
        value = fn()
        with lock:
            results.append(value)

    threads = [threading.Thread(target=worker) for _ in range(n)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=5)
    assert len(results) == n
    return results


# =============================================================================
# 녹음 원본 보관 — app.services.storage
# =============================================================================
def _recording_s3_settings(region: str = "ap-northeast-2") -> Settings:
    return Settings(storage_backend="s3", s3_bucket="nabi-recordings", aws_region=region)


class TestRecordingStorage:
    def test_storage_built_per_request_reuses_one_client(self, created):
        first = build_storage(_recording_s3_settings())
        second = build_storage(_recording_s3_settings())

        assert isinstance(first, RecordingS3Storage) and isinstance(second, RecordingS3Storage)
        assert first._s3 is second._s3  # type: ignore[attr-defined]
        assert [(c.service, c.region) for c in created] == [("s3", "ap-northeast-2")]

    def test_concurrent_first_use_creates_exactly_one_client(self, created):
        built = _run_concurrently(lambda: build_storage(_recording_s3_settings()))
        assert len(created) == 1
        assert all(s._s3 is created[0] for s in built)  # type: ignore[attr-defined]

    def test_each_region_gets_its_own_shared_client(self, created):
        seoul = build_storage(_recording_s3_settings("ap-northeast-2"))
        tokyo = build_storage(_recording_s3_settings("ap-northeast-1"))
        assert seoul._s3 is not tokyo._s3  # type: ignore[attr-defined]
        assert sorted(c.region for c in created) == ["ap-northeast-1", "ap-northeast-2"]

    def test_fake_backend_is_unchanged(self, created):
        s = Settings(storage_backend="fake")
        a, b = build_storage(s), build_storage(s)
        assert isinstance(a, FakeStorage) and isinstance(b, FakeStorage)
        assert a is not b  # 요청마다 새 인메모리 저장소 — 예전 그대로
        assert created == []

    def test_missing_bucket_still_fails_fast_without_creating_a_client(self, created):
        with pytest.raises(RuntimeError, match="S3 버킷 미설정"):
            build_storage(Settings(storage_backend="s3", s3_bucket=None))
        assert created == []


# =============================================================================
# 명단 원본 보관 — app.storage
# =============================================================================
class TestRosterStorage:
    def test_concurrent_first_use_creates_exactly_one_client(self, created, monkeypatch):
        monkeypatch.setattr(settings, "s3_bucket", "nabi-roster-originals")
        monkeypatch.setattr(settings, "aws_region", "ap-northeast-2")

        built = _run_concurrently(get_roster_storage)

        assert all(isinstance(s, RosterS3Storage) for s in built)
        assert [(c.service, c.region) for c in created] == [("s3", "ap-northeast-2")]
        assert all(s._client is created[0] for s in built)  # type: ignore[attr-defined]

    def test_shares_the_s3_client_with_recording_storage(self, created, monkeypatch):
        monkeypatch.setattr(settings, "s3_bucket", "nabi-roster-originals")
        monkeypatch.setattr(settings, "aws_region", "ap-northeast-2")

        roster = get_roster_storage()
        recording = build_storage(_recording_s3_settings("ap-northeast-2"))

        assert roster._client is recording._s3  # type: ignore[attr-defined]
        assert len(created) == 1

    def test_no_bucket_means_null_storage_and_no_client(self, created, monkeypatch):
        monkeypatch.setattr(settings, "s3_bucket", None)
        assert isinstance(get_roster_storage(), NullStorage)
        assert created == []


# =============================================================================
# Cognito 유저풀 — app.auth.cognito_pool (로그인 경로)
# =============================================================================
def _pool(**overrides) -> AwsCognitoUserPool:
    kwargs = dict(
        user_pool_id="pool-test",
        app_client_id="client-test",
        region="ap-northeast-2",
        password_secret="secret-test",
    )
    kwargs.update(overrides)
    return AwsCognitoUserPool(**kwargs)


class TestCognitoPool:
    def test_concurrent_first_use_creates_exactly_one_client(self, created):
        pools = _run_concurrently(_pool)
        assert [(c.service, c.region) for c in created] == [("cognito-idp", "ap-northeast-2")]
        assert all(p._client is created[0] for p in pools)  # type: ignore[attr-defined]

    def test_concurrent_first_logins_share_one_client_through_prod_pool(self, created, monkeypatch):
        """로그인 경로 그대로 — ``_prod_cognito_pool``의 lru_cache는 동시 첫 호출을 막지 않아 풀 객체가 여럿
        생길 수 있지만, boto3 클라이언트는 하나다."""
        monkeypatch.setattr(settings, "cognito_user_pool_id", "pool-test")
        monkeypatch.setattr(settings, "cognito_client_id", "client-test")
        monkeypatch.setattr(settings, "cognito_session_password_secret", "secret-test")
        monkeypatch.setattr(settings, "aws_region", "ap-northeast-2")
        login_router._prod_cognito_pool.cache_clear()
        try:
            pools = _run_concurrently(login_router._prod_cognito_pool)
        finally:
            # 가짜 클라이언트를 쥔 풀이 다른 테스트로 새지 않게 캐시를 비운다.
            login_router._prod_cognito_pool.cache_clear()

        assert [(c.service, c.region) for c in created] == [("cognito-idp", "ap-northeast-2")]
        assert all(p._client is created[0] for p in pools)  # type: ignore[attr-defined]

    def test_injected_client_bypasses_boto3(self, created):
        injected = object()
        assert _pool(client=injected)._client is injected  # type: ignore[attr-defined]
        assert created == []


# =============================================================================
# 공통 — 연결·응답 타임아웃과 재시도를 명시한다(botocore 기본에 맡기지 않는다)
# =============================================================================
def test_every_shared_client_is_created_with_explicit_timeouts_and_retries(created, monkeypatch):
    monkeypatch.setattr(settings, "s3_bucket", "nabi-roster-originals")
    monkeypatch.setattr(settings, "aws_region", "ap-northeast-2")
    build_storage(_recording_s3_settings("ap-northeast-1"))
    get_roster_storage()
    _pool()

    assert sorted((c.service, c.region) for c in created) == [
        ("cognito-idp", "ap-northeast-2"),
        ("s3", "ap-northeast-1"),
        ("s3", "ap-northeast-2"),
    ]
    for client in created:
        assert client.config.connect_timeout == 5
        assert client.config.read_timeout == 60
        assert client.config.retries == {"max_attempts": 3, "mode": "standard"}
        # 업로드 4건 × 4조각 + 내려받기 3건 × 4조각 = 28 동시 전송이 한 공유 클라이언트를 쓴다(기본 10이면 모자란다).
        assert client.config.max_pool_connections == 32
