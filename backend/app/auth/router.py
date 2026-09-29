"""인증 라우터 — 딥링크 토큰 검증 엔드포인트(F-AU-001, #20).

Next.js는 DB·Cognito·DX Korea에 직접 붙지 않고 이 FastAPI 엔드포인트만 호출한다(ADR-0008
경계 B). 검증 통과 시 진입 컨텍스트를 돌려주고, 거부 시 사유 코드를 401로 돌려준다.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from app.auth.deeplink_token import DeepLinkTokenService, VerificationResult

router = APIRouter(prefix="/api/auth", tags=["auth"])

# 프로세스 단일 서비스 인스턴스. 기본 in-memory 저장소 — DB 백엔드로 교체 시 이 의존성만 바꾼다.
_service = DeepLinkTokenService()


def get_deeplink_service() -> DeepLinkTokenService:
    """FastAPI 의존성 — 딥링크 토큰 서비스. 테스트는 override로 자기 인스턴스를 주입한다."""
    return _service


class DeepLinkVerifyRequest(BaseModel):
    token: str = Field(..., min_length=1, description="딥링크로 들어온 토큰 원문")


class DeepLinkVerifyResponse(BaseModel):
    context: dict[str, Any] = Field(..., description="검증 성공 시 진입 컨텍스트")


@router.post(
    "/deeplink/verify",
    response_model=DeepLinkVerifyResponse,
    summary="딥링크 토큰 검증",
)
def verify_deeplink(
    body: DeepLinkVerifyRequest,
    service: DeepLinkTokenService = Depends(get_deeplink_service),
) -> DeepLinkVerifyResponse:
    """딥링크 토큰을 검증한다. 유효하면 진입 컨텍스트, 무효하면 사유 코드(401)."""
    result: VerificationResult = service.verify(body.token)
    if not result.allowed:
        # 거부 사유는 reason 코드로 노출 — UI가 다음 안내를 정한다(F-AU-001 US11).
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"reason": result.rejection.value},
        )
    return DeepLinkVerifyResponse(context=result.context or {})
