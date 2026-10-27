"""슈퍼어드민 콘솔 HTTP 엔드포인트(#OP) — 행사 CRUD, 참가기업 관리, 미팅 운영, 통역사 배정, 역할 관리.

가드:
- **쓰기(POST/PATCH/DELETE, 행사 생성 제외)**: ``require_event_master``(organizer_guard 그대로
  재사용) — 이 행사의 master 전용(ADR-0012).
- **예외: 기업 신청서 편집/대리작성(PATCH profile · POST proxy-profile)**: ADR-0012 개정
  (2026-09-09)으로 ``require_event_operator``(master+sub)로 개방. sub는 자기 관할 기업만 쓸 수
  있게 **서비스 계층에서 읽기 관할 필터(``check_jurisdiction``)를 그대로 미러**한다(관할 밖이면
  403). 담당자(attendee) 추가·편집도 이 경로의 프로필 바디(``attendees``)로 처리된다. 거버넌스
  (역할 전환·운영자 부여/회수·행사 생성·검토 승인 등)는 개정과 무관하게 master 전용 유지.
  ⚠ **부스 지정**(``booth_hall``/``booth_pavilion``/``booth_location``/``booth_type``/``booth_count``)
  은 이 경로 안에서도 **master 전용**이다(발주자 지시 2026-09-28, ``service.check_booth_write``) —
  sub가 부스를 실어 보내면 403. 참가자 경로에선 스키마가 422로 막는다(``app.bm.schemas`` 참고).
- **예외: 참가기업 단건 등록(POST organizations) · 담당자 비밀번호 설정(PATCH contact-password)**:
  명단 업로드를 master+sub로 연 것(2026-09-16)과 같은 규칙을 단건 경로에도 맞춘 것(발주자 지시).
  ``require_event_operator``로 받고 **쓰기 관할**(``service.check_write_jurisdiction`` /
  ``check_create_jurisdiction``)을 서비스 계층에서 건다 — sub는 자기 관할 **바이어만**, 참가사는
  master 전용(읽기 관할보다 좁다: 읽기는 sub도 참가사를 본다). 비밀번호는 자체가입·명단과 같은
  정책·해시(``app.auth.credentials``)를 쓰고 **평문은 로그·응답 어디에도 남기지 않는다**.
- **읽기(GET)**: ``require_event_operator``(이 패키지) — master **또는** sub 통과, sub는 응답을
  자기 관할(관리 바이어)로 필터한다.
- **예외: 참가기업 삭제 영향 미리보기(GET deletion-impact)**: 읽기지만 ``require_event_master`` —
  master 전용인 삭제의 확인 단계라, 지울 수 없는 sub에게는 열지 않는다(기업의 미팅 건수도 흘리지 않는다).
- **행사 생성**(``POST /events``): ``require_existing_master_identity``(이 패키지) — "어디선가
  이미 master인 운영자"만 통과(발주자 권한 원칙 "슈퍼어드민은 DB에서만 부여"와 정합, 크로스리뷰
  지적으로 강화 — 예전엔 아무 운영자나 행사를 만들어 스스로 master가 될 수 있었다). 최초 부트스트랩
  master는 API가 아니라 DB 직접 INSERT(backend/README.md). 생성자는 자동으로 그 행사의 master로도
  배정된다(이미 master인 사람이 또 다른 행사를 만드는 자기증식은 허용).
- **행사 목록**(``GET /events``): 아직 event_id가 없어 위 가드들을 못 쓴다 — ``require_operator_identity``
  (행사 무관 신원)로 연다. master 여부와 무관하게 자기가 organizer로 배정된 행사는 모두 본다.
- **역할 관리(참가기업 역할 전환/운영자 부여·회수·목록)**: 전부 ``require_event_master`` 전용 —
  서브어드민 부여는 슈퍼어드민만 할 수 있고, 슈퍼어드민 자체는 이 API들로 만들거나 지울 수 없다.

프로필 본문(PATCH profile / POST proxy-profile)은 ``app.bm.schemas``의 ``BuyerProfilePatch``/
``ExhibitorProfilePatch``를 그대로 재사용해 검증한다(지시: "bm 서비스 재사용" — 폼 규칙 이중 관리 금지).
"""

from __future__ import annotations

from dataclasses import asdict
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Body, Depends, HTTPException, Query, status
from pydantic import ValidationError
from sqlalchemy.orm import Session

from app.admin import schemas, service
from app.admin.guard import (
    EventOperatorPrincipal,
    OperatorPrincipal,
    require_assigned_operator,
    require_event_operator,
    require_existing_master_identity,
    require_operator_identity,
    resolve_organizer_id,
)
from app.auth.credentials import PASSWORD_POLICY_ERROR, check_password_policy, hash_password
from app.auth.organizer_guard import EventMasterPrincipal, require_event_master
from app.bm import schemas as bm_schemas
from app.bm import service as bm_service
from app.db import get_session, sessionmaker_like
from app.matching import assignment_service
from app.matching.slot_grid import resolve_zone
from app.meetings.service import _requested_by_org_id
from app.models import (
    Event,
    EventOrganizer,
    EventScheduleSettings,
    Interpreter,
    Meeting,
    MeetingVenue,
    Member,
    Notification,
    NotificationDispatch,
    Organization,
    OrganizationEventRole,
    Organizer,
    PostMeetingReview,
    SaturationBatchRun,
)
from app.notifications import bulk_dispatch
from app.notifications import service as notification_service
from app.notifications.channels import NotificationChannel

router = APIRouter(prefix="/api/admin", tags=["admin"])


# =============================================================================
# 공통 헬퍼
# =============================================================================
def _validate_patch(model_cls: type, body: dict) -> dict:
    """전체 프로필 patch 모델로 바디를 검증하고 실제로 담긴 필드만 돌려준다(bm router와 동일 관례)."""
    try:
        validated = model_cls.model_validate(body)
    except ValidationError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=exc.errors(include_url=False, include_context=False),
        ) from exc
    return validated.model_dump(exclude_unset=True)


def _role_mismatch(exc: bm_service.RoleMismatchError) -> HTTPException:
    return HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc))


def _profile_model(role: str) -> type:
    """운영자 경로의 프로필 바디 모델. 참가사는 **AdminExhibitorProfilePatch**(부스 포함)다 —
    참가자 경로의 ``ExhibitorProfilePatch``엔 부스가 없어(운영자 소관) 그걸 쓰면 부스가 422로 막힌다."""
    return bm_schemas.BuyerProfilePatch if role == "buyer" else bm_schemas.AdminExhibitorProfilePatch


def _hash_or_422(password: str | None) -> str | None:
    """평문 비밀번호 → bcrypt 해시. 정책 위반이면 **쓰기 전에** 422. ``None``이면 그대로 None.

    비밀번호를 받는 모든 어드민 경로(단건 등록·비밀번호 재설정)의 단일 관문이다 — 정책·해시는
    ``app.auth.credentials``(자체가입·명단 업로드와 같은 정본)를 쓰고, 여기서 규칙을 새로 만들지
    않는다. ⚠ 에러 메시지에 입력값을 싣지 않고 원인 체인도 끊는다(``from None``) — 평문이 traceback
    으로도 새지 않게(app.roster.router와 동일).
    """
    if password is None:
        return None
    try:
        check_password_policy(password)
    except ValueError as exc:
        raise HTTPException(
            status_code=422, detail={"code": PASSWORD_POLICY_ERROR, "message": str(exc)}
        ) from None
    # 로그인·가입과 달리 요청 커넥션을 쥔 채 해시한다 — 앞선 가드(require_event_operator → resolve_organizer_id)가
    # 운영자 신원 행을 get-or-create로 flush만 해 둔 상태일 수 있어, release_connection(=close)으로 놓으면 그
    # 쓰기가 롤백된다. 운영자 단건 작업 1회당 해시 1번이라 풀 부담이 작다(로그인이 몰려 해시 자리를 기다리면
    # 그동안 커넥션 1개를 계속 쥔다 — app.auth.credentials. 대기열 가득·대기 시간 초과는 503 server_busy — app.main).
    return hash_password(password)


def _require_event(db: Session, event_id: str) -> Event:
    event = service.get_event(db, event_id)
    if event is None:
        raise HTTPException(status_code=404, detail="행사를 찾을 수 없습니다")
    return event


def _require_org_role(db: Session, event_id: str, organization_id: str) -> OrganizationEventRole:
    role = service.get_role_for_org(db, event_id, organization_id)
    if role is None:
        raise HTTPException(status_code=404, detail="기업을 찾을 수 없습니다")
    return role


def _org_not_found() -> HTTPException:
    """참가기업 삭제·삭제 영향 미리보기의 "이 행사에 그 기업이 없다" — **구조화된 코드**로 낸다(2026-10-09).

    화면(BFF)은 이 코드가 실린 404만 "기업 없음"으로 보고 명단을 다시 읽는다. 평문 404(라우팅·배포가 어긋난
    "Not Found" 등)는 일반 실패다. 공용 :func:`_require_org_role`의 문자열 detail은 다른 엔드포인트와 그것을
    쓰는 BFF가 그대로 읽으므로 바꾸지 않고, 이 두 엔드포인트만 이 detail을 쓴다.
    """
    return HTTPException(
        status_code=404, detail={"code": "ORG_NOT_FOUND", "message": "기업을 찾을 수 없습니다"}
    )


def _require_org_role_for_deletion(
    db: Session, event_id: str, organization_id: str
) -> OrganizationEventRole:
    """:func:`_require_org_role`과 같되, 없으면 구조화된 404(:func:`_org_not_found`)."""
    role = service.get_role_for_org(db, event_id, organization_id)
    if role is None:
        raise _org_not_found()
    return role


def _event_out(event: Event) -> schemas.EventOut:
    return schemas.EventOut(
        id=str(event.id),
        name=event.name,
        name_en=event.name_en,
        slug=event.slug,
        venue_name=event.venue_name,
        exhibition_start=event.exhibition_start,
        exhibition_end=event.exhibition_end,
        application_start=event.application_start,
        application_end=event.application_end,
        slot_minutes=event.slot_minutes,
        enabled_venue_types=list(event.enabled_venue_types or []),
        allow_same_role_discovery=event.allow_same_role_discovery,
        timezone=event.timezone,
    )


