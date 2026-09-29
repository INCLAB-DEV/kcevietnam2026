"""자체 회원가입 입출력 스키마(개발계획서 §7.3) — ADR-0007 "공개 자체 회원가입은 열지 않는다"를
발주자 지시로 부분 supersede한다(app.auth.signup_service 참고).

**회원가입으로는 참가사(exhibitor)/바이어(buyer)만 될 수 있다.** ``role``이 이 두 값만 받는
``Literal``이라 organizer/admin 계열 값은 pydantic 레벨에서 422로 원천 차단된다(테스트로 고정).
슈퍼어드민(event master)·서브어드민은 이 API로 만들 수 없다 — 슈퍼어드민은 DB 직접 부여만
(backend/README.md), 서브어드민 부여·역할 변경은 슈퍼어드민 전용 관리자 API(app.admin.router)가
담당한다.
"""

from __future__ import annotations

import re
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

# 이메일 형식·비밀번호 정책은 명단 업로드 공통 비밀번호(app.roster)와 공유하는 단일 정본에서 가져온다.
from app.auth.credentials import EMAIL_RE as _EMAIL_RE
from app.auth.credentials import PASSWORD_MIN_LENGTH, check_password_policy

# 자체 회원가입 허용 역할 — organizer/admin 계열은 이 Literal 밖이라 애초에 값이 안 들어온다.
SignupRole = Literal["buyer", "exhibitor"]


class SignupRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    email: str = Field(..., min_length=3, max_length=254)
    password: str = Field(..., min_length=PASSWORD_MIN_LENGTH)
    name: str = Field(..., min_length=1)
    phone: str | None = None
    org_name_ko: str = Field(..., min_length=1)
    org_name_en: str | None = None
    role: SignupRole
    event_id: str | None = None  # 미지정 시 진행 중인 최신 event로(app.auth.signup_service 참고)
    # 이메일 인증코드 확인 성공 시 발급되는 단기 서명 토큰(#9) — POST /api/auth/signup/email-code/verify
    # 응답의 verification_token. 누락하면 이 필드가 필수라 422로 원천 차단, 있어도 email 불일치/
    # 위조·만료·소진이면 signup_service.signup이 InvalidVerificationTokenError(403)로 거부한다.
    email_verification_token: str = Field(..., min_length=1)

    @field_validator("email")
    @classmethod
    def _valid_email_format(cls, v: str) -> str:
        if not _EMAIL_RE.match(v):
            raise ValueError("올바른 이메일 형식이 아닙니다")
        return v.strip().lower()

    @field_validator("password")
    @classmethod
    def _password_strength(cls, v: str) -> str:
        # 최소 8자 + 영문·숫자 혼합(요구사항 §7.3) — 정책 정본은 app.auth.credentials(명단 공통 비밀번호와 공유).
        return check_password_policy(v)


class SignupResponse(BaseModel):
    """성공 여부만 노출 — 회원ID 등 내부 식별자는 응답에 담지 않는다(지시)."""

    outcome: Literal["created"] = "created"


# =============================================================================
# 이메일 인증코드 (#9) — app.auth.email_verification_service / app.auth.signup_router
# =============================================================================
class EmailCodeRequest(BaseModel):
    """POST /api/auth/signup/email-code 요청 — 이메일 형식만 검증(SignupRequest와 동일 정규식)."""

    model_config = ConfigDict(extra="forbid")

    email: str = Field(..., min_length=3, max_length=254)

    @field_validator("email")
    @classmethod
    def _valid_email_format(cls, v: str) -> str:
        if not _EMAIL_RE.match(v):
            raise ValueError("올바른 이메일 형식이 아닙니다")
        return v.strip().lower()


class EmailCodeResponse(BaseModel):
    """발송 성공만 노출 — 회원 존재 여부를 드러내지 않는다(enumeration 방지)."""

    outcome: Literal["sent"] = "sent"


_CODE_RE = re.compile(r"^\d{6}$")


class EmailCodeVerifyRequest(BaseModel):
    """POST /api/auth/signup/email-code/verify 요청."""

    model_config = ConfigDict(extra="forbid")

    email: str = Field(..., min_length=3, max_length=254)
    code: str

    @field_validator("email")
    @classmethod
    def _valid_email_format(cls, v: str) -> str:
        if not _EMAIL_RE.match(v):
            raise ValueError("올바른 이메일 형식이 아닙니다")
        return v.strip().lower()

    @field_validator("code")
    @classmethod
    def _valid_code_format(cls, v: str) -> str:
        if not _CODE_RE.match(v):
            raise ValueError("인증코드는 숫자 6자리여야 합니다")
        return v


class EmailCodeVerifyResponse(BaseModel):
    """검증 성공 시 발급되는 단기 서명 토큰(TTL 30분) — SignupRequest.email_verification_token에 실어 보낸다."""

    outcome: Literal["verified"] = "verified"
    verification_token: str
