"""어드민 콘솔 DB 로직 — 행사 CRUD, 참가기업 관리(직접수정/대리작성), 미팅 운영, 통역사 배정.

프로필 읽기/쓰기는 ``app.bm.service``를 재사용한다(지시: "bm 서비스 재사용") — 여기서 폼 검증
로직을 새로 만들지 않는다. 트랜잭션 경계는 각 함수가 소유(bm.service와 동일 관례 — commit까지
이 계층에서 끝낸다, 라우터는 인증·404/409 매핑만).
"""

from __future__ import annotations

import re
import uuid
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from sqlalchemy import Text, and_, cast, func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, aliased

from app.admin.guard import resolve_organizer_id
from app.auth.organizer_guard import PERMISSION_MASTER
from app.bm import schemas as bm_schemas
from app.bm import service as bm_service
from app.discover import service as discover_service
from app.matching.meeting_state import IllegalTransitionError, assert_transition
from app.models import (
    BuyerAttendee,
    BuyerInterestKeyword,
    BuyerProfile,
    Event,
    EventOrganizer,
    EventScheduleSettings,
    ExhibitorAttendee,
    ExhibitorKeyword,
    ExhibitorProfile,
    Interpreter,
    InterpreterAssignment,
    Keyword,
    Meeting,
    MeetingVenue,
    Member,
    OrgEventRoleOrgType,
    Organization,
    OrganizationEventRole,
    Organizer,
    PostMeetingReview,
    Registrant,
    SaturationBatchRun,
)

#: 행사 설정 중 ``event_schedule_settings`` 행에 저장되는 필드(나머지는 ``events``).
_SCHEDULE_SETTING_FIELDS = (
    "operating_start",
    "operating_end",
    "lunch_start",
    "lunch_end",
    "slot_gap_minutes",
    "max_meeting_minutes",
    "min_guaranteed_slots",
)


class ProxyWriteBlockedError(Exception):
    """대리작성은 '미신청'(registered) 상태에서만 — 이미 제출/승인/반려된 신청은 PATCH profile(직접수정)을 쓴다."""


class JurisdictionDeniedError(Exception):
    """sub 운영자가 관할 밖(자기 관리 아닌 바이어) 자원에 접근(ADR-0012) — 403 매핑."""


class MeetingNotFoundError(Exception):
    """이 행사에 속한 미팅이 아니거나 존재하지 않음 — 404 매핑."""


class OrganizationNotFoundError(Exception):
    """이 행사에 속한 기업이 아니거나 존재하지 않음 — 404 매핑(통역사 배정 대상 검증)."""


class ReviewTransitionBlockedError(Exception):
    """검토 전이는 submitted 상태에서만 받는다(bm-profile-fields §6 승인 상태머신, D5 승인 게이트).

    이미 검토 끝난 신청(approved/rejected/changes_requested)이나 아직 제출 전(registered)인
    신청에 승인/반려/수정요청을 걸면 이 예외 — 409 매핑. changes_requested 이후 재제출은 참가측
    submit_*(bm.service._promote_to_submitted)이 다시 submitted로 올려야 재검토 대상이 된다."""


class RoleChangeBlockedError(Exception):
    """이 기업이 이 행사에서 이미 미팅(exhibitor/buyer 어느 축이든)에 걸려 있으면 역할 전환을
    막는다 — meetings.exhibitor_org_id/buyer_org_id가 역할 반전 후에도 그대로 남아 매칭 배치가
    어긋나기 때문(FE 콘솔도 동일 규칙, 발주자 지정). 409 매핑 — 먼저 미팅을 정리(취소 등)해야 한다."""


class OrganizerAlreadyAssignedError(Exception):
    """이 운영자는 이미 이 행사에 배정돼 있다 — 등급 변경은 이 엔드포인트(신규 부여) 책임 밖이다
    (기존 master를 이 경로로 몰래 sub로 강등/재확인하는 경로를 만들지 않기 위함). 409 매핑."""


class OrganizerNotAssignedError(Exception):
    """이 운영자는 이 행사에 배정돼 있지 않다 — 404 매핑."""


class MemberNotFoundError(Exception):
    """서브어드민 부여 대상 회원이 없다 — 404(MEMBER_NOT_FOUND) 매핑. 없는 회원으로 organizers 행을
    만들지 않는다(예전엔 오타 난 회원 UUID도 유령 운영자 행이 됐다)."""


class MasterRemovalBlockedError(Exception):
    """master 배정은 이 API로 회수할 수 없다 — 마지막 슈퍼어드민을 지워 콘솔이 잠기는 사고를
    막는다. 부여도 회수도 master는 DB 직접 조작 전용(backend/README.md). 403 매핑."""


class VenueLabelTakenError(Exception):
    """같은 (행사, 종류)에 그 라벨이 이미 있다 — meeting_venues 유니크. 409 매핑."""


class VenueNotManageableError(Exception):
    """booth 장소는 이 CRUD의 대상이 아니다 — 422 매핑(아래 MANAGEABLE_VENUE_TYPES 참고)."""


class VenueInUseError(Exception):
    """참조 미팅이 있는 장소는 지울 수 없다 — 409 매핑. 몇 건이 걸렸는지 실어 보낸다."""

    def __init__(self, meeting_count: int) -> None:
        super().__init__(f"이 장소를 쓰는 미팅이 {meeting_count}건 있어 삭제할 수 없습니다")
        self.meeting_count = meeting_count


class OrganizationHasMeetingsError(Exception):
    """이 기업이 이 행사에서 미팅(exhibitor/buyer 어느 축이든)을 갖고 있으면 참가 삭제를 막는다 —
    409 매핑. venue 삭제(``VenueInUseError``)와 같은 이유: ``meetings.exhibitor_org_id``/
    ``buyer_org_id``는 ``ondelete`` 없는 FK라 참조가 남아있으면 조직 CASCADE 삭제 시 DB가 막는다.
    운영자가 먼저 미팅을 정리(취소 등)해야 한다."""

    def __init__(self, meeting_count: int) -> None:
        super().__init__(f"이 기업이 이 행사에서 미팅을 {meeting_count}건 갖고 있어 삭제할 수 없습니다")
        self.meeting_count = meeting_count


class ContactEmailTakenError(Exception):
    """단건 등록의 담당자 이메일이 이미 다른 회원(members.email unique)이 쓰고 있다 — 409 매핑."""


class ContactMemberNotFoundError(Exception):
    """이 기업에 담당자(members) 행이 없다 — 비밀번호를 걸 계정 자체가 없으므로 404 매핑.

    명단·단건 등록 모두 이메일이 없으면 담당자를 만들지 않는다(members.email NOT NULL). 그런
    기업은 먼저 담당자 이메일을 채워야 로그인 계정이 생긴다.
    """


class OperatorAccountPasswordError(Exception):
    """대상 담당자가 운영자 계정(organizers 행과 연결)이라 콘솔에서 비밀번호를 바꿀 수 없다 — 409 매핑.

    master도 못 한다(누가 부르든 거부) — 권한 문제가 아니라 **대상의 성격** 때문이다. 이게 없으면
    sub가 자기 관할 기업의 담당자로 등록된 master 계정에 새 비밀번호를 심어 탈취할 수 있다.
    운영자 비밀번호는 Cognito/DB 운영 절차로만 바꾼다(backend/README.md "슈퍼어드민 부여").
    """


class MultiEventOrgPasswordError(Exception):
    """대상 조직이 이 행사 말고 **다른 행사에도** 참가 중이다(같은 조직 = 같은 회사, 담당자 계정은
    행사가 아니라 members에 **전역**으로 하나뿐이다).

    비밀번호를 그 담당자 계정(members.password_hash)에 걸면 다른 행사의 로그인도 함께 바뀐다 —
    이 행사 운영자(설령 master라도, 다른 행사엔 권한이 없다)가 남의 행사 로그인을 좌우하게 되므로
    409로 막는다. 호출자가 얽힌 **모든** 행사에서 master면 통과시키는 예외 루트가 있다
    (``set_contact_password``의 ``jurisdiction_organizer_id is None`` + 전 행사 master 확인).
    """


class PasswordWithoutContactEmailError(Exception):
    """비밀번호는 줬는데 담당자 이메일이 없다 — 걸 계정이 안 생기므로 조용히 버리지 않고 422.

    이메일 없이 등록하면 members 행 자체가 없어(위 ContactMemberNotFoundError 참고) 비밀번호가
    아무 데도 저장되지 않는다. "입력했는데 로그인이 안 된다"를 만드느니 입력 단계에서 막는다.
    """


# =============================================================================
# 행사(Event)
# =============================================================================
def _slugify(name: str) -> str:
    base = re.sub(r"[^a-z0-9]+", "-", name.strip().lower()).strip("-") or "event"
    return f"{base}-{uuid.uuid4().hex[:8]}"  # 충돌 방지 접미사(멱등 키가 아니라 매번 새 이벤트)


def list_events_for_organizer(db: Session, organizer_id: str) -> list[Event]:
    """"자기가 organizer로 등록된 행사들" — master/sub 무관, event_organizers 배정이 있는 행사 전부."""
    rows = db.execute(
        select(Event)
        .join(EventOrganizer, EventOrganizer.event_id == Event.id)
        .where(EventOrganizer.organizer_id == organizer_id)
        .order_by(Event.created_at.desc())
    ).scalars().all()
    return list(rows)


def create_event(db: Session, organizer_id: str, data: dict) -> Event:
    """새 행사를 만들고 생성자를 그 행사의 master로 자동 배정한다.

    호출부(``app.admin.guard.require_existing_master_identity``)가 이미 "어디선가 master인
    운영자"만 여기까지 통과시키므로, 이 함수 자체는 무조건 배정한다(자기증식 — 이미 master인
    사람이 새 행사를 또 만들면 그 행사에서도 master). 최초의 첫 행사(아직 아무도 master가 아닌
    시점)는 이 API로 만들 수 없다 — DB 직접 INSERT로 부트스트랩한다(backend/README.md)."""
    fields = dict(data)
    slug = fields.pop("slug", None) or _slugify(fields.get("name", "event"))
    event = Event(slug=slug, **fields)
    db.add(event)
    db.flush()
    db.add(EventOrganizer(event_id=event.id, organizer_id=organizer_id, permission_level=PERMISSION_MASTER))
    db.commit()
    db.refresh(event)
    return event


def get_event(db: Session, event_id: str) -> Event | None:
    return db.get(Event, event_id)


