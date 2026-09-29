"""BM 프로필 HTTP 엔드포인트 — 단계별 저장/조회 + 원자적 제출(F-BM-001/002, ADR-0009).

경로는 역할별로 가른다(바이어=``/api/bm/buyer`` · 참가사=``/api/bm/exhibitor``). 모든 라우트는
Cognito JWT로 주체를 도출하고(``get_current_principal``), **본인 소속 Organization의 프로필만**
접근한다 — 타 org는 403, 무효/누락 토큰은 401. 부분 저장/제출의 트랜잭션 경계는 service가 소유.

PATCH는 단계 모델로 바디를 검증해 **그 단계가 준 필드만** 넘긴다(부분 저장). 제출은 최종 편집
(선택)과 ``submitted`` 전환을 한 트랜잭션으로 묶는다(반쪽 제출 불가).
"""

from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, Body, Depends, HTTPException, status
from pydantic import ValidationError
from sqlalchemy.orm import Session

from app.auth.principal import Principal, get_current_principal
from app.bm import service
from app.bm.schemas import (
    BUYER_STEP_MODELS,
    EXHIBITOR_STEP_MODELS,
    BuyerProfilePatch,
    BuyerProfileResponse,
    ExhibitorProfilePatch,
    ExhibitorProfileResponse,
)
from app.db import get_session
from app.models import OrganizationEventRole

router = APIRouter(prefix="/api/bm", tags=["bm-profile"])


def _load_owned_role(
    db: Session, principal: Principal, org_event_role_id: str
) -> OrganizationEventRole:
    """역할(참가 단위)을 로드하고 소유권을 강제한다 — 존재 안 하면 404, 타 org면 403.

    소유권은 단일 지점에서: 주체의 소속 org가 자원의 소유 org와 다르면 403(본인/소속만 접근).
    """
    try:
        UUID(org_event_role_id)
    except ValueError:
        # 형식이 틀린 id는 존재 여부를 가리지 않고 404(주체에게 자원 부재로 보인다).
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="프로필을 찾을 수 없습니다")

    role = service.get_role(db, org_event_role_id)
    if role is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="프로필을 찾을 수 없습니다")
    if str(role.organization_id) != principal.organization_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="본인 소속 기업의 프로필만 접근할 수 있습니다"
        )
    return role


def _validate_step(models: dict[int, type], step: int, body: dict) -> dict:
    """단계 모델로 바디를 검증하고 **실제로 담긴 필드만**(부분 저장 단위) 돌려준다."""
    model = models.get(step)
    if model is None:
        # 1~4만 PATCH 대상 — 5단계(제출)는 submit 엔드포인트.
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="단계는 1~4만 저장할 수 있습니다(제출은 submit).",
        )
    try:
        validated = model.model_validate(body)
    except ValidationError as exc:
        # include_context=False: model_validator의 ValueError 객체가 ctx에 실려 JSON 직렬화 500이 나는 걸 막는다.
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=exc.errors(include_url=False, include_context=False),
        ) from exc
    return validated.model_dump(exclude_unset=True)


def _role_mismatch(exc: service.RoleMismatchError) -> HTTPException:
    return HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc))


def _submit_with_mapping(fn, db, role, data):
    """제출 호출 + 도메인 예외를 HTTP로 매핑(역할 불일치/반려 409, 제출 완결성 422)."""
    try:
        return fn(db, role, data)
    except service.RoleMismatchError as exc:
        raise _role_mismatch(exc)
    except service.SubmitBlockedError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc))
    except service.SubmitValidationError as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc))


# =============================================================================
# 바이어(F-BM-001)
# =============================================================================
@router.get("/buyer/{org_event_role_id}", response_model=BuyerProfileResponse)
def get_buyer(
    org_event_role_id: str,
    principal: Principal = Depends(get_current_principal),
    db: Session = Depends(get_session),
) -> BuyerProfileResponse:
    role = _load_owned_role(db, principal, org_event_role_id)
    try:
        service._require_buyer(role)
    except service.RoleMismatchError as exc:
        raise _role_mismatch(exc)
    return service.get_buyer_profile(db, role)


@router.patch("/buyer/{org_event_role_id}/steps/{step}", response_model=BuyerProfileResponse)
def patch_buyer(
    org_event_role_id: str,
    step: int,
    body: dict = Body(default_factory=dict),
    principal: Principal = Depends(get_current_principal),
    db: Session = Depends(get_session),
) -> BuyerProfileResponse:
    role = _load_owned_role(db, principal, org_event_role_id)
    data = _validate_step(BUYER_STEP_MODELS, step, body)
    try:
        return service.patch_buyer_step(db, role, data)
    except service.RoleMismatchError as exc:
        raise _role_mismatch(exc)


@router.post("/buyer/{org_event_role_id}/submit", response_model=BuyerProfileResponse)
def submit_buyer(
    org_event_role_id: str,
    body: BuyerProfilePatch | None = Body(default=None),
    principal: Principal = Depends(get_current_principal),
    db: Session = Depends(get_session),
) -> BuyerProfileResponse:
    role = _load_owned_role(db, principal, org_event_role_id)
    data = body.model_dump(exclude_unset=True) if body is not None else None
    return _submit_with_mapping(service.submit_buyer, db, role, data)


# =============================================================================
# 참가사(F-BM-002)
# =============================================================================
@router.get("/exhibitor/{org_event_role_id}", response_model=ExhibitorProfileResponse)
def get_exhibitor(
    org_event_role_id: str,
    principal: Principal = Depends(get_current_principal),
    db: Session = Depends(get_session),
) -> ExhibitorProfileResponse:
    role = _load_owned_role(db, principal, org_event_role_id)
    try:
        service._require_exhibitor(role)
    except service.RoleMismatchError as exc:
        raise _role_mismatch(exc)
    return service.get_exhibitor_profile(db, role)


@router.patch(
    "/exhibitor/{org_event_role_id}/steps/{step}", response_model=ExhibitorProfileResponse
)
def patch_exhibitor(
    org_event_role_id: str,
    step: int,
    body: dict = Body(default_factory=dict),
    principal: Principal = Depends(get_current_principal),
    db: Session = Depends(get_session),
) -> ExhibitorProfileResponse:
    role = _load_owned_role(db, principal, org_event_role_id)
    data = _validate_step(EXHIBITOR_STEP_MODELS, step, body)
    try:
        return service.patch_exhibitor_step(db, role, data)
    except service.RoleMismatchError as exc:
        raise _role_mismatch(exc)


@router.post("/exhibitor/{org_event_role_id}/submit", response_model=ExhibitorProfileResponse)
def submit_exhibitor(
    org_event_role_id: str,
    body: ExhibitorProfilePatch | None = Body(default=None),
    principal: Principal = Depends(get_current_principal),
    db: Session = Depends(get_session),
) -> ExhibitorProfileResponse:
    role = _load_owned_role(db, principal, org_event_role_id)
    data = body.model_dump(exclude_unset=True) if body is not None else None
    return _submit_with_mapping(service.submit_exhibitor, db, role, data)
