"""엑셀 export/import 엔드포인트.

export는 기업목록(2종: 필터 POST/역할 GET)·미팅목록·회의록현황 4종. 미팅목록·회의록현황은 여전히
master 전용(require_event_master) — sub 관할이 바이어 축이라 미팅·리뷰는 관할 개념이 애매하고
발주자 요청 범위 밖이다. 기업목록 2종은 master+sub 겸용(require_event_operator)으로 열되, sub는
자기가 관리하는 바이어만 내려받는다(ADR-0012, 발주자 지시 2026-09-17) — 참가사는 전혀 실리지 않고,
다른 sub의 바이어도 실리지 않는다. 관할 바이어가 0건이면 오류가 아니라 헤더만 있는 파일을 내려준다.

export 4종은 DB 조회 후 app.excel.service의 순수 함수로 포매팅한다. 핸들러는 ``async def``가 아니라
``def``다 — 동기 DB 조회와 openpyxl 워크북 생성(행이 많으면 수 초)을 async 핸들러 안에서 돌리면 그동안
이벤트 루프, 곧 서버 전체가 멈춘다. ``def``면 FastAPI가 스레드풀에서 돌린다.
import(명단 업로드)는 app.roster.router.import_members 핸들러를 어드민 경로에 그대로 붙인 것이다 —
핸들러·적재 코어를 여기서 다시 구현하지 않는다(로직 중복 금지). 권한은 그 핸들러를 따른다
(이 행사의 master·sub, sub는 관할 한정 — 발주자 지시 2026-09-16).
"""

from __future__ import annotations

import io
import uuid
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from sqlalchemy import func, select
from sqlalchemy.orm import Session, aliased

from app.admin.guard import EventOperatorPrincipal, require_event_operator
from app.admin.service import resolve_primary_contact
from app.auth.organizer_guard import EventMasterPrincipal, require_event_master
from app.db import get_session
from app.excel.members import MembersExportRequest, build_members_workbook
from app.excel.service import (
    build_meetings_workbook,
    build_organizations_workbook,
    build_reviews_workbook,
    format_meetings_rows,
    format_organization_rows,
    format_reviews_rows,
)
from app.models import (
    BuyerAttendee,
    BuyerInterestKeyword,
    BuyerProfile,
    Event,
    ExhibitorKeyword,
    ExhibitorProfile,
    Keyword,
    LoveCall,
    Meeting,
    MeetingVenue,
    Organization,
    OrganizationEventRole,
    PostMeetingReview,
)
from app.roster.parser import VALID_ROLES
from app.roster.router import import_members

router = APIRouter(prefix="/api/admin", tags=["admin-excel"])

_XLSX_MEDIA_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


def _validate_event(event_id: str | None, session: Session) -> str:
    """event_id 존재·UUID 형식·실재 확인 — 없음/비-UUID는 400, 미등록 행사는 404."""
    if not event_id:
        raise HTTPException(status_code=400, detail="event_id가 필요합니다.")
    try:
        uuid.UUID(event_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="유효하지 않은 이벤트 ID입니다.") from exc
    if session.scalars(select(Event).where(Event.id == event_id)).first() is None:
        raise HTTPException(status_code=404, detail="이벤트를 찾을 수 없습니다.")
    return event_id