def update_event(db: Session, event: Event, data: dict) -> Event:
    for key, value in data.items():
        setattr(event, key, value)
    db.commit()
    db.refresh(event)
    return event


def get_or_create_schedule_settings(db: Session, event_id: str) -> EventScheduleSettings:
    """행사 운영시간 설정 행 — 없으면 스키마 기본값(09:00~18:00)으로 만든다.

    행사 생성 시점에 미리 만들지 않는 건 기존 데이터(설정 행 없는 행사)와의 호환 때문이다.
    읽기/쓰기 어느 쪽으로든 처음 닿을 때 만들어지므로 호출부는 존재 여부를 신경 쓰지 않는다.
    """
    row = db.execute(
        select(EventScheduleSettings).where(EventScheduleSettings.event_id == event_id)
    ).scalar_one_or_none()
    if row is None:
        row = EventScheduleSettings(event_id=event_id)
        db.add(row)
        db.commit()
        db.refresh(row)
    return row


def update_event_settings(
    db: Session, event: Event, data: dict
) -> tuple[Event, EventScheduleSettings]:
    """행사 설정 갱신 — 두 테이블에 걸친 값을 한 트랜잭션으로 나눠 쓴다.

    ``slot_minutes``는 ``events``에만 있다(mt001meet01에서 단일화) — settings 쪽에 같은 이름의
    컬럼을 되살리지 않는다.
    """
    schedule = get_or_create_schedule_settings(db, str(event.id))
    for key, value in data.items():
        if key in _SCHEDULE_SETTING_FIELDS:
            setattr(schedule, key, value)
        else:
            setattr(event, key, value)
    schedule.updated_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(event)
    db.refresh(schedule)
    return event, schedule


# =============================================================================
# Organization(참가기업) — 목록/상세/직접수정/대리작성
# =============================================================================
def get_role_for_org(db: Session, event_id: str, organization_id: str) -> OrganizationEventRole | None:
    return db.execute(
        select(OrganizationEventRole).where(
            OrganizationEventRole.event_id == event_id,
            OrganizationEventRole.organization_id == organization_id,
        )
    ).scalar_one_or_none()


def check_jurisdiction(role: OrganizationEventRole, jurisdiction_organizer_id: str | None) -> None:
    """sub 관할 검사(ADR-0012) — master는 ``jurisdiction_organizer_id=None``으로 호출해 전역 통과.

    국내기업(Exhibitor)은 sub도 전부 열람 가능(관할 무관, "국내기업은 열람만"). 바이어는 자기가
    현재 관리하는(managing_organizer_id 일치) 건만 통과.
    """
    if jurisdiction_organizer_id is None:
        return
    allowed = role.is_exhibitor or (role.is_buyer and role.managing_organizer_id == jurisdiction_organizer_id)
    if not allowed:
        raise JurisdictionDeniedError("이 바이어는 관할 밖입니다")


def check_write_jurisdiction(
    role: OrganizationEventRole, jurisdiction_organizer_id: str | None
) -> None:
    """sub **쓰기** 관할 — 읽기(``check_jurisdiction``)보다 좁다. master는 None으로 전역 통과.

    읽기는 "국내기업(참가사)은 sub도 열람 가능"이지만, 계정 비밀번호처럼 되돌리기 어려운 쓰기는
    명단 업로드와 같은 규칙으로 좁힌다(app.roster.import_service ``_jurisdiction_denial`` 미러):
    **바이어 참가여야 하고(참가사는 master 전용), 그 바이어를 현재 자기가 관리 중이어야 한다.**
    "참가사 겸 바이어"인 행도 sub에겐 닫는다 — 참가사 축이 걸린 순간 master 소관이다.
    """
    if jurisdiction_organizer_id is None:
        return
    if role.is_exhibitor or not role.is_buyer:
        raise JurisdictionDeniedError("서브 운영자는 바이어만 등록·관리할 수 있습니다")
    if role.managing_organizer_id != jurisdiction_organizer_id:
        raise JurisdictionDeniedError("이 바이어는 관할 밖입니다")


def check_create_jurisdiction(role: str, jurisdiction_organizer_id: str | None) -> None:
    """단건 등록의 sub 관할 — 아직 행이 없으므로 요청한 ``role``만 본다(바이어 전용).

    ``check_write_jurisdiction``의 "새로 만드는 행" 버전이다. 명단 업로드의 ``buyer_only`` 거부와
    같은 규칙 — sub가 참가사를 새로 만들지 못하게 한다.
    """
    if jurisdiction_organizer_id is None:
        return
    if role != "buyer":
        raise JurisdictionDeniedError("서브 운영자는 바이어만 등록할 수 있습니다")


def _organization_query(
    event_id: str,
    *,
    role: str | None,
    status: str | None,
    search: str | None,
    jurisdiction_organizer_id: str | None,
):
    stmt = (
        select(OrganizationEventRole, Organization, ExhibitorProfile, BuyerProfile)
        .join(Organization, Organization.id == OrganizationEventRole.organization_id)
        # 명단 표시 필드(담당자·부스·분야 등, 2026-09) — org_event_role_id는 두 프로필 테이블
        # 모두 unique FK라 1:1이다(fan-out 없음, N+1 방지: 행마다 따로 조회하지 않고 여기서 한 번에
        # LEFT JOIN). 신청서 미제출 기업은 두 쪽 다 NULL로 온다.
        .outerjoin(ExhibitorProfile, ExhibitorProfile.org_event_role_id == OrganizationEventRole.id)
        .outerjoin(BuyerProfile, BuyerProfile.org_event_role_id == OrganizationEventRole.id)
        .where(OrganizationEventRole.event_id == event_id)
    )
    if role == "buyer":
        stmt = stmt.where(OrganizationEventRole.is_buyer.is_(True))
    elif role == "exhibitor":
        stmt = stmt.where(OrganizationEventRole.is_exhibitor.is_(True))
    if status:
        stmt = stmt.where(OrganizationEventRole.application_status == status)
    if search:
        like = f"%{search}%"
        stmt = stmt.where(or_(Organization.name_ko.ilike(like), Organization.name_en.ilike(like)))
    if jurisdiction_organizer_id is not None:
        stmt = stmt.where(
            or_(
                OrganizationEventRole.is_exhibitor.is_(True),
                OrganizationEventRole.managing_organizer_id == jurisdiction_organizer_id,
            )
        )
    return stmt


@dataclass
class OrganizationListRow:
    """참가기업 명단 한 줄 — list_organizations 전용 조인·집계 결과.

    ``role``/``org``는 원본 ORM 행(목록 필터·정렬이 이미 이걸 쓴다) 그대로 두고, 프로필·분류·
    담당자는 배치 조회로 한 번에 계산해 얹는다(N+1 금지 — 행마다 따로 쿼리하지 않는다).
    """

    role: OrganizationEventRole
    org: Organization
    exhibitor: ExhibitorProfile | None
    buyer: BuyerProfile | None
    exhibition_categories: list[str]
    interest_categories: list[str]
    org_types: list[str]
    contact_name: str | None
    contact_email: str | None
    contact_phone: str | None
    match_count: int = 0


def resolve_primary_contact(
    *,
    representative_name_ko: str | None,
    company_email: str | None,
    main_tel: str | None,
    buyer_tel: str | None,
    buyer_contact_email: str | None = None,
    attendee_first_name: str | None = None,
    attendee_last_name: str | None = None,
    attendee_email: str | None = None,
    attendee_tel: str | None = None,
    attendee_mobile: str | None = None,
    member_name: str | None = None,
    member_email: str | None = None,
    member_phone: str | None = None,
) -> tuple[str | None, str | None, str | None]:
    """담당자 표시명/이메일/전화 폴백 — 순수 함수(DB 무관), app.excel.router.export_organizations와
    이 모듈의 list_organizations가 공유하는 **단일** 규칙이다(같은 기업이 명단 화면과 엑셀에서
    다른 담당자로 보이면 안 된다).

    이름·전화는 엑셀 export가 이미 쓰던 규칙을 그대로 재사용한다: 셀러 대표자명/대표전화 → (전화는)
    바이어 기관전화 → 바이어 첫 담당자(buyer_attendees, sort_order 최소) 성명/tel/mobile.
    이메일은 셀러 회사이메일 → 바이어 자신의 신청서 등록 이메일(buyer_profiles.contact_email) →
    바이어 첫 담당자 이메일 순(엑셀은 이 중간 단계가 없었다 — 바이어 자신의 등록 이메일을 빠뜨리고
    있어 여기서 같이 보강했다. 공유 함수라 엑셀 export도 함께 좋아진다).

    ``member_*``는 최후 폴백 — 단건 등록(create_organization)이 남긴 members 행이다. 신청서(BM)를
    아직 제출하지 않은 기업은 exhibitor/buyer 프로필 자체가 없어 위 폴백이 전부 비는데, 그렇다고
    운영자가 등록 당시 입력한 담당자명·이메일·전화까지 "-"로 지워 보일 이유는 없다 — 명단 화면에
    "저장은 됐는데 보이지 않는" 유실감을 주던 버그(2026-09-12) 수정.
    """
    attendee_name = " ".join(part for part in (attendee_first_name, attendee_last_name) if part) or None
    contact_name = representative_name_ko or attendee_name or member_name
    contact_email = company_email or buyer_contact_email or attendee_email or member_email
    contact_phone = main_tel or buyer_tel or attendee_tel or attendee_mobile or member_phone
    return contact_name, contact_email, contact_phone


def _codes_by_key(db: Session, link_model, fk: str, category: str, keys: list[str]) -> dict[str, list[str]]:
    """다대다 분류 코드를 fk값(프로필/역할 id) 기준으로 묶어 반환 — 목록 화면 배치 조회 전용
    (행마다 따로 조회하지 않는다, N+1 금지). 정렬은 app.bm.service._codes_for_profile과 동일
    규칙(결정적 노출)."""
    if not keys:
        return {}
    grouped: dict[str, list[str]] = defaultdict(list)
    rows = db.execute(
        select(getattr(link_model, fk), Keyword.code)
        .join(Keyword, Keyword.id == link_model.keyword_id)
        .where(getattr(link_model, fk).in_(keys), Keyword.category == category)
    ).all()
    for key, code in rows:
        grouped[key].append(code)
    return {key: sorted(codes) for key, codes in grouped.items()}


