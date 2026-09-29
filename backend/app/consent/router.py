"""약관 동의 HTTP 엔드포인트 (F-AU-001).

- GET  /api/consents/active  — 유효 약관 목록(필수/선택 플래그). member_id 주면 동의 여부·게이트도.
- POST /api/consents/agree   — 항목별 동의 수집(마스터 갱신 + 이력 append, version·시각·ip 스냅샷).

세션/계정 발급(session-issue)은 별도 슬라이스 — 여기선 member_id를 받아 동의만 책임진다.
"""

from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session

from app.consent import rules, service
from app.consent.schemas import (
    ActiveConsentsResponse,
    AgreeRequest,
    AgreeResponse,
    ConsentDocumentOut,
)
from app.db import get_session

router = APIRouter(prefix="/api/consents", tags=["consents"])


def _client_ip(request: Request) -> str | None:
    """동의 증빙용 IP.

    ALB는 관측한 소스 IP를 X-Forwarded-For **끝에** append한다 → 클라이언트가 헤더를 위조해도
    신뢰 프록시(ALB)가 붙인 **마지막 값**이 실제 접속 IP다. 첫 값은 클라이언트가 통제할 수 있어
    감사 증빙으로 못 쓴다. (프록시 홉이 ALB 1개라는 전제 — 다단 프록시면 신뢰 홉 수 설정 필요.)
    """
    xff = request.headers.get("x-forwarded-for")
    if xff:
        parts = [p.strip() for p in xff.split(",") if p.strip()]
        if parts:
            return parts[-1]
    return request.client.host if request.client else None


def _validate_uuid(member_id: str) -> None:
    """malformed UUID를 DB 쿼리(500) 전에 422로 거른다."""
    try:
        UUID(member_id)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail="member_id가 유효한 UUID가 아닙니다.") from exc


@router.get("/active", response_model=ActiveConsentsResponse)
def get_active_consents(
    member_id: str | None = None,
    db: Session = Depends(get_session),
) -> ActiveConsentsResponse:
    active = service.load_active_documents(db)
    agreed_types: set[str] = set()
    gate_satisfied: bool | None = None
    if member_id is not None:
        _validate_uuid(member_id)
        status = service.gate_status(db, member_id)
        agreed_types = status.agreed_types
        gate_satisfied = status.satisfied

    documents = [
        ConsentDocumentOut(
            id=d.id,
            type=d.type,
            title=d.title,
            version=d.version,
            is_required=d.is_required,
            content_url=d.content_url,
            effective_date=str(d.effective_date) if d.effective_date else None,
            already_agreed=(d.type in agreed_types) if member_id is not None else None,
        )
        # 필수 먼저, 그 다음 type 정의 순서로 안정 정렬(화면 노출 순서 결정적).
        for d in sorted(active, key=lambda x: (not x.is_required, rules.CONSENT_TYPES.index(x.type)))
    ]
    return ActiveConsentsResponse(documents=documents, gate_satisfied=gate_satisfied)


@router.post("/agree", response_model=AgreeResponse)
def agree_consents(
    body: AgreeRequest,
    request: Request,
    db: Session = Depends(get_session),
) -> AgreeResponse:
    # member_id UUID 형식은 스키마가 검증(422). 미존재 member는 FK 500 전에 404로 거른다.
    if not service.member_exists(db, body.member_id):
        raise HTTPException(status_code=404, detail="member_id에 해당하는 회원이 없습니다.")

    agreed_types = set(body.agreed_types)
    try:
        gate = service.record_agreements(db, body.member_id, agreed_types, _client_ip(request))
    except rules.UnknownConsentTypeError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    if not gate.satisfied:
        # 필수 약관 미동의 — 진행 차단(아무것도 기록하지 않음).
        raise HTTPException(
            status_code=422,
            detail={
                "message": "필수 약관에 모두 동의해야 진행할 수 있습니다.",
                "missing_required": list(gate.missing_required),
            },
        )

    return AgreeResponse(
        gate_satisfied=True,
        recorded_types=sorted(agreed_types),
        missing_required=[],
    )
