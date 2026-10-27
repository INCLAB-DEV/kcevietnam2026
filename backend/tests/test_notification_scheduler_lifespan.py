"""알림 스케줄러 lifespan 게이트 테스트 (ADR-0010) — SCHEDULER_ENABLED 온/오프와 태스크 생명주기.

`test_notification_scheduler.py`/`test_meetings_scheduler.py`는 tick 함수(순수 로직)를 21개
테스트로 커버한다. 이 파일이 잠그는 건 그 tick을 감싸는 `reminder_scheduler_lifespan`
자체다 — 실운영에서 `settings.scheduler_enabled`를 True로 켤 예정인데, 이 게이트를 아무도
테스트하지 않으면 "플래그를 켰는데 태스크가 안 뜬다" / "앱 종료 시 태스크가 안 죽는다" 같은
회귀를 잡을 수 없다. 꺼진 채로 뜰 때 남기는 경고 한 줄(리마인더·자동 완료·회의록 텍스트 정리가 이
프로세스에서 안 돈다)도 여기서 잠근다.

DB나 SMTP에 붙지 않는다 — `SessionLocal`과 두 tick 함수를 모듈 전역으로 monkeypatch해서 갈아
끼우고, `asyncio.sleep`도 패치해 실제 60초(TICK_INTERVAL_SECONDS)를 기다리지 않는다. 전부
순수 asyncio라 pytest-asyncio 없이 `asyncio.run()`으로 감싼 동기 테스트로 작성한다(이 프로젝트
테스트 스위트에 pytest-asyncio 설정이 없다).
"""

from __future__ import annotations

import asyncio
import logging

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


def _patch_retention_noop(monkeypatch):
    """하루 한 번 회의록 텍스트 정리(같은 tick 끝에 돈다)도 no-op으로 — 더미 세션에 쿼리를 보내지 않게."""
    monkeypatch.setattr(scheduler, "run_daily_text_retention", lambda db, now: None)


def _patch_ticks_noop(monkeypatch):
    """두 tick 함수를 아무 일도 안 하는 no-op으로 바꾼다(반환값은 tick 시그니처와 무관하게 무시됨)."""
    monkeypatch.setattr(scheduler, "run_reminder_tick", lambda db, now, **kw: [])
    monkeypatch.setattr(scheduler, "run_completion_tick", lambda db, now, **kw: [])
    _patch_retention_noop(monkeypatch)


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


def _scheduler_warnings(caplog) -> list[str]:
    return [
        record.getMessage()
        for record in caplog.records
        if record.name == "app.notifications.scheduler" and record.levelno == logging.WARNING
    ]


def _capture_scheduler_warnings(monkeypatch, caplog) -> None:
    # 같은 테스트 세션에서 앞선 테스트의 마이그레이션(alembic fileConfig)이 app.* 로거를 꺼 둘 수 있다 — 테스트 실행
    # 순서와 무관하게 이 로거의 출력을 보도록 이 테스트 동안만 다시 켠다.
    monkeypatch.setattr(logging.getLogger("app.notifications.scheduler"), "disabled", False)
    caplog.set_level(logging.WARNING, logger="app.notifications.scheduler")


def test_disabled_logs_one_warning_naming_what_will_not_run(monkeypatch, caplog):
    """꺼진 채로 뜨면 시작할 때 경고 한 줄 — 리마인더·자동 완료·회의록 텍스트 보존기간 정리가 이 프로세스에서 안 돈다.

    SCHEDULER_ENABLED를 빠뜨려도 앱은 아무 오류 없이 뜬다 — 이 한 줄이 없으면 알림이 안 나가고 텍스트가 안 지워지는
    걸 한참 뒤에야 안다. 동작은 그대로다(태스크를 만들지 않는다 — 위 테스트).
    """
    monkeypatch.setattr(settings, "scheduler_enabled", False)
    monkeypatch.setattr(settings, "meeting_text_retention_days_after_event", 30)
    _capture_scheduler_warnings(monkeypatch, caplog)

    async def scenario():
        async with scheduler.reminder_scheduler_lifespan(app=None):
            pass

    asyncio.run(scenario())

    (message,) = _scheduler_warnings(caplog)  # 정확히 한 줄
    assert "SCHEDULER_ENABLED=false" in message
    for not_running in (
        "미팅 리마인더",
        "자동 완료 처리",
        "회의록 텍스트 보존기간 정리(행사 종료 30일 뒤)",
    ):
        assert not_running in message