def list_organizations(
    db: Session,
    event_id: str,
    *,
    role: str | None = None,
    status: str | None = None,
    search: str | None = None,
    limit: int | None = 20,
    offset: int = 0,
    jurisdiction_organizer_id: str | None = None,
) -> tuple[list[OrganizationListRow], int]:
    stmt = _organization_query(
        event_id, role=role, status=status, search=search, jurisdiction_organizer_id=jurisdiction_organizer_id
    )
    total = db.execute(select(func.count()).select_from(stmt.subquery())).scalar_one()
    raw_rows = db.execute(
        stmt.order_by(Organization.created_at.desc()).limit(limit).offset(offset)
    ).all()

    exhibitor_profile_ids = [ex.id for _, _, ex, _ in raw_rows if ex is not None]
    buyer_profile_ids = [by.id for _, _, _, by in raw_rows if by is not None]
    role_ids = [role_row.id for role_row, _, _, _ in raw_rows]

    exhibition_categories_by_profile = _codes_by_key(
        db, ExhibitorKeyword, "exhibitor_profile_id", "business_field", exhibitor_profile_ids
    )
    interest_categories_by_profile = _codes_by_key(
        db, BuyerInterestKeyword, "buyer_profile_id", "business_field", buyer_profile_ids
    )
    org_types_by_role = _codes_by_key(db, OrgEventRoleOrgType, "org_event_role_id", "org_type", role_ids)

    # 바이어 첫 담당자(sort_order 최소) — 담당자 연락처 폴백용 배치 조회(엑셀 export의 first_attendees와
    # 동일 패턴, 행마다 조회하지 않는다).
    first_attendees: dict[str, BuyerAttendee] = {}
    if buyer_profile_ids:
        for attendee in db.execute(
            select(BuyerAttendee)
            .where(BuyerAttendee.buyer_profile_id.in_(buyer_profile_ids))
            .order_by(BuyerAttendee.sort_order)
        ).scalars():
            first_attendees.setdefault(attendee.buyer_profile_id, attendee)

    # 단건 등록(create_organization)이 남긴 members 행 — 신청서를 아직 안 낸 기업(exhibitor/buyer
    # 프로필이 없다)의 최후 담당자 폴백(resolve_primary_contact). 조직당 첫 행(created_at 최소)만.
    organization_ids = [org.id for _, org, _, _ in raw_rows]
    first_members: dict[str, Member] = {}
    if organization_ids:
        for member in db.execute(
            select(Member)
            .where(Member.organization_id.in_(organization_ids))
            .order_by(Member.created_at)
        ).scalars():
            first_members.setdefault(member.organization_id, member)

    # 취소/거절/만료를 제외한 미팅 수. 목록과 필터 엑셀에서 같은 집계를 사용한다.
    match_counts: dict[str, int] = defaultdict(int)
    if organization_ids:
        for ex_id, by_id in db.execute(select(Meeting.exhibitor_org_id, Meeting.buyer_org_id).where(
            Meeting.event_id == event_id,
            Meeting.status.in_(["proposed", "accepted", "completed", "noshow"]),
            or_(Meeting.exhibitor_org_id.in_(organization_ids), Meeting.buyer_org_id.in_(organization_ids)),
        )):
            for org_id in {ex_id, by_id}:
                match_counts[org_id] += 1

    rows: list[OrganizationListRow] = []
    for role_row, org, exhibitor, buyer in raw_rows:
        attendee = first_attendees.get(buyer.id) if buyer is not None else None
        member = first_members.get(org.id)
        contact_name, contact_email, contact_phone = resolve_primary_contact(
            representative_name_ko=exhibitor.representative_name_ko if exhibitor else None,
            company_email=exhibitor.company_email if exhibitor else None,
            main_tel=exhibitor.main_tel if exhibitor else None,
            buyer_tel=buyer.tel if buyer else None,
            buyer_contact_email=buyer.contact_email if buyer else None,
            attendee_first_name=attendee.first_name if attendee else None,
            attendee_last_name=attendee.last_name if attendee else None,
            attendee_email=attendee.email if attendee else None,
            attendee_tel=attendee.tel if attendee else None,
            attendee_mobile=attendee.mobile if attendee else None,
            member_name=member.name if member else None,
            member_email=member.email if member else None,
            member_phone=member.phone if member else None,
        )
        rows.append(
            OrganizationListRow(
                role=role_row,
                org=org,
                exhibitor=exhibitor,
                buyer=buyer,
                exhibition_categories=exhibition_categories_by_profile.get(exhibitor.id, []) if exhibitor else [],
                interest_categories=interest_categories_by_profile.get(buyer.id, []) if buyer else [],
                org_types=org_types_by_role.get(role_row.id, []),
                contact_name=contact_name,
                contact_email=contact_email,
                contact_phone=contact_phone,
                match_count=match_counts.get(org.id, 0),
            )
        )
    return rows, total


def create_organization(
    db: Session,
    event_id: str,
    *,
    name_ko: str,
    name_en: str | None,
    role: str,
    contact_name: str | None,
    contact_email: str | None,
    contact_phone: str | None,
    created_by_organizer_id: str,
    contact_password_hash: str | None = None,
    jurisdiction_organizer_id: str | None = None,
) -> tuple[OrganizationEventRole, Organization]:
    """참가기업 단건 등록 — roster import(app.roster.import_service)와 달리 dedup 없이 항상 새
    Organization을 만든다(호출부가 명시적으로 "새 회사 하나"를 등록하는 경로라 기존 동명 회사와
    병합할 이유가 없다). ``contact_email``이 있으면 담당자(members) 1행도 함께 만든다.

    ``contact_password_hash``(선택)는 그 담당자 계정의 bcrypt 해시다 — **평문은 이 함수에 들어오지
    않는다**(라우터가 정책 검사 후 해시만 넘긴다, app.roster.router와 같은 관례). 해시가 있는데
    이메일이 없으면 저장할 곳이 없으므로 ``PasswordWithoutContactEmailError``로 막는다.

    ``jurisdiction_organizer_id``(sub 등록)가 있으면 바이어만 만들 수 있고, 새 참가의 관리·최초등록
    운영자로 그 sub를 기록한다(ADR-0012 관할 — app.roster.import_service ``_upsert_role``과 동일).
    """
    check_create_jurisdiction(role, jurisdiction_organizer_id)
    if contact_password_hash is not None and not contact_email:
        raise PasswordWithoutContactEmailError("비밀번호를 설정하려면 담당자 이메일이 필요합니다")
    # strip+lower — 로그인 검증자(app.auth.local_verify)가 lower()로 조회한다. 대문자 섞인 이메일로
    # 등록하면 그대로는 로그인이 안 되던 버그(roster import _upsert_member와 같은 규칙으로 정렬).
    if contact_email:
        contact_email = contact_email.strip().lower()

    org = Organization(name_ko=name_ko, name_en=name_en)
    db.add(org)
    db.flush()  # org.id 확보 — role/member FK가 즉시 참조

    event_role = OrganizationEventRole(
        organization_id=org.id,
        event_id=event_id,
        is_exhibitor=(role == "exhibitor"),
        is_buyer=(role == "buyer"),
        created_by_organizer_id=created_by_organizer_id,
        # sub가 만든 바이어는 그 sub 관할로 들어간다. master 등록은 종전대로 무관리(NULL).
        managing_organizer_id=jurisdiction_organizer_id,
    )
    db.add(event_role)

    if contact_email:
        db.add(Member(
            organization_id=org.id,
            name=contact_name or name_ko,
            email=contact_email,
            phone=contact_phone,
            password_hash=contact_password_hash,
        ))

    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise ContactEmailTakenError(f"이미 사용 중인 이메일입니다: {contact_email}") from exc
    db.refresh(event_role)
    db.refresh(org)
    return event_role, org


def _other_event_ids_for_organization(db: Session, organization_id: str, event_id: str) -> list[str]:
    """이 조직이 ``event_id`` 말고 role을 가진 다른 행사 id 목록(중복 없이)."""
    return list(
        db.execute(
            select(OrganizationEventRole.event_id)
            .where(
                OrganizationEventRole.organization_id == organization_id,
                OrganizationEventRole.event_id != event_id,
            )
            .distinct()
        ).scalars()
    )


def check_single_event_org(
    db: Session, organization_id: str, event_id: str, caller_organizer_id: str
) -> None:
    """담당자 비밀번호를 걸기 전 "이 조직이 여러 행사에 걸쳐 있지 않은가" 검사(P0 — 크로스이벤트
    비밀번호 탈취 방지).

    ``members.password_hash``는 행사 무관 **전역**이라, 한 조직이 이 행사와 다른 행사에 동시
    참가 중이면 이 행사 운영자가 그 담당자 비밀번호를 바꿔 다른 행사의 로그인까지 함께 바꿔버린다.
    다른 행사가 하나라도 걸려 있으면, 호출자가 그 **모든** 다른 행사에서 master가 아닌 한
    ``MultiEventOrgPasswordError``(409 MULTI_EVENT_ORG)로 막는다 — sub는 물론, 이 행사의 master도
    다른 행사엔 권한이 없으면 걸린다.
    """
    other_event_ids = _other_event_ids_for_organization(db, organization_id, event_id)
    if not other_event_ids:
        return
    master_event_ids = set(
        db.execute(
            select(EventOrganizer.event_id).where(
                EventOrganizer.organizer_id == caller_organizer_id,
                EventOrganizer.permission_level == PERMISSION_MASTER,
                EventOrganizer.event_id.in_(other_event_ids),
            )
        ).scalars()
    )
    if not set(other_event_ids) <= master_event_ids:
        raise MultiEventOrgPasswordError(
            "이 기업은 다른 행사에도 참가 중입니다 — 모든 관련 행사에 접근 권한이 있는 "
            "슈퍼관리자에게 요청하세요"
        )


def get_contact_member(db: Session, organization_id: str) -> Member | None:
    """이 기업의 담당자(members) — 조직당 첫 행(created_at 최소). 없으면 None.

    "첫 행" 규칙은 명단 화면의 담당자 폴백(``list_organizations``의 first_members)과 **같은 행**을
    가리킨다 — 화면에 보이는 담당자 이메일과 비밀번호를 거는 계정이 어긋나면 안 된다. id를 보조
    정렬키로 둬 created_at이 같은 행에서도 결정적으로 같은 행을 고른다.
    """
    return db.execute(
        select(Member)
        .where(Member.organization_id == organization_id)
        .order_by(Member.created_at, Member.id)
    ).scalars().first()


