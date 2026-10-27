"""OP-002 필터 명단: 화면과 같은 목록 조회·미팅 집계, 페이지 제한 없는 xlsx.

ordered_ids는 브라우저의 한국어 정렬 순서만 전달한다. 조회 대상·권한을 결정하지 않는다.
기존 GET 리포트(approved/submitted)의 계약과 구분한 POST 경로에서 사용한다.
"""

from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.admin.service import list_organizations
from app.bm.schemas import BusinessFieldCode, ContentCategoryCode
from app.excel.service import build_organizations_workbook, format_organization_rows
from app.models import Keyword

CATEGORY_LABELS = {
    "animation_character": "애니메이션/캐릭터",
    "broadcasting": "방송",
    "comics_game_music": "만화,웹툰/게임/음악",
}


class MembersExportRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    tab: Literal["exhibitor", "buyer"]
    query: str = Field(default="", max_length=500)
    statuses: list[
        Literal["registered", "submitted", "approved", "changes_requested", "rejected"]
    ] = Field(default_factory=list)
    content_categories: list[ContentCategoryCode] = Field(default_factory=list)
    business_fields: list[BusinessFieldCode] = Field(default_factory=list)
    has_matches_only: bool = False
    sort: Literal["name", "matches", "status"] = "status"
    ordered_ids: list[UUID] = Field(default_factory=list, max_length=20000)


def build_members_workbook(
    db: Session,
    event_id: str,
    filters: MembersExportRequest,
    *,
    jurisdiction_organizer_id: str | None = None,
):
    """``jurisdiction_organizer_id``(sub)는 관할 밖 자료를 애초에 행에 올리지 않는다(ADR-0012,
    발주자 지시 2026-09-17). 참가사(exhibitor) 탭은 sub에게 아예 열지 않는다 — 국내기업 열람은
    /admin 명단 화면 몫이고, 이 export는 "sub가 관리하는 바이어"로 한정한다. 관할 바이어가 0건이면
    빈 결과가 아니라 예외 없이 헤더만 있는 파일을 돌려준다(기존 빈 결과 분기가 그대로 처리한다).
    """
    if jurisdiction_organizer_id is not None and filters.tab != "buyer":
        template = format_organization_rows([{}], all_statuses=True)[0]
        headers = list(template)
        headers.insert(headers.index("키워드 / Keywords"), "카테고리 / Category")
        headers[headers.index("키워드 / Keywords")] = "사업분야/관심분야 / Business Fields"
        wb = build_organizations_workbook([{h: "" for h in headers}])
        wb.active.delete_rows(2)
        return wb
    # 목록 API와 동일한 데이터 소스: 연락처 폴백·분류코드·미팅 수를 중복 구현하지 않는다.
    # jurisdiction_organizer_id를 그대로 넘기면 DB 단에서 이미 "참가사 전부 + 관할 바이어만"으로
    # 좁혀진다(list_organizations의 _organization_query) — 아래 tab 분류 루프가 참가사 겸업 행은
    # exhibitor 버킷으로 보내므로(=filters.tab이 "buyer"인 여기선 제외), 결과적으로 관할 바이어만 남는다.
    rows, _ = list_organizations(db, event_id, limit=None, jurisdiction_organizer_id=jurisdiction_organizer_id)
    labels = dict(
        db.execute(
            select(Keyword.code, Keyword.label).where(Keyword.category == "business_field")
        ).all()
    )
    query = filters.query.strip().lower()
    status_rank = {
        "approved": 0,
        "submitted": 1,
        "changes_requested": 2,
        "registered": 3,
        "rejected": 4,
    }
    selected = []
    for r in rows:
        # OP-002 행은 참가사 우선 단일 탭(겸업 기업 포함)으로 분류된다.
        tab = "exhibitor" if r.role.is_exhibitor else "buyer"
        if tab != filters.tab:
            continue
        if query and not any(
            query in (name or "").lower() for name in (r.org.name_ko, r.org.name_en)
        ):
            continue
        if filters.statuses and r.role.application_status not in filters.statuses:
            continue
        category = r.exhibitor.content_category if r.exhibitor else None
        if (
            tab == "exhibitor"
            and filters.content_categories
            and category not in filters.content_categories
        ):
            continue
        fields = r.exhibition_categories if tab == "exhibitor" else r.interest_categories
        if filters.business_fields and not set(fields).intersection(filters.business_fields):
            continue
        if filters.has_matches_only and r.match_count == 0:
            continue
        selected.append(r)
    # 화면에서 전달된 순서는 로케일 정렬 보존용이다. 미전달/새 행은 결정적으로 뒤에 정렬한다.
    order = {str(org_id): i for i, org_id in enumerate(filters.ordered_ids)}

    def sort_key(r):
        primary = (
            -r.match_count
            if filters.sort == "matches"
            else status_rank.get(r.role.application_status, 9)
            if filters.sort == "status"
            else 0
        )
        return (
            order.get(str(r.org.id), len(order)),
            primary,
            r.org.name_ko or r.org.name_en or "",
            str(r.org.id),
        )

    selected.sort(key=sort_key)
    data = []
    for r in selected:
        ex, by = r.exhibitor, r.buyer
        is_ex = filters.tab == "exhibitor"
        data.append(
            {
                "name_ko": r.org.name_ko,
                "name_en": r.org.name_en,
                "is_exhibitor": r.role.is_exhibitor,
                "is_buyer": r.role.is_buyer,
                "application_status": r.role.application_status,
                "contact_name": r.contact_name
                if is_ex
                else (by.contact_name_ko if by else None) or r.contact_name,
                "contact_email": r.contact_email,
                "contact_phone": r.contact_phone,
                "booth_location": " · ".join(
                    v for v in (ex.booth_hall, ex.booth_pavilion, ex.booth_location) if v
                )
                if is_ex and ex
                else None,
                "keywords": ", ".join(
                    labels.get(code, code)
                    for code in (r.exhibition_categories if is_ex else r.interest_categories)
                ),
                "registered_at": r.role.created_at,
            }
        )
    formatted = format_organization_rows(data, all_statuses=True)
    # 빈 결과도 같은 헤더. 기존 포맷터/스타일러를 사용하고 OP-002 컬럼만 확장한다.
    template = format_organization_rows([{}], all_statuses=True)[0]
    headers = list(template)
    headers.insert(headers.index("키워드 / Keywords"), "카테고리 / Category")
    headers[headers.index("키워드 / Keywords")] = "사업분야/관심분야 / Business Fields"
    result = []
    for r, row in zip(selected, formatted):
        row["카테고리 / Category"] = (
            CATEGORY_LABELS.get(r.exhibitor.content_category if r.exhibitor else None, "미입력")
            if filters.tab == "exhibitor"
            else ""
        )
        row["사업분야/관심분야 / Business Fields"] = row.pop("키워드 / Keywords")
        result.append({h: row.get(h, "") for h in headers})
    if result:
        return build_organizations_workbook(result)
    wb = build_organizations_workbook([{h: "" for h in headers}])
    wb.active.delete_rows(2)
    return wb
