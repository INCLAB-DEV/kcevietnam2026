"""이메일 발송 포트 — 알림(ADR-0010)의 저비용 기본 채널.

app.services.transcription의 TRANSCRIBER_BACKEND 패턴을 그대로 따른다: 'fake'는 외부 호출
없이 결정적으로 동작(테스트/로컬 기본값), 'smtp'는 자격증명이 없으면 생성 시점에 명확히
실패한다(조용한 폴백 금지 — fail-closed).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Protocol

from app.config import Settings
from app.config import settings as _SETTINGS


@dataclass(frozen=True)
class EmailMessage:
    to: list[str]
    subject: str
    body: str


class EmailSender(Protocol):
    def send(self, message: EmailMessage) -> None:
        """이메일 한 통을 발송한다. 실패 시 예외를 던진다(호출부가 dispatch status로 흡수)."""
        ...


@dataclass
class FakeEmailSender:
    """외부 호출 없는 결정적 발송 — 테스트/로컬 기본값. 보낸 메일을 기록해 검증 가능."""

    sent: list[EmailMessage] = field(default_factory=list)

    def send(self, message: EmailMessage) -> None:
        self.sent.append(message)


class SmtpEmailSender:
    """실 SMTP 발송(STARTTLS). 설정(SMTP_HOST/PORT/FROM) 없으면 생성 시점에 즉시 실패한다."""

    def __init__(
        self,
        host: str | None,
        port: int,
        user: str | None,
        password: str | None,
        from_addr: str | None,
        *,
        reply_to: str | None = None,
        sender_name: str | None = None,
    ) -> None:
        if not host or not from_addr:
            raise RuntimeError(
                "SMTP 설정 없음(SMTP_HOST/SMTP_FROM) — 이메일 채널을 쓸 수 없습니다"
            )
        self._host = host
        self._port = port
        self._user = user
        self._password = password
        self._from = from_addr
        self._reply_to = reply_to
        self._sender_name = sender_name

    def send(self, message: EmailMessage) -> None:  # pragma: no cover - 외부호출
        import smtplib
        from email.mime.text import MIMEText
        from email.utils import formataddr

        msg = MIMEText(message.body, "plain", "utf-8")
        msg["Subject"] = message.subject
        # 헤더 From(표시용)과 봉투 발신자(smtp.sendmail 첫 인자)를 분리한다 — 표시이름을 섞으면
        # 봉투 발신자가 깨지는 MTA가 있어, 봉투는 항상 순수 주소(self._from)로 보낸다.
        msg["From"] = formataddr((self._sender_name, self._from)) if self._sender_name else self._from
        msg["To"] = ", ".join(message.to)
        if self._reply_to:
            msg["Reply-To"] = self._reply_to

        with smtplib.SMTP(self._host, self._port) as smtp:
            smtp.starttls()
            if self._user and self._password:
                smtp.login(self._user, self._password)
            smtp.sendmail(self._from, message.to, msg.as_string())


def build_email_sender(settings: Settings | None = None) -> EmailSender:
    s = settings or _SETTINGS
    if s.email_backend == "smtp":
        return SmtpEmailSender(
            s.smtp_host,
            s.smtp_port,
            s.smtp_user,
            s.smtp_password,
            s.smtp_from,
            reply_to=s.smtp_reply_to,
            sender_name=s.email_sender_name,
        )
    return FakeEmailSender()