def is_operator_account(db: Session, member: Member) -> bool:
    """이 회원이 운영자 계정인가 — ``organizers.member_id``가 이 회원을 가리키는지로 판정한다.

    운영자 신원 브릿지(app.admin.guard.resolve_organizer_id)가 로그인 회원ID를 그대로
    ``organizers.member_id``에 넣으므로, 자체가입/명단 계정(회원ID = ``members.id``)이 운영자면
    여기서 걸린다. 데모 DX Korea 회원ID(mbr-*)로 만들어진 운영자 행은 members와 애초에 연결되지
    않아(이 비교에 안 걸림) 대상이 될 일도 없다.
    """
    return (
        db.execute(select(Organizer.id).where(Organizer.member_id == str(member.id))).first()
        is not None
    )


def set_contact_password(
    db: Session,
    role: OrganizationEventRole,
    password_hash: str,
    *,
    caller_organizer_id: str,
    jurisdiction_organizer_id: str | None = None,
) -> Member:
    """담당자 계정 비밀번호 설정/재설정 — 등록 이후 운영자가 다시 정해주는 경로.

    **평문은 들어오지 않는다**(라우터가 정책 검사 후 해시만 넘긴다). 순서가 중요하다: 관할 →
    크로스이벤트 검사 → 대상 존재 → 운영자 계정 거부까지 전부 통과한 다음에야 쓴다(거부 경로에서
    아무것도 안 바뀐다).

    이미 비밀번호가 있는 계정도 덮어쓴다 — 명단 업로드(기존 값 보존)와 반대인 건 의도다. 이쪽은
    "이 계정 비밀번호를 지금 이 값으로 정해달라"는 명시적 단건 지시라서다.
    """
    check_write_jurisdiction(role, jurisdiction_organizer_id)
    check_single_event_org(db, role.organization_id, role.event_id, caller_organizer_id)
    member = get_contact_member(db, role.organization_id)
    if member is None:
        raise ContactMemberNotFoundError("이 기업에는 담당자 계정이 없습니다")
    if is_operator_account(db, member):
        raise OperatorAccountPasswordError("운영자 계정의 비밀번호는 콘솔에서 바꿀 수 없습니다")
    member.password_hash = password_hash
    db.commit()
    db.refresh(member)
    return member


def count_meetings_for_organization(db: Session, event_id: str, organization_id: str) -> int:
    """이 행사에서 이 기업이 걸린 미팅 수 — exhibitor/buyer 어느 축이든(상태 무관, count_meetings_
    at_venue와 동일 이유: meetings.exhibitor_org_id/buyer_org_id는 ondelete 없는 FK)."""
    return db.execute(
        select(func.count()).select_from(Meeting).where(
            Meeting.event_id == event_id,
            or_(Meeting.exhibitor_org_id == organization_id, Meeting.buyer_org_id == organization_id),
        )
    ).scalar_one()


def delete_organization_participation(db: Session, role: OrganizationEventRole) -> None:
    """참가기업 삭제 — 이 행사의 role(및 그 아래 프로필/담당자/제품 등, CASCADE)만 지운다.

    미팅이 걸려 있으면 409(``OrganizationHasMeetingsError``) — 운영자가 먼저 정리해야 한다(venue
    삭제와 동일 원칙). role 삭제 후 이 org가 **다른 행사에서도 role이 하나도 없으면** org와 그
    members까지 함께 지운다(셀프가입 1:1 고아 방지) — 여러 행사에 걸친 org는 이 행사 role만 빠지고
    org 자체는 남는다.
    """
    meeting_count = count_meetings_for_organization(db, role.event_id, role.organization_id)
    if meeting_count:
        raise OrganizationHasMeetingsError(meeting_count)

    organization_id = role.organization_id
    db.delete(role)
    db.flush()

    remaining = db.execute(
        select(func.count()).select_from(OrganizationEventRole).where(
            OrganizationEventRole.organization_id == organization_id
        )
    ).scalar_one()
    if remaining == 0:
        org = db.get(Organization, organization_id)
        if org is not None:
            db.delete(org)
    db.commit()


def patch_profile(
    db: Session,
    role: OrganizationEventRole,
    profile_role: str,
    data: dict,
    *,
    jurisdiction_organizer_id: str | None = None,
) -> bm_schemas.BuyerProfileResponse | bm_schemas.ExhibitorProfileResponse:
    """운영자 신청서 직접 수정 — bm 서비스 그대로 재사용(별도 검증 로직 없음).

    ADR-0012 개정(2026-09-09): 기업 신청서 편집은 master+sub 공용이다. sub는 관할 기업만 쓸 수
    있으므로 읽기 관할 필터(``check_jurisdiction``)를 그대로 미러한다 — master는
    ``jurisdiction_organizer_id=None``으로 전역 통과, sub는 자기 organizer_id를 넘겨 관할 밖이면
    ``JurisdictionDeniedError``(라우터가 403)로 막는다(fail-closed).
    """
    check_jurisdiction(role, jurisdiction_organizer_id)
    if profile_role == "buyer":
        return bm_service.patch_buyer_step(db, role, data)
    return bm_service.patch_exhibitor_step(db, role, data)


def proxy_write_profile(
    db: Session,
    role: OrganizationEventRole,
    profile_role: str,
    data: dict,
    organizer_id: str,
    *,
    approve_immediately: bool,
    jurisdiction_organizer_id: str | None = None,
) -> bm_schemas.BuyerProfileResponse | bm_schemas.ExhibitorProfileResponse:
    """대리작성 — 엑셀 임포트만 되고 회원가입 안 한 기업의 프로필을 운영자가 대신 채운다.

    ADR-0012 개정(2026-09-09): master+sub 공용. sub는 관할 기업만(``check_jurisdiction`` 미러) —
    관할 검사를 **상태 검사보다 먼저** 돌려, 관할 밖 기업의 신청 상태(409 사유)를 sub에게 흘리지
    않는다(fail-closed, 정보 노출 차단).

    대리작성은 신청 의사를 대신 확정하는 동작이므로 저장과 상태 전이를 한 트랜잭션으로 묶는다.
    master가 작성하면 별도 자기 승인 단계를 만들지 않고 즉시 ``approved``로 전환해 매칭 풀에
    노출한다. sub가 작성하면 승인 권한이 없으므로 ``submitted``로 전환해 master 검토 대기열에
    넣는다. 이미 제출/승인/반려된 신청은 일반 정정 경로를 써야 하므로 409로 막는다.
    """
    check_jurisdiction(role, jurisdiction_organizer_id)
    if role.application_status != "registered":
        raise ProxyWriteBlockedError(
            f"대리작성은 미신청(registered) 상태에서만 가능합니다(현재 상태: {role.application_status!r})"
        )
    if profile_role == "buyer":
        bm_service._require_buyer(role)
        profile = bm_service._ensure_buyer(db, role)
        bm_service._apply_buyer_fields(db, profile, role, data)
    else:
        bm_service._require_exhibitor(role)
        profile = bm_service._ensure_exhibitor(db, role)
        bm_service._apply_exhibitor_fields(db, profile, role, data)
    role.proxy_written_by_organizer_id = organizer_id
    if approve_immediately:
        role.application_status = "approved"
        role.reviewed_at = datetime.now(timezone.utc)
        role.reviewed_by = organizer_id
        role.review_note = "슈퍼관리자 대리작성 자동 승인"
    else:
        role.application_status = "submitted"
    db.commit()
    db.refresh(role)
    if profile_role == "buyer":
        return bm_service.get_buyer_profile(db, role)
    return bm_service.get_exhibitor_profile(db, role)


def set_unavailable_slots(
    db: Session, role: OrganizationEventRole, slots: list[str]
) -> bm_schemas.ExhibitorProfileResponse:
    """미팅 불가 슬롯 운영자 관리 — 기업 측 쓰기는 app.bm에서 422로 차단, 여기가 유일한 쓰기 경로."""
    bm_service._require_exhibitor(role)
    profile = bm_service._ensure_exhibitor(db, role)
    profile.unavailable_meeting_slots = slots
    db.commit()
    db.refresh(role)
    return bm_service.get_exhibitor_profile(db, role)


def _has_any_meeting(db: Session, event_id: str, organization_id: str) -> bool:
    return (
        db.execute(
            select(Meeting.id).where(
                Meeting.event_id == event_id,
                or_(Meeting.exhibitor_org_id == organization_id, Meeting.buyer_org_id == organization_id),
            )
        ).first()
        is not None
    )


def set_organization_role(db: Session, role: OrganizationEventRole, new_role: str) -> OrganizationEventRole:
    """참가 기업의 역할을 전환한다(바이어<->참가사). 이미 미팅(어느 축이든)이 있으면 막는다 —
    meetings.exhibitor_org_id/buyer_org_id는 역할이 바뀌어도 그대로 남아 배치가 어긋나기 때문
    (FE 콘솔도 동일 규칙). application_status·기존 buyer_profile/exhibitor_profile 행은 건드리지
    않는다 — 프로필-역할 정합은 이 함수 책임 밖이다(한계, 이후 PATCH profile은 RoleMismatchError로
    잡아낸다)."""
    if _has_any_meeting(db, role.event_id, role.organization_id):
        raise RoleChangeBlockedError(
            "이 기업은 이미 미팅이 있어 역할을 바꿀 수 없습니다 — 미팅을 먼저 정리하세요"
        )
    role.is_exhibitor = new_role == "exhibitor"
    role.is_buyer = new_role == "buyer"
    db.commit()
    db.refresh(role)
    return role


def review_organization_application(
    db: Session,
    role: OrganizationEventRole,
    decision: str,
    reviewer_organizer_id: str,
    note: str | None,
) -> OrganizationEventRole:
    """신청서 검토 전이(OP-003) — submitted → {approved, rejected, changes_requested}.

    submitted가 아니면(이미 검토됨/아직 미제출) ReviewTransitionBlockedError(409) — 보수적으로
    막는다: 재검토·이중승인 같은 애매한 경로를 열어두지 않는다. 통과하면 상태 + 검토 감사
    필드(reviewed_at/by/note)를 한 트랜잭션으로 갱신한다.
    """
    if role.application_status != "submitted":
        raise ReviewTransitionBlockedError(
            f"제출(submitted) 상태만 검토할 수 있습니다(현재 상태: {role.application_status!r})"
        )
    role.application_status = decision
    role.reviewed_at = datetime.now(timezone.utc)
    role.reviewed_by = reviewer_organizer_id
    role.review_note = note
    db.commit()
    db.refresh(role)
    return role


