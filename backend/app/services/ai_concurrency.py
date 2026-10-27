"""AI 외부 호출 동시성 상한 — 미팅이 한꺼번에 끝나 녹음·회의록 정리 요청이 몰리는 순간을 버티는 장치.

운영 전제: 백엔드는 uvicorn 프로세스 하나(t4g.small, 2 vCPU)다. 예전엔
- 녹음 전사가 FastAPI BackgroundTasks로 돌았다. 작업이 AnyIO 스레드풀 토큰(기본 40)을 수 분씩 쥐었고,
  FastAPI(0.138)가 요청 스코프 의존성(``get_session``)을 BackgroundTasks까지 끝난 뒤에 정리하므로 인증이
  SELECT한 요청 커넥션도 전사가 끝날 때까지 반납되지 않았다 — 녹음이 몰리면 DB 풀이 먼저 동났다.
- 텍스트 구조화·러브콜 초안(동기 OpenAI 호출)은 상한이 없어 동시 요청 수만큼 OpenAI를 두드렸다.

그래서 장치를 둔다.

1. **전사 전용 스레드풀** ``ThreadPoolExecutor(max_workers=settings.transcription_max_concurrency)`` —
   넘치는 작업은 이 풀의 큐에서 기다린다(스레드풀 토큰도, 요청 세션도 쥐지 않은 채로). 접수 응답(202)은
   큐 상태와 무관하게 바로 나간다.
2. **동기 채팅 호출 자리** ``BoundedSemaphore(settings.ai_chat_max_concurrency)`` — 제한 시간 안에 자리를
   못 얻으면 ``AiBusyError``. 라우트가 이걸 사용자 응답으로 바꾼다(구조화 503 ai_busy, 러브콜은 직접 작성
   폴백). 전사 작업 안의 구조화 호출은 이 자리를 쓰지 않는다 — 이미 1번 풀 크기로 묶여 있다.
3. **녹음 접수 상한**(2026-10-02, 업로드 상한 200MB로 상향과 함께) — 둘 다 넘으면 ``AiBusyError``(503 ai_busy).
   - 대기열 깊이 ``reserve_transcription_job`` — 접수됐지만 끝나지 않은(대기 + 실행) 작업 수를
     ``settings.transcription_max_queue_depth``로 묶는다. 예전엔 무제한으로 받아 두고 15분 뒤에야 만료로 실패시켰다.
   - 업로드 동시 처리 ``transcription_upload_slot`` — 받은 파일을 S3로 흘려보내는 구간의 동시 수
     (``settings.transcription_max_concurrent_uploads``). 업로드마다 잡히는 전송 버퍼(app.services.storage)가
     몰릴 때 이 배수로만 늘게 한다.
4. **자리 대기 상한**(2026-10-06 교차리뷰 HIGH) — 2번(채팅)·3번(업로드)의 자리는 **기다리는 요청 수**도 묶는다
   (``settings.ai_chat_max_waiters``·``settings.transcription_upload_max_waiters``). 기다리는 요청도 AnyIO 스레드
   토큰(프로세스 전체 40개)을 쥐고 있어서, 예전처럼 대기를 무한정 받으면 몰린 순간 스레드가 바닥나 AI와 무관한
   다른 동기 API까지 몇 초씩 멈출 수 있었다. 빈 자리가 있으면 바로 잡고(대기 수에 들어가지 않는다), 없는데 이미 상한만큼
   기다리는 중이면 줄을 서지 않고 **즉시** ``AiBusyError``, 그 밖에는 예전처럼 제한 시간까지 기다린다 — 비밀번호
   해시 자리(app.auth.credentials.password_hash_slot)와 같은 규약이다. 스레드 예산은 app.config 주석 참고.

모두 첫 사용 시점에 설정을 읽어 지연 생성한다. ``shutdown_ai_workers``가 비워 두면 다음 사용 때 현재
설정으로 다시 만든다(lifespan 종료, 그리고 설정을 바꿔 가며 검증하는 테스트가 이 경로를 쓴다). 자리 대기 수는
자리와 한 벌이라 같이 0에서 다시 시작한다(``_Slots``). 대기열 깊이 카운터만은 비우지 않는다 — 종료 뒤에도 끝까지
도는 작업(아래 shutdown 독스트링)이 끝날 때 스스로 돌려준다.
"""

