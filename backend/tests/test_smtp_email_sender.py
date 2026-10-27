"""SmtpEmailSender 단위 테스트 — SES 전환 대비(2026-09) 발신자 표시이름/Reply-To 분리.

smtplib.SMTP를 몽키패치해 실제 소켓 없이 호출 인자만 검증한다(DB 불필요, migrated_db 픽스처 없이
바로 돈다). 봉투 발신자(sendmail 첫 인자)와 헤더 From을 분리하는 게 이 테스트군의 핵심 —
표시이름을 넣어도 봉투는 항상 순수 주소여야 한다.
"""

from __future__ import annotations

import threading
from email.header import decode_header
from email.parser import Parser
from email.utils import parseaddr

import pytest

from app.config import Settings, settings
from app.notifications import email as email_module
from app.notifications.email import (
    EmailMessage,
    RateLimiter,
    SmtpEmailSender,
    build_email_sender,
    email_rate_limiter,
)


class _FakeSmtp:
    """smtplib.SMTP를 대신하는 스파이 — 생성(host/port/timeout)·starttls/login/sendmail 호출 인자를 기록한다."""

    instances: list["_FakeSmtp"] = []

    def __init__(self, host, port, timeout=None):
        self.host = host
        self.port = port
        self.timeout = timeout
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


@pytest.fixture(autouse=True)
def _no_wait_rate_limiter(monkeypatch):
    """실발송 경로는 프로세스 공유 상한을 지난다 — 이 파일의 다른 테스트가 실제로 0.1초씩 기다리지 않게,
    시간이 멈춘 가짜 시계 상한으로 바꿔 둔다(상한 자체는 아래 TestProcessWideRateLimit가 따로 잠근다)."""
    monkeypatch.setattr(
        email_module, "_rate_limiter", RateLimiter(10, clock=lambda: 0.0, sleep=lambda _s: None)
    )


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


class TestSocketTimeout:
    """SMTP 소켓 타임아웃(동시성 하드닝 1차) — 없으면 SES/네트워크가 멈췄을 때 발송 스레드가 무기한 묶인다."""

    def test_timeout_is_passed_to_smtplib(self, fake_smtp):
        sender = SmtpEmailSender(
            "smtp.example.com", 587, None, None, "no-reply@salesground.kr", timeout=7.5
        )
        sender.send(EmailMessage(to=["buyer@example.com"], subject="s", body="b"))

        smtp = fake_smtp.instances[0]
        assert (smtp.host, smtp.port, smtp.timeout) == ("smtp.example.com", 587, 7.5)

    def test_build_email_sender_uses_configured_timeout(self, fake_smtp):
        s = Settings(
            email_backend="smtp",
            smtp_host="smtp.example.com",
            smtp_from="no-reply@salesground.kr",
            smtp_timeout_seconds=3,
        )
        build_email_sender(s).send(EmailMessage(to=["buyer@example.com"], subject="s", body="b"))
        assert fake_smtp.instances[0].timeout == 3

    def test_default_timeout_is_finite(self, fake_smtp):
        # 기본값(config.smtp_timeout_seconds=8 — 정상 SES 발송 0.2~0.3초)으로도 None(무제한)이 아니어야 한다.
        s = Settings(email_backend="smtp", smtp_host="smtp.example.com", smtp_from="no-reply@salesground.kr")
        build_email_sender(s).send(EmailMessage(to=["buyer@example.com"], subject="s", body="b"))
        assert fake_smtp.instances[0].timeout == 8


# =============================================================================
# 초당 상한 — RateLimiter 자체 + 실발송 경로의 프로세스 공유 상한(여러 스레드·여러 인스턴스 합산)
# =============================================================================
class _FakeClock:
    """한 스레드용 가짜 시계 — sleep이 시간을 그만큼 전진시킨다(실제로 기다리지 않는다)."""

    def __init__(self) -> None:
        self.now = 0.0
        self.sleeps: list[float] = []

    def monotonic(self) -> float:
        return self.now

    def sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)
        self.now += seconds


class _FrozenThreadClock:
    """여러 스레드가 함께 쓰는 가짜 시계 — 전역 시각은 0에 멈춰 두고, sleep은 '그 스레드가 깨어날 가상 시각'만
    스레드별로 기록한다(실제로 기다리지 않는다).

    모든 발송이 같은 순간 몰려든 최악의 경우를 흉내 낸다. 상한이 내준 차례가 곧 가상 발송 시각이 되므로,
    스레드 실행 순서와 무관하게 결과가 결정적이다.
    """

    def __init__(self) -> None:
        self._local = threading.local()

    def monotonic(self) -> float:
        return 0.0

    def sleep(self, seconds: float) -> None:
        self._local.wake_at = seconds

    def take_virtual_now(self) -> float:
        wake_at = getattr(self._local, "wake_at", 0.0)
        self._local.wake_at = 0.0
        return wake_at


