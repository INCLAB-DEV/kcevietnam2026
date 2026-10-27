"""이메일 발송 포트 — 알림(ADR-0010)의 저비용 기본 채널.

app.services.transcription의 TRANSCRIBER_BACKEND 패턴을 그대로 따른다: 'fake'는 외부 호출
없이 결정적으로 동작(테스트/로컬 기본값), 'smtp'는 자격증명이 없으면 생성 시점에 명확히
실패한다(조용한 폴백 금지 — fail-closed).
"""

from __future__ import annotations

import threading
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Protocol

from app.config import Settings
from app.config import settings as _SETTINGS


class RateLimiter:
    """발송 사이에 최소 간격(1/per_second초)을 강제한다 — 1초에 per_second통을 넘지 않는다.

    다음 발송 시각을 락 안에서 예약하고 락 밖에서 기다리므로, 여러 스레드가 함께 써도 서로 다른 슬롯을
    받는다. ``cost``는 이번 발송이 차지하는 칸 수다(수신자 수 — SES 한도는 메시지가 아니라 수신자로
    센다). clock/sleep은 테스트가 가짜 시계로 갈아끼울 수 있게 주입받는다.
    """

    def __init__(
        self,
        per_second: float,
        *,
        clock: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        self._interval = 1.0 / per_second
        self._clock = clock
        self._sleep = sleep
        self._lock = threading.Lock()
        self._next_at: float | None = None

    def acquire(self, cost: int = 1) -> None:
        with self._lock:
            now = self._clock()
            slot = now if self._next_at is None else max(now, self._next_at)
            self._next_at = slot + self._interval * max(1, cost)
        if slot > now:
            self._sleep(slot - now)


# 프로세스 공유 발송 상한 — 일괄 확정 백그라운드 스레드·리마인더 스케줄러·요청 안 단건 발송이 모두 같은
# 상한을 나눠 쓴다. 발송 경로마다 따로 두면 각각은 상한을 지켜도 합쳐서 SES 한도(14통/초)를 넘는다.
_limiter_lock = threading.Lock()
_rate_limiter: RateLimiter | None = None


def email_rate_limiter() -> RateLimiter:
    """프로세스 공유 발송 상한(초당 ``settings.email_max_per_second``통). 처음 부를 때 만든다."""
    global _rate_limiter
    with _limiter_lock:
        if _rate_limiter is None:
            _rate_limiter = RateLimiter(_SETTINGS.email_max_per_second)
        return _rate_limiter


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
    """실 SMTP 발송(STARTTLS). 설정(SMTP_HOST/PORT/FROM) 없으면 생성 시점에 즉시 실패한다.

    모든 실발송이 지나는 가장 낮은 공통 경로라, 프로세스 공유 상한(``email_rate_limiter``)을 여기서 건다 —
    인스턴스가 요청마다 새로 만들어지거나(deps.get_email_sender) 알림 채널에 캐시돼 있어도(service.
    _default_channels) 상한은 하나다.
    """

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
        timeout: float = 8.0,
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
        # 소켓 타임아웃(연결·응답 대기 각각). 기본값은 config와 같고 실제 값은 build_email_sender가 넘긴다.
        self._timeout = timeout

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

        # 연결 전에 프로세스 공유 상한의 차례를 받는다(수신자 수만큼). 상한은 호출 시점에 꺼낸다 — 캐시된
        # 인스턴스도 같은 상한을 쓰게(그리고 테스트가 가짜 시계 상한으로 바꿔 끼울 수 있게).
        email_rate_limiter().acquire(cost=len(message.to))

        # timeout 없이 열면 소켓 기본값(무제한)이라, SES·네트워크가 응답을 멈추면 발송 스레드(요청이든
        # 스케줄러든)가 영원히 묶인다. 넘기면 socket.timeout(OSError)으로 실패 → 채널이 'failed'로 기록한다.
        with smtplib.SMTP(self._host, self._port, timeout=self._timeout) as smtp:
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
            timeout=s.smtp_timeout_seconds,
        )
    return FakeEmailSender()