from __future__ import annotations

import logging
import threading
from collections.abc import Callable, Iterator
from concurrent.futures import Future, ThreadPoolExecutor
from contextlib import contextmanager
from typing import Any

from app.config import settings

logger = logging.getLogger(__name__)


class AiBusyError(RuntimeError):
    """AI 동시 호출 자리를 얻지 못했다 — 대기열이 이미 꽉 찼거나(즉시) 제한 시간 안에 차례가 오지 않았다. 지금
    바쁘니 잠시 후 다시 시도할 일이다."""


class _Slots:
    """동시 실행 자리(세마포어)와 그 자리를 **기다리는** 요청 수 한 벌.

    대기 수를 모듈 전역이 아니라 자리와 같은 객체에 둔다 — ``shutdown_ai_workers``가 이 벌을 버리면 대기 수도 같이
    0에서 다시 시작하고, 그 순간 옛 자리를 기다리던 요청이 나중에 자기 몫을 되돌려도 새 벌의 셈은 어긋나지 않는다
    (전역 숫자를 0으로 되돌렸다면 그 요청이 끝날 때 -1이 돼 상한이 한 명씩 느슨해진다).
    """

    def __init__(self, size: int) -> None:
        self.semaphore = threading.BoundedSemaphore(size)
        # 지금 자리를 기다리는 요청 수(자리를 잡고 일하는 요청은 세지 않는다). ``_lock`` 아래에서만 바꾼다.
        self.waiting = 0


_lock = threading.Lock()
_chat_slot_state: _Slots | None = None
_upload_slot_state: _Slots | None = None
_transcription_executor: ThreadPoolExecutor | None = None
# 접수됐지만 아직 끝나지 않은 전사 작업 수(대기 + 실행, 접수 중인 예약 포함). ``_lock`` 아래에서만 바꾼다.
_queued_transcriptions = 0


def _take_slot(
    slots: _Slots, *, max_waiters: int, timeout: float, full: str, timed_out: str
) -> None:
    """자리 하나를 잡는다(돌려주는 건 호출부). 못 잡으면 ``AiBusyError`` — ``full``·``timed_out``은 사유별 예외 메시지다.

    ``app.auth.credentials.password_hash_slot``과 같은 규약이다.
    - 빈 자리가 있으면 기다리지 않고 바로 잡는다(대기 수에 들어가지 않는다).
    - 없으면 줄을 선다 — 단 이미 ``max_waiters``명이 기다리는 중이면 서지 않고 **즉시** 거절한다. 기다리는 요청도
      AnyIO 스레드 토큰(프로세스 전체 40개)을 쥐고 있어서, 줄을 무한정 세우면 스레드가 바닥나 다른 API까지 멈춘다.
    - 줄은 ``timeout``초까지 — 넘으면 거절한다.
    대기 수는 ``_lock`` 아래에서 세고, 대기를 마치는 모든 경로(자리 얻음·시간 초과·예외)에서 되돌린다. 세마포어를
    기다리는 동안에는 ``_lock``을 쥐지 않는다.
    """
    semaphore = slots.semaphore
    if semaphore.acquire(blocking=False):
        return
    with _lock:
        if slots.waiting >= max_waiters:
            raise AiBusyError(full)
        slots.waiting += 1
    try:
        acquired = semaphore.acquire(timeout=timeout)
    finally:
        with _lock:
            slots.waiting -= 1
    if not acquired:
        raise AiBusyError(timed_out)


def _chat_slots() -> _Slots:
    global _chat_slot_state
    with _lock:
        if _chat_slot_state is None:
            _chat_slot_state = _Slots(settings.ai_chat_max_concurrency)
        return _chat_slot_state