def _event_settings_out(event: Event, schedule: EventScheduleSettings) -> schemas.EventSettingsOut:
    """행사 설정 — ``events``(정책) + ``event_schedule_settings``(운영시간)를 한 응답으로 합친다."""
    return schemas.EventSettingsOut(
        event_id=str(event.id),
        slot_minutes=event.slot_minutes,
        enabled_venue_types=list(event.enabled_venue_types or []),
        allow_same_role_discovery=event.allow_same_role_discovery,
        operating_start=schedule.operating_start,
        operating_end=schedule.operating_end,
        lunch_start=schedule.lunch_start,
        lunch_end=schedule.lunch_end,
        slot_gap_minutes=schedule.slot_gap_minutes,
        max_meeting_minutes=schedule.max_meeting_minutes,
        min_guaranteed_slots=schedule.min_guaranteed_slots,
        participant_menu=schedule.participant_menu,
        participant_email_enabled=schedule.participant_email_enabled,
    )


def _org_list_item(
    role: OrganizationEventRole,
    org: Organization,
    exhibitor=None,
    buyer=None,
    *,
    exhibition_categories: list[str] | None = None,
    interest_categories: list[str] | None = None,
    org_types: list[str] | None = None,
    contact: tuple[str | None, str | None, str | None] = (None, None, None),
    match_count: int = 0,
) -> schemas.OrganizationListItem:
    """참가기업 명단 한 줄 응답 조립. exhibitor/buyer(프로필)·분류·담당자는 전부 선택 인자 —
    create_organization(방금 만든 org, 프로필 아직 없음)은 role/org만 넘기고 나머지는 기본값
    (None/빈 배열)으로 빠진다. list_organizations(service.OrganizationListRow)는 전부 채워 넘긴다."""
    contact_name, contact_email, contact_phone = contact
    return schemas.OrganizationListItem(
        id=str(org.id),
        name_ko=org.name_ko,
        name_en=org.name_en,
        is_exhibitor=role.is_exhibitor,
        is_buyer=role.is_buyer,
        created_by_organizer_id=role.created_by_organizer_id,
        buyer_subtype=role.buyer_subtype,
        proxy_written_by_organizer_id=role.proxy_written_by_organizer_id,
        application_status=role.application_status,
        managing_organizer_id=role.managing_organizer_id,
        match_count=match_count,
        contact_name=contact_name,
        contact_email=contact_email,
        contact_phone=contact_phone,
        representative_name_ko=exhibitor.representative_name_ko if exhibitor else None,
        representative_name_en=exhibitor.representative_name_en if exhibitor else None,
        company_email=exhibitor.company_email if exhibitor else None,
        main_tel=exhibitor.main_tel if exhibitor else None,
        booth_hall=exhibitor.booth_hall if exhibitor else None,
        booth_pavilion=exhibitor.booth_pavilion if exhibitor else None,
        booth_location=exhibitor.booth_location if exhibitor else None,
        booth_type=exhibitor.booth_type if exhibitor else None,
        booth_count=exhibitor.booth_count if exhibitor else None,
        exhibition_categories=exhibition_categories or [],
        content_category=exhibitor.content_category if exhibitor else None,
        contact_name_ko=buyer.contact_name_ko if buyer else None,
        contact_name_en=buyer.contact_name_en if buyer else None,
        contact_title_ko=buyer.contact_title_ko if buyer else None,
        contact_title_en=buyer.contact_title_en if buyer else None,
        contact_language=buyer.contact_language if buyer else None,
        contact_interpreter_need=buyer.contact_interpreter_need if buyer else None,
        country=buyer.country if buyer else None,
        city_state=buyer.city_state if buyer else None,
        tel=buyer.tel if buyer else None,
        interest_categories=interest_categories or [],
        org_types=org_types or [],
    )


def _org_detail(db: Session, role: OrganizationEventRole) -> schemas.OrganizationDetail:
    org = db.get(Organization, role.organization_id)
    return schemas.OrganizationDetail(
        id=str(role.organization_id),
        org_event_role_id=str(role.id),
        event_id=str(role.event_id),
        name_ko=org.name_ko if org else None,
        name_en=org.name_en if org else None,
        is_exhibitor=role.is_exhibitor,
        is_buyer=role.is_buyer,
        application_status=role.application_status,
        managing_organizer_id=role.managing_organizer_id,
        created_by_organizer_id=role.created_by_organizer_id,
        proxy_written_by_organizer_id=role.proxy_written_by_organizer_id,
        reviewed_at=role.reviewed_at,
        reviewed_by=role.reviewed_by,
        review_note=role.review_note,
        buyer_profile=bm_service.get_buyer_profile(db, role) if role.is_buyer else None,
        exhibitor_profile=bm_service.get_exhibitor_profile(db, role) if role.is_exhibitor else None,
    )


def _meeting_item(
    meeting: Meeting, venue_type: str | None = None, venue_label: str | None = None
) -> schemas.MeetingListItem:
    return schemas.MeetingListItem(
        id=str(meeting.id),
        exhibitor_org_id=str(meeting.exhibitor_org_id),
        buyer_org_id=str(meeting.buyer_org_id),
        status=meeting.status,
        matching_type=meeting.matching_type,
        scheduled_start=meeting.scheduled_start,
        scheduled_end=meeting.scheduled_end,
        venue_id=str(meeting.venue_id) if meeting.venue_id else None,
        venue_type=venue_type,
        venue_label=venue_label,
        cancelled_by=meeting.cancelled_by,
        cancelled_reason_code=meeting.cancelled_reason_code,
        cancelled_reason_text=meeting.cancelled_reason_text,
        updated_at=meeting.updated_at,
    )


def _interpreter_out(interpreter: Interpreter, org_ids: list[str]) -> schemas.InterpreterOut:
    return schemas.InterpreterOut(
        id=str(interpreter.id),
        event_id=str(interpreter.event_id),
        name=interpreter.name,
        languages=list(interpreter.languages or []),
        phone=interpreter.phone,
        email=interpreter.email,
        note=interpreter.note,
        assigned_organization_ids=org_ids,
    )


# =============================================================================
# 내 신원 — GET /api/admin/me
# =============================================================================
@router.get("/me", response_model=schemas.AdminMeOut)
def get_admin_me(
    principal: OperatorPrincipal = Depends(require_assigned_operator),
    db: Session = Depends(get_session),
) -> schemas.AdminMeOut:
    """지금 로그인한 운영자 본인의 표시용 신원 + 배정된 행사별 권한등급(ADR-0012).

    참가자 ``GET /api/me``의 운영자판이다 — 프론트 사이드바·감사기록 표시명(actorName)의 유일한
    실 원천. 이 응답이 없으면 화면이 목업 인물을 그리고 그 이름이 대리작성 기록에 박힌다.

    **표시용이다.** 여기 실린 permission_level로 무언가를 허용하지 않는다 — 실제 쓰기 허용은
    ``require_event_master``, 읽기는 ``require_event_operator``가 매 요청 판정한다(경계 B).
    """
    return schemas.AdminMeOut.model_validate(
        service.build_admin_me(db, member_id=principal.member_id, organizer_id=principal.organizer_id)
    )


# =============================================================================
# 행사(Event) CRUD — 멀티 이벤트(슈퍼어드민이 행사마다 새로 만든다)
# =============================================================================
@router.get("/events", response_model=schemas.EventListResponse)
def list_events(
    principal: OperatorPrincipal = Depends(require_operator_identity),
    db: Session = Depends(get_session),
) -> schemas.EventListResponse:
    events = service.list_events_for_organizer(db, principal.organizer_id)
    return schemas.EventListResponse(items=[_event_out(e) for e in events])


@router.post("/events", response_model=schemas.EventOut, status_code=status.HTTP_201_CREATED)
def create_event(
    body: schemas.EventCreate,
    principal: OperatorPrincipal = Depends(require_existing_master_identity),
    db: Session = Depends(get_session),
) -> schemas.EventOut:
    data = body.model_dump(exclude_unset=True, exclude_none=True)
    event = service.create_event(db, principal.organizer_id, data)
    return _event_out(event)


@router.get("/events/{event_id}", response_model=schemas.EventOut)
def get_event(
    event_id: str,
    _principal: EventOperatorPrincipal = Depends(require_event_operator),
    db: Session = Depends(get_session),
) -> schemas.EventOut:
    return _event_out(_require_event(db, event_id))


@router.patch("/events/{event_id}", response_model=schemas.EventOut)
def update_event(
    event_id: str,
    body: schemas.EventUpdate,
    _master: EventMasterPrincipal = Depends(require_event_master),
    db: Session = Depends(get_session),
) -> schemas.EventOut:
    event = _require_event(db, event_id)
    return _event_out(service.update_event(db, event, body.model_dump(exclude_unset=True)))


@router.get("/events/{event_id}/settings", response_model=schemas.EventSettingsOut)
def get_event_settings(
    event_id: str,
    _principal: EventOperatorPrincipal = Depends(require_event_operator),
    db: Session = Depends(get_session),
) -> schemas.EventSettingsOut:
    event = _require_event(db, event_id)
    return _event_settings_out(event, service.get_or_create_schedule_settings(db, str(event.id)))


@router.patch("/events/{event_id}/settings", response_model=schemas.EventSettingsOut)
def update_event_settings(
    event_id: str,
    body: schemas.EventSettingsUpdate,
    _master: EventMasterPrincipal = Depends(require_event_master),
    db: Session = Depends(get_session),
) -> schemas.EventSettingsOut:
    event = _require_event(db, event_id)
    updated_event, schedule = service.update_event_settings(
        db, event, body.model_dump(exclude_unset=True)
    )
    return _event_settings_out(updated_event, schedule)


