"""대량 알림의 이메일 발송을 요청 밖으로 — 포화배정(일괄배정) 확정처럼 한 요청이 수십~수백 통을 만드는 경로용.

예전엔 확정 요청 하나가 (확정 미팅 N건 × 양쪽 기업 × 소속 멤버 수)만큼 SMTP 발송을 **요청 안에서 순서대로**
했다(통마다 새 연결 + STARTTLS + 로그인). 수십 통이면 응답이 분 단위로 늦어지고 그동안 요청 스레드와 DB
커넥션이 묶였으며, 연달아 쏘는 속도가 SES 계정 한도(14통/초)를 넘을 수도 있었다.

여기서는 **발송만** 뒤로 미룬다.

- 알림 행 생성(멱등 키)과 인앱 dispatch 기록은 지금처럼 요청 트랜잭션에서 커밋된다 — 인박스엔 바로 뜬다.
- 이메일 채널만 ``DeferredChannel``로 감싸 "보낼 목록"을 모은다(이 채널의 dispatch 행은 요청에서 만들지
  않는다). 응답 뒤 전용 스레드 1개가 보내고, 실제 결과(sent/failed/skipped)를 **자기 세션**으로
  ``notification_dispatches``에 기록한다.
- 초당 상한은 여기서 따로 걸지 않는다 — 실발송 경로(``SmtpEmailSender.send``)가 프로세스 공유 상한
  (``app.notifications.email.email_rate_limiter``)을 지키므로, 이 스레드의 발송도 리마인더·단건 발송과
  합산해서 상한 안에 든다.

단건 흐름(수락·거절·취소 등 2통 안팎)은 여기를 타지 않고 그대로 요청 안에서 보낸다. 재시작하면 아직 안 보낸
메일은 유실된다 — 알림 행·인앱은 남고, 이메일 dispatch 행이 없는 것으로 드러난다.

행사 설정 "참가자 알림 메일"(``participant_email_enabled``)이 꺼진 행사의 알림은 애초에 대기열에 담기지 않는다
(``service._emit_notification``이 지연 채널을 부르지 않고 ``skipped`` 행을 남긴다). 담긴 **뒤에** 꺼지는 경우를 위해
보내기 직전에 알림마다 한 번 더 읽고, 꺼졌으면 그 알림의 메일은 보내지 않고 같은 ``skipped`` 행을 남긴다.
"""

from __future__ import annotations

import logging
import threading
from collections.abc import Callable, Sequence
from concurrent.futures import Future, ThreadPoolExecutor
from dataclasses import dataclass
from datetime import datetime, timezone

from sqlalchemy.orm import Session

from app.notifications import service as notification_service
from app.notifications.channels import (
    ChannelRecipient,
    DispatchResult,
    EmailChannel,
    NotificationChannel,
    NotificationEnvelope,
    send_isolated,
    suppressed_dispatch_results,
)

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class PendingDispatch:
    """미뤄 둔 발송 1건 — 알림 1행의 봉투와 그 수신자들."""

    envelope: NotificationEnvelope
    recipients: tuple[ChannelRecipient, ...]


class DeferredChannel:
    """채널 하나를 '지금 보내지 않고 모아 두는' 래퍼 — ``NotificationChannel`` 계약(name, send)을 그대로 따른다.

    ``_emit_notification``은 채널이 돌려준 결과로 dispatch 행을 만든다. 빈 결과를 돌려주므로 이 채널의
    dispatch 행은 요청 트랜잭션에 생기지 않고, 백그라운드 발송이 실제 결과로 기록한다.
    """

    def __init__(self, inner: NotificationChannel) -> None:
        self.name = inner.name
        self.inner = inner
        self.pending: list[PendingDispatch] = []

    def send(
        self, envelope: NotificationEnvelope, recipients: list[ChannelRecipient]
    ) -> list[DispatchResult]:
        self.pending.append(PendingDispatch(envelope=envelope, recipients=tuple(recipients)))
        return []


