"""알림 채널 포트 테스트 (ADR-0010) — DB 없이 순수 채널 디스패치 로직만 검증.

InAppChannel(DB 기록=발신 자체) · EmailChannel(FakeEmailSender 경유, 우아한 열화) · 채널 레지스트리.
"""

from __future__ import annotations

from app.config import settings
from app.notifications.channels import (
    ChannelRecipient,
    EmailChannel,
    InAppChannel,
    NotificationEnvelope,
    build_channels,
    render_email,
)
from app.notifications.email import EmailMessage, FakeEmailSender


def _envelope(type_: str = "meeting_requested", **payload) -> NotificationEnvelope:
    return NotificationEnvelope(
        notification_id="ntf-1",
        type=type_,
        event_id="ev-1",
        meeting_id="mtg-1",
        payload=payload or {"counterpart_org_name": "한화"},
    )


class TestInAppChannel:
    def test_all_recipients_marked_sent(self):
        ch = InAppChannel()
        recipients = [
            ChannelRecipient(member_id="m1", email="a@x.com"),
            ChannelRecipient(member_id="m2", email=None),
        ]
        results = ch.send(_envelope(), recipients)
        assert {r.member_id for r in results} == {"m1", "m2"}
        assert all(r.channel == "in_app" and r.status == "sent" for r in results)

    def test_no_recipients_returns_empty(self):
        assert InAppChannel().send(_envelope(), []) == []


class TestEmailChannel:
    def test_sends_to_members_with_email(self):
        sender = FakeEmailSender()
        ch = EmailChannel(sender)
        results = ch.send(_envelope(), [ChannelRecipient(member_id="m1", email="a@x.com")])
        assert results[0].status == "sent"
        assert results[0].channel == "email"
        assert len(sender.sent) == 1
        assert sender.sent[0].to == ["a@x.com"]

    def test_skips_members_without_email(self):
        sender = FakeEmailSender()
        ch = EmailChannel(sender)
        results = ch.send(_envelope(), [ChannelRecipient(member_id="m1", email=None)])
        assert results[0].status == "skipped"
        assert sender.sent == []

    def test_one_recipient_failure_does_not_block_others(self):
        class FlakySender:
            def __init__(self) -> None:
                self.sent: list[EmailMessage] = []

            def send(self, message: EmailMessage) -> None:
                if message.to == ["bad@x.com"]:
                    raise RuntimeError("boom")
                self.sent.append(message)

        ch = EmailChannel(FlakySender())
        results = ch.send(
            _envelope(),
            [
                ChannelRecipient(member_id="m1", email="bad@x.com"),
                ChannelRecipient(member_id="m2", email="good@x.com"),
            ],
        )
        by_member = {r.member_id: r for r in results}
        assert by_member["m1"].status == "failed"
        assert by_member["m1"].error == "boom"
        assert by_member["m2"].status == "sent"

    def test_render_email_has_korean_title_and_english_subtitle(self):
        subject, body = render_email(_envelope(type_="review_ready", counterpart_org_name="한화"))
        assert "정리가 끝났어요" in subject
        assert "ready" in subject.lower()
        assert "한화" in body

    def test_render_email_for_application_approved_has_no_counterpart_line(self):
        # 상대 기업 개념이 없는 통지 — 승인 사실 + 접속 안내만, "상대 기업" 문구가 없어야 한다.
        subject, body = render_email(_envelope(type_="application_approved", org_name="한화", role="exhibitor"))
        assert "승인" in subject
        assert "approved" in subject.lower()
        assert "상대 기업" not in body

    def test_render_email_for_meeting_rejected_omits_reason(self):
        # 거절 사유는 1차 미노출(GitHub #4) — 상대 기업명·다음 행동 안내만, 사유 관련 문구가 없다.
        subject, body = render_email(
            _envelope(type_="meeting_rejected", counterpart_org_name="한화")
        )
        assert "거절" in subject
        assert "declined" in subject.lower()
        assert "한화" in body
        assert "사유" not in body

    def test_render_email_default_brand_name_is_nabi(self):
        subject, body = render_email(_envelope(type_="review_ready", counterpart_org_name="한화"))
        assert subject.startswith("[NABI]")

    def test_render_email_custom_brand_name_reflected(self, monkeypatch):
        monkeypatch.setattr(settings, "email_brand_name", "KCE 2026")
        subject, body = render_email(_envelope(type_="application_approved", counterpart_org_name="한화"))
        assert subject.startswith("[KCE 2026]")
        assert "KCE 2026 비즈매칭 서비스" in body
        assert "log in to KCE 2026" in body


def test_build_channels_registers_in_app_and_email_in_order():
    channels = build_channels(FakeEmailSender())
    assert [c.name for c in channels] == ["in_app", "email"]
