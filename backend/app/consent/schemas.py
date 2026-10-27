"""약관 API 입출력 스키마(Pydantic). HTTP 경계 계약 — DB 모델과 분리."""

from __future__ import annotations

from uuid import UUID

from pydantic import BaseModel, Field, field_validator


class ConsentDocumentOut(BaseModel):
    """활성 약관 1건. member 컨텍스트가 있으면 already_agreed로 현재 동의 여부를 알린다."""

    id: str
    type: str
    title: str
    version: str
    is_required: bool
    content_url: str | None = None
    effective_date: str | None = None
    already_agreed: bool | None = None  # member_id 조회 시에만 채움(재방문자 게이트용)


class ActiveConsentsResponse(BaseModel):
    documents: list[ConsentDocumentOut]
    # member_id가 주어졌을 때만 게이트 충족 여부를 함께 준다(재방문자=true면 약관 재요구 불필요).
    gate_satisfied: bool | None = None


class AgreeRequest(BaseModel):
    member_id: str = Field(..., description="동의 주체 member.id (UUID)")
    agreed_types: list[str] = Field(
        default_factory=list, description="동의한 약관 type 목록(필수는 전부 포함되어야 통과)"
    )

    @field_validator("member_id")
    @classmethod
    def _member_id_is_uuid(cls, v: str) -> str:
        # malformed UUID는 DB 쿼리(invalid-text-representation 500) 전에 422로 거른다.
        UUID(v)
        return v


class AgreeResponse(BaseModel):
    gate_satisfied: bool
    recorded_types: list[str]
    missing_required: list[str] = Field(default_factory=list)
