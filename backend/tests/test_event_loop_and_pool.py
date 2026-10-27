"""동시성 하드닝(1차) — DB 풀 설정 반영 + 무거운 동기 핸들러가 이벤트 루프에서 돌지 않는지 잠근다.

FastAPI는 ``async def`` 핸들러를 이벤트 루프 위에서 직접 돌린다. 그 안에서 동기 DB 조회·openpyxl 워크북
생성·명단 파싱·boto3 업로드를 하면 그동안 서버 전체가 멈춘다(단일 uvicorn 프로세스). ``def``여야 FastAPI가
스레드풀에서 돌린다 — 아래 핸들러가 다시 ``async def``로 바뀌면 이 테스트가 잡는다.
"""

from __future__ import annotations

import inspect

import pytest

from app.api.reviews import transcribe_and_structure
from app.config import Settings, settings
from app.db import engine
from app.excel.router import (
    export_filtered_members,
    export_meetings,
    export_organizations,
    export_reviews,
)
from app.roster.router import import_members


def test_engine_pool_uses_configured_limits():
    pool = engine.pool
    assert pool.size() == settings.db_pool_size
    assert pool._max_overflow == settings.db_max_overflow  # type: ignore[attr-defined]
    assert pool._timeout == settings.db_pool_timeout  # type: ignore[attr-defined]
    assert pool._pre_ping is settings.db_pool_pre_ping  # type: ignore[attr-defined]


def test_pool_defaults_are_wider_than_sqlalchemy_defaults_and_fail_fast():
    s = Settings(_env_file=None)
    assert (s.db_pool_size, s.db_max_overflow, s.db_pool_timeout, s.db_pool_pre_ping) == (10, 40, 10, True)


@pytest.mark.parametrize(
    "handler",
    [
        export_filtered_members,  # POST /api/admin/export/organizations.xlsx
        export_organizations,  # GET  /api/admin/export/organizations.xlsx
        export_meetings,  # GET  /api/admin/export/meetings.xlsx
        export_reviews,  # GET  /api/admin/export/reviews.xlsx
        import_members,  # POST /organizer/events/{id}/members/import + /api/admin/import/roster
        transcribe_and_structure,  # POST /meetings/{id}/review/step2/transcribe
    ],
    ids=lambda h: h.__name__,
)
def test_heavy_sync_handlers_are_not_coroutines(handler):
    assert not inspect.iscoroutinefunction(handler), f"{handler.__name__} 가 async def 다"