# =============================================================================
# Organization(참가기업) — 목록/상세/직접수정/대리작성/불가슬롯
# =============================================================================
@router.get("/events/{event_id}/organizations", response_model=schemas.OrganizationListResponse)
def list_organizations(
    event_id: str,
    role: schemas.ProfileRole | None = Query(default=None),
    status_filter: str | None = Query(default=None, alias="status"),
    search: str | None = Query(default=None),
    limit: int = Query(default=20, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    principal: EventOperatorPrincipal = Depends(require_event_operator),
    db: Session = Depends(get_session),
) -> schemas.OrganizationListResponse:
    jurisdiction = None if principal.is_master else principal.organizer_id
    rows, total = service.list_organizations(
        db, event_id, role=role, status=status_filter, search=search,
        limit=limit, offset=offset, jurisdiction_organizer_id=jurisdiction,
    )
    return schemas.OrganizationListResponse(
        items=[
            _org_list_item(
                r.role, r.org, r.exhibitor, r.buyer,
                exhibition_categories=r.exhibition_categories,
                interest_categories=r.interest_categories,
                org_types=r.org_types,
                contact=(r.contact_name, r.contact_email, r.contact_phone),
                match_count=r.match_count,
            )
            for r in rows
        ],
        total=total, limit=limit, offset=offset,
    )


@router.post(
    "/events/{event_id}/organizations",
    response_model=schemas.OrganizationListItem,
    status_code=status.HTTP_201_CREATED,
)
def create_organization(
    event_id: str,
    body: schemas.OrganizationCreateIn,
    principal: EventOperatorPrincipal = Depends(require_event_operator),
    db: Session = Depends(get_session),
) -> schemas.OrganizationListItem:
    """참가기업 단건 등록 — 명단 임포트 없이 운영자가 한 건씩 만든다.

    권한(발주자 지시): **이 행사의 운영자(master·sub)**. 명단 업로드를 이미 master+sub로 연 것과
    같은 규칙을 단건 경로에도 맞춘다 — sub는 **바이어만** 만들 수 있고, 만든 바이어는 그 sub
    관할로 들어간다(관할 판정은 서비스 계층, ``check_create_jurisdiction``). 예전엔 master 전용이었다.

    ``contact_password``(선택)는 명단 업로드의 공통 비밀번호와 같은 정책으로 **쓰기 전에** 검사하고
    (위반이면 422, 아무것도 만들지 않는다) 해시만 서비스로 넘긴다. 평문은 로그·응답·감사기록 어디에도
    남기지 않는다(app.roster.router와 동일 관례). 비밀번호를 안 주면 종전대로 ``password_hash``가
    NULL이라 그 계정은 로그인할 수 없다.
    """
    _require_event(db, event_id)
    password_hash = _hash_or_422(body.contact_password)
    created_by = resolve_organizer_id(db, principal.member_id)
    jurisdiction = None if principal.is_master else principal.organizer_id
    try:
        role, org = service.create_organization(
            db,
            event_id,
            name_ko=body.name_ko,
            name_en=body.name_en,
            role=body.role,
            contact_name=body.contact_name,
            contact_email=body.contact_email,
            contact_phone=body.contact_phone,
            created_by_organizer_id=created_by,
            contact_password_hash=password_hash,
            jurisdiction_organizer_id=jurisdiction,
        )
    except service.JurisdictionDeniedError as exc:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(exc)) from exc
    except service.PasswordWithoutContactEmailError as exc:
        raise HTTPException(
            status_code=422,
            detail={"code": "PASSWORD_WITHOUT_CONTACT_EMAIL", "message": str(exc)},
        ) from exc
    except service.ContactEmailTakenError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    return _org_list_item(role, org)


@router.patch(
    "/events/{event_id}/organizations/{organization_id}/contact-password",
    response_model=schemas.ContactPasswordResult,
)
def set_organization_contact_password(
    event_id: str,
    organization_id: str,
    body: schemas.ContactPasswordUpdate,
    principal: EventOperatorPrincipal = Depends(require_event_operator),
    db: Session = Depends(get_session),
) -> schemas.ContactPasswordResult:
    """담당자 계정 비밀번호 설정/재설정 — 등록(단건·명단) 이후 다시 정해주는 유일한 경로.

    권한은 단건 등록과 같다(이 행사의 master·sub, sub는 자기 관할 바이어만 — 참가사는 master 전용).
    **운영자 계정(organizers 행과 연결된 회원)은 누가 불러도 거부**한다(409 OPERATOR_ACCOUNT) —
    sub가 관할 기업 담당자로 등록된 master 계정을 탈취하는 길을 막는다.

    **대상 기업이 다른 행사에도 참가 중이면 거부**한다(409 MULTI_EVENT_ORG) — 담당자 비밀번호는
    ``members``에 행사 무관 전역으로 저장되므로, 안 막으면 이 행사 권한만으로 다른 행사의 로그인을
    바꿔버릴 수 있다(호출자가 얽힌 모든 행사에서 master가 아닌 한, 이 행사의 master도 걸린다).

    응답에는 비밀번호도 해시도 싣지 않는다(``ContactPasswordResult``는 식별 정보만).
    """
    org_role = _require_org_role(db, event_id, organization_id)
    password_hash = _hash_or_422(body.password)
    assert password_hash is not None  # body.password는 필수라 None이 될 수 없다
    jurisdiction = None if principal.is_master else principal.organizer_id
    try:
        member = service.set_contact_password(
            db,
            org_role,
            password_hash,
            caller_organizer_id=principal.organizer_id,
            jurisdiction_organizer_id=jurisdiction,
        )
    except service.JurisdictionDeniedError as exc:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(exc)) from exc
    except service.MultiEventOrgPasswordError as exc:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"code": "MULTI_EVENT_ORG", "message": str(exc)},
        ) from exc
    except service.ContactMemberNotFoundError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "NO_CONTACT_MEMBER", "message": str(exc)},
        ) from exc
    except service.OperatorAccountPasswordError as exc:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"code": "OPERATOR_ACCOUNT", "message": str(exc)},
        ) from exc
    return schemas.ContactPasswordResult(
        organization_id=str(org_role.organization_id),
        member_id=str(member.id),
        contact_email=member.email,
    )


@router.delete(
    "/events/{event_id}/organizations/{organization_id}", status_code=status.HTTP_204_NO_CONTENT
)
def delete_organization(
    event_id: str,
    organization_id: str,
    _master: EventMasterPrincipal = Depends(require_event_master),
    db: Session = Depends(get_session),
) -> None:
    """참가기업 삭제 — 이 행사의 참가(role)를 제거한다. 다른 행사에 이 기업의 흔적(참가·미팅·알림 등)이
    하나도 없으면 조직과 로그인 계정(members)까지 지우고, 있으면 그것들과 다른 행사의 데이터는 그대로 둔다
    (``service.ORGANIZATION_TRACE_CHECKS``). 취소·거절된 미팅만 있는 기업은 그 미팅 행과 함께 지운다.

    **예정(proposed·accepted)이나 완료(completed) 미팅이 있으면 409(ORG_HAS_MEETINGS)** — detail에
    상태별 건수(``scheduled_count``·``completed_count``)를 싣는다. 예정 미팅은 운영자가 먼저 취소해야 하고
    (상대 기업에 알림이 간다), 완료 미팅이 있는 기업은 지울 수 없다. 강제로 지우는 옵션은 없다.
    판정을 통과한 뒤에도 DB가 막으면 409(ORG_DELETE_CONFLICT) — 어느 경우든 아무것도 지워지지 않는다.
    이 행사에 그 기업이 없으면(먼저 지워졌거나 다른 행사의 기업) 404 ``{"code": "ORG_NOT_FOUND", ...}`` —
    잠금을 얻고 보니 이미 지워진 경우도 같다.
    화면은 지우기 전에 ``GET .../deletion-impact``로 같은 판정과 함께 지워질 것을 읽는다.
    """
    role = _require_org_role_for_deletion(db, event_id, organization_id)
    try:
        service.delete_organization_participation(db, role)
    except service.OrganizationNotFoundError as exc:
        raise _org_not_found() from exc
    except service.OrganizationHasMeetingsError as exc:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "code": "ORG_HAS_MEETINGS",
                "message": str(exc),
                "meeting_count": exc.meeting_count,
                "scheduled_count": exc.scheduled_count,
                "completed_count": exc.completed_count,
            },
        ) from exc
    except service.OrganizationDeleteConflictError as exc:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"code": "ORG_DELETE_CONFLICT", "message": str(exc)},
        ) from exc


@router.get(
    "/events/{event_id}/organizations/{organization_id}/deletion-impact",
    response_model=schemas.OrganizationDeletionImpactOut,
)
def get_organization_deletion_impact(
    event_id: str,
    organization_id: str,
    _master: EventMasterPrincipal = Depends(require_event_master),
    db: Session = Depends(get_session),
) -> schemas.OrganizationDeletionImpactOut:
    """참가기업 삭제 영향 미리보기 — 삭제 확인 화면이 지우기 **전에** 읽는다(삭제와 같은 master 전용).

    삭제 가능 여부, 막는 미팅의 상태별 건수, 함께 지워질 것의 건수를 돌려준다. 실제 삭제와 같은 판정
    함수(``service.assess_organization_deletion``)를 쓴다 — 아무것도 바꾸지 않고 잠그지도 않는다. 읽은 뒤
    상황이 바뀌면 DELETE가 다시 판정해 409로 답한다. 이 행사에 그 기업이 없으면 DELETE와 같은 구조화된 404
    ``{"code": "ORG_NOT_FOUND", ...}``다.
    """
    role = _require_org_role_for_deletion(db, event_id, organization_id)
    impact = service.assess_organization_deletion(db, role)
    return schemas.OrganizationDeletionImpactOut(
        organization_id=str(role.organization_id),
        deletable=impact.deletable,
        scheduled_count=impact.scheduled_count,
        completed_count=impact.completed_count,
        closed_meeting_count=impact.closed_meeting_count,
        review_count=impact.review_count,
        transcription_job_count=impact.transcription_job_count,
        notification_count=impact.notification_count,
        draft_item_count=impact.draft_item_count,
        linked_record_count=impact.linked_record_count,
        member_count=impact.member_count,
        organization_deleted=impact.organization_deleted,
        other_event_count=impact.other_event_count,
    )


@router.get(
    "/events/{event_id}/organizations/{organization_id}", response_model=schemas.OrganizationDetail
)
def get_organization(
    event_id: str,
    organization_id: str,
    principal: EventOperatorPrincipal = Depends(require_event_operator),
    db: Session = Depends(get_session),
) -> schemas.OrganizationDetail:
    role = _require_org_role(db, event_id, organization_id)
    if not principal.is_master:
        try:
            service.check_jurisdiction(role, principal.organizer_id)
        except service.JurisdictionDeniedError as exc:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(exc))
    return _org_detail(db, role)


@router.patch("/events/{event_id}/organizations/{organization_id}/profile")
def patch_organization_profile(
    event_id: str,
    organization_id: str,
    role: schemas.ProfileRole = Query(...),
    body: dict = Body(default_factory=dict),
    principal: EventOperatorPrincipal = Depends(require_event_operator),
    db: Session = Depends(get_session),
) -> bm_schemas.BuyerProfileResponse | bm_schemas.ExhibitorProfileResponse:
    # ADR-0012 개정: 신청서 편집은 master+sub. sub는 관할 기업만(읽기 필터 미러) — 관할 밖 403.
    org_role = _require_org_role(db, event_id, organization_id)
    data = _validate_patch(_profile_model(role), body)
    jurisdiction = None if principal.is_master else principal.organizer_id
    try:
        return service.patch_profile(
            db,
            org_role,
            role,
            data,
            is_master=principal.is_master,
            jurisdiction_organizer_id=jurisdiction,
        )
    except bm_service.RoleMismatchError as exc:
        raise _role_mismatch(exc)
    except service.JurisdictionDeniedError as exc:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(exc))