def test_app_startup_logs_the_disabled_warning_exactly_once(monkeypatch, caplog):
    """실제 앱 lifespan(app.main)으로 띄워도 경고는 한 줄이고, 앱은 그대로 뜬다."""
    from fastapi.testclient import TestClient

    from app.main import app

    monkeypatch.setattr(settings, "scheduler_enabled", False)
    _capture_scheduler_warnings(monkeypatch, caplog)

    with TestClient(app) as started:
        assert started.get("/health").json() == {"status": "ok"}

    assert len(_scheduler_warnings(caplog)) == 1


def test_enabled_logs_no_disabled_warning(monkeypatch, caplog):
    monkeypatch.setattr(settings, "scheduler_enabled", True)
    _patch_session_local(monkeypatch)
    _patch_ticks_noop(monkeypatch)
    _patch_fast_sleep(monkeypatch)
    _capture_scheduler_warnings(monkeypatch, caplog)

    async def scenario():
        async with scheduler.reminder_scheduler_lifespan(app=None):
            await asyncio.sleep(0)

    asyncio.run(scenario())

    assert _scheduler_warnings(caplog) == []


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
    _patch_retention_noop(monkeypatch)

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


def test_tick_runs_off_the_event_loop_so_the_loop_stays_responsive(monkeypatch):
    """동시성 하드닝(1차) — tick의 동기 작업(DB·리마인더 SMTP)은 이벤트 루프 밖 스레드에서 돈다.

    예전엔 tick을 루프 위에서 그대로 돌려, 리마인더 수십 통을 보내는 동안 서버 전체(요청 수락·모든 async
    경로)가 멈췄다. tick을 일부러 막아 둔 채로 루프가 다른 코루틴을 계속 돌리는지 본다 — 루프 위에서
    돌았다면 하트비트는 tick이 (타임아웃으로) 끝난 뒤에야 돌고, 그때는 tick이 이미 끝나 있다.
    """
    import threading

    monkeypatch.setattr(settings, "scheduler_enabled", True)
    _patch_session_local(monkeypatch)

    in_tick = threading.Event()
    release = threading.Event()
    tick_threads: list[threading.Thread] = []

    def blocking_reminder_tick(db, now, **kwargs):
        tick_threads.append(threading.current_thread())
        in_tick.set()
        try:
            release.wait(timeout=5)
        finally:
            in_tick.clear()
        return []

    monkeypatch.setattr(scheduler, "run_reminder_tick", blocking_reminder_tick)
    monkeypatch.setattr(scheduler, "run_completion_tick", lambda db, now, **kw: [])
    _patch_retention_noop(monkeypatch)

    observed: dict[str, object] = {}

    async def scenario():
        observed["loop_thread"] = threading.current_thread()
        async with scheduler.reminder_scheduler_lifespan(app=None):
            # tick이 시작될 때까지 루프를 양보하며 기다린다(스레드에서 돈다면 금방 들어온다).
            for _ in range(1000):
                if in_tick.is_set():
                    break
                await asyncio.sleep(0.005)
            beats = 0
            for _ in range(5):
                await asyncio.sleep(0.01)
                beats += 1
            observed["beats"] = beats
            observed["tick_still_running"] = in_tick.is_set()
            release.set()

    asyncio.run(scenario())

    assert observed["beats"] == 5
    assert observed["tick_still_running"] is True  # 하트비트가 tick과 '동시에' 돌았다
    assert tick_threads and tick_threads[0] is not observed["loop_thread"]
