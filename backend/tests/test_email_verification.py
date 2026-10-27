"""가입 이메일 인증코드 테스트(#9) — POST /api/auth/signup/email-code{,/verify}.

서비스 레벨(app.auth.email_verification_service)은 clock 주입으로 만료·쿨다운을 결정적으로
검증하고, HTTP 레벨은 FastAPI TestClient로 두 엔드포인트 + 뒤이은 가입 성공까지 왕복한다.
test_signup_api.py와 동일하게 Postgres 통합 DB(``migrated_db``)를 쓴다.
"""

from __future__ import annotations

import itertools
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from app.auth import email_verification_service as svc
from app.auth.signup_router import get_email_sender, get_email_verify_ticket_service
from app.config import settings
from app.db import get_session
from app.main import app
from app.models import EmailVerificationCode
from app.notifications.email import FakeEmailSender

_seq = itertools.count(1)


@pytest.fixture()
def db_factory(migrated_db: str):
    engine = create_engine(migrated_db, future=True)
    TestSession = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)
    yield TestSession
    engine.dispose()


@pytest.fixture()
def fake_sender():
    return FakeEmailSender()


@pytest.fixture()
def client(db_factory, fake_sender):
    def _override_session():
        db = db_factory()
        try:
            yield db
        except Exception:
            db.rollback()
            raise
        finally:
            db.close()

    app.dependency_overrides[get_session] = _override_session
    app.dependency_overrides[get_email_sender] = lambda: fake_sender
    yield TestClient(app, raise_server_exceptions=False)
    app.dependency_overrides.clear()


def _email() -> str:
    return f"verify-user-{next(_seq)}@example.com"


# =============================================================================
# HTTP 해피패스 — 발송 → 확인 → 가입까지
# =============================================================================
def test_request_code_sends_email_and_persists_hash(client, db_factory, fake_sender):
    email = _email()
    resp = client.post("/api/auth/signup/email-code", json={"email": email})
    assert resp.status_code == 200
    assert resp.json() == {"outcome": "sent"}

    assert len(fake_sender.sent) == 1
    assert fake_sender.sent[0].to == [email]

    db = db_factory()
    try:
        row = db.execute(
            select(EmailVerificationCode).where(EmailVerificationCode.email == email)
        ).scalar_one()
        assert row.code_hash  # 평문 코드는 어디에도 없다
        assert row.consumed_at is None
        assert row.attempt_count == 0
    finally:
        db.close()


def test_request_code_is_sent_even_when_an_event_turned_participant_email_off(
    client, db_factory, fake_sender
):
    """행사 설정 "참가자 알림 메일"(nt004mail0001)은 자동 알림·러브콜 메일을 막지만, 가입 인증 코드는 유일한 예외다 —
    행사와 무관한 가입 절차라 꺼진 행사가 있어도 나간다."""
    from app.models import EventScheduleSettings

    event_id = _seed_event(db_factory)
    db = db_factory()
    try:
        db.add(EventScheduleSettings(event_id=event_id, participant_email_enabled=False))
        db.commit()
    finally:
        db.close()
    email = _email()

    resp = client.post("/api/auth/signup/email-code", json={"email": email})

    assert resp.status_code == 200
    assert resp.json() == {"outcome": "sent"}
    assert [m.to for m in fake_sender.sent] == [[email]]


def _sent_code(fake_sender, email: str) -> str:
    """FakeEmailSender가 받은 메일 본문에서 6자리 코드를 꺼낸다(테스트 전용 백도어)."""
    msg = next(m for m in fake_sender.sent if m.to == [email])
    import re

    match = re.search(r"\b(\d{6})\b", msg.body)
    assert match, f"본문에서 6자리 코드를 못 찾음: {msg.body!r}"
    return match.group(1)


def test_verify_code_success_then_signup_succeeds(client, db_factory, fake_sender):
    event = _seed_event(db_factory)
    email = _email()
    client.post("/api/auth/signup/email-code", json={"email": email})
    code = _sent_code(fake_sender, email)

    verify_resp = client.post("/api/auth/signup/email-code/verify", json={"email": email, "code": code})
    assert verify_resp.status_code == 200
    token = verify_resp.json()["verification_token"]
    assert token

    signup_resp = client.post(
        "/api/auth/signup",
        json={
            "email": email,
            "password": "abcd1234",
            "name": "홍길동",
            "org_name_ko": "테스트기업",
            "role": "buyer",
            "event_id": event,
            "email_verification_token": token,
        },
    )
    assert signup_resp.status_code == 201


def _seed_event(db_factory) -> str:
    from app.models import Event

    n = next(_seq)
    db = db_factory()
    try:
        ev = Event(name="인증코드테스트행사", slug=f"email-verify-{n}")
        db.add(ev)
        db.commit()
        return str(ev.id)
    finally:
        db.close()


def test_verify_wrong_code_422(client, db_factory, fake_sender):
    email = _email()
    client.post("/api/auth/signup/email-code", json={"email": email})

    resp = client.post("/api/auth/signup/email-code/verify", json={"email": email, "code": "000000"})
    assert resp.status_code == 422


def test_verify_no_code_sent_422(client):
    resp = client.post(
        "/api/auth/signup/email-code/verify", json={"email": _email(), "code": "123456"}
    )
    assert resp.status_code == 422