@router.post("/events/{event_id}/organizations/{organization_id}/proxy-profile")
def proxy_write_organization_profile(
    event_id: str,
    organization_id: str,
    role: schemas.ProfileRole = Query(...),
    body: dict = Body(default_factory=dict),
    principal: EventOperatorPrincipal = Depends(require_event_operator),
    db: Session = Depends(get_session),
) -> bm_schemas.BuyerProfileResponse | bm_schemas.ExhibitorProfileResponse:
    # ADR-0012 개정: 대리작성(담당자 attendee 보강 포함)도 master+sub. sub는 관할 기업만.
    org_role = _require_org_role(db, event_id, organization_id)
    data = _validate_patch(_profile_model(role), body)
    # 대리작성 감사 도장(proxy_written_by_organizer_id)은 실행 운영자의 organizer 행 — 실 가드에선
    # principal.organizer_id와 동일 값이나, 감사 귀속은 member_id 기준 get-or-create로 명시한다.
    organizer_id = resolve_organizer_id(db, principal.member_id)
    jurisdiction = None if principal.is_master else principal.organizer_id
    try:
        result = service.proxy_write_profile(
            db,
            org_role,
            role,
            data,
            organizer_id,
            approve_immediately=principal.is_master,
            is_master=principal.is_master,
            jurisdiction_organizer_id=jurisdiction,
        )
    except bm_service.RoleMismatchError as exc:
        raise _role_mismatch(exc)
    except service.JurisdictionDeniedError as exc:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(exc))
    except service.ProxyWriteBlockedError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc))

    if principal.is_master and org_role.application_status == "approved":
        org_name = notification_service.org_display_name(db, org_role.organization_id)
        role_label = "exhibitor" if org_role.is_exhibitor else "buyer"
        notification_service.notify_after_commit(
            db,
            lambda: notification_service.notify_application_approved(
                db,
                event_id=str(org_role.event_id),
                recipient_org_id=str(org_role.organization_id),
                org_name=org_name,
                role=role_label,
            ),
            description=f"proxy_application_approved (org_id={org_role.organization_id})",
        )
    return result


@router.get("/events/{event_id}/unavailable-slots", response_model=dict[str, list[str]])
def list_unavailable_slots(
    event_id: str,
    _principal: EventOperatorPrincipal = Depends(require_event_operator),
    db: Session = Depends(get_session),
) -> dict[str, list[str]]:
    """참가사 org_id → 미팅 불가 슬롯 전체 조회 (H8 수정).

    PATCH는 200을 돌려주며 실제로 저장까지 잘 되고 있었다(``set_unavailable_slots`` 정상
    commit) — 문제는 **읽기**였다: 이 값을 되돌려줄 GET이 아예 없어서, 프론트 설정 화면은
    기업 목록 응답(``GET .../organizations``, unavailable_slots 필드 자체가 없음)에서
    항상 빈 배열로 초기화했다. 새로고침하면 "안 남아 있는 것처럼" 보인 이유가 이것이다.
    ``service.list_exhibitor_unavailable_slots``는 배정 그리드(assignment-schedule)가 이미
    쓰던 함수를 그대로 재사용한다.
    """
    _require_event(db, event_id)
    return service.list_exhibitor_unavailable_slots(db, event_id)


@router.patch("/events/{event_id}/organizations/{organization_id}/unavailable-slots")
def patch_unavailable_slots(
    event_id: str,
    organization_id: str,
    body: schemas.UnavailableSlotsUpdate,
    _master: EventMasterPrincipal = Depends(require_event_master),
    db: Session = Depends(get_session),
) -> bm_schemas.ExhibitorProfileResponse:
    org_role = _require_org_role(db, event_id, organization_id)
    try:
        return service.set_unavailable_slots(db, org_role, body.slots)
    except bm_service.RoleMismatchError as exc:
        raise _role_mismatch(exc)


# =============================================================================
# 미팅(Schedule Table) — 목록/운영자 취소
# =============================================================================
@router.get("/events/{event_id}/meetings", response_model=schemas.MeetingListResponse)
def list_meetings(
    event_id: str,
    status_filter: str | None = Query(default=None, alias="status"),
    limit: int = Query(default=20, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    principal: EventOperatorPrincipal = Depends(require_event_operator),
    db: Session = Depends(get_session),
) -> schemas.MeetingListResponse:
    jurisdiction = None if principal.is_master else principal.organizer_id
    rows, total = service.list_meetings(
        db, event_id, status=status_filter, limit=limit, offset=offset, jurisdiction_organizer_id=jurisdiction
    )
    return schemas.MeetingListResponse(
        items=[_meeting_item(m, vtype, vlabel) for m, vtype, vlabel in rows],
        total=total,
        limit=limit,
        offset=offset,
    )


@router.post("/events/{event_id}/meetings/{meeting_id}/cancel", response_model=schemas.MeetingCancelOut)
def cancel_meeting(
    event_id: str,
    meeting_id: str,
    body: schemas.MeetingCancelIn | None = None,
    _master: EventMasterPrincipal = Depends(require_event_master),
    db: Session = Depends(get_session),
) -> schemas.MeetingCancelOut:
    """운영자 취소 — 살아있는 미팅만(409 아니면), 사유 기록 후 **양측 org에** 취소 알림."""
    payload = body or schemas.MeetingCancelIn()
    try:
        meeting = service.cancel_meeting(
            db,
            event_id,
            meeting_id,
            reason_code=payload.reason_code,
            reason_text=payload.reason_text,
        )
    except service.MeetingNotFoundError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc))
    except service.MeetingNotCancellableError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc))

    # 참가자 취소와 달리 **양측**이 받는다 — 운영자가 취소했으므로 "취소 안 한 쪽"이 둘 다다.
    exhibitor_name = notification_service.org_display_name(db, meeting.exhibitor_org_id)
    buyer_name = notification_service.org_display_name(db, meeting.buyer_org_id)
    for recipient_org_id, counterpart_name in (
        (str(meeting.exhibitor_org_id), buyer_name),
        (str(meeting.buyer_org_id), exhibitor_name),
    ):
        notification_service.notify_after_commit(
            db,
            lambda org=recipient_org_id, name=counterpart_name: notification_service.notify_meeting_cancelled(
                db,
                event_id=str(meeting.event_id),
                meeting_id=str(meeting.id),
                recipient_org_id=org,
                counterpart_org_name=name,
                cancelled_by_role="organizer",
                scheduled_start=meeting.scheduled_start,
            ),
            description=f"meeting_cancelled/organizer (meeting_id={meeting.id}, org={recipient_org_id})",
        )
    return schemas.MeetingCancelOut(id=str(meeting.id), status=meeting.status)


# =============================================================================
# 알림 발송 이력(#OP 알림 콘솔) — dispatch 행 단위 조회·재발송(경로 계약: FE api-paths.ts)
# =============================================================================
@router.get("/events/{event_id}/notifications", response_model=schemas.NotificationLogListResponse)
def list_notification_logs(
    event_id: str,
    principal: EventOperatorPrincipal = Depends(require_event_operator),
    db: Session = Depends(get_session),
) -> schemas.NotificationLogListResponse:
    """읽기 — master+sub 겸용 가드(다른 조회 라우트와 동일). 최신순. sub는 수신 기업이 관할인 행만."""
    _require_event(db, event_id)
    jurisdiction = None if principal.is_master else principal.organizer_id
    rows = notification_service.list_admin_logs(db, event_id, jurisdiction_organizer_id=jurisdiction)
    return schemas.NotificationLogListResponse(
        items=[schemas.NotificationLogOut(**asdict(r)) for r in rows]
    )


@router.post(
    "/events/{event_id}/notifications/{dispatch_id}/resend",
    response_model=schemas.NotificationResendOut,
)
def resend_notification_log(
    event_id: str,
    dispatch_id: str,
    _master: EventMasterPrincipal = Depends(require_event_master),
    db: Session = Depends(get_session),
) -> schemas.NotificationResendOut:
    """재발송 — 쓰기라 master 전용. 이 행사 소속 dispatch만(다른 행사 것은 404).

    행사 설정 "참가자 알림 메일"이 꺼져 있으면 이메일 등 외부 채널 재발송은 409
    ``{"code": "PARTICIPANT_EMAIL_DISABLED", ...}`` 로 거부하고 dispatch 행은 그대로 둔다(인앱 재발송은 된다).
    """
    dispatch = db.get(NotificationDispatch, dispatch_id)
    notification = db.get(Notification, dispatch.notification_id) if dispatch is not None else None
    if notification is None or notification.event_id != event_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="발송 이력 없음")
    try:
        updated = notification_service.resend_dispatch(db, dispatch_id)
    except notification_service.ParticipantEmailDisabledError as exc:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"code": "PARTICIPANT_EMAIL_DISABLED", "message": str(exc)},
        ) from exc
    if updated is None:  # 직전 조회와 같은 행 — 도달 불가에 가까운 방어
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="발송 이력 없음")
    return schemas.NotificationResendOut(
        id=updated.id,
        channel=updated.channel,
        delivered=updated.status == "sent",
        sent_at=updated.sent_at,
    )


# =============================================================================
# 통역사 배정(#OP) — 참가기업별 통역사
# =============================================================================
@router.get("/events/{event_id}/interpreters", response_model=list[schemas.InterpreterOut])
def list_interpreters(
    event_id: str,
    _principal: EventOperatorPrincipal = Depends(require_event_operator),
    db: Session = Depends(get_session),
) -> list[schemas.InterpreterOut]:
    return [_interpreter_out(it, org_ids) for it, org_ids in service.list_interpreters(db, event_id)]


@router.post(
    "/events/{event_id}/interpreters", response_model=schemas.InterpreterOut, status_code=status.HTTP_201_CREATED
)
def create_interpreter(
    event_id: str,
    body: schemas.InterpreterCreate,
    _master: EventMasterPrincipal = Depends(require_event_master),
    db: Session = Depends(get_session),
) -> schemas.InterpreterOut:
    interpreter = service.create_interpreter(db, event_id, body.model_dump())
    return _interpreter_out(interpreter, [])


@router.get("/events/{event_id}/interpreters/{interpreter_id}", response_model=schemas.InterpreterOut)
def get_interpreter(
    event_id: str,
    interpreter_id: str,
    _principal: EventOperatorPrincipal = Depends(require_event_operator),
    db: Session = Depends(get_session),
) -> schemas.InterpreterOut:
    interpreter = service.get_interpreter(db, event_id, interpreter_id)
    if interpreter is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="통역사를 찾을 수 없습니다")
    return _interpreter_out(interpreter, service.assigned_organization_ids(db, interpreter.id))