# =============================================================================
# 운영자(Organizer) 관리 — 서브어드민 부여/회수/목록(슈퍼어드민 전용, #OP 역할 관리)
# =============================================================================
def find_member_for_grant(db: Session, *, email: str | None = None, member_id: str | None = None) -> Member | None:
    """부여 대상 회원 조회 — 이메일은 대소문자 무시(로그인 검증자도 소문자로 접어 비교한다), member_id는
    members.id(UUID)만. 비-UUID 회원키(데모 ``mbr-*``)는 members 조회 전에 걸러 22P02를 피한다."""
    if email is not None and email.strip():
        return db.execute(
            select(Member)
            .where(func.lower(Member.email) == email.strip().lower())
            .order_by(Member.created_at, Member.id)
        ).scalars().first()
    if member_id is not None and _is_uuid(member_id.strip()):
        return db.get(Member, member_id.strip())
    return None


def grant_sub_organizer(
    db: Session,
    event_id: str,
    permission_level: str,
    *,
    email: str | None = None,
    member_id: str | None = None,
) -> EventOrganizer:
    """가입된 회원(이메일 또는 members.id)에게 이 행사의 sub 권한을 부여한다.

    회원이 없으면 ``MemberNotFoundError``(404) — organizers 행을 만들지 않는다. 이미 이 행사에
    배정돼 있으면(master든 sub든) 409 — 등급 변경은 이 경로 책임이 아니다(기존 master를 몰래 건드리지
    않기 위한 보수적 선택). 운영자 신원 앵커는 로그인이 쓰는 회원ID(members.id)로 잇는다
    (``resolve_organizer_id`` — 로그인 분기 ``_is_registered_operator``·``/api/admin/me``가 같은 키를 본다).
    """
    member = find_member_for_grant(db, email=email, member_id=member_id)
    if member is None:
        raise MemberNotFoundError("해당 이메일로 가입한 회원을 찾을 수 없습니다")
    organizer_id = resolve_organizer_id(db, str(member.id))
    existing = db.execute(
        select(EventOrganizer).where(
            EventOrganizer.event_id == event_id, EventOrganizer.organizer_id == organizer_id
        )
    ).scalar_one_or_none()
    if existing is not None:
        raise OrganizerAlreadyAssignedError(
            f"이미 이 행사의 운영자입니다(현재 등급: {existing.permission_level!r})"
        )
    eo = EventOrganizer(event_id=event_id, organizer_id=organizer_id, permission_level=permission_level)
    db.add(eo)
    db.commit()
    db.refresh(eo)
    return eo


def remove_organizer(db: Session, event_id: str, event_organizer_id: str) -> None:
    """운영자 배정을 회수한다 — sub만 가능. master 배정은 API로 절대 회수할 수 없다(부여도 회수도
    master는 DB 직접 조작 전용 — 마지막 슈퍼어드민을 지워 콘솔이 잠기는 사고 방지).

    ``event_organizer_id``는 ``event_organizers.id``(이 행사에서의 배정 레코드) — FE 계약(GET
    목록이 돌려준 ``AdminOrganizer.id``를 그대로 되돌려줌)과 맞춘다. ``organizers.id``(계정 전역
    신원)가 아니다 — 같은 사람이 다른 행사에서 가진 배정은 건드리지 않는다."""
    existing = db.execute(
        select(EventOrganizer).where(
            EventOrganizer.id == event_organizer_id, EventOrganizer.event_id == event_id
        )
    ).scalar_one_or_none()
    if existing is None:
        raise OrganizerNotAssignedError("이 행사에 배정된 운영자가 아닙니다")
    if existing.permission_level == PERMISSION_MASTER:
        raise MasterRemovalBlockedError("슈퍼어드민(master) 배정은 API로 회수할 수 없습니다")
    db.delete(existing)
    db.commit()


def list_event_organizers(
    db: Session, event_id: str
) -> list[tuple[EventOrganizer, Organizer, Member | None]]:
    """이 행사의 운영자 배정 + 표시용 회원 행(없으면 None).

    회원 조인은 organizers.member_id(text) ↔ members.id(uuid)라 캐스트해 LEFT JOIN한다 — 데모 회원키
    (``mbr-*``)처럼 members에 없는 운영자도 목록에서 빠지지 않는다.
    """
    rows = db.execute(
        select(EventOrganizer, Organizer, Member)
        .join(Organizer, Organizer.id == EventOrganizer.organizer_id)
        .outerjoin(Member, cast(Member.id, Text) == Organizer.member_id)
        .where(EventOrganizer.event_id == event_id)
        .order_by(EventOrganizer.permission_level, EventOrganizer.created_at, EventOrganizer.id)
    ).all()
    return [(eo, organizer, member) for eo, organizer, member in rows]


def get_event_organizer_display(
    db: Session, event_organizer: EventOrganizer
) -> tuple[Organizer, Member | None]:
    """방금 만든 배정 한 건의 표시용 (운영자, 회원) — 부여 응답이 목록과 같은 이름·이메일을 싣게 한다."""
    organizer = db.get(Organizer, event_organizer.organizer_id)
    member_key = organizer.member_id if organizer is not None else None
    member = db.get(Member, member_key) if member_key and _is_uuid(member_key) else None
    return organizer, member


def organizer_display_identity(organizer: Organizer, member: Member | None) -> tuple[str, str]:
    """운영자 목록의 (이름, 이메일) — **회원 행 → organizers 행** 순. UUID·자리표시자는 절대 내보내지 않는다.

    ``resolve_organizer_id``가 get-or-create할 때 넣는 ``운영자 {member_id}`` / ``{member_id}@organizer.
    nabi.local``은 사람이 쓴 값이 아니라 FK 앵커용 자리표시자다 — 화면에 그대로 나가면 회원 UUID가
    이름·이메일 칸에 찍힌다. 알 수 없으면 이름은 "이름 미등록", 이메일은 빈 문자열(화면이 "-" 처리).
    """
    placeholder_name = f"운영자 {organizer.member_id}" if organizer.member_id else None
    organizer_name = _blank_to_none(organizer.name)
    if organizer_name is not None and organizer_name == placeholder_name:
        organizer_name = None
    organizer_email = _blank_to_none(organizer.email)
    if organizer_email is not None and organizer_email.endswith(_PLACEHOLDER_EMAIL_SUFFIX):
        organizer_email = None
    name = _blank_to_none(member.name if member is not None else None) or organizer_name or "이름 미등록"
    email = _blank_to_none(member.email if member is not None else None) or organizer_email or ""
    return name, email


def _blank_to_none(value: str | None) -> str | None:
    """빈 문자열·공백만인 값은 없는 값으로 접는다 — 화면이 아이콘만 남은 빈 줄을 그리지 않도록."""
    if value is None:
        return None
    cleaned = value.strip()
    return cleaned or None


def build_admin_me(db: Session, *, member_id: str, organizer_id: str) -> dict:
    """로그인한 운영자 본인의 표시용 신원 + 배정된 행사별 권한등급(``GET /api/admin/me``).

    신원의 우선순위는 **members 행 → organizers 행**이다. ``organizers``는 인증 신원과 FK를 잇는
    앵커라 값이 자리표시자일 수 있고(``guard.resolve_organizer_id``가 get-or-create할 때 넣는
    ``운영자 {member_id}`` / ``{member_id}@organizer.nabi.local``), ``members``에는 사람이 실제로
    쓰는 이름·이메일·연락처와 소속 조직이 있다. 같은 사람의 값이 갈라졌다면 사람이 관리하는 쪽이 맞다.

    ⚠ ``members.id``는 uuid 컬럼이라 비-UUID 회원키(데모 토큰의 ``mbr-org-01`` 등)를 그대로 넣으면
    Postgres가 22P02로 트랜잭션을 깨서 500이 난다 — 조회 **전에** UUID 여부를 판별한다
    (``app.auth.principal._demo_principal``·``app.discover.service._resolve_identity``와 같은 주의).
    비-UUID면 members를 아예 조회하지 않고 organizers 값만 쓴다.

    자리표시자 이메일은 그대로 흘리지 않는다 — 사이드바에 가짜 주소를 그리느니 비우는 게 낫다.
    """
    organizer = db.get(Organizer, organizer_id)
    member = db.get(Member, member_id) if _is_uuid(member_id) else None

    organizer_email = _blank_to_none(organizer.email if organizer is not None else None)
    if organizer_email is not None and organizer_email.endswith(_PLACEHOLDER_EMAIL_SUFFIX):
        organizer_email = None

    affiliation = None
    if member is not None and member.organization_id is not None:
        org = db.get(Organization, member.organization_id)
        if org is not None:
            affiliation = _blank_to_none(discover_service.display_name(org))

    rows = db.execute(
        select(EventOrganizer.event_id, EventOrganizer.permission_level)
        .where(EventOrganizer.organizer_id == organizer_id)
        .order_by(EventOrganizer.created_at, EventOrganizer.id)
    ).all()

    return {
        "member_id": member_id,
        "organizer_id": organizer_id,
        "name": _blank_to_none(member.name if member is not None else None)
        or _blank_to_none(organizer.name if organizer is not None else None),
        "email": _blank_to_none(member.email if member is not None else None) or organizer_email,
        "phone": _blank_to_none(member.phone if member is not None else None),
        "affiliation": affiliation,
        "events": [{"event_id": str(event_id), "permission_level": level} for event_id, level in rows],
    }


#: ``guard.resolve_organizer_id``가 자동 생성 시 넣는 자리표시자 이메일 도메인 — 표시에서 걸러낸다.
_PLACEHOLDER_EMAIL_SUFFIX = "@organizer.nabi.local"


def _is_uuid(value: str) -> bool:
    try:
        uuid.UUID(str(value))
        return True
    except (ValueError, AttributeError, TypeError):
        return False


# =============================================================================
# 미팅(Schedule Table) — 목록/운영자 취소
# =============================================================================
def _scope_to_managed_buyer_meetings(stmt, jurisdiction_organizer_id: str):
    """미팅 질의를 sub 관할로 좁힌다 — 자기가 관리하는 바이어가 낀 미팅만(ADR-0012).

    관할 판정은 바이어측 ``organization_event_roles.managing_organizer_id``다. 국내기업(참가사)은
    공유 열람 풀이지만, 참가사의 미팅 상대는 다른 sub의 바이어일 수 있으므로 미팅은 **바이어 축**으로만
    거른다. 미팅 목록·운영 대시보드·기업 디테일 일정이 모두 이 한 규칙을 쓴다(판정이 갈라지지 않게).
    """
    buyer_role = aliased(OrganizationEventRole)
    return stmt.join(
        buyer_role,
        and_(buyer_role.organization_id == Meeting.buyer_org_id, buyer_role.event_id == Meeting.event_id),
    ).where(buyer_role.managing_organizer_id == jurisdiction_organizer_id)


