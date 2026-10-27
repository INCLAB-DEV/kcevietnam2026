"""셀프 비밀번호 변경 HTTP 경계 — ``POST /api/me/change-password``(발주자 요구사항 2026-09-30).

Next.js는 DB·Cognito에 직접 붙지 않고 이 엔드포인트만 호출한다(ADR-0008 경계 B). 도메인 규칙은
``app.auth.password_change``가 소유하고, 이 모듈은 **인증 의존성 + 도메인 예외 → HTTP 환산**만 얹는다.

prefix가 ``/api/me``인 라우터는 이미 ``app.discover.router.me_router``가 하나 있지만, 슬라이스가
달라 라우터를 나눴다(이유는 ``password_change`` 독스트링). FastAPI는 같은 prefix의 라우터 여러
개를 문제없이 합치므로 프론트가 보는 경로는 그대로 하나다.

에러 바디 규약(미팅·discover·admin과 동일)::

    {"detail": {"code": "NO_LOCAL_PASSWORD", "message": "..."}}

코드 목록: NO_LOCAL_PASSWORD(409) · INVALID_CREDENTIALS(403) · PASSWORD_POLICY(422) ·
SAME_PASSWORD(422). 미인증은 ``get_current_principal``이 기존 형태(401)로 닫는다.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.auth import password_change
from app.auth.credentials import PASSWORD_POLICY_ERROR
from app.auth.principal import Principal, get_current_principal
from app.db import get_session

router = APIRouter(prefix="/api/me", tags=["me"])


class ChangePasswordRequest(BaseModel):
    # 빈 값만 막는다 — 길이·문자 구성 판정은 check_password_policy(단일 정본)가 하므로 여기서
    # 규칙을 중복해 두지 않는다(두 군데 있으면 한쪽만 고쳐져 정책이 갈라진다).
    current_password: str = Field(..., min_length=1, description="지금 쓰고 있는 비밀번호")
    new_password: str = Field(..., min_length=1, description="새 비밀번호(정책 판정은 서버가 한다)")


class ChangePasswordResponse(BaseModel):
    # 해시도 평문도 싣지 않는다 — 성공했다는 사실 하나만 돌려준다.
    ok: bool


def _detail(status_code: int, code: str, message: str) -> HTTPException:
    return HTTPException(status_code=status_code, detail={"code": code, "message": message})


@router.post("/change-password", response_model=ChangePasswordResponse)
def change_password(
    body: ChangePasswordRequest,
    principal: Principal = Depends(get_current_principal),
    db: Session = Depends(get_session),
) -> ChangePasswordResponse:
    """로그인한 회원이 자기 비밀번호를 바꾼다. 대상은 항상 **토큰의 주체 자신**이다.

    회원을 바디로 받지 않는 게 핵심이다 — 대상을 ``principal.member_id``로 못박아 두면 "남의 회원
    ID를 실어 보내 비밀번호를 바꾸는" 경로가 구조적으로 존재하지 않는다(소유권 403 판정이 애초에
    필요 없다). 운영자가 남의 비밀번호를 재설정하는 경로는 별도다
    (``PATCH /api/admin/events/{id}/organizations/{id}/contact-password``, 관할 검사 포함).

    ⚠ 모든 HTTPException을 ``from None``으로 올린다 — 도메인 예외 메시지에는 평문이 없지만, 원인
    체인을 남기면 평문을 들고 있는 프레임이 traceback에 함께 실릴 수 있다.
    """
    try:
        password_change.change_member_password(
            db,
            member_id=principal.member_id,
            current_password=body.current_password,
            new_password=body.new_password,
        )
    except password_change.NoLocalPasswordError as exc:
        # 입력값 오류가 아니라 계정 상태(로컬 비밀번호 미설정 = DX Korea 검증 대상 계정)와의
        # 충돌이라 422가 아니라 409다 — 화면은 "여기서 바꿀 수 없는 계정"으로 안내해야 한다.
        raise _detail(status.HTTP_409_CONFLICT, "NO_LOCAL_PASSWORD", str(exc)) from None
    except password_change.InvalidCurrentPasswordError as exc:
        # 회원 존재 여부·어느 필드가 틀렸는지를 추가로 흘리지 않는다(local_verify와 동일 관례).
        raise _detail(status.HTTP_403_FORBIDDEN, "INVALID_CREDENTIALS", str(exc)) from None
    except password_change.PasswordPolicyViolationError as exc:
        raise _detail(422, PASSWORD_POLICY_ERROR, str(exc)) from None
    except password_change.SamePasswordError as exc:
        raise _detail(422, "SAME_PASSWORD", str(exc)) from None
    return ChangePasswordResponse(ok=True)
