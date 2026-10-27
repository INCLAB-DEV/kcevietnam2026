"""알림 채널 포트 테스트 (ADR-0010) — DB 없이 순수 채널 디스패치 로직만 검증.

InAppChannel(DB 기록=발신 자체) · EmailChannel(FakeEmailSender 경유, 우아한 열화) · 채널 레지스트리.
"""

from __future__ import annotations

import pytest

from app.config import settings
from app.models import DEFAULT_PARTICIPANT_MENU
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

    def test_render_email_default_brand_name_is_sales_ai(self):
        subject, body = render_email(_envelope(type_="review_ready", counterpart_org_name="한화"))
        assert subject.startswith("[Sales AI]")

    def test_render_email_custom_brand_name_reflected(self, monkeypatch):
        monkeypatch.setattr(settings, "email_brand_name", "KCE 2026")
        subject, body = render_email(_envelope(type_="application_approved", counterpart_org_name="한화"))
        assert subject.startswith("[KCE 2026]")
        assert "KCE 2026 비즈매칭 서비스" in body
        assert "log in to KCE 2026" in body


# 참가자 메뉴(nv001menu0001)에 따른 메일 본문. 전체 메뉴(full)로 설정한 행사의 본문은 **글자 그대로** 고정한다 —
# 이 설정이 생기기 전의 문구이고, 고객이 전체 메뉴로 되돌렸을 때 예전과 완전히 같아야 하기 때문이다.
_FULL_APPROVED_BODY = (
    "비즈매칭 승인이 완료되었습니다 (Your application has been approved)\n\n"
    "이제 Sales AI 비즈매칭 서비스에서 바이어/참가사를 탐색하고 미팅을 신청할 수 있어요.\n"
    "You can now log in to Sales AI to explore matches and request meetings.\n"
)
_FULL_DEFAULT_BODY = (
    "미팅 신청이 도착했어요 (New meeting request)\n\n"
    "상대 기업 / Counterpart: 한화\n\n"
    "Sales AI 알림함에서 자세히 확인하세요.\n"
    "Check the details in your Sales AI notification inbox.\n"
)
_MEETINGS_ONLY_APPROVED_BODY = (
    "비즈매칭 승인이 완료되었습니다 (Your application has been approved)\n\n"
    "이제 Sales AI 비즈매칭 서비스에 로그인해 미팅 화면에서 일정을 확인할 수 있어요.\n"
    "You can now log in to Sales AI and check your schedule on the Meetings screen.\n"
)
_MEETINGS_ONLY_DEFAULT_BODY = (
    "미팅 신청이 도착했어요 (New meeting request)\n\n"
    "상대 기업 / Counterpart: 한화\n\n"
    "Sales AI에 로그인해 미팅 화면에서 자세히 확인하세요.\n"
    "Log in to Sales AI and check the details on the Meetings screen.\n"
)
_REJECTED_BODY = (
    "미팅 신청이 거절됐어요 (Your meeting request was declined)\n\n"
    "상대 기업 / Counterpart: 한화\n\n"
    "다른 시간으로 다시 신청해 보세요.\n"
    "Feel free to send a new request for a different time.\n"
)
#: 본문 끝의 "어디서 확인하라" 안내가 메뉴를 따르는 6종(승인·거절은 전용 본문이 따로 있다).
_SCREEN_POINTING_TYPES = (
    "meeting_requested", "meeting_accepted", "meeting_cancelled",
    "meeting_reminder", "review_prompt", "review_ready",
)


def _menu_envelope(type_: str, menu: str | None, **payload) -> NotificationEnvelope:
    """menu=None이면 봉투에 값을 싣지 않는다(구 호출부·테스트) — 봉투의 기본값이 적용된다."""
    extra = {} if menu is None else {"participant_menu": menu}
    return NotificationEnvelope(
        notification_id="ntf-1",
        type=type_,
        event_id="ev-1",
        meeting_id="mtg-1",
        payload=payload or {"counterpart_org_name": "한화"},
        **extra,
    )