def list_meetings(
    db: Session,
    event_id: str,
    *,
    status: str | None = None,
    limit: int = 20,
    offset: int = 0,
    jurisdiction_organizer_id: str | None = None,
) -> tuple[list[tuple[Meeting, str | None, str | None]], int]:
    """미팅 목록 — 장소 표기를 LEFT JOIN으로 함께 가져온다(행마다 다시 조회하지 않는다).

    Returns:
        ((미팅, venue_type, venue_label) 목록, 전체 건수). 장소 미지정 미팅은 두 값이 None.
    """
    stmt = (
        select(Meeting, MeetingVenue.venue_type, MeetingVenue.label)
        .select_from(Meeting)
        .outerjoin(MeetingVenue, MeetingVenue.id == Meeting.venue_id)
        .where(Meeting.event_id == event_id)
    )
    if status:
        stmt = stmt.where(Meeting.status == status)
    if jurisdiction_organizer_id is not None:
        # sub 관할 = 자기가 관리하는 바이어가 낀 미팅만(바이어측 role.managing_organizer_id로 판정).
        stmt = _scope_to_managed_buyer_meetings(stmt, jurisdiction_organizer_id)
    total = db.execute(select(func.count()).select_from(stmt.subquery())).scalar_one()
    rows = db.execute(
        stmt.order_by(Meeting.created_at.desc()).limit(limit).offset(offset)
    ).all()
    return [(row[0], row[1], row[2]) for row in rows], total


class MeetingNotCancellableError(Exception):
    """이미 끝난 미팅(rejected/cancelled/completed)을 취소하려는 시도 — 라우터가 409."""


def cancel_meeting(
    db: Session,
    event_id: str,
    meeting_id: str,
    *,
    reason_code: str | None = None,
    reason_text: str | None = None,
) -> Meeting:
    """운영자 취소 — **살아있는 미팅만**(proposed/accepted).

    운영자는 어떤 출처의 미팅이든 취소할 수 있다(도메인 규칙, CONTEXT.md 거부 vs 취소). 하지만
    "어떤 상태든"은 아니다 — 예전엔 completed/rejected 미팅도 cancelled로 덮어써서, 이미 진행되고
    회의록까지 쓴 미팅이 취소로 둔갑할 수 있었다. 상태 전이표(``matching.meeting_state``)를 통과
    시켜 참가자 경로와 같은 규칙을 쓴다.

    ``cancelled_by='organizer'``, ``cancelled_by_org_id=NULL`` — 운영자는 org가 아니다.
    """
    meeting = db.get(Meeting, meeting_id)
    if meeting is None or str(meeting.event_id) != str(event_id):
        raise MeetingNotFoundError("미팅을 찾을 수 없습니다")
    try:
        assert_transition(meeting.status, "cancelled")
    except IllegalTransitionError as exc:
        raise MeetingNotCancellableError(str(exc)) from exc

    # 위 검사는 락 없이 읽은 값이다 — 그 사이 참가자가 이 미팅을 accept/reject/cancel 했을 수
    # 있다(app.meetings.service의 동시성 결함과 같은 클래스). 행을 FOR UPDATE로 재로드해 락
    # 안에서 전이를 다시 검증한다.
    db.refresh(meeting, with_for_update=True)
    try:
        assert_transition(meeting.status, "cancelled")
    except IllegalTransitionError as exc:
        raise MeetingNotCancellableError(str(exc)) from exc

    now = datetime.now(timezone.utc)
    meeting.status = "cancelled"
    meeting.awaiting_org_id = None
    meeting.cancelled_at = now
    meeting.cancelled_by = "organizer"
    meeting.cancelled_by_org_id = None
    meeting.cancelled_reason_code = reason_code
    meeting.cancelled_reason_text = reason_text
    meeting.updated_at = now
    db.commit()
    db.refresh(meeting)
    return meeting


# =============================================================================
# 통역사 배정(#OP) — 참가기업별 통역사
# =============================================================================
def assigned_organization_ids(db: Session, interpreter_id: str) -> list[str]:
    ids = db.execute(
        select(InterpreterAssignment.organization_id).where(
            InterpreterAssignment.interpreter_id == interpreter_id
        )
    ).scalars().all()
    return [str(x) for x in ids]


def list_interpreters(db: Session, event_id: str) -> list[tuple[Interpreter, list[str]]]:
    interpreters = db.execute(
        select(Interpreter).where(Interpreter.event_id == event_id).order_by(Interpreter.created_at)
    ).scalars().all()
    return [(it, assigned_organization_ids(db, it.id)) for it in interpreters]


def create_interpreter(db: Session, event_id: str, data: dict) -> Interpreter:
    interpreter = Interpreter(event_id=event_id, **data)
    db.add(interpreter)
    db.commit()
    db.refresh(interpreter)
    return interpreter


def get_interpreter(db: Session, event_id: str, interpreter_id: str) -> Interpreter | None:
    interpreter = db.get(Interpreter, interpreter_id)
    if interpreter is None or str(interpreter.event_id) != str(event_id):
        return None
    return interpreter


def update_interpreter(db: Session, interpreter: Interpreter, data: dict) -> Interpreter:
    for key, value in data.items():
        setattr(interpreter, key, value)
    db.commit()
    db.refresh(interpreter)
    return interpreter


def delete_interpreter(db: Session, interpreter: Interpreter) -> None:
    db.delete(interpreter)
    db.commit()


def assign_interpreter(
    db: Session, event_id: str, interpreter_id: str, organization_id: str
) -> InterpreterAssignment:
    """참가기업 ↔ 통역사 배정 — unique(event, organization)라 기존 배정이 있으면 갈아끼운다(upsert)."""
    if get_role_for_org(db, event_id, organization_id) is None:
        raise OrganizationNotFoundError("이 행사에 소속된 기업이 아닙니다")
    existing = db.execute(
        select(InterpreterAssignment).where(
            InterpreterAssignment.event_id == event_id,
            InterpreterAssignment.organization_id == organization_id,
        )
    ).scalar_one_or_none()
    if existing is not None:
        existing.interpreter_id = interpreter_id
        db.commit()
        db.refresh(existing)
        return existing
    assignment = InterpreterAssignment(
        event_id=event_id, organization_id=organization_id, interpreter_id=interpreter_id
    )
    db.add(assignment)
    db.commit()
    db.refresh(assignment)
    return assignment


def unassign_interpreter(db: Session, event_id: str, interpreter_id: str, organization_id: str) -> bool:
    existing = db.execute(
        select(InterpreterAssignment).where(
            InterpreterAssignment.event_id == event_id,
            InterpreterAssignment.interpreter_id == interpreter_id,
            InterpreterAssignment.organization_id == organization_id,
        )
    ).scalar_one_or_none()
    if existing is None:
        return False
    db.delete(existing)
    db.commit()
    return True


# =============================================================================
# 미팅 장소(venue) 프로비저닝(#OP) — 비즈매칭존 테이블 / 비즈니스룸
# =============================================================================
#: 운영자가 손으로 만드는 장소 종류. **booth는 여기 없다** — 참가사 부스는 미팅 신청 시점에
#: ``meetings.service.get_or_create_booth_venue``가 (행사, 'booth', "7홀 A-12") 자연키로 자동
#: 생성한다. 그 행을 콘솔에서 만들거나 이름을 바꾸면 다음 신청이 같은 라벨로 또 만들어 장소가
#: 둘로 갈라지므로, booth는 조회/수정/삭제 대상에서 통째로 뺀다.
MANAGEABLE_VENUE_TYPES: tuple[str, ...] = ("zone_table", "business_room")


def _require_manageable(venue: MeetingVenue) -> None:
    if venue.venue_type not in MANAGEABLE_VENUE_TYPES:
        raise VenueNotManageableError(
            "부스 장소는 미팅 신청 시 자동 생성되므로 콘솔에서 수정·삭제할 수 없습니다"
        )


def list_venues(db: Session, event_id: str) -> list[MeetingVenue]:
    """행사의 운영 장소 목록 — **라벨 순**.

    정렬이 곧 배정 순서다: ``meetings.service._resolve_venue``가 후보 중 비어 있는 첫 장소를
    고르므로, 콘솔이 보여주는 순서와 실제 배정 순서가 같아야 운영자가 "T-01부터 찬다"를 눈으로
    확인할 수 있다.
    """
    return list(
        db.execute(
            select(MeetingVenue)
            .where(
                MeetingVenue.event_id == event_id,
                MeetingVenue.venue_type.in_(MANAGEABLE_VENUE_TYPES),
            )
            .order_by(MeetingVenue.label)
        ).scalars().all()
    )


def get_venue(db: Session, event_id: str, venue_id: str) -> MeetingVenue | None:
    """이 행사의 장소 한 건. 타 행사 것이거나 id 형식이 틀리면 None(라우터가 404).

    uuid 형식을 먼저 보는 건 ``meeting_venues.id``가 uuid 컬럼이라 임의 문자열을 비교에 넣으면
    Postgres가 22P02로 트랜잭션을 깨서 정상 404가 500이 되기 때문이다.
    """
    try:
        uuid.UUID(str(venue_id))
    except (ValueError, AttributeError, TypeError):
        return None
    venue = db.get(MeetingVenue, venue_id)
    if venue is None or str(venue.event_id) != str(event_id):
        return None
    return venue


def _label_taken(db: Session, event_id: str, venue_type: str, label: str, exclude_id: str | None) -> bool:
    q = select(MeetingVenue.id).where(
        MeetingVenue.event_id == event_id,
        MeetingVenue.venue_type == venue_type,
        MeetingVenue.label == label,
    )
    if exclude_id is not None:
        q = q.where(MeetingVenue.id != exclude_id)
    return db.execute(q.limit(1)).scalar_one_or_none() is not None