@router.patch("/events/{event_id}/interpreters/{interpreter_id}", response_model=schemas.InterpreterOut)
def update_interpreter(
    event_id: str,
    interpreter_id: str,
    body: schemas.InterpreterUpdate,
    _master: EventMasterPrincipal = Depends(require_event_master),
    db: Session = Depends(get_session),
) -> schemas.InterpreterOut:
    interpreter = service.get_interpreter(db, event_id, interpreter_id)
    if interpreter is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="통역사를 찾을 수 없습니다")
    interpreter = service.update_interpreter(db, interpreter, body.model_dump(exclude_unset=True))
    return _interpreter_out(interpreter, service.assigned_organization_ids(db, interpreter.id))


@router.delete("/events/{event_id}/interpreters/{interpreter_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_interpreter(
    event_id: str,
    interpreter_id: str,
    _master: EventMasterPrincipal = Depends(require_event_master),
    db: Session = Depends(get_session),
) -> None:
    interpreter = service.get_interpreter(db, event_id, interpreter_id)
    if interpreter is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="통역사를 찾을 수 없습니다")
    service.delete_interpreter(db, interpreter)


@router.post(
    "/events/{event_id}/interpreters/{interpreter_id}/assign", response_model=schemas.InterpreterOut
)
def assign_interpreter(
    event_id: str,
    interpreter_id: str,
    body: schemas.InterpreterAssignIn,
    _master: EventMasterPrincipal = Depends(require_event_master),
    db: Session = Depends(get_session),
) -> schemas.InterpreterOut:
    interpreter = service.get_interpreter(db, event_id, interpreter_id)
    if interpreter is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="통역사를 찾을 수 없습니다")
    try:
        service.assign_interpreter(db, event_id, interpreter_id, body.organization_id)
    except service.OrganizationNotFoundError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc))
    return _interpreter_out(interpreter, service.assigned_organization_ids(db, interpreter.id))


@router.delete(
    "/events/{event_id}/interpreters/{interpreter_id}/assign/{organization_id}",
    response_model=schemas.InterpreterOut,
)
def unassign_interpreter(
    event_id: str,
    interpreter_id: str,
    organization_id: str,
    _master: EventMasterPrincipal = Depends(require_event_master),
    db: Session = Depends(get_session),
) -> schemas.InterpreterOut:
    interpreter = service.get_interpreter(db, event_id, interpreter_id)
    if interpreter is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="통역사를 찾을 수 없습니다")
    service.unassign_interpreter(db, event_id, interpreter_id, organization_id)
    return _interpreter_out(interpreter, service.assigned_organization_ids(db, interpreter.id))


# =============================================================================
# 미팅 장소(venue) 프로비저닝(#OP) — 비즈매칭존 테이블 / 비즈니스룸
# =============================================================================
# **booth는 이 CRUD에 없다.** 참가사 부스 장소는 미팅 신청 시점에 자동 생성되는 파생물이라
# (``meetings.service.get_or_create_booth_venue``) 운영자가 만들거나 이름을 바꿀 자원이 아니다.
# 목록은 아예 걸러내고, 어쩌다 booth id로 들어온 PATCH/DELETE는 422로 거부한다(404가 아니다 —
# 그 장소는 실재하고, 다만 이 경로의 대상이 아니라는 사실을 정확히 알려준다).
#
# 에러 바디는 ``{"code", "message"}`` 형태다(탐색·미팅 라우터와 같은 규약) — 라벨 충돌과 사용 중
# 삭제는 둘 다 409라, 화면이 문구가 아니라 코드로 갈라야 안내를 정확히 띄울 수 있다.
def _venue_out(venue, meeting_count: int = 0) -> schemas.VenueOut:
    return schemas.VenueOut(
        id=str(venue.id),
        event_id=str(venue.event_id),
        venue_type=venue.venue_type,
        label=venue.label,
        meeting_count=meeting_count,
    )


def _require_venue(db: Session, event_id: str, venue_id: str):
    venue = service.get_venue(db, event_id, venue_id)
    if venue is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="장소를 찾을 수 없습니다")
    return venue


def _venue_conflict(exc: service.VenueLabelTakenError) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_409_CONFLICT,
        detail={"code": "VENUE_LABEL_TAKEN", "message": str(exc)},
    )


def _venue_not_manageable(exc: service.VenueNotManageableError) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        detail={"code": "VENUE_NOT_MANAGEABLE", "message": str(exc)},
    )


@router.get("/events/{event_id}/venues", response_model=list[schemas.VenueOut])
def list_venues(
    event_id: str,
    _principal: EventOperatorPrincipal = Depends(require_event_operator),
    db: Session = Depends(get_session),
) -> list[schemas.VenueOut]:
    """운영 장소 목록(zone_table·business_room) — 라벨 순 = 실제 배정 순서."""
    venues = service.list_venues(db, event_id)
    counts = service.meeting_counts_by_venue(db, [str(v.id) for v in venues])
    return [_venue_out(v, counts.get(str(v.id), 0)) for v in venues]


@router.post(
    "/events/{event_id}/venues", response_model=schemas.VenueOut, status_code=status.HTTP_201_CREATED
)
def create_venue(
    event_id: str,
    body: schemas.VenueCreate,
    _master: EventMasterPrincipal = Depends(require_event_master),
    db: Session = Depends(get_session),
) -> schemas.VenueOut:
    _require_event(db, event_id)
    try:
        venue = service.create_venue(db, event_id, body.venue_type, body.label)
    except service.VenueLabelTakenError as exc:
        raise _venue_conflict(exc) from exc
    return _venue_out(venue)


@router.patch("/events/{event_id}/venues/{venue_id}", response_model=schemas.VenueOut)
def update_venue(
    event_id: str,
    venue_id: str,
    body: schemas.VenueUpdate,
    _master: EventMasterPrincipal = Depends(require_event_master),
    db: Session = Depends(get_session),
) -> schemas.VenueOut:
    venue = _require_venue(db, event_id, venue_id)
    try:
        venue = service.update_venue(db, venue, body.label)
    except service.VenueNotManageableError as exc:
        raise _venue_not_manageable(exc) from exc
    except service.VenueLabelTakenError as exc:
        raise _venue_conflict(exc) from exc
    return _venue_out(venue, service.count_meetings_at_venue(db, str(venue.id)))


@router.delete("/events/{event_id}/venues/{venue_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_venue(
    event_id: str,
    venue_id: str,
    _master: EventMasterPrincipal = Depends(require_event_master),
    db: Session = Depends(get_session),
) -> None:
    """장소 삭제 — 참조 미팅이 있으면 409(VENUE_IN_USE). 미팅을 먼저 정리해야 한다."""
    venue = _require_venue(db, event_id, venue_id)
    try:
        service.delete_venue(db, venue)
    except service.VenueNotManageableError as exc:
        raise _venue_not_manageable(exc) from exc
    except service.VenueInUseError as exc:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "code": "VENUE_IN_USE",
                "message": str(exc),
                "meeting_count": exc.meeting_count,
            },
        ) from exc


# =============================================================================
# 참가 기업 역할 전환(#OP 역할 관리) — master 전용
# =============================================================================
@router.patch(
    "/events/{event_id}/organizations/{organization_id}/role", response_model=schemas.OrganizationRoleOut
)
def update_organization_role(
    event_id: str,
    organization_id: str,
    body: schemas.OrganizationRoleUpdate,
    _master: EventMasterPrincipal = Depends(require_event_master),
    db: Session = Depends(get_session),
) -> schemas.OrganizationRoleOut:
    org_role = _require_org_role(db, event_id, organization_id)
    try:
        org_role = service.set_organization_role(db, org_role, body.role)
    except service.RoleChangeBlockedError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc))
    return schemas.OrganizationRoleOut(
        id=str(org_role.organization_id),
        event_id=str(org_role.event_id),
        is_exhibitor=org_role.is_exhibitor,
        is_buyer=org_role.is_buyer,
    )


# =============================================================================
# 신청서 검토(승인/반려/수정요청, OP-003) — master 전용
# =============================================================================
def _review_out(role: OrganizationEventRole) -> schemas.OrganizationReviewOut:
    return schemas.OrganizationReviewOut(
        id=str(role.organization_id),
        event_id=str(role.event_id),
        org_event_role_id=str(role.id),
        application_status=role.application_status,
        reviewed_at=role.reviewed_at,
        reviewed_by=role.reviewed_by,
        review_note=role.review_note,
    )


@router.patch(
    "/events/{event_id}/organizations/{organization_id}/review",
    response_model=schemas.OrganizationReviewOut,
)
def review_organization(
    event_id: str,
    organization_id: str,
    body: schemas.OrganizationReviewIn,
    master: EventMasterPrincipal = Depends(require_event_master),
    db: Session = Depends(get_session),
) -> schemas.OrganizationReviewOut:
    """신청서 검토 결정 — submitted → {approved, rejected, changes_requested}. 그 외 현재 상태면 409."""
    org_role = _require_org_role(db, event_id, organization_id)
    reviewer_id = resolve_organizer_id(db, master.member_id)
    try:
        org_role = service.review_organization_application(
            db, org_role, body.status, reviewer_id, body.note
        )
    except service.ReviewTransitionBlockedError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc))

    # 승인 완료 통지 — 신청서 검토 결정 경로는 이 함수 하나뿐이라(콘솔의 명단 상태 변경도 동일
    # 경로), 여기 한 곳만 배선하면 모든 승인 경로를 커버한다. 반려/수정요청은 발화하지 않는다.
    if org_role.application_status == "approved":
        org_name = notification_service.org_display_name(db, org_role.organization_id)
        role_label = "exhibitor" if org_role.is_exhibitor else "buyer"
        notification_service.notify_after_commit(
            db,
            lambda: notification_service.notify_application_approved(
                db,
                event_id=str(org_role.event_id),
                recipient_org_id=str(org_role.organization_id),
                org_name=org_name,
                role=role_label,
            ),
            description=f"application_approved (org_id={org_role.organization_id})",
        )
    return _review_out(org_role)


# =============================================================================
# 운영자(Organizer) 관리(#OP 역할 관리) — 서브어드민 부여/회수/목록, 전부 master 전용
# =============================================================================
def _organizer_out(eo: EventOrganizer, organizer: Organizer, member: Member | None) -> schemas.OrganizerOut:
    # 이름·이메일은 회원 행 우선 — organizers의 자리표시자(운영자 {UUID})는 화면에 내지 않는다.
    name, email = service.organizer_display_identity(organizer, member)
    return schemas.OrganizerOut(
        id=str(eo.id),
        event_id=str(eo.event_id),
        member_id=organizer.member_id,
        name=name,
        email=email,
        permission_level=eo.permission_level,
        trade_office=None,  # ADR-0013 슬라이스 전까지 스텁(schemas.OrganizerOut 참고)
        granted_at=eo.created_at,
    )