def ai_chat_waiters() -> int:
    """지금 채팅 자리를 기다리는 요청 수 — 로그·테스트용."""
    with _lock:
        return _chat_slot_state.waiting if _chat_slot_state is not None else 0


@contextmanager
def ai_chat_slot(timeout: float | None = None) -> Iterator[None]:
    """동기 AI 채팅 호출 1건의 자리를 잡는다. 못 잡으면 ``AiBusyError`` — 줄이 이미 ``ai_chat_max_waiters``명으로
    꽉 찼으면 즉시, 아니면 ``timeout``(기본 설정값) 안에 차례가 오지 않았을 때(``_take_slot``).

    자리를 기다리는 동안에도 요청 스레드는 묶여 있으므로, 호출부는 **DB 커넥션을 먼저 놓고**
    (``app.db.release_connection``) 이걸 부른다 — 기다리는 요청들이 커넥션까지 쥐고 있으면 안 된다.
    """
    slots = _chat_slots()
    wait = settings.ai_chat_acquire_timeout_seconds if timeout is None else timeout
    _take_slot(
        slots,
        max_waiters=settings.ai_chat_max_waiters,
        timeout=wait,
        full="AI 동시 호출 대기열이 꽉 찼다",
        timed_out="AI 동시 호출 상한에 걸렸다",
    )
    try:
        yield
    finally:
        slots.semaphore.release()


def _transcription_pool() -> ThreadPoolExecutor:
    global _transcription_executor
    with _lock:
        if _transcription_executor is None:
            _transcription_executor = ThreadPoolExecutor(
                max_workers=settings.transcription_max_concurrency,
                thread_name_prefix="transcription",
            )
        return _transcription_executor


def submit_transcription(fn: Callable[..., Any], /, *args: Any, **kwargs: Any) -> Future:
    """전사 작업을 전용 풀에 넣는다. 풀이 차 있으면 큐에서 순서를 기다린다(호출부는 바로 돌아간다).

    작업 본체(``reviews._run_transcription_job``)가 실패를 작업 상태(error)로 기록하지만, 그 기록마저
    실패하면 예외가 Future 안에 조용히 갇힌다 — 아무도 ``result()``를 부르지 않으므로 로그로 꺼내 둔다.
    """
    future = _transcription_pool().submit(fn, *args, **kwargs)
    future.add_done_callback(_log_unhandled_failure)
    return future


def _log_unhandled_failure(future: Future) -> None:
    if future.cancelled():
        return
    exc = future.exception()
    if exc is not None:
        logger.error("전사 작업이 처리되지 않은 예외로 끝났다", exc_info=exc)


# =============================================================================
# 녹음 접수 상한 — 대기열 깊이 + 업로드 동시 처리
# =============================================================================
class TranscriptionReservation:
    """대기열 한 칸 — 접수를 시작할 때 잡고, 작업이 끝나면(성공·실패·취소) 또는 접수가 중간에 실패하면 돌려준다.

    S3에 올리기 **전에** 잡는다 — 대기열이 꽉 찼으면 원본을 보관하지도, 작업 행을 만들지도 않고 바로 거절한다.
    ``release``는 여러 번 불려도 한 번만 돌려준다(접수 실패 정리와 작업 완료 콜백이 겹쳐도 카운터가 어긋나지 않게).
    """

    def __init__(self) -> None:
        self._released = False
        self._release_lock = threading.Lock()

    def release(self) -> None:
        global _queued_transcriptions
        with self._release_lock:
            if self._released:
                return
            self._released = True
        with _lock:
            _queued_transcriptions -= 1

    def submit(self, fn: Callable[..., Any], /, *args: Any, **kwargs: Any) -> Future:
        """작업을 전사 풀에 넣고, 끝나면 이 칸을 돌려주게 한다. 넣기 자체가 실패하면(풀 종료 중) 바로 돌려준다."""
        try:
            future = submit_transcription(fn, *args, **kwargs)
        except BaseException:
            self.release()
            raise
        future.add_done_callback(lambda _done: self.release())
        return future


