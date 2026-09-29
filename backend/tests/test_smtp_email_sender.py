"""SmtpEmailSender 단위 테스트 — SES 전환 대비(2026-09) 발신자 표시이름/Reply-To 분리.

smtplib.SMTP를 몽키패치해 실제 소켓 없이 호출 인자만 검증한다(DB 불필요, migrated_db 픽스처 없이
바로 돈다). 봉투 발신자(sendmail 첫 인자)와 헤더 From을 분리하는 게 이 테스트군의 핵심 —
표시이름을 넣어도 봉투는 항상 순수 주소여야 한다.
"""

from __future__ import annotations

from email.header import decode_header
from email.parser import Parser
from email.utils import parseaddr

import pytest

from app.config import Settings
from app.notifications.email import EmailMessage, SmtpEmailSender, build_email_sender


class _FakeSmtp:
    """smtplib.SMTP를 대신하는 스파이 — starttls/login/sendmail 호출 인자를 기록한다."""

    instances: list["_FakeSmtp"] = []

    def __init__(self, host, port):
        self.host = host
        self.port = port
        self.starttls_called = False
        self.login_args: tuple | None = None
        self.sendmail_args: tuple | None = None
        _FakeSmtp.instances.append(self)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def starttls(self):
        self.starttls_called = True

    def login(self, user, password):
        self.login_args = (user, password)

    def sendmail(self, from_addr, to_addrs, msg_string):
        self.sendmail_args = (from_addr, to_addrs, msg_string)


@pytest.fixture(autouse=True)
def _reset_instances():
    _FakeSmtp.instances.clear()
    yield
    _FakeSmtp.instances.clear()


@pytest.fixture()
def fake_smtp(monkeypatch):
    import smtplib

    monkeypatch.setattr(smtplib, "SMTP", _FakeSmtp)
    return _FakeSmtp


def _parsed_headers(msg_string: str):
    return Parser().parsestr(msg_string)


def _decoded(header_value: str) -> str:
    """RFC 2047 인코딩된 헤더 값을 사람이 읽는 문자열로 되돌린다(한글 표시이름 역검증용)."""
    parts = decode_header(header_value)
    return "".join(
        (chunk.decode(enc or "utf-8") if isinstance(chunk, bytes) else chunk) for chunk, enc in parts
    )


class TestEnvelopeAndFromHeader:
    def test_sender_name_sets_display_from_header_but_envelope_stays_plain_address(self, fake_smtp):
        sender = SmtpEmailSender(
            "smtp.example.com", 587, None, None, "no-reply@salesground.kr", sender_name="KCE 2026"
        )
        sender.send(EmailMessage(to=["buyer@example.com"], subject="s", body="b"))

        smtp = fake_smtp.instances[0]
        envelope_from, to_addrs, msg_string = smtp.sendmail_args
        # 봉투 발신자는 항상 순수 주소.
        assert envelope_from == "no-reply@salesground.kr"
        assert to_addrs == ["buyer@example.com"]

        msg = _parsed_headers(msg_string)
        display_name, addr = parseaddr(msg["From"])
        assert addr == "no-reply@salesground.kr"
        assert display_name == "KCE 2026"

    def test_no_sender_name_keeps_from_header_as_plain_address(self, fake_smtp):
        sender = SmtpEmailSender("smtp.example.com", 587, None, None, "no-reply@salesground.kr")
        sender.send(EmailMessage(to=["buyer@example.com"], subject="s", body="b"))

        smtp = fake_smtp.instances[0]
        envelope_from, _, msg_string = smtp.sendmail_args
        assert envelope_from == "no-reply@salesground.kr"

        msg = _parsed_headers(msg_string)
        assert msg["From"] == "no-reply@salesground.kr"
        display_name, addr = parseaddr(msg["From"])
        assert display_name == ""
        assert addr == "no-reply@salesground.kr"

    def test_korean_sender_name_survives_encoding_roundtrip(self, fake_smtp):
        sender = SmtpEmailSender(
            "smtp.example.com", 587, None, None, "no-reply@salesground.kr", sender_name="한화 비즈매칭"
        )
        sender.send(EmailMessage(to=["buyer@example.com"], subject="s", body="b"))

        smtp = fake_smtp.instances[0]
        envelope_from, _, msg_string = smtp.sendmail_args
        assert envelope_from == "no-reply@salesground.kr"

        msg = _parsed_headers(msg_string)
        display_name, addr = parseaddr(msg["From"])
        assert addr == "no-reply@salesground.kr"
        assert _decoded(display_name) == "한화 비즈매칭"