class DeferredEmailBatch:
    """활성 채널 중 이메일만 지연 래퍼로 바꾼 묶음.

    사용법: 알림 생성 함수에 ``channels=batch.channels``를 넘겨 알림을 다 만든 뒤(요청 트랜잭션 커밋 후),
    ``batch.send_in_background(...)``로 모아 둔 이메일을 응답과 무관하게 보낸다.

    ``channels``가 None이면(채널 구성 실패) 아무것도 감싸지 않는다 — 알림 생성은 기본 경로를 타고
    (``channels=None``), 그 실패는 예전처럼 알림 쪽에서만 드러난다.
    """

    def __init__(self, channels: Sequence[NotificationChannel] | None) -> None:
        self._deferred: list[DeferredChannel] = []
        self.channels: tuple[NotificationChannel, ...] | None = None
        if channels is None:
            return
        wrapped: list[NotificationChannel] = []
        for channel in channels:
            if channel.name == EmailChannel.name:
                deferred = DeferredChannel(channel)
                self._deferred.append(deferred)
                wrapped.append(deferred)
            else:
                wrapped.append(channel)
        self.channels = tuple(wrapped)

    @classmethod
    def from_active_channels(cls) -> DeferredEmailBatch:
        """현재 활성 채널로 만든다. 채널 구성 자체가 실패하면(SMTP 미설정 등 — fail-closed로 예외) 감싸지
        않은 묶음을 돌려준다: 예전엔 그 실패가 알림마다 ``notify_after_commit``에 삼켜졌고 확정 응답은
        정상이었다 — 여기서 예외를 올리면 이미 커밋된 확정이 500으로 보이게 된다."""
        try:
            return cls(notification_service.active_channels())
        except Exception:  # noqa: BLE001 - 채널 구성 실패가 이미 커밋된 일괄 확정 응답을 깨지 않게
            logger.exception("알림 채널 구성 실패 — 이메일 지연 발송 없이 기본 경로로 둔다")
            return cls(None)

    @property
    def pending_messages(self) -> int:
        """모아 둔 발송 대상 수(수신자 단위)."""
        return sum(len(item.recipients) for d in self._deferred for item in d.pending)

    def send_in_background(self, session_factory: Callable[[], Session]) -> Future | None:
        """모아 둔 이메일을 전용 스레드에 넘기고 바로 돌아온다. 보낼 게 없으면 None.

        ``session_factory``는 결과 기록용 — 요청 세션은 스레드 간에 넘기지 않으므로 같은 DB에 붙는
        새 세션 팩토리를 받는다(``app.db.sessionmaker_like``).
        """
        jobs = [(d.inner, list(d.pending)) for d in self._deferred if d.pending]
        if not jobs:
            return None
        future = _email_pool().submit(_deliver, jobs, session_factory)
        future.add_done_callback(_log_unhandled_failure)
        return future


def _deliver(
    jobs: list[tuple[NotificationChannel, list[PendingDispatch]]],
    session_factory: Callable[[], Session],
) -> None:
    """백그라운드 본체 — 수신자 1명씩 보내고(초당 상한은 실발송 경로가 지킨다), 알림 1건 단위로 결과를 기록한다.

    기록은 알림마다 짧은 세션으로 한다: 수백 통을 다 보낸 뒤 한 번에 쓰면 그 사이 커넥션을 쥐거나(세션을
    열어 둔 경우) 중간에 죽었을 때 보낸 사실이 하나도 안 남는다.

    알림마다 보내기 직전에 행사 설정 "참가자 알림 메일"을 다시 읽는다 — 확정 뒤 발송이 끝나기 전에 운영자가
    스위치를 끄면 남은 메일은 나가지 않는다(``skipped`` + ``event_email_disabled``).
    """
    for channel, pending in jobs:
        for item in pending:
            enabled = _email_still_enabled(session_factory, item.envelope.event_id)
            if enabled is None:
                # 확인하지 못했다 — 보내지 않고 'failed'로 남긴다(알림 콘솔의 미전달 → 개별 재발송 대상).
                _record(
                    session_factory,
                    item.envelope.notification_id,
                    _unreadable_switch_results(channel.name, item.recipients),
                )
                continue
            if not enabled:
                _record(
                    session_factory,
                    item.envelope.notification_id,
                    suppressed_dispatch_results(channel.name, list(item.recipients)),
                )
                continue
            results: list[DispatchResult] = []
            for recipient in item.recipients:
                # 채널이 격리 못 한 실패도 그 수신자의 'failed'가 되고 다음 수신자로 넘어간다.
                results.extend(send_isolated(channel, item.envelope, [recipient]))
            _record(session_factory, item.envelope.notification_id, results)


#: 발송 직전 스위치를 읽지 못해 보내지 않은 dispatch의 error 문구(실패로 남겨 재발송 대상이 되게 한다).
_SWITCH_UNREADABLE = "참가자 알림 메일 설정을 확인하지 못해 보내지 않음"


