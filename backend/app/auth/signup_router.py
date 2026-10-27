"""자체 회원가입 HTTP 엔드포인트(개발계획서 §7.3) — POST /api/auth/signup + 이메일 인증코드(#9).

ADR-0007 "공개 자체 회원가입은 열지 않는다"의 발주자 지시 supersede(app.auth.signup_service의
모듈 docstring 참고). 검증·비즈니스 로직은 그쪽에 두고, 여기는 HTTP 상태코드 매핑만 한다.

이메일 인증코드 두 엔드포인트(#9, 발주자 정정 2026-09-15 "가입 중 코드 확인")도 이 라우터에
함께 둔다 — 셋 다 가입 트랜잭션 한 흐름(코드 발송 → 코드 확인 → 가입)이라 별도 라우터로
쪼개지 않는다. 검증 성공 시 발급하는 단기 서명 토큰은 ``login_ticket.LoginTicketService``를
그대로 재사용한다(login_router._ticket_service와 동일한 "프로세스 단일 인스턴스" 관례 —
발급(email-code/verify)과 검증(signup)이 같은 인스턴스를 봐야 하므로 모듈 전역에 둔다).
"""

from __future__ import annotations

from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.auth import email_verification_service, signup_service
from app.auth.login_ticket import LoginTicketService
from app.auth.signup_schemas import (
    EmailCodeRequest,
    EmailCodeResponse,
    EmailCodeVerifyRequest,
    EmailCodeVerifyResponse,
    SignupRequest,
    SignupResponse,
)
from app.db import get_session
from app.notifications.email import EmailSender, build_email_sender

router = APIRouter(prefix="/api/auth", tags=["auth"])

# 이메일 인증 토큰 TTL(#9 지시서 — "TTL 30분"). login_ticket 기본 10분과 다른 용도의 별도 인스턴스.
_EMAIL_VERIFY_TOKEN_TTL = timedelta(minutes=30)
_email_verify_ticket_service = LoginTicketService(default_ttl=_EMAIL_VERIFY_TOKEN_TTL)


def get_email_verify_ticket_service() -> LoginTicketService:
    """테스트가 dependency_overrides로 더블을 꽂거나, 토큰을 직접 발급해 갈 수 있게 노출."""
    return _email_verify_ticket_service


def get_email_sender() -> EmailSender:
    """테스트가 FakeEmailSender로 override — 기본은 app.config.settings.email_backend를 따른다."""
    return build_email_sender()


@router.post("/signup/email-code", response_model=EmailCodeResponse, status_code=status.HTTP_200_OK)
def request_signup_email_code(
    body: EmailCodeRequest,
    db: Session = Depends(get_session),
    sender: EmailSender = Depends(get_email_sender),
) -> EmailCodeResponse:
    try:
        email_verification_service.request_code(db, body.email, sender)
    except email_verification_service.RateLimitedError as exc:
        raise HTTPException(status_code=status.HTTP_429_TOO_MANY_REQUESTS, detail=str(exc)) from exc
    except RuntimeError as exc:
        # SmtpEmailSender 생성/발송 실패(SMTP 미설정 등) — fail-closed, 500 대신 명확한 메시지.
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(exc)) from exc
    return EmailCodeResponse()


@router.post(
    "/signup/email-code/verify", response_model=EmailCodeVerifyResponse, status_code=status.HTTP_200_OK
)
def verify_signup_email_code(
    body: EmailCodeVerifyRequest,
    db: Session = Depends(get_session),
    ticket_service: LoginTicketService = Depends(get_email_verify_ticket_service),
) -> EmailCodeVerifyResponse:
    try:
        email_verification_service.verify_code(db, body.email, body.code)
    except email_verification_service.InvalidCodeError as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)) from exc
    token = ticket_service.issue({"email": body.email}, ttl=_EMAIL_VERIFY_TOKEN_TTL)
    return EmailCodeVerifyResponse(verification_token=token)


@router.post("/signup", response_model=SignupResponse, status_code=status.HTTP_201_CREATED)
def create_signup(
    body: SignupRequest,
    db: Session = Depends(get_session),
    ticket_service: LoginTicketService = Depends(get_email_verify_ticket_service),
) -> SignupResponse:
    try:
        signup_service.signup(db, body, ticket_service)
    except signup_service.DuplicateEmailError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    except signup_service.InvalidVerificationTokenError as exc:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(exc)) from exc
    except (signup_service.EventNotFoundError, signup_service.NoActiveEventError) as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    return SignupResponse()
