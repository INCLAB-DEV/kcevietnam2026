"""준비 상태 헬스체크(/health/ready) — 프로세스 생존(/health)에 더해 DB까지 응답하는지 본다.

외부 헬스체크(Route 53)는 프런트 /api/health/ready를 거쳐 이걸 부른다. 잠그는 것:
- DB가 ``SELECT 1``에 답하면 200 ``{"status": "ok"}``.
- DB 연결 실패·시간 초과(풀 고갈 포함)는 503 ``{"status": "unavailable"}`` — 매달리지 않고 짧은 상한 안에 답한다.
  원인 문자열은 응답에 싣지 않는다.
- ``/health``는 그대로(DB를 보지 않는다 — DB 장애로 컨테이너를 재시작시키면 안 된다).
"""

from __future__ import annotations

import threading
import time

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine

from app import main
from app.main import app


@pytest.fixture
def client():
    return TestClient(app)


def test_ready_is_200_when_the_database_answers(client, migrated_db, monkeypatch):
    engine = create_engine(migrated_db, future=True)
    monkeypatch.setattr(main, "engine", engine)
    try:
        resp = client.get("/health/ready")
    finally:
        engine.dispose()
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}


def test_ready_is_503_when_the_database_is_unreachable(client, monkeypatch):
    def _refused():
        raise ConnectionRefusedError("connection to server at 10.0.0.1 port 5432 failed: password=secret")

    monkeypatch.setattr(main, "_ping_database", _refused)
    resp = client.get("/health/ready")
    assert resp.status_code == 503
    assert resp.json() == {"status": "unavailable"}
    assert "secret" not in resp.text and "10.0.0.1" not in resp.text


def test_ready_answers_503_within_the_timeout_when_the_database_hangs(monkeypatch):
    """멈춘 DB 확인을 기다리지 않고 상한(여기선 0.2초)에서 503을 낸다. 확인 스레드는 뒤에서 스스로 끝난다.

    ``with TestClient``로 이벤트 루프를 요청 사이에 살려 둔다(uvicorn과 같다) — 요청마다 루프를 새로 띄우면 루프를
    닫을 때 남은 스레드를 기다려서 응답 시간이 아니라 스레드 시간을 재게 된다.
    """
    release = threading.Event()
    monkeypatch.setattr(main, "READY_DB_TIMEOUT_SECONDS", 0.2)
    monkeypatch.setattr(main, "_ping_database", lambda: release.wait(5))
    with TestClient(app) as client:
        try:
            started = time.monotonic()
            resp = client.get("/health/ready")
            elapsed = time.monotonic() - started
        finally:
            release.set()
    assert resp.status_code == 503
    assert elapsed < 2  # 풀 대기(최대 10초)·멈춘 DB에 헬스체크가 매달리지 않는다


def test_liveness_stays_independent_of_the_database(client, monkeypatch):
    def _broken():
        raise AssertionError("/health 는 DB를 보지 않는다")

    monkeypatch.setattr(main, "_ping_database", _broken)
    resp = client.get("/health")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}


def test_default_db_timeout_fits_the_external_health_check_budget():
    """Route 53은 연결 뒤 2초 안에 응답을 받아야 한다 — 프런트(1.5초)보다 짧게 끊는다."""
    assert main.READY_DB_TIMEOUT_SECONDS < 1.5