def test_resend_within_60s_is_rate_limited_429(client, fake_sender):
    email = _email()
    first = client.post("/api/auth/signup/email-code", json={"email": email})
    assert first.status_code == 200

    second = client.post("/api/auth/signup/email-code", json={"email": email})
    assert second.status_code == 429
    assert len(fake_sender.sent) == 1  # 두 번째는 발송되지 않았다


def test_invalid_email_format_422(client):
    resp = client.post("/api/auth/signup/email-code", json={"email": "not-an-email"})
    assert resp.status_code == 422


# =============================================================================
# 서비스 레벨 — clock 주입으로 만료·쿨다운·5회 상한·재발송 무효화를 결정적으로 검증
# =============================================================================
def test_five_wrong_attempts_invalidate_the_code(db_factory, fake_sender):
    email = _email()
    db = db_factory()
    try:
        now = datetime.now(timezone.utc)
        svc.request_code(db, email, fake_sender, clock=lambda: now)
        code = _sent_code(fake_sender, email)

        for _ in range(svc.MAX_VERIFY_ATTEMPTS):
            with pytest.raises(svc.InvalidCodeError):
                svc.verify_code(db, email, "000000", clock=lambda: now)

        # 맞는 코드를 넣어도 이미 5회 초과로 소진됐다 — 여전히 거부.
        with pytest.raises(svc.InvalidCodeError):
            svc.verify_code(db, email, code, clock=lambda: now)
    finally:
        db.close()


def test_expired_code_is_rejected(db_factory, fake_sender):
    email = _email()
    db = db_factory()
    try:
        now = datetime.now(timezone.utc)
        svc.request_code(db, email, fake_sender, clock=lambda: now)
        code = _sent_code(fake_sender, email)

        later = now + svc.CODE_TTL + timedelta(seconds=1)
        with pytest.raises(svc.InvalidCodeError):
            svc.verify_code(db, email, code, clock=lambda: later)
    finally:
        db.close()


def test_resend_invalidates_previous_code(db_factory, fake_sender):
    email = _email()
    db = db_factory()
    try:
        t0 = datetime.now(timezone.utc)
        svc.request_code(db, email, fake_sender, clock=lambda: t0)
        old_code = _sent_code(fake_sender, email)

        # 쿨다운을 지나 재발송 — 예전 코드는 무효화된다.
        t1 = t0 + svc.RESEND_COOLDOWN + timedelta(seconds=1)
        svc.request_code(db, email, fake_sender, clock=lambda: t1)

        with pytest.raises(svc.InvalidCodeError):
            svc.verify_code(db, email, old_code, clock=lambda: t1)
    finally:
        db.close()


def test_hourly_send_limit(db_factory, fake_sender):
    email = _email()
    db = db_factory()
    try:
        t0 = datetime.now(timezone.utc)
        # 쿨다운을 매번 넘겨 5회까지는 통과시킨다.
        for i in range(svc.MAX_SENDS_PER_HOUR):
            svc.request_code(db, email, fake_sender, clock=lambda i=i: t0 + timedelta(seconds=i * 61))

        sixth_at = t0 + timedelta(seconds=svc.MAX_SENDS_PER_HOUR * 61)
        with pytest.raises(svc.RateLimitedError):
            svc.request_code(db, email, fake_sender, clock=lambda: sixth_at)
    finally:
        db.close()


# =============================================================================
# 브랜드 표기 — EMAIL_BRAND_NAME 기본값(Sales AI)에서 회귀 없음 + 값 교체 시 제목·본문에 반영
# =============================================================================
def test_default_brand_name_subject_and_body_unchanged(db_factory, fake_sender):
    email = _email()
    db = db_factory()
    try:
        svc.request_code(db, email, fake_sender, clock=lambda: datetime.now(timezone.utc))
        msg = next(m for m in fake_sender.sent if m.to == [email])
        assert msg.subject == "[Sales AI] 이메일 인증코드 / Verification code"
        assert "Sales AI 가입 인증코드는" in msg.body
        assert "Your Sales AI signup verification code is" in msg.body
    finally:
        db.close()


def test_custom_brand_name_reflected_in_subject_and_body(db_factory, fake_sender, monkeypatch):
    monkeypatch.setattr(settings, "email_brand_name", "KCE 2026")
    email = _email()
    db = db_factory()
    try:
        svc.request_code(db, email, fake_sender, clock=lambda: datetime.now(timezone.utc))
        msg = next(m for m in fake_sender.sent if m.to == [email])
        assert msg.subject == "[KCE 2026] 이메일 인증코드 / Verification code"
        assert "KCE 2026 가입 인증코드는" in msg.body
        assert "Your KCE 2026 signup verification code is" in msg.body
    finally:
        db.close()


# =============================================================================
# 토큰 발급 — email-code/verify가 발급하는 토큰이 signup_router의 프로세스 싱글턴과 동일한지
# =============================================================================
def test_verify_issues_token_from_shared_ticket_service(client, fake_sender):
    email = _email()
    client.post("/api/auth/signup/email-code", json={"email": email})
    code = _sent_code(fake_sender, email)

    resp = client.post("/api/auth/signup/email-code/verify", json={"email": email, "code": code})
    token = resp.json()["verification_token"]

    # 라우터가 실제로 쓰는 것과 같은 싱글턴이면, 여기서 바로 검증에 성공해야 한다(아직 미소진).
    result = get_email_verify_ticket_service().verify(token)
    assert result.allowed is True
    assert result.payload == {"email": email}