def _xlsx_response(wb, filename: str) -> StreamingResponse:
    output = io.BytesIO()
    wb.save(output)
    output.seek(0)
    return StreamingResponse(
        iter([output.getvalue()]),
        media_type=_XLSX_MEDIA_TYPE,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.post("/export/organizations.xlsx")
def export_filtered_members(
    filters: MembersExportRequest,
    event_id: str | None = Query(None),
    session: Session = Depends(get_session),
    principal: EventOperatorPrincipal = Depends(require_event_operator),
) -> StreamingResponse:
    event_id = _validate_event(event_id, session)
    jurisdiction = None if principal.is_master else principal.organizer_id
    return _xlsx_response(
        build_members_workbook(session, event_id, filters, jurisdiction_organizer_id=jurisdiction),
        "organizations.xlsx",
    )


@router.get("/export/organizations.xlsx")
def export_organizations(
    event_id: str | None = Query(None),
    role: str | None = Query(None),  # exhibitor|buyer|both — 생략/둘 다면 전체(master만. sub는 항상 buyer로 좁힌다)
    session: Session = Depends(get_session),
    principal: EventOperatorPrincipal = Depends(require_event_operator),
) -> StreamingResponse:
    """기업 목록 export — approved/submitted 상태만."""
    event_id = _validate_event(event_id, session)

    if role is not None and role not in VALID_ROLES:
        raise HTTPException(status_code=400, detail=f"role은 {sorted(VALID_ROLES)} 중 하나여야 합니다.")

    jurisdiction = None if principal.is_master else principal.organizer_id
    if jurisdiction is not None:
        # sub — 요청 role과 무관하게 자기 관할 바이어만(참가사는 절대 안 실린다, ADR-0012).
        role_filter = [
            OrganizationEventRole.is_buyer.is_(True),
            OrganizationEventRole.managing_organizer_id == jurisdiction,
        ]
    else:
        role_filter = []
        if role == "exhibitor":
            role_filter = [OrganizationEventRole.is_exhibitor.is_(True)]
        elif role == "buyer":
            role_filter = [OrganizationEventRole.is_buyer.is_(True)]

    query = (
        select(
            Organization.name_ko,
            Organization.name_en,
            OrganizationEventRole.is_exhibitor,
            OrganizationEventRole.is_buyer,
            OrganizationEventRole.application_status,
            ExhibitorProfile.id,
            ExhibitorProfile.booth_location,
            ExhibitorProfile.representative_name_ko,
            ExhibitorProfile.company_email,
            BuyerProfile.id,
            ExhibitorProfile.main_tel,  # 전화(셀러) — 뒤에 추가(기존 인덱스 유지, buyer_profile_ids의 row[9] 안 깨지게)
            BuyerProfile.tel,  # 전화(바이어 기관)
            OrganizationEventRole.created_at,  # 등록일
            BuyerProfile.contact_email,  # 바이어 자신의 신청서 등록 이메일 — 담당자 폴백(admin.service와 공유, 뒤에 추가)
        )
        .join(OrganizationEventRole, Organization.id == OrganizationEventRole.organization_id)
        .outerjoin(ExhibitorProfile, OrganizationEventRole.id == ExhibitorProfile.org_event_role_id)
        .outerjoin(BuyerProfile, OrganizationEventRole.id == BuyerProfile.org_event_role_id)
        .where(
            OrganizationEventRole.event_id == event_id,
            OrganizationEventRole.application_status.in_(["approved", "submitted"]),
            *role_filter,
        )
    )

    result_rows = session.execute(query).all()

    # 바이어 첫 담당자(buyer_attendees, sort_order 최소) 일괄 조회 — 셀러 프로필 연락정보가 없는
    # 행(바이어 전용 기업 등)의 담당자/연락처 폴백이다. 행별 조회 대신 1회로 모은다.
    buyer_profile_ids = [row[9] for row in result_rows if row[9] is not None]
    first_attendees: dict[str, BuyerAttendee] = {}
    if buyer_profile_ids:
        for attendee in session.scalars(
            select(BuyerAttendee)
            .where(BuyerAttendee.buyer_profile_id.in_(buyer_profile_ids))
            .order_by(BuyerAttendee.sort_order)
        ):
            first_attendees.setdefault(attendee.buyer_profile_id, attendee)

    rows_data = []
    for (
        name_ko,
        name_en,
        is_exhibitor,
        is_buyer,
        application_status,
        exhibitor_profile_id,
        booth_location,
        representative_name_ko,
        company_email,
        buyer_profile_id,
        main_tel,
        buyer_tel,
        created_at,
        buyer_contact_email,
    ) in result_rows:
        # 키워드는 이 기업의 프로필(exhibitor/buyer)에 달린 것만 — 프로필 id로 좁혀 조회한다.
        keywords: list[str] = []
        if is_exhibitor and exhibitor_profile_id is not None:
            keywords = list(
                session.execute(
                    select(Keyword.label)
                    .join(ExhibitorKeyword, ExhibitorKeyword.keyword_id == Keyword.id)
                    .where(ExhibitorKeyword.exhibitor_profile_id == exhibitor_profile_id)
                ).scalars()
            )
        elif is_buyer and buyer_profile_id is not None:
            keywords = list(
                session.execute(
                    select(Keyword.label)
                    .join(BuyerInterestKeyword, BuyerInterestKeyword.keyword_id == Keyword.id)
                    .where(BuyerInterestKeyword.buyer_profile_id == buyer_profile_id)
                ).scalars()
            )

        # 담당자/연락처 폴백 — app.admin.service.resolve_primary_contact()로 명단 화면(OP-002)과
        # 규칙을 공유한다(같은 기업이 엑셀과 화면에서 다른 담당자로 보이면 안 된다).
        attendee = first_attendees.get(buyer_profile_id)
        contact_name, contact_email, contact_phone = resolve_primary_contact(
            representative_name_ko=representative_name_ko,
            company_email=company_email,
            main_tel=main_tel,
            buyer_tel=buyer_tel,
            buyer_contact_email=buyer_contact_email,
            attendee_first_name=attendee.first_name if attendee else None,
            attendee_last_name=attendee.last_name if attendee else None,
            attendee_email=attendee.email if attendee else None,
            attendee_tel=attendee.tel if attendee else None,
            attendee_mobile=attendee.mobile if attendee else None,
        )

        rows_data.append({
            "name_ko": name_ko,
            "name_en": name_en,
            "is_exhibitor": is_exhibitor,
            "is_buyer": is_buyer,
            "application_status": application_status,
            "booth_location": booth_location if is_exhibitor else None,  # 부스는 셀러만 노출
            "contact_name": contact_name,
            "contact_email": contact_email,
            "contact_phone": contact_phone,
            "keywords": ", ".join(keywords) if keywords else "",
            "registered_at": created_at,
        })

    wb = build_organizations_workbook(format_organization_rows(rows_data))
    return _xlsx_response(wb, "organizations.xlsx")


@router.get("/export/meetings.xlsx")
def export_meetings(
    event_id: str | None = Query(None),
    date: str | None = Query(None),
    session: Session = Depends(get_session),
    _: EventMasterPrincipal = Depends(require_event_master),
) -> StreamingResponse:
    """미팅 목록 export."""
    event_id = _validate_event(event_id, session)
    # 엑셀의 소요시간 폴백·"슬롯" 칸 길이에 쓸 **이 행사의** 슬롯 길이. 30분을 모듈 상수로 박아두면
    # 격자가 "40분 상담 + 5분 텀"(mt003gap0001)으로 바뀐 뒤 내보내기가 거짓이 된다. _validate_event가
    # 방금 존재를 확인했으므로 .one() 이 비어 실패할 일은 없다(같은 PK를 한 번 더 읽지만 export
    # 빈도상 무시 — _validate_event 의 반환형을 바꾸면 다른 3개 엔드포인트까지 손대야 한다).
    slot_minutes = session.scalars(
        select(Event.slot_minutes).where(Event.id == event_id)
    ).one()

    # exhibitor_org_id/buyer_org_id 모두 organizations FK라 같은 테이블을 두 번 조인해야 한다 —
    # aliased() 없이 Organization을 두 번 join하면 SQL이 모호해진다(자기 자신과 self-join).
    ExhibitorOrg = aliased(Organization)
    BuyerOrg = aliased(Organization)

    # counterpart_noshow/self_noshow는 리뷰 테이블(post_meeting_reviews)에 참가기업·바이어 각자
    # 최대 1건씩, 즉 미팅당 최대 2행 있을 수 있다 — 그대로 join하면 미팅 행이 중복(fan-out)된다.
    # 미팅당 하나로 접어서(어느 쪽이든, 어느 형태로든 노쇼 보고가 하나라도 있으면 Y) outerjoin한다.
    noshow_subq = (
        select(
            PostMeetingReview.meeting_id.label("meeting_id"),
            func.bool_or(
                PostMeetingReview.counterpart_noshow | PostMeetingReview.self_noshow
            ).label("counterpart_noshow"),
        )
        .group_by(PostMeetingReview.meeting_id)
        .subquery()
    )

    query = (
        select(
            Meeting.status,
            Meeting.matching_type,
            Meeting.scheduled_start,
            Meeting.scheduled_end,
            ExhibitorOrg.name_ko,
            BuyerOrg.name_ko,
            MeetingVenue.label,
            noshow_subq.c.counterpart_noshow,
        )
        .join(ExhibitorOrg, Meeting.exhibitor_org_id == ExhibitorOrg.id)
        .join(BuyerOrg, Meeting.buyer_org_id == BuyerOrg.id)
        .outerjoin(MeetingVenue, Meeting.venue_id == MeetingVenue.id)
        .outerjoin(noshow_subq, Meeting.id == noshow_subq.c.meeting_id)
        .where(
            Meeting.event_id == event_id,
            Meeting.status != "cancelled",
        )
    )

    if date:
        try:
            target_date = datetime.strptime(date, "%Y-%m-%d")
        except ValueError as exc:
            raise HTTPException(status_code=400, detail="date는 YYYY-MM-DD 형식이어야 합니다.") from exc
        start_of_day = target_date
        end_of_day = target_date + timedelta(days=1)
        query = query.where(
            Meeting.scheduled_start >= start_of_day,
            Meeting.scheduled_start < end_of_day,
        )

    rows_data = [
        {
            "status": status,
            "matching_type": matching_type,
            "scheduled_start": scheduled_start,
            "scheduled_end": scheduled_end,
            "exhibitor_name": exhibitor_name,
            "buyer_name": buyer_name,
            "venue_label": venue_label,
            "counterpart_noshow": counterpart_noshow,
        }
        for (
            status,
            matching_type,
            scheduled_start,
            scheduled_end,
            exhibitor_name,
            buyer_name,
            venue_label,
            counterpart_noshow,
        ) in session.execute(query).all()
    ]

    wb = build_meetings_workbook(format_meetings_rows(rows_data, slot_minutes=slot_minutes))
    return _xlsx_response(wb, "meetings.xlsx")


@router.get("/export/reviews.xlsx")
def export_reviews(
    event_id: str | None = Query(None),
    session: Session = Depends(get_session),
    _: EventMasterPrincipal = Depends(require_event_master),
) -> StreamingResponse:
    """회의록 현황 export — completed 미팅만."""
    event_id = _validate_event(event_id, session)

    ExhibitorOrg = aliased(Organization)
    BuyerOrg = aliased(Organization)

    query = (
        select(
            Meeting.id,
            Meeting.scheduled_start,
            Meeting.exhibitor_org_id,
            Meeting.buyer_org_id,
            ExhibitorOrg.name_ko,
            BuyerOrg.name_ko,
        )
        .join(ExhibitorOrg, Meeting.exhibitor_org_id == ExhibitorOrg.id)
        .join(BuyerOrg, Meeting.buyer_org_id == BuyerOrg.id)
        .where(
            Meeting.event_id == event_id,
            Meeting.status == "completed",
        )
    )

    rows_data = []
    for (
        meeting_id,
        scheduled_start,
        exhibitor_org_id,
        buyer_org_id,
        exhibitor_name,
        buyer_name,
    ) in session.execute(query).all():
        reviewer_org_ids = set(
            session.execute(
                select(PostMeetingReview.reviewer_org_id).where(PostMeetingReview.meeting_id == meeting_id)
            ).scalars()
        )
        has_love_call = (
            session.scalar(select(LoveCall.id).where(LoveCall.meeting_id == meeting_id)) is not None
        )

        rows_data.append({
            "scheduled_start": scheduled_start,
            "exhibitor_name": exhibitor_name,
            "buyer_name": buyer_name,
            "exhibitor_reviewed": exhibitor_org_id in reviewer_org_ids,
            "buyer_reviewed": buyer_org_id in reviewer_org_ids,
            "has_love_call": has_love_call,
        })

    wb = build_reviews_workbook(format_reviews_rows(rows_data))
    return _xlsx_response(wb, "reviews.xlsx")


# 명단 업로드 — 핸들러를 여기서 다시 구현하지 않고 app.roster.router.import_members **그 함수**를 어드민
# 경로(event_id는 쿼리)에 한 번 더 붙인다. 두 경로·두 콘솔이 같은 검증·권한(master+sub, sub는 관할)·
# 공통 비밀번호·행별 결과를 공유해 다시 갈라지지 않는다(예전 별칭은 핸들러를 복제해 두었다).
router.add_api_route("/import/roster", import_members, methods=["POST"])