def create_venue(db: Session, event_id: str, venue_type: str, label: str) -> MeetingVenue:
    """장소 한 건 추가. 같은 (행사, 종류, 라벨)이 이미 있으면 409.

    선검사 + IntegrityError 이중 방어다 — 선검사만으로는 동시 생성 두 건이 둘 다 통과해 DB
    유니크에 튕기면서 500이 되고, IntegrityError만으로는 어느 제약이 걸렸는지 메시지가 거칠다.
    """
    if _label_taken(db, event_id, venue_type, label, exclude_id=None):
        raise VenueLabelTakenError(f"이미 같은 이름의 장소가 있습니다: {label}")
    venue = MeetingVenue(event_id=event_id, venue_type=venue_type, label=label)
    db.add(venue)
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise VenueLabelTakenError(f"이미 같은 이름의 장소가 있습니다: {label}") from exc
    db.refresh(venue)
    return venue


def update_venue(db: Session, venue: MeetingVenue, label: str) -> MeetingVenue:
    """라벨 변경. 종류(venue_type)는 바꾸지 않는다 — 종류가 바뀌면 그건 다른 장소다."""
    _require_manageable(venue)
    if label == venue.label:
        return venue
    if _label_taken(db, str(venue.event_id), venue.venue_type, label, exclude_id=str(venue.id)):
        raise VenueLabelTakenError(f"이미 같은 이름의 장소가 있습니다: {label}")
    venue.label = label
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise VenueLabelTakenError(f"이미 같은 이름의 장소가 있습니다: {label}") from exc
    db.refresh(venue)
    return venue


def meeting_counts_by_venue(db: Session, venue_ids: list[str]) -> dict[str, int]:
    """장소 id들 → 참조 미팅 수. 목록에서 장소마다 세지 않으려고 **한 번에** 집계한다.

    참조가 0인 장소는 결과에 없다(GROUP BY의 자연스러운 결과) — 호출부가 ``.get(id, 0)``으로 받는다.
    """
    if not venue_ids:
        return {}
    rows = db.execute(
        select(Meeting.venue_id, func.count())
        .where(Meeting.venue_id.in_(venue_ids))
        .group_by(Meeting.venue_id)
    ).all()
    return {str(venue_id): count for venue_id, count in rows}


def count_meetings_at_venue(db: Session, venue_id: str) -> int:
    """이 장소를 참조하는 미팅 수 — 상태 무관.

    취소·거절된 미팅도 센다. ``meetings.venue_id`` FK에 ``ondelete``가 없어(RESTRICT) 종료된
    미팅이라도 행이 남아 있는 한 DB가 삭제를 막기 때문이다 — 여기서 상태로 걸러 "지울 수 있다"고
    답하면 그 다음 DELETE가 500으로 끝난다.
    """
    return db.execute(
        select(func.count()).select_from(Meeting).where(Meeting.venue_id == venue_id)
    ).scalar_one()


def delete_venue(db: Session, venue: MeetingVenue) -> None:
    """장소 삭제 — 참조 미팅이 있으면 409(``VenueInUseError``).

    선검사를 두는 이유가 이 함수의 존재 이유다: ``meetings.venue_id``는 ``ondelete`` 없는 FK라
    참조가 있으면 DB가 IntegrityError를 던지고, 그대로 두면 운영자가 "삭제 실패" 대신 500을
    본다. 미팅을 CASCADE로 함께 지우거나 venue_id를 NULL로 끊는 선택지는 없다 — 확정된 미팅의
    장소는 기록이지 정리 대상이 아니다.
    """
    _require_manageable(venue)
    in_use = count_meetings_at_venue(db, str(venue.id))
    if in_use:
        raise VenueInUseError(in_use)
    db.delete(venue)
    try:
        db.commit()
    except IntegrityError as exc:
        # 선검사와 커밋 사이에 미팅이 새로 잡힌 레이스 — 실제 참조 수를 다시 세어 알린다.
        db.rollback()
        raise VenueInUseError(count_meetings_at_venue(db, str(venue.id))) from exc


# =============================================================================
# OP-001 운영 대시보드(#53) — 원시 사실만 추린다. 비율·상태묶음·시간대 버킷 계산은 여기서 하지
# 않는다 — frontend/lib/organizer/ops-metrics.ts의 이미 테스트된 순수 집계(aggregateOpsMetrics)가
# 그대로 소비한다(getHomeDashboard가 raw 미팅을 내려주고 FE가 집계하는 것과 동일 원칙).
#
# sub 관할 스코프(2026-09-17, 발주사 체크리스트 "서브/어드민 매칭 현황"): ``jurisdiction_organizer_id``를
# 주면 **자기가 관리하는 바이어의 매칭 활동**만 추린다 — 참가자=관할 바이어 역할 행, 미팅=관할 바이어가
# 낀 미팅, 리뷰=그 미팅에 달린 것. 국내기업(참가사)은 열람 풀이지만 대시보드 수치는 "내 바이어" 기준이라
# 참가사 축(참가사 참가자·슬롯 사용률·0건 참가사)은 싣지 않는다. master는 None으로 행사 전역 그대로.
# =============================================================================
def list_registrant_role_counts(db: Session, event_id: str) -> tuple[int, int]:
    """명단 적재 규모(registrants 건수) — 역할별. role_hint='both'는 양쪽에 잡힌다(roster.import_service.
    _role_flags와 동일 원칙 — "명단만 vs 실제 참여"의 분모)."""
    exhibitor = db.execute(
        select(func.count()).select_from(Registrant).where(
            Registrant.event_id == event_id, Registrant.role_hint.in_(("exhibitor", "both"))
        )
    ).scalar_one()
    buyer = db.execute(
        select(func.count()).select_from(Registrant).where(
            Registrant.event_id == event_id, Registrant.role_hint.in_(("buyer", "both"))
        )
    ).scalar_one()
    return exhibitor, buyer


def count_managed_buyers(db: Session, event_id: str, organizer_id: str) -> int:
    """sub 대시보드의 "등록" 규모 — 이 운영자가 현재 관리하는 바이어 참가(역할 행) 수(승인 상태 무관).

    master의 ``list_registrant_role_counts``(명단 스냅샷 registrants 건수)와 분모가 다른 이유:
    registrants에는 운영자 링크가 없고, 무역관 바이어는 스냅샷 밖 직접등록(ADR-0013)이라 registrant가
    아예 없을 수 있다. 관할의 진실원천은 역할 행의 ``managing_organizer_id``(ADR-0012)이므로 여기서
    센다 — sub가 참가기업 관리 바이어 탭에서 보는 행 수와 같은 모집단이다.
    """
    return db.execute(
        select(func.count()).select_from(OrganizationEventRole).where(
            OrganizationEventRole.event_id == event_id,
            OrganizationEventRole.is_buyer.is_(True),
            OrganizationEventRole.managing_organizer_id == organizer_id,
        )
    ).scalar_one()


def list_ops_participants(
    db: Session, event_id: str, *, jurisdiction_organizer_id: str | None = None
) -> list[OrganizationEventRole]:
    """비즈매칭에 참여한 기업 원본(역할 플래그+승인 상태) — approved 판정(ADR-0009)은 FE가 한다.

    sub(``jurisdiction_organizer_id``)면 자기가 관리하는 바이어 역할 행만 — 참가사 축은 라우터가
    출력에서 뺀다(``_ops_participants_out``, 이중역할 기업의 참가사 행 포함).
    """
    stmt = select(OrganizationEventRole).where(OrganizationEventRole.event_id == event_id)
    if jurisdiction_organizer_id is not None:
        stmt = stmt.where(
            OrganizationEventRole.is_buyer.is_(True),
            OrganizationEventRole.managing_organizer_id == jurisdiction_organizer_id,
        )
    return list(db.execute(stmt).scalars().all())


def list_ops_meetings(
    db: Session, event_id: str, *, jurisdiction_organizer_id: str | None = None
) -> list[Meeting]:
    stmt = select(Meeting).where(Meeting.event_id == event_id)
    if jurisdiction_organizer_id is not None:
        stmt = _scope_to_managed_buyer_meetings(stmt, jurisdiction_organizer_id)
    return list(db.execute(stmt).scalars().all())


def list_ops_reviews(
    db: Session, event_id: str, *, jurisdiction_organizer_id: str | None = None
) -> list[PostMeetingReview]:
    """completed 필터 없이 이 행사의 리뷰 전부 — 완료/노쇼 판정은 FE 집계가 미팅 상태와 조인해서 한다.

    sub면 관할 미팅(관리 바이어가 낀 미팅)에 달린 리뷰만 — 양측(참가사·바이어) 리뷰 모두 그 미팅의
    사실이라 함께 싣는다(후기 작성률 분모가 미팅×2이기 때문).
    """
    stmt = (
        select(PostMeetingReview)
        .join(Meeting, Meeting.id == PostMeetingReview.meeting_id)
        .where(Meeting.event_id == event_id)
    )
    if jurisdiction_organizer_id is not None:
        stmt = _scope_to_managed_buyer_meetings(stmt, jurisdiction_organizer_id)
    return list(db.execute(stmt).scalars().all())


def list_saturation_runs(db: Session, event_id: str) -> list[SaturationBatchRun]:
    return list(
        db.execute(
            select(SaturationBatchRun)
            .where(SaturationBatchRun.event_id == event_id)
            .order_by(SaturationBatchRun.run_number)
        )
        .scalars()
        .all()
    )


def compute_event_days(event: Event) -> int:
    """행사 진행 일수 — exhibition_start/end에서 파생(하드코딩 금지, ops-metrics-mock.ts와 동일
    원칙). 둘 중 하나라도 미정이면 0(슬롯 총량 파생 쪽이 0 total로 방어하게 둔다)."""
    if event.exhibition_start is None or event.exhibition_end is None:
        return 0
    return (event.exhibition_end - event.exhibition_start).days + 1


# =============================================================================
# OP-005 배정 스케줄 읽기(F-OP-005 Phase 6) — 배정 콘솔 그리드가 그대로 쓸 수 있게 조합한다. 기업
# 카드 조립은 ``app.discover.service``의 이미 검증된 프로젝션(``_load_profiles``/``_project``/
# ``_roles_of``)을 그대로 재사용한다(탐색과 동일한 "무엇을 공개하나" 규칙, 별도 매핑을 새로 만들지
# 않는다) — 다만 승인·가시성 필터는 걸지 않는다: 운영자 강제배정은 미승인 기업도 대상이 될 수 있다
# ("슈퍼관리자 자유도 최대", app.matching.assignment_service 모듈 docstring).
# =============================================================================
_WEEKDAY_KO = ("월", "화", "수", "목", "금", "토", "일")  # date.weekday(): 월=0 ... 일=6