def reserve_transcription_job() -> TranscriptionReservation:
    """대기열 한 칸을 잡는다. 접수됐지만 끝나지 않은 작업이 이미 상한이면 ``AiBusyError``(기다리지 않는다)."""
    global _queued_transcriptions
    with _lock:
        if _queued_transcriptions >= settings.transcription_max_queue_depth:
            raise AiBusyError("전사 대기열이 꽉 찼다")
        _queued_transcriptions += 1
    return TranscriptionReservation()


def queued_transcriptions() -> int:
    """지금 잡혀 있는 대기열 칸 수(대기 + 실행 + 접수 중) — 로그·테스트용."""
    with _lock:
        return _queued_transcriptions


def _upload_slots() -> _Slots:
    global _upload_slot_state
    with _lock:
        if _upload_slot_state is None:
            _upload_slot_state = _Slots(settings.transcription_max_concurrent_uploads)
        return _upload_slot_state


def transcription_upload_waiters() -> int:
    """지금 업로드 자리를 기다리는 요청 수 — 로그·테스트용."""
    with _lock:
        return _upload_slot_state.waiting if _upload_slot_state is not None else 0


@contextmanager
def transcription_upload_slot(timeout: float | None = None) -> Iterator[None]:
    """녹음 1건을 저장소로 흘려보내는 동안의 자리. 못 잡으면 ``AiBusyError`` — 줄이 이미
    ``transcription_upload_max_waiters``명으로 꽉 찼으면 즉시, 아니면 ``timeout``(기본 설정값) 안에 차례가 오지 않았을 때.

    ``ai_chat_slot``과 같은 규약 — 기다리는 동안 요청 스레드가 묶이므로 DB 커넥션을 먼저 놓고 부른다.
    """
    slots = _upload_slots()
    wait = settings.transcription_upload_acquire_timeout_seconds if timeout is None else timeout
    _take_slot(
        slots,
        max_waiters=settings.transcription_upload_max_waiters,
        timeout=wait,
        full="녹음 업로드 대기열이 꽉 찼다",
        timed_out="녹음 업로드 동시 처리 상한에 걸렸다",
    )
    try:
        yield
    finally:
        slots.semaphore.release()


def shutdown_ai_workers(*, wait: bool = False) -> None:
    """전사 풀을 닫고(시작 전 작업은 취소) 자리 장치들을 비운다 — 다음 사용 때 현재 설정으로 다시 만든다.

    lifespan 종료에서 ``wait=False``로 부른다 — 이 호출 자체는 기다리지 않고 돌아오고, 대기열의(시작 전) 작업만
    취소된다. **실행 중인 전사는 중단되지 않는다**: 인터프리터 종료가 concurrent.futures 워커 스레드를 끝까지
    join하므로 프로세스는 그 작업이 끝날 때까지 남는다. 운영에선 ``docker stop``의 유예 시간(기본 10초) 뒤
    SIGKILL로 끝난다. 취소·중단된 작업 행은 pending으로 남고, 다음 시작 때 고아 정리(app.main)가 실패로 바꾼다.

    자리 대기 수(채팅·업로드)는 자리와 함께 비워진다 — 지금 옛 자리를 쥐었거나 기다리는 요청은 옛 벌에 반납하고
    옛 벌의 셈을 되돌리므로 새 장치의 셈에 섞이지 않는다(``_Slots``).
    대기열 깊이 카운터는 비우지 않는다 — 취소된 작업은 취소 즉시, 실행 중인 작업은 끝날 때 각자 칸을 돌려준다.
    """
    global _chat_slot_state, _upload_slot_state, _transcription_executor
    with _lock:
        executor, _transcription_executor = _transcription_executor, None
        _chat_slot_state = None
        _upload_slot_state = None
    if executor is not None:
        executor.shutdown(wait=wait, cancel_futures=True)