class TestRateLimiter:
    def test_never_more_than_per_second_in_any_one_second_window(self):
        clock = _FakeClock()
        limiter = RateLimiter(4, clock=clock.monotonic, sleep=clock.sleep)
        stamps = []
        for _ in range(17):
            limiter.acquire()
            stamps.append(clock.now)

        for t in stamps:
            assert sum(1 for s in stamps if t <= s < t + 1) <= 4
        assert stamps[-1] == 4.0  # 17통 = 첫 통 즉시 + 16 × 0.25초

    def test_idle_gap_does_not_accumulate_burst_credit_or_extra_wait(self):
        clock = _FakeClock()
        limiter = RateLimiter(4, clock=clock.monotonic, sleep=clock.sleep)
        limiter.acquire()
        clock.now += 10  # 한참 쉬었다가
        limiter.acquire()  # 바로 보낼 수 있고
        assert clock.sleeps == []
        limiter.acquire()  # 그다음부터는 다시 간격을 지킨다
        assert clock.sleeps == [0.25]

    def test_cost_reserves_that_many_slots(self):
        """수신자 3명짜리 한 통은 3칸을 쓴다(SES는 수신자 수로 센다) — 다음 발송은 3칸 뒤로 밀린다."""
        clock = _FakeClock()
        limiter = RateLimiter(10, clock=clock.monotonic, sleep=clock.sleep)
        limiter.acquire(cost=3)
        limiter.acquire()
        assert clock.sleeps == [pytest.approx(0.3)]


class _RecordingSmtp(_FakeSmtp):
    """sendmail 시점의 가상 시각·스레드를 기록하는 가짜 SMTP — 공유 가짜 시계를 클래스에 꽂아 쓴다."""

    clock: _FrozenThreadClock | None = None
    lock = threading.Lock()
    log: list[tuple[float, str, tuple[str, ...]]] = []

    def sendmail(self, from_addr, to_addrs, msg_string):
        assert self.clock is not None, "테스트가 공유 가짜 시계를 꽂아야 한다"
        at = self.clock.take_virtual_now()
        with self.lock:
            self.log.append((at, threading.current_thread().name, tuple(to_addrs)))


class TestProcessWideRateLimit:
    """일괄 확정 스레드·리마인더 스케줄러·요청 안 단건 발송이 **합쳐서** 초당 상한을 넘지 않는다.

    발송 경로마다 SmtpEmailSender 인스턴스가 따로 있다(요청마다 새로 만든 것, 알림 채널에 캐시된 것) —
    상한이 인스턴스·스레드별이면 각자는 지켜도 합쳐서 SES 한도를 넘는다.
    """

    def test_concurrent_senders_from_many_threads_share_one_limit(self, monkeypatch):
        import smtplib

        clock = _FrozenThreadClock()
        monkeypatch.setattr(_RecordingSmtp, "clock", clock)
        monkeypatch.setattr(_RecordingSmtp, "log", [])
        monkeypatch.setattr(smtplib, "SMTP", _RecordingSmtp)
        monkeypatch.setattr(
            email_module, "_rate_limiter", RateLimiter(10, clock=clock.monotonic, sleep=clock.sleep)
        )
        # 서로 다른 인스턴스 둘 — 알림 채널에 캐시된 발송기와 요청마다 새로 만드는 발송기를 흉내 낸다.
        senders = [
            SmtpEmailSender("smtp.example.com", 587, None, None, "no-reply@salesground.kr"),
            SmtpEmailSender("smtp.example.com", 587, None, None, "no-reply@salesground.kr"),
        ]
        start = threading.Barrier(4)

        def worker(index: int) -> None:
            start.wait()
            for n in range(5):
                senders[(index + n) % 2].send(
                    EmailMessage(to=[f"t{index}-{n}@example.com"], subject="s", body="b")
                )

        threads = [threading.Thread(target=worker, args=(i,), name=f"sender-{i}") for i in range(4)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=10)

        log = _RecordingSmtp.log
        assert len(log) == 20
        assert len({thread for _, thread, _ in log}) == 4  # 정말로 네 스레드가 동시에 보냈다
        times = sorted(at for at, _, _ in log)
        # 같은 순간 20통이 몰려도 상한 하나가 0.1초 간격의 서로 다른 차례를 나눠 줬다 — 겹치는 차례가 없다.
        assert times == pytest.approx([i * 0.1 for i in range(20)])
        for t in times:
            assert sum(1 for s in times if t <= s < t + 1 - 1e-9) <= 10

    def test_message_with_many_recipients_uses_as_many_slots(self, monkeypatch):
        import smtplib

        clock = _FrozenThreadClock()
        monkeypatch.setattr(_RecordingSmtp, "clock", clock)
        monkeypatch.setattr(_RecordingSmtp, "log", [])
        monkeypatch.setattr(smtplib, "SMTP", _RecordingSmtp)
        monkeypatch.setattr(
            email_module, "_rate_limiter", RateLimiter(10, clock=clock.monotonic, sleep=clock.sleep)
        )
        sender = SmtpEmailSender("smtp.example.com", 587, None, None, "no-reply@salesground.kr")

        # 러브콜 메일처럼 한 통에 담당자 3명 → 3칸. 다음 발송은 0.3초 뒤 차례다.
        sender.send(EmailMessage(to=["a@example.com", "b@example.com", "c@example.com"], subject="s", body="b"))
        sender.send(EmailMessage(to=["d@example.com"], subject="s", body="b"))

        assert [at for at, _, _ in _RecordingSmtp.log] == pytest.approx([0.0, 0.3])

    def test_process_limiter_uses_configured_rate_and_is_shared(self, monkeypatch):
        monkeypatch.setattr(email_module, "_rate_limiter", None)
        monkeypatch.setattr(settings, "email_max_per_second", 4)
        limiter = email_rate_limiter()
        assert limiter is email_rate_limiter()  # 프로세스에 하나
        assert limiter._interval == pytest.approx(0.25)  # type: ignore[attr-defined]

    def test_default_rate_stays_below_ses_limit(self):
        assert 0 < Settings(_env_file=None).email_max_per_second <= 14
