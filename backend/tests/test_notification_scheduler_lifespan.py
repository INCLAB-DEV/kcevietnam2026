"""알림 스케줄러 lifespan 게이트 테스트 (ADR-0010) — SCHEDULER_ENABLED 온/오프와 태스크 생명주기.

`test_notification_scheduler.py`/`test_meetings_scheduler.py`는 tick 함수(순수 로직)를 21개
테스트로 커버한다. 이 파일이 잠그는 건 그 tick을 감싸는 `reminder_scheduler_lifespan`
자체다 — 실운영에서 `settings.scheduler_enabled`를 True로 켤 예정인데, 이 게이트를 아무도
테스트하지 않으면 "플래그를 켰는데 태스크가 안 뜬다" / "앱 종료 시 태스크가 안 죽는다" 같은
회귀를 잡을 수 없다.

DB나 SMTP에 붙지 않는다 — `SessionLocal`과 두 tick 함수를 모듈 전역으로 monkeypatch해서 갈아
끼우고, `asyncio.sleep`도 패치해 실제 60초(TICK_INTERVAL_SECONDS)를 기다리지 않는다. 전부
순수 asyncio라 pytest-asyncio 없이 `asyncio.run()`으로 감싼 동기 테스트로 작성한다(이 프로젝트
테스트 스위트에 pytest-asyncio 설정이 없다).
"""

from __future__ import annotations

import asyncio

from app.config import settings
from app.notifications import scheduler


class _FakeSession:
    """`with SessionLocal() as db:` 형태만 만족하면 되는 더미 — 실제 쿼리는 절대 안 나간다."""

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False


def _patch_session_local(monkeypatch):
    """`_reminder_loop`가 여는 `SessionLocal()`을 실제 DB 커넥션 없는 더미로 갈아끼운다."""
    monkeypatch.setattr(scheduler, "SessionLocal", lambda: _FakeSession())


def _patch_ticks_noop(monkeypatch):
    """두 tick 함수를 아무 일도 안 하는 no-op으로 바꾼다(반환값은 tick 시그니처와 무관하게 무시됨)."""
    monkeypatch.setattr(scheduler, "run_reminder_tick", lambda db, now, **kw: [])
    monkeypatch.setattr(scheduler, "run_completion_tick", lambda db, now, **kw: [])


def _patch_fast_sleep(monkeypatch):
    """`TICK_INTERVAL_SECONDS`(60초) 대기를 없애고 이벤트 루프에 제어권만 한 번 돌려준다.

    `asyncio.sleep(0)`은 실제 지연 없이 다른 태스크가 스케줄될 체크포인트만 만든다 — 루프가
    타이트 스핀이 되긴 하지만 각 반복이 no-op tick이라 즉시 끝나고, 테스트가 바로 태스크를
    취소하므로 실행 시간에 영향이 없다.
    """

    orig_sleep = asyncio.sleep

    async def fake_sleep(_seconds):
        await orig_sleep(0)

    monkeypatch.setattr(scheduler.asyncio, "sleep", fake_sleep)


def test_disabled_by_default_creates_no_task(monkeypatch):
    """`scheduler_enabled=False`(기본값)면 lifespan이 백그라운드 태스크를 전혀 만들지 않는다."""
    monkeypatch.setattr(settings, "scheduler_enabled", False)
    created_tasks = []
    orig_create_task = asyncio.create_task

    def spy_create_task(coro, *args, **kwargs):
        task = orig_create_task(coro, *args, **kwargs)
        created_tasks.append(task)
        return task

    monkeypatch.setattr(scheduler.asyncio, "create_task", spy_create_task)

    async def scenario():
        async with scheduler.reminder_scheduler_lifespan(app=None):
            pass

    asyncio.run(scenario())

    assert created_tasks == []