class TestReplyTo:
    def test_reply_to_header_present_when_configured(self, fake_smtp):
        sender = SmtpEmailSender(
            "smtp.example.com",
            587,
            None,
            None,
            "no-reply@salesground.kr",
            reply_to="ops@salesground.kr",
        )
        sender.send(EmailMessage(to=["buyer@example.com"], subject="s", body="b"))

        smtp = fake_smtp.instances[0]
        msg = _parsed_headers(smtp.sendmail_args[2])
        assert msg["Reply-To"] == "ops@salesground.kr"

    def test_reply_to_header_absent_when_not_configured(self, fake_smtp):
        sender = SmtpEmailSender("smtp.example.com", 587, None, None, "no-reply@salesground.kr")
        sender.send(EmailMessage(to=["buyer@example.com"], subject="s", body="b"))

        smtp = fake_smtp.instances[0]
        msg = _parsed_headers(smtp.sendmail_args[2])
        assert msg["Reply-To"] is None


class TestFailClosed:
    def test_missing_host_raises_at_construction(self):
        with pytest.raises(RuntimeError):
            SmtpEmailSender(None, 587, None, None, "no-reply@salesground.kr")

    def test_missing_from_addr_raises_at_construction(self):
        with pytest.raises(RuntimeError):
            SmtpEmailSender("smtp.example.com", 587, None, None, None)


class TestBuildEmailSenderWiring:
    def test_passes_reply_to_and_sender_name_through_to_smtp_sender(self, fake_smtp):
        s = Settings(
            email_backend="smtp",
            smtp_host="smtp.example.com",
            smtp_from="no-reply@salesground.kr",
            smtp_reply_to="ops@salesground.kr",
            email_sender_name="KCE 2026",
        )
        sender = build_email_sender(s)
        assert isinstance(sender, SmtpEmailSender)

        sender.send(EmailMessage(to=["buyer@example.com"], subject="s", body="b"))
        smtp = fake_smtp.instances[0]
        msg = _parsed_headers(smtp.sendmail_args[2])
        assert msg["Reply-To"] == "ops@salesground.kr"
        display_name, addr = parseaddr(msg["From"])
        assert display_name == "KCE 2026"
        assert addr == "no-reply@salesground.kr"

    def test_no_reply_to_or_sender_name_configured_behaves_like_before(self, fake_smtp):
        s = Settings(email_backend="smtp", smtp_host="smtp.example.com", smtp_from="no-reply@salesground.kr")
        sender = build_email_sender(s)
        sender.send(EmailMessage(to=["buyer@example.com"], subject="s", body="b"))

        smtp = fake_smtp.instances[0]
        msg = _parsed_headers(smtp.sendmail_args[2])
        assert msg["Reply-To"] is None
        assert msg["From"] == "no-reply@salesground.kr"


class TestLoginAndStarttls:
    def test_starttls_and_login_still_called_with_new_kwargs(self, fake_smtp):
        sender = SmtpEmailSender(
            "smtp.example.com",
            587,
            "user",
            "pw",
            "no-reply@salesground.kr",
            reply_to="ops@salesground.kr",
            sender_name="KCE 2026",
        )
        sender.send(EmailMessage(to=["buyer@example.com"], subject="s", body="b"))

        smtp = fake_smtp.instances[0]
        assert smtp.starttls_called
        assert smtp.login_args == ("user", "pw")