@router.get("/events/{event_id}/organizers", response_model=list[schemas.OrganizerOut])
def list_organizers(
    event_id: str,
    _master: EventMasterPrincipal = Depends(require_event_master),
    db: Session = Depends(get_session),
) -> list[schemas.OrganizerOut]:
    rows = service.list_event_organizers(db, event_id)
    return [_organizer_out(eo, organizer, member) for eo, organizer, member in rows]


@router.post(
    "/events/{event_id}/organizers", response_model=schemas.OrganizerOut, status_code=status.HTTP_201_CREATED
)
def create_organizer(
    event_id: str,
    body: schemas.OrganizerGrantIn,
    _master: EventMasterPrincipal = Depends(require_event_master),
    db: Session = Depends(get_session),
) -> schemas.OrganizerOut:
    """서브어드민 부여 — 대상은 가입된 회원(로그인 이메일, 하위 호환으로 members.id).

    에러 바디는 ``{"code", "message"}``(화면이 문구가 아니라 코드로 안내를 가른다):
    없는 회원 404 ``MEMBER_NOT_FOUND`` · 이미 이 행사 운영자 409 ``ORGANIZER_ALREADY_ASSIGNED`` ·
    master 요청은 스키마에서 422. 응답은 목록과 같은 표시 신원 + ``id``(event_organizers.id) — 화면이
    이 id로 행을 추가하므로 부여 직후 곧바로 회수할 수 있다.
    """
    _require_event(db, event_id)
    try:
        eo = service.grant_sub_organizer(
            db, event_id, body.permission_level, email=body.email, member_id=body.member_id
        )
    except service.MemberNotFoundError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "MEMBER_NOT_FOUND", "message": str(exc)},
        ) from exc
    except service.OrganizerAlreadyAssignedError as exc:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"code": "ORGANIZER_ALREADY_ASSIGNED", "message": str(exc)},
        ) from exc
    organizer, member = service.get_event_organizer_display(db, eo)
    return _organizer_out(eo, organizer, member)


@router.delete("/events/{event_id}/organizers/{organizer_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_organizer(
    event_id: str,
    organizer_id: str,  # 경로변수명은 URL 관례를 따르지만 실제 값은 event_organizers.id다(FE 계약, 아래).
    _master: EventMasterPrincipal = Depends(require_event_master),
    db: Session = Depends(get_session),
) -> None:
    """FE가 GET 목록에서 받은 ``AdminOrganizer.id``(= event_organizers.id)를 그대로 되돌려보낸다
    (frontend/lib/admin/api-paths.ts ``organizer(eventId, organizerId)``와 types.ts 주석 "회수 시
    경로 키" 참고) — organizers.id(계정 전역 신원)가 아니다."""
    try:
        service.remove_organizer(db, event_id, organizer_id)
    except service.OrganizerNotAssignedError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc))
    except service.MasterRemovalBlockedError as exc:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(exc))


# =============================================================================
# 강제 배정 / AI 전체 포화배정(F-OP-005 Phase 3-4) — master 전용. 실 로직은
# ``app.matching.assignment_service``가 소유(book_meeting 프리미티브 재사용) — 여기는 인증·직렬화·
# 알림 발화만. 에러 바디 규약은 참가자 미팅 라우터(app.meetings.router)와 동일:
# {"detail": {"code": ..., "message": ...}}.
# =============================================================================
def _assignment_error(exc: assignment_service.MeetingError) -> HTTPException:
    return HTTPException(status_code=exc.status_code, detail=exc.to_detail())


def _assignment_response(db: Session, meeting: Meeting) -> schemas.MeetingListItem:
    """배정 응답을 **알림을 보내기 전에** 만든다(강제·⚡재보충 공통, 리뷰 H2).

    배정은 이미 커밋됐다(assignment_service가 refresh까지 마쳐 값이 채워져 있다). 예전엔 알림(커밋 + SMTP 대기)
    **뒤에** 응답을 만들어, 만료된 미팅·장소 객체를 다시 읽느라 커넥션을 빌려야 했다 — 그 순간 풀이 고갈되면
    성공한 배정이 500으로 보였다. 응답 계약(MeetingListItem)은 그대로다.
    """
    venue = db.get(MeetingVenue, meeting.venue_id) if meeting.venue_id else None
    return _meeting_item(meeting, venue.venue_type if venue else None, venue.label if venue else None)


def _emit_assignment_notifications(
    db: Session,
    meeting: Meeting,
    *,
    channels: tuple[NotificationChannel, ...] | None = None,
) -> None:
    """강제/포화 배정 알림 — accepted면 양쪽에 확정 알림(OPEN 즉시확정과 동일 패턴, ``notify_meeting_accepted``
    재사용), proposed면 바이어(응답을 쥔 당사자)에게만 신청 알림. ``requested_by_role='organizer'``로
    출처를 표시한다(participant/counterpart가 신청한 게 아니라는 걸 받는 쪽이 알 수 있게).

    FORCED 채널은 2026-09-15 정정(ADR-0005, 발주자 QA B3)으로 ``resolve_entry_state``가 항상
    accepted를 반환하므로, 강제 배정은 이제 예외 없이 이 함수의 accepted 분기(양쪽 확정 알림)를
    탄다 — 새 알림 타입을 만들지 않고 기존 ``meeting_accepted``를 그대로 재사용한다(AI_SATURATION의
    Exhibitor 자동확정도 이미 같은 분기를 타는 선례가 있어 정합적이다).

    ``channels``를 생략하면 활성 채널 그대로(단건 배정 — 요청 안에서 발송). 일괄 확정은 이메일을 지연
    채널로 감싼 묶음을 넘긴다(``bulk_dispatch.DeferredEmailBatch``).
    """
    # 미팅 값은 첫 알림을 보내기 **전에** 지역 변수로 꺼내 둔다. 알림마다 커밋(+단건이면 SMTP 대기)이 끼므로,
    # 두 번째 알림부터 ``meeting.*``을 읽으면 만료된 ORM 객체를 다시 읽으러 커넥션을 빌려야 한다 — 그 사이 풀이
    # 고갈되면 남은 알림이 조용히 빠졌다(리뷰 H2).
    event_id = str(meeting.event_id)
    meeting_id = str(meeting.id)
    exhibitor_org_id = str(meeting.exhibitor_org_id)
    buyer_org_id = str(meeting.buyer_org_id)
    matching_type = meeting.matching_type
    scheduled_start = meeting.scheduled_start
    meeting_status = meeting.status
    venue_id = meeting.venue_id

    exhibitor_name = notification_service.org_display_name(db, exhibitor_org_id)
    buyer_name = notification_service.org_display_name(db, buyer_org_id)

    if meeting_status == "proposed":
        notification_service.notify_after_commit(
            db,
            lambda: notification_service.notify_meeting_requested(
                db,
                event_id=event_id,
                meeting_id=meeting_id,
                recipient_org_id=buyer_org_id,
                counterpart_org_name=exhibitor_name,
                requested_by_role="organizer",
                channels=channels,
            ),
            description=f"meeting_requested/{matching_type} (meeting_id={meeting_id})",
        )
        return

    venue_label = notification_service.venue_label(db, venue_id)
    for recipient_org_id, other_name in (
        (exhibitor_org_id, buyer_name),
        (buyer_org_id, exhibitor_name),
    ):
        notification_service.notify_after_commit(
            db,
            lambda org=recipient_org_id, name=other_name: notification_service.notify_meeting_accepted(
                db,
                event_id=event_id,
                meeting_id=meeting_id,
                recipient_org_id=org,
                counterpart_org_name=name,
                scheduled_start=scheduled_start,
                venue_label=venue_label,
                channels=channels,
            ),
            description=f"meeting_accepted/{matching_type} (meeting_id={meeting_id}, org={recipient_org_id})",
        )


@router.post(
    "/events/{event_id}/forced-assignments",
    response_model=schemas.MeetingListItem,
    status_code=status.HTTP_201_CREATED,
)
def create_forced_assignment(
    event_id: str,
    body: schemas.ForcedAssignmentIn,
    _master: EventMasterPrincipal = Depends(require_event_master),
    db: Session = Depends(get_session),
) -> schemas.MeetingListItem:
    """운영자 강제 배정 — book_meeting 재사용. 항상 즉시확정(accepted, 2026-09-15 정정 — ADR-0005,
    발주자 QA B3). 양쪽 조직에 확정 알림이 나간다(``_emit_assignment_notifications``).
    ``venue_id``를 생략하면 장소는 백엔드가 정한다(기본: 참가사 부스 — ``assignment_service.
    _auto_venue_resolver``, 2026-10-01). BFF는 더 이상 장소를 고르지 않는다."""
    try:
        meeting = assignment_service.create_forced_meeting(
            db,
            event_id=event_id,
            exhibitor_org_id=body.exhibitor_org_id,
            buyer_org_id=body.buyer_org_id,
            venue_id=body.venue_id,
            scheduled_start=body.scheduled_start,
            scheduled_end=body.scheduled_end,
            slot_ids=body.slot_ids,
            reason=body.reason,
        )
    except assignment_service.MeetingError as exc:
        raise _assignment_error(exc)

    item = _assignment_response(db, meeting)
    _emit_assignment_notifications(db, meeting)
    return item


@router.post(
    "/events/{event_id}/retrigger-assignments",
    response_model=schemas.MeetingListItem,
    status_code=status.HTTP_201_CREATED,
)
def create_retrigger_assignment(
    event_id: str,
    body: schemas.ForcedAssignmentIn,
    _master: EventMasterPrincipal = Depends(require_event_master),
    db: Session = Depends(get_session),
) -> schemas.MeetingListItem:
    """단일 기업 빈슬롯 보충 재트리거(⚡, F-OP-003) 확정 — book_meeting 재사용(Channel.AI_RETRIGGER).
    강제 배정과 달리 운영자 개입 채널이 아니라 **받는 쪽 바이어 유형이 진입 상태를 그대로
    결정**한다(초청=즉시확정, 일반=수락대기). FE ``confirmSingleFill``이 만든 draft 목록을 항목별로
    이 엔드포인트에 반복 호출한다(``app/api/organizer/assignments/route.ts``) — 이전엔 이 채널을
    받는 백엔드 엔드포인트가 없어 실세션에서도 인메모리 mock store로 조용히 폴백했다(발주자 QA
    지적 B: "⚡ 확정이 등록 안 되는 것 같다")."""
    try:
        meeting = assignment_service.create_retrigger_meeting(
            db,
            event_id=event_id,
            exhibitor_org_id=body.exhibitor_org_id,
            buyer_org_id=body.buyer_org_id,
            venue_id=body.venue_id,
            scheduled_start=body.scheduled_start,
            scheduled_end=body.scheduled_end,
            slot_ids=body.slot_ids,
        )
    except assignment_service.MeetingError as exc:
        raise _assignment_error(exc)

    item = _assignment_response(db, meeting)
    _emit_assignment_notifications(db, meeting)
    return item