def list_matching_org_roles(
    db: Session, event_id: str, *, organization_ids: set[str] | None = None
) -> list[tuple[OrganizationEventRole, Organization]]:
    """이 행사의 참가 역할 전부 — 등록순(비즈매칭 신청순 tie-break의 단일 진실원천, created_at
    오름차순). 승인 상태·역할 선언 여부로 거르지 않는다(운영자는 전부 본다).

    ``organization_ids``를 주면 그 기업들만(OP-003 기업 디테일 일정 — 본 기업 + 미팅 상대만 싣는다).
    """
    stmt = (
        select(OrganizationEventRole, Organization)
        .join(Organization, Organization.id == OrganizationEventRole.organization_id)
        .where(OrganizationEventRole.event_id == event_id)
    )
    if organization_ids is not None:
        if not organization_ids:
            return []
        stmt = stmt.where(OrganizationEventRole.organization_id.in_(sorted(organization_ids)))
    rows = db.execute(stmt.order_by(OrganizationEventRole.created_at, OrganizationEventRole.id)).all()
    return list(rows)


def matching_roster_cards(
    db: Session,
    role_rows: list[tuple[OrganizationEventRole, Organization]],
    *,
    jurisdiction_organizer_id: str | None = None,
) -> tuple[list[dict], list[dict], dict[str, int]]:
    """(참가사 카드들, 바이어 카드들, org_id→등록순) — discover 프로젝션 재사용, 승인·가시성 필터
    없음. 카드 dict는 ``app.discover.schemas.DiscoverOrgOut``과 필드 단위로 일치한다(discover.
    _project가 만드는 그대로) — 라우터가 그 스키마로 그대로 검증한다.

    sub(``jurisdiction_organizer_id``)면 바이어 카드는 자기가 관리하는 바이어만 싣는다 — 참가사
    카드는 공유 열람 풀이라 그대로(이중역할 기업도 참가사 카드는 나오고 바이어 카드만 빠진다).
    """
    index = discover_service._load_profiles(db, [r for r, _ in role_rows], locale="ko")
    exhibitors: list[dict] = []
    buyers: list[dict] = []
    application_order: dict[str, int] = {}
    for i, (role_row, org) in enumerate(role_rows, start=1):
        application_order[str(role_row.organization_id)] = i
        for role in discover_service._roles_of(role_row):
            if (
                role == "buyer"
                and jurisdiction_organizer_id is not None
                and role_row.managing_organizer_id != jurisdiction_organizer_id
            ):
                continue
            card = discover_service._project(role_row, org, role, index, locale="ko")
            (exhibitors if role == "exhibitor" else buyers).append(card)
    return exhibitors, buyers, application_order


def list_assignment_meetings(
    db: Session,
    event_id: str,
    *,
    organization_id: str | None = None,
    jurisdiction_organizer_id: str | None = None,
) -> list[tuple[Meeting, str | None]]:
    """이 행사의 미팅 전부(상태 무관) + 장소 라벨. 시각 미정(scheduled_start NULL) 미팅은 그리드
    칸에 놓을 수 없어 뺀다(현재 도메인상 사실상 발생하지 않는다 — book_meeting은 항상 시각을 박는다).

    ``organization_id``: 그 기업이 (참가사든 바이어든) 낀 미팅만 — OP-003 기업 디테일 일정.
    ``jurisdiction_organizer_id``: sub 관할(관리 바이어가 낀 미팅)만 — 참가사 일정을 sub가 볼 때 다른
    sub 바이어와의 미팅(상대 기업명)이 새지 않게 한다.
    """
    stmt = (
        select(Meeting, MeetingVenue.label)
        .select_from(Meeting)
        .outerjoin(MeetingVenue, MeetingVenue.id == Meeting.venue_id)
        .where(Meeting.event_id == event_id, Meeting.scheduled_start.is_not(None))
    )
    if organization_id is not None:
        stmt = stmt.where(
            or_(Meeting.exhibitor_org_id == organization_id, Meeting.buyer_org_id == organization_id)
        )
    if jurisdiction_organizer_id is not None:
        stmt = _scope_to_managed_buyer_meetings(stmt, jurisdiction_organizer_id)
    rows = db.execute(stmt.order_by(Meeting.created_at)).all()
    return [(row[0], row[1]) for row in rows]


def assignment_review_facts(db: Session, meeting_ids: list[str]) -> dict[str, tuple[bool, bool | None]]:
    """meeting_id → (has_review, attended). ``app.meetings.service.build_views``의 뷰어별 관점이
    아니라, 이 미팅에 달린 리뷰 전부를 객관적으로 뭉친 값이다 — has_review는 누구든 하나라도
    리뷰(post_meeting_review)를 남겼는가. attended는 리뷰가 실제로 신고한 값만 반영한다: 아무도
    리뷰를 안 남겼으면 None(모름, 지어내지 않는다) — 리뷰가 있으면 **노쇼 신고가 하나라도 있으면
    False**(가장 부정적인 신고가 우선), 전부 참석으로 신고됐으면 True. 노쇼 신고는 상대가 남긴
    counterpart_noshow든 본인이 남긴 self_noshow든 둘 다 같은 무게로 센다(둘 다 "이 미팅은 노쇼
    였다"는 같은 사실을 말한다)."""
    if not meeting_ids:
        return {}
    rows = db.execute(
        select(
            PostMeetingReview.meeting_id,
            PostMeetingReview.counterpart_noshow,
            PostMeetingReview.self_noshow,
        ).where(PostMeetingReview.meeting_id.in_(meeting_ids))
    ).all()
    out: dict[str, tuple[bool, bool | None]] = {}
    for meeting_id, counterpart_noshow, self_noshow in rows:
        key = str(meeting_id)
        _, attended = out.get(key, (False, None))
        if counterpart_noshow or self_noshow:
            attended = False
        elif attended is not False:
            attended = True
        out[key] = (True, attended)
    return out


def list_exhibitor_unavailable_slots(db: Session, event_id: str) -> dict[str, list[str]]:
    """org_id → 배정 불가 슬롯(exhibitor_profiles.unavailable_meeting_slots). **참가사만** 저장소가
    있다 — 바이어 쪽 불가슬롯은 실 컬럼이 없어 응답에 아예 키가 없다(빈 배열조차 지어내지 않는다,
    소비부 lib/organizer/slot-intersection.ts의 isAvailableAt은 키 없음=가능으로 취급한다)."""
    rows = db.execute(
        select(OrganizationEventRole.organization_id, ExhibitorProfile.unavailable_meeting_slots)
        .join(ExhibitorProfile, ExhibitorProfile.org_event_role_id == OrganizationEventRole.id)
        .where(OrganizationEventRole.event_id == event_id)
    ).all()
    return {str(org_id): list(slots) for org_id, slots in rows if slots}


def list_assignment_contacts(
    db: Session, event_id: str, *, jurisdiction_organizer_id: str | None = None
) -> dict[str, tuple[str, str]]:
    """org_id → (담당자명, 직함) — 각 프로필의 첫 참석자(sort_order 최소)만 쓴다(http-members-
    client.ts의 ``buyer?.attendees?.[0]`` 관례와 동일). 참석자를 아직 안 채운 기업은 키가 없다
    (배정 상세 슬라이드 참석자 표시용, frontend AssignmentScheduleData.contactsByOrgId).

    sub(``jurisdiction_organizer_id``)면 바이어 담당자는 관리 바이어 것만 — 참가사 담당자는 그대로.
    """
    out: dict[str, tuple[str, str]] = {}
    buyer_stmt = (
        select(
            OrganizationEventRole.organization_id,
            BuyerAttendee.first_name,
            BuyerAttendee.last_name,
            BuyerAttendee.job_title,
        )
        .select_from(OrganizationEventRole)
        .join(BuyerProfile, BuyerProfile.org_event_role_id == OrganizationEventRole.id)
        .join(BuyerAttendee, BuyerAttendee.buyer_profile_id == BuyerProfile.id)
        .where(OrganizationEventRole.event_id == event_id)
    )
    if jurisdiction_organizer_id is not None:
        buyer_stmt = buyer_stmt.where(OrganizationEventRole.managing_organizer_id == jurisdiction_organizer_id)
    buyer_rows = db.execute(
        buyer_stmt.order_by(OrganizationEventRole.organization_id, BuyerAttendee.sort_order, BuyerAttendee.id)
    ).all()
    for org_id, first, last, title in buyer_rows:
        key = str(org_id)
        if key in out:
            continue  # sort_order 순으로 이미 첫 참석자를 담았다
        name = " ".join(p for p in (first, last) if p) or "-"
        out[key] = (name, title or "")

    exhibitor_rows = db.execute(
        select(
            OrganizationEventRole.organization_id,
            ExhibitorAttendee.first_name_ko,
            ExhibitorAttendee.first_name_en,
            ExhibitorAttendee.last_name_ko,
            ExhibitorAttendee.last_name_en,
            ExhibitorAttendee.title_ko,
            ExhibitorAttendee.title_en,
        )
        .select_from(OrganizationEventRole)
        .join(ExhibitorProfile, ExhibitorProfile.org_event_role_id == OrganizationEventRole.id)
        .join(ExhibitorAttendee, ExhibitorAttendee.exhibitor_profile_id == ExhibitorProfile.id)
        .where(OrganizationEventRole.event_id == event_id)
        .order_by(OrganizationEventRole.organization_id, ExhibitorAttendee.sort_order, ExhibitorAttendee.id)
    ).all()
    for org_id, fko, fen, lko, len_, tko, ten in exhibitor_rows:
        key = str(org_id)
        if key in out:
            continue
        name = " ".join(p for p in (fko or fen, lko or len_) if p) or "-"
        out[key] = (name, tko or ten or "")
    return out


def list_event_dates(event: Event) -> list[dict]:
    """행사 진행일 목록(그리드 열 = 날짜 탭) — exhibition_start/end에서 파생. 하드코딩 금지 원칙은
    compute_event_days와 동일. 둘 중 하나라도 미정이면 빈 목록(그리드가 날짜 탭 없이 빈 화면)."""
    if event.exhibition_start is None or event.exhibition_end is None:
        return []
    out: list[dict] = []
    cur = event.exhibition_start
    while cur <= event.exhibition_end:
        out.append(
            {"id": cur.isoformat(), "label": f"{cur.month}/{cur.day}", "weekday": _WEEKDAY_KO[cur.weekday()]}
        )
        cur += timedelta(days=1)
    return out