class TestRenderEmailByParticipantMenu:
    def test_default_menu_is_the_code_constant(self):
        assert DEFAULT_PARTICIPANT_MENU == "meetings_only"
        assert _menu_envelope("meeting_requested", None).participant_menu == DEFAULT_PARTICIPANT_MENU

    def test_full_menu_bodies_are_byte_identical_to_before_this_setting_existed(self):
        _, approved = render_email(_menu_envelope("application_approved", "full", org_name="한화"))
        _, requested = render_email(_menu_envelope("meeting_requested", "full"))
        assert approved == _FULL_APPROVED_BODY
        assert requested == _FULL_DEFAULT_BODY

    # None = 값을 싣지 않은 봉투, "something_else" = 어휘 밖 값(미래 어휘·오타). 둘 다 기본값으로 떨어진다 —
    # 폴백이 상수 하나(DEFAULT_PARTICIPANT_MENU)를 본다는 것을 본문으로 확인한다. 렌더가 터지지도 않는다.
    @pytest.mark.parametrize("menu", ["meetings_only", None, "something_else", ""])
    def test_meetings_only_and_every_fallback_point_to_the_meetings_screen(self, menu):
        _, approved = render_email(_menu_envelope("application_approved", menu, org_name="한화"))
        _, requested = render_email(_menu_envelope("meeting_requested", menu))
        assert approved == _MEETINGS_ONLY_APPROVED_BODY
        assert requested == _MEETINGS_ONLY_DEFAULT_BODY

    def test_meetings_only_approval_mail_does_not_send_people_to_discover(self):
        # 메뉴에 없는 화면(기업 탐색)과 화면에서 내린 동선(미팅 신청)을 권하지 않는다.
        for hidden in ("탐색", "신청할 수", "explore", "request meetings"):
            assert hidden not in _MEETINGS_ONLY_APPROVED_BODY

    @pytest.mark.parametrize("type_", _SCREEN_POINTING_TYPES)
    def test_only_the_two_guidance_lines_differ_between_menus(self, type_):
        _, full = render_email(_menu_envelope(type_, "full"))
        _, body = render_email(_menu_envelope(type_, "meetings_only"))
        assert full.endswith(
            "Sales AI 알림함에서 자세히 확인하세요.\nCheck the details in your Sales AI notification inbox.\n"
        )
        assert body.endswith(
            "Sales AI에 로그인해 미팅 화면에서 자세히 확인하세요.\n"
            "Log in to Sales AI and check the details on the Meetings screen.\n"
        )
        assert "알림함" not in body and "inbox" not in body
        # 안내 두 줄만 다르다 — 제목 줄과 상대 기업 줄은 메뉴와 무관하다.
        assert body.split("\n")[:3] == full.split("\n")[:3]

    @pytest.mark.parametrize("type_", ["application_approved", "meeting_rejected", *_SCREEN_POINTING_TYPES])
    def test_subject_does_not_depend_on_menu(self, type_):
        assert render_email(_menu_envelope(type_, "meetings_only"))[0] == render_email(
            _menu_envelope(type_, "full")
        )[0]

    @pytest.mark.parametrize("menu", [None, "full", "meetings_only"])
    def test_rejected_mail_is_the_same_in_every_menu(self, menu):
        # 거절 메일은 화면을 가리키지 않아 이번 변경 범위 밖이다 — 어느 메뉴에서도 기존 본문 그대로.
        assert render_email(_menu_envelope("meeting_rejected", menu))[1] == _REJECTED_BODY

    def test_custom_brand_name_is_reflected_in_both_wordings(self, monkeypatch):
        monkeypatch.setattr(settings, "email_brand_name", "KCE 2026")
        _, approved = render_email(_menu_envelope("application_approved", "meetings_only", org_name="한화"))
        _, requested = render_email(_menu_envelope("meeting_requested", "meetings_only"))
        assert "KCE 2026 비즈매칭 서비스에 로그인해" in approved
        assert "log in to KCE 2026" in approved
        assert "KCE 2026에 로그인해" in requested
        assert "Log in to KCE 2026" in requested
        _, full_requested = render_email(_menu_envelope("meeting_requested", "full"))
        assert "KCE 2026 알림함에서" in full_requested
        assert "your KCE 2026 notification inbox" in full_requested


def test_build_channels_registers_in_app_and_email_in_order():
    channels = build_channels(FakeEmailSender())
    assert [c.name for c in channels] == ["in_app", "email"]


class TestSuppressedDispatchResults:
    """참가자 알림 메일이 꺼진 행사의 외부 채널 결과(nt004mail0001) — 채널을 부르지 않고 만든다."""

    def test_email_recipients_become_skipped_with_reason_and_missing_address_keeps_its_shape(self):
        from app.notifications.channels import EVENT_EMAIL_DISABLED, suppressed_dispatch_results

        recipients = [
            ChannelRecipient(member_id="m1", email="a@x.com"),
            ChannelRecipient(member_id="m2", email=None),
            ChannelRecipient(member_id="m3", email=""),
        ]
        sender = FakeEmailSender()
        # 켜져 있었다면 EmailChannel이 냈을 결과와 같은 행 집합 — 상태·사유만 다르다.
        on = EmailChannel(sender).send(_envelope(), recipients)

        off = suppressed_dispatch_results("email", recipients)

        assert EVENT_EMAIL_DISABLED == "event_email_disabled"
        assert [(r.member_id, r.channel) for r in off] == [(r.member_id, r.channel) for r in on]
        assert [(r.status, r.error) for r in off] == [
            ("skipped", "event_email_disabled"),
            ("skipped", None),  # 주소 없음 — EmailChannel과 같은 모양(사유 없음)
            ("skipped", None),
        ]

    def test_other_external_channels_are_skipped_for_every_recipient(self):
        from app.notifications.channels import suppressed_dispatch_results

        off = suppressed_dispatch_results("sms", [ChannelRecipient(member_id="m1", email=None)])
        assert [(r.member_id, r.channel, r.status, r.error) for r in off] == [
            ("m1", "sms", "skipped", "event_email_disabled")
        ]