def _saturation_item_out(item) -> schemas.SaturationDraftItemOut:
    return schemas.SaturationDraftItemOut(
        id=str(item.id),
        exhibitor_org_id=str(item.exhibitor_org_id),
        buyer_org_id=str(item.buyer_org_id),
        venue_id=str(item.venue_id) if item.venue_id else None,
        scheduled_start=item.scheduled_start,
        scheduled_end=item.scheduled_end,
        status=item.status,
        materialized_meeting_id=(
            str(item.materialized_meeting_id) if item.materialized_meeting_id else None
        ),
        seq_no=item.seq_no,
    )


def _saturation_run_out(run, items) -> schemas.SaturationRunOut:
    return schemas.SaturationRunOut(
        id=str(run.id),
        event_id=str(run.event_id),
        run_number=run.run_number,
        min_guaranteed_slots=run.min_guaranteed_slots,
        status=run.status,
        created_at=run.created_at,
        confirmed_at=run.confirmed_at,
        items=[_saturation_item_out(i) for i in items],
    )


# =============================================================================
# OP-001 운영 대시보드(#53) — 응답 조립. 계산(비율·상태묶음·시간대 버킷)은 하지 않는다(service
# docstring 참고) — 여기선 ORM 행 → snake_case 원시 출력 스키마 매핑만 한다.
# =============================================================================
def _ops_participants_out(
    roles: list[OrganizationEventRole], *, include_exhibitor_rows: bool = True
) -> list[schemas.OpsParticipantOut]:
    """역할 플래그가 둘 다 서면(is_exhibitor∧is_buyer) 두 행으로 갈라 낸다 — FE
    OpsParticipant.role은 단일 축이라 참가자 수 집계(참가사/바이어 분리 카운트)가 그 전제를 쓴다.

    ``include_exhibitor_rows=False``(sub 관할 스코프)면 바이어 행만 — 관할은 바이어 소유권이라
    이중역할 기업의 참가사 쪽은 그 sub의 매칭 활동이 아니다."""
    out: list[schemas.OpsParticipantOut] = []
    for r in roles:
        approved = r.application_status == "approved"
        if r.is_exhibitor and include_exhibitor_rows:
            out.append(schemas.OpsParticipantOut(org_id=str(r.organization_id), role="exhibitor", approved=approved))
        if r.is_buyer:
            out.append(schemas.OpsParticipantOut(org_id=str(r.organization_id), role="buyer", approved=approved))
    return out


def _ops_meeting_out(meeting: Meeting, zone: ZoneInfo) -> schemas.OpsMeetingOut:
    # DB는 UTC로 저장/반환된다 — 행사 로컬 타임존으로 변환해야 FE의 시간대 집계(ops-metrics.ts
    # hourlyDistribution, 문자열에서 시(hour)를 직접 잘라 읽는다)가 맞는 시(hour)로 버킷을 채운다.
    start = meeting.scheduled_start.astimezone(zone) if meeting.scheduled_start else None
    return schemas.OpsMeetingOut(
        id=str(meeting.id),
        exhibitor_org_id=str(meeting.exhibitor_org_id),
        buyer_org_id=str(meeting.buyer_org_id),
        status=meeting.status,
        scheduled_start=start,
        saturation_run_id=str(meeting.saturation_run_id) if meeting.saturation_run_id else None,
    )


def _ops_review_out(review: PostMeetingReview) -> schemas.OpsReviewOut:
    return schemas.OpsReviewOut(
        meeting_id=str(review.meeting_id),
        reviewer_org_id=str(review.reviewer_org_id),
        counterpart_noshow=review.counterpart_noshow,
        self_noshow=review.self_noshow,
    )


def _ops_schedule_out(event: Event, schedule: EventScheduleSettings) -> schemas.OpsScheduleOut:
    return schemas.OpsScheduleOut(
        operating_start=schedule.operating_start.strftime("%H:%M"),
        operating_end=schedule.operating_end.strftime("%H:%M"),
        slot_minutes=event.slot_minutes,
        slot_gap_minutes=schedule.slot_gap_minutes,
        # NULL → "00:00" (_assignment_settings_out 과 같은 관례) — FE slotTimes 가 빈 구간으로
        # 해석해 아무 칸도 건너뛰지 않는다.
        lunch_start=schedule.lunch_start.strftime("%H:%M") if schedule.lunch_start else "00:00",
        lunch_end=schedule.lunch_end.strftime("%H:%M") if schedule.lunch_end else "00:00",
        event_days=service.compute_event_days(event),
    )


def _ops_saturation_run_out(run: SaturationBatchRun) -> schemas.OpsSaturationRunOut:
    return schemas.OpsSaturationRunOut(
        run_number=run.run_number,
        status=run.status,
        created_at=run.created_at,
        min_guaranteed_slots=run.min_guaranteed_slots,
    )


@router.post(
    "/events/{event_id}/saturation-runs",
    response_model=schemas.SaturationRunOut,
    status_code=status.HTTP_201_CREATED,
)
def create_saturation_run(
    event_id: str,
    _master: EventMasterPrincipal = Depends(require_event_master),
    db: Session = Depends(get_session),
) -> schemas.SaturationRunOut:
    """AI 전체 포화배정 — draft run 생성. 미팅 0건 org를 naive하게 짝지어 draft만 적재(미확정,
    Meeting 생성 없음)."""
    try:
        run, items = assignment_service.create_saturation_run(db, event_id)
    except assignment_service.MeetingError as exc:
        raise _assignment_error(exc)
    return _saturation_run_out(run, items)


@router.get(
    "/events/{event_id}/saturation-runs/{run_id}", response_model=schemas.SaturationRunOut
)
def get_saturation_run(
    event_id: str,
    run_id: str,
    _master: EventMasterPrincipal = Depends(require_event_master),
    db: Session = Depends(get_session),
) -> schemas.SaturationRunOut:
    try:
        run, items = assignment_service.get_saturation_run(db, event_id, run_id)
    except assignment_service.MeetingError as exc:
        raise _assignment_error(exc)
    return _saturation_run_out(run, items)


@router.post(
    "/events/{event_id}/saturation-runs/{run_id}/confirm",
    response_model=schemas.SaturationConfirmOut,
)
def confirm_saturation_run(
    event_id: str,
    run_id: str,
    _master: EventMasterPrincipal = Depends(require_event_master),
    db: Session = Depends(get_session),
) -> schemas.SaturationConfirmOut:
    """Draft 확정 — 항목별로 book_meeting 물질화(SAVEPOINT 단위 원자성). 슬롯/장소 충돌 항목은
    'skipped'로 남고 나머지는 계속 진행한다(부분 성공 — 전체 롤백 아님).

    확정 알림은 미팅마다 양쪽에 나간다. 알림 행·인앱은 여기(요청 트랜잭션)서 만들고, 이메일 발송만
    응답 이후 전용 스레드가 초당 상한을 지켜 보낸다 — 수십~수백 통을 요청 안에서 순서대로 보내던 때는
    응답이 분 단위로 늦어지고 SES 한도(14통/초)를 넘길 수 있었다(app.notifications.bulk_dispatch).
    """
    try:
        run, results = assignment_service.confirm_saturation_run(db, event_id, run_id)
    except assignment_service.MeetingError as exc:
        raise _assignment_error(exc)

    batch = bulk_dispatch.DeferredEmailBatch.from_active_channels()
    try:
        for result in results:
            if result.item.status == "confirmed" and result.item.materialized_meeting_id:
                meeting = db.get(Meeting, result.item.materialized_meeting_id)
                if meeting is not None:
                    _emit_assignment_notifications(db, meeting, channels=batch.channels)
    finally:
        # 알림 행은 위에서 각각 커밋됐다 — 그 뒤에 넘겨야 백그라운드 기록(같은 DB의 새 세션)이 행을 본다.
        # 루프가 중간에 예외로 끝나도(기업명 조회 실패·풀 고갈 등) **이미 만든 알림의 메일은 반드시 넘긴다**:
        # 알림 행은 커밋돼 멱등 키가 잡혔으므로, 여기서 놓치면 다시 확정해도 그 메일은 영영 안 나간다(리뷰 H1).
        batch.send_in_background(sessionmaker_like(db))

    confirmed = [r for r in results if r.item.status == "confirmed"]
    skipped = [r for r in results if r.item.status == "skipped"]
    return schemas.SaturationConfirmOut(
        run=_saturation_run_out(run, [r.item for r in results]),
        confirmed_count=len(confirmed),
        skipped_count=len(skipped),
        items=[
            schemas.SaturationConfirmResultItem(
                id=str(r.item.id),
                exhibitor_org_id=str(r.item.exhibitor_org_id),
                buyer_org_id=str(r.item.buyer_org_id),
                status=r.item.status,
                materialized_meeting_id=(
                    str(r.item.materialized_meeting_id) if r.item.materialized_meeting_id else None
                ),
                error_code=r.error.code if r.error else None,
                error_message=r.error.message if r.error else None,
            )
            for r in results
        ],
    )


@router.post(
    "/events/{event_id}/saturation-runs/{run_id}/discard",
    response_model=schemas.SaturationRunOut,
)
def discard_saturation_run(
    event_id: str,
    run_id: str,
    _master: EventMasterPrincipal = Depends(require_event_master),
    db: Session = Depends(get_session),
) -> schemas.SaturationRunOut:
    """draft 폐기 — 물질화 없이 상태만 전이(Meeting 생성 없음, 비파괴)."""
    try:
        run = assignment_service.discard_saturation_run(db, event_id, run_id)
    except assignment_service.MeetingError as exc:
        raise _assignment_error(exc)
    _, items = assignment_service.get_saturation_run(db, event_id, run_id)
    return _saturation_run_out(run, items)