def _unreadable_switch_results(
    channel_name: str, recipients: Sequence[ChannelRecipient]
) -> list[DispatchResult]:
    """스위치를 확인하지 못해 보내지 않은 알림의 기록 — 보냈을 수신자는 ``failed``(재발송 대상). 이메일 주소가
    없는 수신자는 스위치와 무관하게 원래도 안 보냈을 수신자라 :class:`EmailChannel` 과 같은 ``skipped``(사유 없음)."""
    results: list[DispatchResult] = []
    for r in recipients:
        if channel_name == EmailChannel.name and not r.email:
            results.append(DispatchResult(member_id=r.member_id, channel=channel_name, status="skipped"))
        else:
            results.append(
                DispatchResult(
                    member_id=r.member_id,
                    channel=channel_name,
                    status="failed",
                    error=_SWITCH_UNREADABLE,
                )
            )
    return results


def _email_still_enabled(session_factory: Callable[[], Session], event_id: str) -> bool | None:
    """발송 직전 스위치 재확인 — 짧은 세션으로 읽고 바로 돌려준다(보내는 동안 커넥션을 쥐지 않는다).

    읽기 자체가 실패하면(DB 일시 장애 등) None — 호출부는 **보내지 않는다**(fail-closed): 메일을 막으려고 둔
    스위치라, 확인할 수 없을 때 보내는 쪽이 되돌릴 수 없는 실수다. 꺼짐(skipped)으로 적지도 않는다 — 실제로
    꺼졌는지 모르기 때문이다. 'failed'로 남겨 알림 콘솔에서 개별 재발송할 수 있게 한다(그 기록마저 같은 DB라
    실패하면 로그만 남고 이메일 dispatch 행이 없는 것으로 드러난다).
    """
    try:
        with session_factory() as db:
            return notification_service.participant_email_enabled_for_event(db, event_id)
    except Exception:  # noqa: BLE001 - 확인 실패가 나머지 발송 작업을 멈추지 않게(이 알림만 보류)
        logger.exception(
            "참가자 알림 메일 설정 확인 실패 — 이 알림의 메일은 보내지 않는다 (event_id=%s)", event_id
        )
        return None


def _record(
    session_factory: Callable[[], Session], notification_id: str, results: list[DispatchResult]
) -> None:
    if not results:
        return
    try:
        with session_factory() as db:
            notification_service.record_dispatches(
                db, notification_id, results, now=datetime.now(timezone.utc)
            )
            db.commit()
    except Exception:  # noqa: BLE001 - 기록 실패가 나머지 발송을 멈추지 않는다(발송은 이미 끝났다)
        logger.exception("지연 발송 결과 기록 실패 (notification_id=%s)", notification_id)


def _log_unhandled_failure(future: Future) -> None:
    if future.cancelled():
        return
    exc = future.exception()
    if exc is not None:
        logger.error("일괄 메일 발송 작업이 처리되지 않은 예외로 끝났다", exc_info=exc)


_lock = threading.Lock()
_pool: ThreadPoolExecutor | None = None


def _email_pool() -> ThreadPoolExecutor:
    # 스레드 1개로 직렬화한다 — 일괄 확정이 겹쳐도 SMTP 연결을 하나씩만 열고, 공유 상한의 몫을 한 번에 하나씩만
    # 가져가 리마인더·단건 발송이 그 사이에 끼어들 수 있게 한다.
    global _pool
    with _lock:
        if _pool is None:
            _pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="bulk-email")
        return _pool


def shutdown_bulk_email(*, wait: bool = False) -> None:
    """lifespan 종료 시 — 시작 전 발송 작업은 취소하고 바로 돌아온다(``wait=False``).

    진행 중인 발송은 중단되지 않는다: 인터프리터 종료가 concurrent.futures 워커 스레드를 끝까지 join하므로
    프로세스는 그 발송 묶음이 끝날 때까지 남고, 운영에선 ``docker stop``의 유예 시간(기본 10초) 뒤 SIGKILL로
    끝난다. 못 보낸 메일은 유실되고 그 이메일 dispatch 행이 없는 것으로 드러난다(모듈 docstring 참고).
    테스트는 ``wait=True``로 불러 발송·기록이 끝날 때까지 기다린 뒤 싱글턴을 비운다.
    """
    global _pool
    with _lock:
        pool, _pool = _pool, None
    if pool is not None:
        pool.shutdown(wait=wait, cancel_futures=True)
