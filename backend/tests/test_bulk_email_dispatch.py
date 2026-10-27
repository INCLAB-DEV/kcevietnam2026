"""일괄 알림 이메일 지연 발송(app.notifications.bulk_dispatch) 단위 테스트 — DB 없이 돈다.

API 수준(포화배정 확정 → 응답 먼저, 백그라운드 발송, 초당 상한)은 ``test_op005_assignment_api.py``의
``test_saturation_confirm_responds_before_emails_and_sends_them_in_background_throttled``가 잠근다.
초당 상한 자체(프로세스 공유, 여러 스레드 합산)는 실발송 경로 소관이라 ``test_smtp_email_sender.py``가 잠근다.
여기서는 부품을 잠근다: 이메일 채널만 감싸기, 채널 구성 실패 시 기본 경로 유지, 수신자 하나의 예외가
나머지 발송·기록을 막지 않음.
"""

from __future__ import annotations

from app.notifications import bulk_dispatch
from app.notifications import service as notification_service
from app.notifications.bulk_dispatch import (
    DeferredChannel,
    DeferredEmailBatch,
    PendingDispatch,
)
from app.notifications.channels import (
    ChannelRecipient,
    DispatchResult,
    EmailChannel,
    InAppChannel,
    NotificationEnvelope,
)
from app.notifications.email import FakeEmailSender


def _envelope(notification_id: str = "n-1") -> NotificationEnvelope:
    return NotificationEnvelope(
        notification_id=notification_id,
        type="meeting_accepted",
        event_id="event-1",
        meeting_id="meeting-1",
        payload={"counterpart_org_name": "VinaContent"},
    )


class TestDeferredEmailBatch:
    def test_only_the_email_channel_is_deferred(self):
        in_app = InAppChannel()
        email = EmailChannel(FakeEmailSender())
        batch = DeferredEmailBatch([in_app, email])

        assert batch.channels[0] is in_app
        deferred = batch.channels[1]
        assert isinstance(deferred, DeferredChannel) and deferred.name == "email"

        recipients = [ChannelRecipient(member_id="m-1", email="a@example.com")]
        # 지연 채널은 지금 보내지 않는다 — 빈 결과(=요청 트랜잭션에 이메일 dispatch 행 없음) + 대기열 적재.
        assert deferred.send(_envelope(), recipients) == []
        assert batch.pending_messages == 1

    def test_nothing_pending_means_no_background_job(self):
        batch = DeferredEmailBatch([InAppChannel(), EmailChannel(FakeEmailSender())])
        assert batch.send_in_background(lambda: None) is None

    def test_channel_build_failure_keeps_the_default_path(self, monkeypatch):
        """SMTP 미설정 등으로 채널 구성이 실패해도 일괄 확정 응답을 깨지 않는다 — 감싸지 않고(None) 넘긴다."""

        def _boom():
            raise RuntimeError("SMTP 설정 없음")

        monkeypatch.setattr(notification_service, "active_channels", _boom)
        batch = DeferredEmailBatch.from_active_channels()
        assert batch.channels is None
        assert batch.send_in_background(lambda: None) is None


class _RecordingSession:
    """``with session_factory() as db`` 형태만 흉내 내는 세션 — 추가된 dispatch 행을 모은다."""

    def __init__(self, sink: list) -> None:
        self._sink = sink

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def add(self, row) -> None:
        self._sink.append(row)

    def commit(self) -> None:
        pass


class _FlakyChannel:
    """두 번째 수신자에서 채널 자체가 예외를 던지는 채널 — 격리가 안 된 실패를 흉내 낸다."""

    name = "email"

    def __init__(self) -> None:
        self.calls = 0

    def send(self, envelope, recipients):
        self.calls += 1
        if self.calls == 2:
            raise RuntimeError("render 실패")
        return [DispatchResult(member_id=r.member_id, channel="email", status="sent") for r in recipients]


def test_one_recipient_failure_does_not_stop_the_rest_and_everything_is_recorded(
    participant_email_forced_on,
):
    # DB 없이 도는 테스트라(가짜 세션·비-UUID 행사) 행사 설정 행으로 메일 스위치를 켤 수 없다 — 기본이 꺼짐이므로
    # 발송 직전 재확인이 켜짐을 읽도록 스위치 읽기만 켠다(participant_email_forced_on, conftest).
    rows: list = []
    channel = _FlakyChannel()
    pending = [
        PendingDispatch(
            envelope=_envelope("n-1"),
            recipients=tuple(ChannelRecipient(member_id=f"m-{i}", email=f"{i}@example.com") for i in range(3)),
        )
    ]

    bulk_dispatch._deliver([(channel, pending)], lambda: _RecordingSession(rows))

    assert channel.calls == 3  # 실패 뒤에도 다음 수신자로 계속 간다(수신자 1명씩 보낸다)
    assert [(r.member_id, r.status) for r in rows] == [("m-0", "sent"), ("m-1", "failed"), ("m-2", "sent")]
    assert rows[1].error == "render 실패"
    assert rows[0].sent_at is not None and rows[1].sent_at is None


def test_unreadable_switch_records_failed_for_addressed_and_skipped_for_addressless(monkeypatch):
    """발송 직전 스위치를 못 읽으면 보내지 않는다(fail-closed). 주소가 있는 수신자는 failed(재발송 대상), 주소가 없는
    수신자는 원래도 안 보냈을 수신자라 EmailChannel과 같은 skipped(사유 없음)."""

    def _unreadable(_db, _event_id):
        raise RuntimeError("DB 일시 장애")

    monkeypatch.setattr(notification_service, "participant_email_enabled_for_event", _unreadable)
    rows: list = []
    channel = _FlakyChannel()
    pending = [
        PendingDispatch(
            envelope=_envelope("n-1"),
            recipients=(
                ChannelRecipient(member_id="m-addressed", email="a@example.com"),
                ChannelRecipient(member_id="m-addressless", email=None),
            ),
        )
    ]

    bulk_dispatch._deliver([(channel, pending)], lambda: _RecordingSession(rows))

    assert channel.calls == 0  # 아무것도 보내지 않았다
    assert [(r.member_id, r.channel, r.status, r.error) for r in rows] == [
        ("m-addressed", "email", "failed", "참가자 알림 메일 설정을 확인하지 못해 보내지 않음"),
        ("m-addressless", "email", "skipped", None),
    ]
