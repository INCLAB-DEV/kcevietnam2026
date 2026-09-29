"""가입 이메일 인증코드 — 실존 이메일 확인 게이트(#9, 발주자 정정 2026-09-15).

가입 폼이 "아무 이메일이나 적어도 가입"되는 문제를 막는다: 이메일 입력 → 6자리 코드 발송 →
코드 확인이 통과해야 ``app.auth.signup_service.signup``을 호출할 수 있다(단기 서명 토큰을 거쳐,
app.auth.signup_router 참고).

DB에는 코드 해시만 저장한다(평문 금지). 저장소는 ``EmailVerificationCode``(app.models) 테이블 —
로그인/딥링크 티켓 모듈(app.auth.login_ticket / deeplink_token)과 달리 인메모리가 아니라 DB를
쓰는 이유는 레이트리밋(시간당 발송 횟수)이 프로세스 재시작·다중 인스턴스에도 걸쳐야 하기 때문이다.

이메일 존재 여부(가입된 회원인지)는 이 모듈이 노출하지 않는다(enumeration 방지) — 호출부는
회원 존재와 무관하게 항상 실제로 코드를 발송한다. 이미 가입된 이메일이면 뒤이은 signup 호출이
기존 DuplicateEmailError(409)로 걸린다.
"""

from __future__ import annotations

import hashlib
import secrets
from datetime import datetime, timedelta, timezone

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.config import settings as _SETTINGS
from app.models import EmailVerificationCode
from app.notifications.email import EmailMessage, EmailSender

CODE_LENGTH = 6
CODE_TTL = timedelta(minutes=10)
RESEND_COOLDOWN = timedelta(seconds=60)
MAX_SENDS_PER_HOUR = 5
MAX_VERIFY_ATTEMPTS = 5


def _utcnow() -> datetime:
    """주입 가능한 기본 시계 — timezone-aware UTC(login_ticket/deeplink_token과 동일 관례)."""
    return datetime.now(timezone.utc)


class RateLimitedError(Exception):
    """60초 재발송 쿨다운 또는 시간당 5회 발송 상한 초과 — 429 매핑."""


class InvalidCodeError(Exception):
    """코드 불일치·만료·소진(5회 초과 포함)·미발송 — 422 매핑."""


def _normalize_email(email: str) -> str:
    return email.strip().lower()


def _generate_code() -> str:
    return f"{secrets.randbelow(10**CODE_LENGTH):0{CODE_LENGTH}d}"


def _hash_code(email: str, code: str) -> str:
    # 이메일을 코드와 함께 해시해 같은 6자리값이라도 이메일마다 다른 해시가 되게 한다.
    return hashlib.sha256(f"{email}:{code}".encode("utf-8")).hexdigest()


def _aware(value: datetime) -> datetime:
    """DB에서 읽은 naive datetime을 UTC-aware로 정규화(드라이버가 tz 정보를 떨굴 수 있음)."""
    return value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)


def request_code(
    db: Session,
    email: str,
    sender: EmailSender,
    clock=_utcnow,
) -> None:
    """코드 생성 → 해시 저장 → 메일 발송. 레이트리밋 위반 시 RateLimitedError.

    같은 email의 기존 미소비 코드는 새 코드 발급 전에 무효화한다(재발송 시 구 코드 무효).
    발송 자체가 실패하면(SmtpEmailSender 등) 예외가 그대로 전파된다 — 호출부(router)가
    상태코드로 매핑한다(fail-closed, 조용한 폴백 없음).
    """
    normalized = _normalize_email(email)
    now = clock()

    latest = db.execute(
        select(EmailVerificationCode)
        .where(EmailVerificationCode.email == normalized)
        .order_by(EmailVerificationCode.created_at.desc())
        .limit(1)
    ).scalar_one_or_none()
    if latest is not None and now - _aware(latest.created_at) < RESEND_COOLDOWN:
        raise RateLimitedError("잠시 후 다시 시도해주세요 (60초 재발송 제한)")

    hour_ago = now - timedelta(hours=1)
    sent_count = db.execute(
        select(func.count())
        .select_from(EmailVerificationCode)
        .where(
            EmailVerificationCode.email == normalized,
            EmailVerificationCode.created_at >= hour_ago,
        )
    ).scalar_one()
    if sent_count >= MAX_SENDS_PER_HOUR:
        raise RateLimitedError("발송 횟수를 초과했어요. 잠시 후 다시 시도해주세요")

    # 재발송 시 기존 미소비 코드는 전부 무효화.
    db.execute(
        EmailVerificationCode.__table__.update()
        .where(
            EmailVerificationCode.email == normalized,
            EmailVerificationCode.consumed_at.is_(None),
        )
        .values(consumed_at=now)
    )

    code = _generate_code()
    db.add(
        EmailVerificationCode(
            email=normalized,
            code_hash=_hash_code(normalized, code),
            expires_at=now + CODE_TTL,
        )
    )
    db.commit()

    brand = _SETTINGS.email_brand_name
    sender.send(
        EmailMessage(
            to=[normalized],
            subject=f"[{brand}] 이메일 인증코드 / Verification code",
            body=(
                f"{brand} 가입 인증코드는 {code} 입니다. 10분 이내에 입력해주세요.\n"
                f"Your {brand} signup verification code is {code}. It expires in 10 minutes.\n"
            ),
        )
    )


def verify_code(db: Session, email: str, code: str, clock=_utcnow) -> None:
    """코드를 대조한다. 성공하면 조용히 반환(호출부가 검증 토큰을 발급), 실패 시 InvalidCodeError.

    검증 실패 누적이 MAX_VERIFY_ATTEMPTS(5)에 닿으면 해당 코드를 즉시 소진 처리해, 맞는 코드를
    나중에 다시 넣어도 더 이상 통과하지 못하게 한다(무차별 대입 방지).
    """
    normalized = _normalize_email(email)
    now = clock()

    row = db.execute(
        select(EmailVerificationCode)
        .where(
            EmailVerificationCode.email == normalized,
            EmailVerificationCode.consumed_at.is_(None),
        )
        .order_by(EmailVerificationCode.created_at.desc())
        .limit(1)
    ).scalar_one_or_none()

    if row is None:
        raise InvalidCodeError("발송된 인증코드가 없어요. 인증코드를 다시 요청해주세요")

    if now >= _aware(row.expires_at):
        raise InvalidCodeError("인증코드가 만료됐어요. 다시 요청해주세요")

    if _hash_code(normalized, code) != row.code_hash:
        row.attempt_count += 1
        if row.attempt_count >= MAX_VERIFY_ATTEMPTS:
            row.consumed_at = now
        db.commit()
        raise InvalidCodeError("인증코드가 올바르지 않아요")

    row.consumed_at = now
    db.commit()