def test_enabled_creates_task_that_stays_alive_in_context(monkeypatch):
    """`scheduler_enabled=True`면 태스크가 생성되고, lifespan 컨텍스트 안에서는 아직 살아있다."""
    monkeypatch.setattr(settings, "scheduler_enabled", True)
    _patch_session_local(monkeypatch)
    _patch_ticks_noop(monkeypatch)
    _patch_fast_sleep(monkeypatch)

    captured_task: dict[str, asyncio.Task] = {}
    orig_create_task = asyncio.create_task

    def spy_create_task(coro, *args, **kwargs):
        task = orig_create_task(coro, *args, **kwargs)
        captured_task["task"] = task
        return task

    monkeypatch.setattr(scheduler.asyncio, "create_task", spy_create_task)

    async def scenario():
        async with scheduler.reminder_scheduler_lifespan(app=None):
            # 태스크를 한 번 스케줄시킨다 — create_task 직후엔 아직 실행 전이라 done()이
            # False인 게 당연하므로, 최소 한 체크포인트는 이벤트 루프에 양보해야 의미가 있다.
            await asyncio.sleep(0)
            assert "task" in captured_task
            assert captured_task["task"].done() is False

    asyncio.run(scenario())


def test_task_is_cancelled_cleanly_on_context_exit(monkeypatch):
    """lifespan 컨텍스트를 빠져나가면 태스크가 취소되고, CancelledError가 밖으로 새지 않는다."""
    monkeypatch.setattr(settings, "scheduler_enabled", True)
    _patch_session_local(monkeypatch)
    _patch_ticks_noop(monkeypatch)
    _patch_fast_sleep(monkeypatch)

    captured_task: dict[str, asyncio.Task] = {}
    orig_create_task = asyncio.create_task

    def spy_create_task(coro, *args, **kwargs):
        task = orig_create_task(coro, *args, **kwargs)
        captured_task["task"] = task
        return task

    monkeypatch.setattr(scheduler.asyncio, "create_task", spy_create_task)

    async def scenario():
        async with scheduler.reminder_scheduler_lifespan(app=None):
            await asyncio.sleep(0)
        # 여기까지 예외 없이 도달했다는 것 자체가 CancelledError가 suppress됐다는 증거다.

    asyncio.run(scenario())  # 컨텍스트 종료가 예외 없이 끝나야 한다.

    task = captured_task["task"]
    assert task.done() is True
    assert task.cancelled() is True


def test_loop_survives_tick_exception_and_retries_next_tick(monkeypatch):
    """한 tick(`run_reminder_tick`)이 예외를 던져도 `_reminder_loop`가 죽지 않고 다음 tick을 돈다.

    `except Exception`(scheduler.py) 방어선을 검증한다 — 첫 호출은 예외, 두 번째부터는 성공하게
    monkeypatch하고, 호출이 2회 이상 일어나는지 본다. `asyncio.sleep`은 패치돼 있어 실제로 60초
    기다리지 않는다.
    """
    monkeypatch.setattr(settings, "scheduler_enabled", True)
    _patch_session_local(monkeypatch)
    _patch_fast_sleep(monkeypatch)

    call_count = {"n": 0}

    def flaky_reminder_tick(db, now, **kwargs):
        call_count["n"] += 1
        if call_count["n"] == 1:
            raise RuntimeError("의도적 tick 실패 — 방어선 검증용")
        return []

    monkeypatch.setattr(scheduler, "run_reminder_tick", flaky_reminder_tick)
    monkeypatch.setattr(scheduler, "run_completion_tick", lambda db, now, **kw: [])

    async def scenario():
        async with scheduler.reminder_scheduler_lifespan(app=None):
            # call_count가 2 이상이 될 때까지 짧게 폴링한다 — 타이트 스핀 루프이므로
            # 몇 번의 양보(sleep(0))만으로 충분하고, 무한정 기다리지 않도록 타임아웃을 건다.
            async def wait_for_second_call():
                while call_count["n"] < 2:
                    await asyncio.sleep(0)

            await asyncio.wait_for(wait_for_second_call(), timeout=1)

    asyncio.run(scenario())

    assert call_count["n"] >= 2