# =============================================================================
# OP-001 운영 대시보드(#53) — 이 행사의 원시 집계 입력. 읽기라 master+sub(require_event_operator).
#  · master: 참가기업 명단·미팅 상세를 포함해 관할 필터 없이 행사 전체(scope='event', 기존 그대로).
#  · sub: 자기가 관리하는 바이어의 매칭 활동만(scope='jurisdiction') — 발주사 체크리스트가 매칭 현황
#    대시보드를 "서브/어드민" 공용으로 둬서 개방했다(2026-09-17). 다른 sub의 바이어·미팅은 절대 싣지
#    않는다. 포화배정 실행 이력은 거버넌스(master 전용 행위)의 기록이라 sub에겐 비워 보낸다.
# =============================================================================
@router.get("/events/{event_id}/ops-metrics", response_model=schemas.OpsMetricsOut)
def get_ops_metrics(
    event_id: str,
    principal: EventOperatorPrincipal = Depends(require_event_operator),
    db: Session = Depends(get_session),
) -> schemas.OpsMetricsOut:
    event = _require_event(db, event_id)
    schedule = service.get_or_create_schedule_settings(db, event_id)
    zone = resolve_zone(event.timezone)
    jurisdiction = None if principal.is_master else principal.organizer_id

    if jurisdiction is None:
        exhibitor_registrants, buyer_registrants = service.list_registrant_role_counts(db, event_id)
        runs = service.list_saturation_runs(db, event_id)
    else:
        exhibitor_registrants, buyer_registrants = 0, service.count_managed_buyers(db, event_id, jurisdiction)
        runs = []
    participants = service.list_ops_participants(db, event_id, jurisdiction_organizer_id=jurisdiction)
    meetings = service.list_ops_meetings(db, event_id, jurisdiction_organizer_id=jurisdiction)
    reviews = service.list_ops_reviews(db, event_id, jurisdiction_organizer_id=jurisdiction)

    return schemas.OpsMetricsOut(
        roster=schemas.OpsRosterOut(
            exhibitor_registrants=exhibitor_registrants, buyer_registrants=buyer_registrants
        ),
        participants=_ops_participants_out(participants, include_exhibitor_rows=jurisdiction is None),
        meetings=[_ops_meeting_out(m, zone) for m in meetings],
        reviews=[_ops_review_out(r) for r in reviews],
        schedule=_ops_schedule_out(event, schedule),
        saturation_runs=[_ops_saturation_run_out(r) for r in runs],
        scope="event" if jurisdiction is None else "jurisdiction",
    )


# =============================================================================
# OP-005 배정 스케줄 읽기(F-OP-005 Phase 6) — 배정 콘솔 그리드 조회. 쓰기(강제배정·AI 전체
# 포화배정)는 위 "강제 배정 / AI 전체 포화배정" 절 참고 — 이 절은 그 반대편, 이미 배정된 것들을
# 그리드가 그대로 그릴 수 있는 모양으로 조립해 낸다. 계산(추천 점수 등)은 하지 않는다 — 추천은 AI
# 매칭 추천 엔진이 아직 미구현이라 계약 밖이다(응답에 필드 자체가 없다, FE는 recsByOrgId를 빈
# 값으로 다룬다). frontend/lib/organizer/assignment-mock.ts의 buildAssignmentSchedule()이 이
# 엔드포인트로 교체되는 seam이다(frontend/lib/api-client/server.ts getAssignmentSchedule).
# =============================================================================
def _assignment_settings_out(
    event: Event, schedule: EventScheduleSettings
) -> schemas.AssignmentScheduleSettingsOut:
    lunch_start = schedule.lunch_start.strftime("%H:%M") if schedule.lunch_start else "00:00"
    lunch_end = schedule.lunch_end.strftime("%H:%M") if schedule.lunch_end else "00:00"
    return schemas.AssignmentScheduleSettingsOut(
        start_time=schedule.operating_start.strftime("%H:%M"),
        end_time=schedule.operating_end.strftime("%H:%M"),
        slot_minutes=event.slot_minutes,
        lunch_start=lunch_start,
        lunch_end=lunch_end,
        slot_gap_minutes=schedule.slot_gap_minutes,
        max_meeting_minutes=schedule.max_meeting_minutes,
        min_slots=schedule.min_guaranteed_slots,
    )


def _assignment_meeting_out(
    meeting: Meeting,
    venue_label: str | None,
    zone: ZoneInfo,
    review_facts: dict[str, tuple[bool, bool | None]],
) -> schemas.AssignmentMeetingOut:
    start = meeting.scheduled_start.astimezone(zone) if meeting.scheduled_start else None
    duration = None
    if meeting.scheduled_start and meeting.scheduled_end:
        duration = int((meeting.scheduled_end - meeting.scheduled_start).total_seconds() // 60)
    has_review, attended = review_facts.get(str(meeting.id), (False, None))
    return schemas.AssignmentMeetingOut(
        id=str(meeting.id),
        exhibitor_org_id=str(meeting.exhibitor_org_id),
        buyer_org_id=str(meeting.buyer_org_id),
        slot_id=f"{start.strftime('%Y-%m-%d')}T{start.strftime('%H:%M')}" if start else "",
        status=meeting.status,
        matching_type=meeting.matching_type,
        duration_minutes=duration,
        attended=attended,
        has_review=has_review,
        venue_label=venue_label,
        requested_by_org_id=_requested_by_org_id(meeting),
    )


def _assignment_schedule_out(
    db: Session,
    event: Event,
    role_rows: list[tuple[OrganizationEventRole, Organization]],
    meeting_rows: list[tuple[Meeting, str | None]],
    *,
    jurisdiction_organizer_id: str | None = None,
    organization_ids: set[str] | None = None,
) -> schemas.AssignmentScheduleOut:
    """배정 그리드 모양 응답 조립 — 전체 그리드(master)와 기업 디테일 일정(master+sub)이 공유한다.

    ``organization_ids``를 주면 불가슬롯·담당자를 그 기업들로 좁힌다(기업 디테일은 본 기업 + 미팅
    상대만 싣는다). ``jurisdiction_organizer_id``(sub)는 바이어 카드·바이어 담당자를 관리 바이어로 좁힌다.
    둘 다 None이면 기존 전체 그리드와 완전히 같은 출력이다.
    """
    event_id = str(event.id)
    schedule = service.get_or_create_schedule_settings(db, event_id)
    zone = resolve_zone(event.timezone)

    exhibitor_cards, buyer_cards, application_order = service.matching_roster_cards(
        db, role_rows, jurisdiction_organizer_id=jurisdiction_organizer_id
    )
    review_facts = service.assignment_review_facts(db, [str(m.id) for m, _ in meeting_rows])
    meetings_out = [_assignment_meeting_out(m, label, zone, review_facts) for m, label in meeting_rows]

    contacts = service.list_assignment_contacts(db, event_id, jurisdiction_organizer_id=jurisdiction_organizer_id)
    unavailable = service.list_exhibitor_unavailable_slots(db, event_id)
    if organization_ids is not None:
        contacts = {org_id: c for org_id, c in contacts.items() if org_id in organization_ids}
        unavailable = {org_id: s for org_id, s in unavailable.items() if org_id in organization_ids}

    return schemas.AssignmentScheduleOut(
        exhibitors=exhibitor_cards,
        buyers=buyer_cards,
        dates=[schemas.AssignmentDateOut(**d) for d in service.list_event_dates(event)],
        settings=_assignment_settings_out(event, schedule),
        meetings=meetings_out,
        application_order=application_order,
        unavailable_by_org_id=unavailable,
        contacts_by_org_id={
            org_id: schemas.AssignmentContactOut(name=name, title=title)
            for org_id, (name, title) in contacts.items()
        },
    )


@router.get("/events/{event_id}/assignment-schedule", response_model=schemas.AssignmentScheduleOut)
def get_assignment_schedule(
    event_id: str,
    _master: EventMasterPrincipal = Depends(require_event_master),
    db: Session = Depends(get_session),
) -> schemas.AssignmentScheduleOut:
    """배정 콘솔 그리드 원천 — 기업 로스터(discover 프로젝션 재사용, 승인·가시성 필터 없음) + 행사일
    + 운영시간 + 실제 배정된 미팅 + 참가사 불가슬롯 + 담당자. master 전용(강제배정 쓰기와 동일
    게이팅) — 행사 전역 배정 그리드는 거버넌스 화면이다. sub가 한 기업의 일정을 읽는 길은 아래
    ``get_organization_schedule``(관할 검사)이다."""
    event = _require_event(db, event_id)
    return _assignment_schedule_out(
        db,
        event,
        service.list_matching_org_roles(db, event_id),
        service.list_assignment_meetings(db, event_id),
    )


@router.get(
    "/events/{event_id}/organizations/{organization_id}/schedule",
    response_model=schemas.AssignmentScheduleOut,
)
def get_organization_schedule(
    event_id: str,
    organization_id: str,
    principal: EventOperatorPrincipal = Depends(require_event_operator),
    db: Session = Depends(get_session),
) -> schemas.AssignmentScheduleOut:
    """OP-003 기업 디테일(조회) — 한 기업의 프로필 카드 + 미팅 일정을 배정 그리드와 같은 모양으로.

    읽기라 master+sub(ADR-0012 canRead). 관할은 ``GET .../organizations/{id}``와 같은
    ``check_jurisdiction``이다 — 국내기업은 공유 열람, 해외 바이어는 관리 운영자만(밖이면 403).
    sub에겐 일정도 관할로 좁힌다: 참가사 일정을 열어도 **자기 관리 바이어와의 미팅만** 보인다(다른
    sub 바이어와의 미팅·상대 기업명은 싣지 않는다). 배정(쓰기)은 여전히 master 전용 엔드포인트들이다.

    응답의 기업 카드는 본 기업 + 실린 미팅의 상대들뿐이다(행사 전체 로스터가 아니다) — 이 화면은
    배정 후보 탐색이 아니라 조회이기 때문이다.
    """
    event = _require_event(db, event_id)
    if not service._is_uuid(organization_id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="기업을 찾을 수 없습니다")
    role = _require_org_role(db, event_id, organization_id)
    jurisdiction = None if principal.is_master else principal.organizer_id
    try:
        service.check_jurisdiction(role, jurisdiction)
    except service.JurisdictionDeniedError as exc:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(exc))

    meeting_rows = service.list_assignment_meetings(
        db, event_id, organization_id=organization_id, jurisdiction_organizer_id=jurisdiction
    )
    involved = {str(role.organization_id)}
    for meeting, _ in meeting_rows:
        involved.update((str(meeting.exhibitor_org_id), str(meeting.buyer_org_id)))
    return _assignment_schedule_out(
        db,
        event,
        service.list_matching_org_roles(db, event_id, organization_ids=involved),
        meeting_rows,
        jurisdiction_organizer_id=jurisdiction,
        organization_ids=involved,
    )
