"""어드민 콘솔 API 입출력 스키마(Pydantic). 프로필 본문은 ``app.bm.schemas``를 그대로 재사용한다
(슈퍼어드민 직접수정/대리작성 모두 "bm 서비스 재사용" — 별도 검증 로직을 새로 만들지 않는다).
"""

from __future__ import annotations

from datetime import date, datetime, time
from typing import Literal, get_args

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.bm.schemas import (
    ApplicationStatus,
    BusinessFieldCode,
    BuyerProfileResponse,
    ContentCategoryCode,
    ExhibitorProfileResponse,
    Lang,
    OrgTypeCode,
)
from app.discover.schemas import DiscoverOrgOut
from app.matching.slot_grid import resolve_zone
from app.models import SLOT_MINUTES_CHOICES

VenueType = Literal["booth", "zone_table", "business_room"]
#: 미팅 한 칸 길이(분). 허용 어휘의 진실원천은 ``app.models.SLOT_MINUTES_CHOICES``(= DB CHECK
#: ``events_slot_minutes_check``)다 — 갈라지면 40분 행사가 API는 통과하고 DB에서 터지므로,
#: 임포트 시점 assert로 드리프트를 잡는다(``app.meetings.schemas`` 의 CancelReasonCode와 같은 패턴).
SlotMinutes = Literal[10, 20, 30, 40, 60]
assert get_args(SlotMinutes) == SLOT_MINUTES_CHOICES
ProfileRole = Literal["buyer", "exhibitor"]


# =============================================================================
# 행사(Event) — 멀티 이벤트 CRUD(#OP 슈퍼어드민 콘솔, 베트남 피벗)
# =============================================================================
class EventCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(..., min_length=1)
    name_en: str | None = None  # 행사명(영문) — 한/영 다국어 요건(FE 어드민 콘솔)
    slug: str | None = None  # 미제공 시 name에서 자동 생성(충돌 방지 접미사 포함)
    venue_name: str | None = None
    exhibition_start: date | None = None
    exhibition_end: date | None = None
    application_start: date | None = None
    application_end: date | None = None
    slot_minutes: SlotMinutes | None = None
    enabled_venue_types: list[VenueType] | None = None
    allow_same_role_discovery: bool | None = None
    timezone: str | None = None  # IANA 문자열(예: 'Asia/Ho_Chi_Minh'). 미지정 시 DB 기본값(Asia/Seoul).

    @field_validator("timezone")
    @classmethod
    def _valid_timezone(cls, v: str | None) -> str | None:
        # 조용한 UTC 폴백 금지(app.matching.slot_grid.resolve_zone docstring) — 알 수 없는 타임존은
        # 422로 막는다. 여기서 값을 못박지는 않는다(멀티 행사 재사용 전제, minds-ground-client-profile).
        if v is not None:
            resolve_zone(v)
        return v


class EventUpdate(BaseModel):
    """행사 식별/일정 필드. 정책 값(slot_minutes 등)은 EventSettingsUpdate로 분리(§8 정책 vs 일정)."""

    model_config = ConfigDict(extra="forbid")
    name: str | None = None
    name_en: str | None = None
    venue_name: str | None = None
    exhibition_start: date | None = None
    exhibition_end: date | None = None
    application_start: date | None = None
    application_end: date | None = None
    timezone: str | None = None  # events.timezone — 행사 현지 타임존(IANA). 슈퍼어드민이 여기서 바꾼다.

    @field_validator("timezone")
    @classmethod
    def _valid_timezone(cls, v: str | None) -> str | None:
        if v is not None:
            resolve_zone(v)
        return v


class EventOut(BaseModel):
    id: str
    name: str
    name_en: str | None = None
    slug: str
    venue_name: str | None = None
    exhibition_start: date | None = None
    exhibition_end: date | None = None
    application_start: date | None = None
    application_end: date | None = None
    slot_minutes: int
    enabled_venue_types: list[str] = Field(default_factory=list)
    allow_same_role_discovery: bool
    timezone: str  # IANA 문자열 — 미팅 시각 표시·슬롯 그리드가 전부 이 값으로 해석된다(ADR-0014).


class EventListResponse(BaseModel):
    items: list[EventOut]


class EventSettingsUpdate(BaseModel):
    """행사별 매칭/열람 정책 + 운영시간 — 다음 행사에서 뒤집을 수 있게 이벤트 설정으로 둔다.

    두 테이블에 나눠 저장된다: ``slot_minutes``/``enabled_venue_types``/``allow_same_role_discovery``는
    ``events``, 운영시간·점심·최소보장 슬롯은 ``event_schedule_settings``(행 없으면 생성). 화면에는
    한 덩어리의 "행사 설정"이라 API도 한 엔드포인트로 받는다.
    """

    model_config = ConfigDict(extra="forbid")
    slot_minutes: SlotMinutes | None = None
    enabled_venue_types: list[VenueType] | None = None
    allow_same_role_discovery: bool | None = None
    # 슬롯 그리드의 나머지 축 — 참가자 미팅 신청(F-MT-001)이 이 값으로 하루치 슬롯을 만든다.
    operating_start: time | None = None
    operating_end: time | None = None
    lunch_start: time | None = None
    lunch_end: time | None = None
    # 격자 모양의 나머지 두 축(mt003gap0001): 칸 사이 텀과 미팅 1건 스팬 상한. 범위는 여기서 강제한다
    # (DB CHECK 없음 — 마이그레이션 docstring의 "연속 범위는 API 경계에서" 관례 참고).
    slot_gap_minutes: int | None = Field(default=None, ge=0, le=30)
    max_meeting_minutes: int | None = Field(default=None, ge=10, le=480)
    min_guaranteed_slots: int | None = Field(default=None, ge=0)


class EventSettingsOut(BaseModel):
    event_id: str
    slot_minutes: int
    enabled_venue_types: list[str] = Field(default_factory=list)
    allow_same_role_discovery: bool
    operating_start: time
    operating_end: time
    lunch_start: time | None = None
    lunch_end: time | None = None
    #: 칸 사이 텀(분). 슬롯 간격(stride) = ``slot_minutes + slot_gap_minutes``.
    slot_gap_minutes: int
    #: 연속 슬롯을 이은 미팅 1건의 스팬 상한(분).
    max_meeting_minutes: int
    min_guaranteed_slots: int


# =============================================================================
# Organization(참가기업) 목록/상세 — 운영자 전용(visibility_rules 미적용, 운영자는 전부 본다)
# =============================================================================
class OrganizationListItem(BaseModel):
    match_count: int = 0
    id: str  # organization_id
    name_ko: str | None = None
    name_en: str | None = None
    is_exhibitor: bool
    is_buyer: bool
    application_status: ApplicationStatus
    managing_organizer_id: str | None = None
    # 누가 이 참가를 만들었나 — 없으면 기업이 직접 가입한 것이다(명단 "등록 주체" 컬럼).
    created_by_organizer_id: str | None = None
    # 바이어 참가 유형(초청/사전등록/현장) — 명단 "유형" 컬럼의 원천(organization_event_roles).
    buyer_subtype: str | None = None
    # Non-null when an organizer has written this organization's application for them.
    proxy_written_by_organizer_id: str | None = None

    # ── 표시용 확장 필드(운영자 콘솔 명단이 담당자·부스·분야를 전부 "-"로만 보여주던 버그 수정,
    # 2026-09) ────────────────────────────────────────────────────────────────────────────────
    # 신청서 미제출 기업은 이 아래 전부 None/빈 배열이다 — 지어내지 않고 정직하게 비운다.
    #
    # 담당자(공통) — app.admin.service.resolve_primary_contact()의 단일 폴백 규칙으로 계산.
    # 이름·전화는 app.excel.router.export_organizations와 완전히 같은 규칙(다른 값이 보이면 안 됨).
    contact_name: str | None = None
    contact_email: str | None = None
    contact_phone: str | None = None

    # 참가사(exhibitor_profiles) — 신청서 제출 전까지 전부 None.
    representative_name_ko: str | None = None
    representative_name_en: str | None = None
    company_email: str | None = None
    main_tel: str | None = None
    booth_hall: str | None = None
    booth_pavilion: str | None = None
    booth_location: str | None = None
    booth_type: str | None = None
    booth_count: int | None = None
    exhibition_categories: list[BusinessFieldCode] = Field(default_factory=list)  # 사업분야(8, 멀티)
    content_category: ContentCategoryCode | None = None  # 카테고리(3, 단일)

    # 바이어(buyer_profiles) — 신청서 제출 전까지 전부 None/빈 배열. 연매출·직원수는 명단에 불필요.
    contact_name_ko: str | None = None
    contact_name_en: str | None = None
    contact_title_ko: str | None = None
    contact_title_en: str | None = None
    contact_language: str | None = None  # 자유텍스트(BuyerProfile.contact_language 주석 참고)
    contact_interpreter_need: bool | None = None
    country: str | None = None
    city_state: str | None = None
    tel: str | None = None
    interest_categories: list[BusinessFieldCode] = Field(default_factory=list)  # 관심분야(8, 멀티)
    org_types: list[OrgTypeCode] = Field(default_factory=list)  # 참가자구분(8, 멀티, org_event_role 단위)


class OrganizationListResponse(BaseModel):
    items: list[OrganizationListItem]
    total: int
    limit: int
    offset: int


class OrganizationDetail(BaseModel):
    id: str  # organization_id
    org_event_role_id: str
    event_id: str
    name_ko: str | None = None
    name_en: str | None = None
    is_exhibitor: bool
    is_buyer: bool
    application_status: ApplicationStatus
    managing_organizer_id: str | None = None
    created_by_organizer_id: str | None = None
    proxy_written_by_organizer_id: str | None = None
    reviewed_at: datetime | None = None
    reviewed_by: str | None = None
    review_note: str | None = None
    buyer_profile: BuyerProfileResponse | None = None
    exhibitor_profile: ExhibitorProfileResponse | None = None


class OrganizationCreateIn(BaseModel):
    """참가기업 단건 등록 — 명단 임포트(roster) 없이 운영자가 한 건씩 직접 만든다.

    새 ``organizations`` 행 + 그 org의 ``organization_event_role``(이 행사, ``role``)을 만든다.
    ``contact_email``이 있으면 담당자(members) 1행도 함께 만든다(roster import와 동일하게 이메일
    없으면 담당자를 만들지 않는다 — ``members.email``이 NOT NULL·unique라 빈 값을 못 담는다).

    ``contact_password``(선택)는 그 담당자 계정의 로그인 비밀번호다 — 명단 업로드의 공통 비밀번호와
    **같은 정책·같은 해시**(app.auth.credentials)를 쓴다. 생략하면 ``password_hash``가 NULL로 남아
    그 계정은 로그인할 수 없다(명단 업로드에서 비밀번호를 안 올린 것과 같은 상태). ⚠ 평문은 이
    스키마 밖으로 나가지 않는다 — 라우터가 검증→해시까지만 하고, 응답·로그·감사기록에 싣지 않는다.
    """

    model_config = ConfigDict(extra="forbid")
    name_ko: str = Field(..., min_length=1)
    name_en: str | None = None
    role: ProfileRole  # "exhibitor" | "buyer"
    contact_name: str | None = None
    contact_email: str | None = None
    contact_phone: str | None = None
    contact_password: str | None = None


class ContactPasswordUpdate(BaseModel):
    """담당자 계정 비밀번호 설정/재설정 — 등록(단건·명단) 이후 운영자가 다시 정해주는 경로.

    빈 문자열로 "비밀번호 지우기"를 표현하지 않는다(정책 검사에서 422) — 계정을 로그인 불가로
    되돌리는 건 이 화면의 일이 아니다. 평문은 요청 본문으로만 들어오고 응답엔 담기지 않는다.
    """

    model_config = ConfigDict(extra="forbid")
    password: str


class ContactPasswordResult(BaseModel):
    """비밀번호 설정 결과 — **비밀번호·해시는 절대 싣지 않는다**(식별 정보만).

    화면이 "어느 계정에 걸었는지"를 토스트로 보여줄 수 있게 담당자 이메일까지만 돌려준다(이미
    기업 목록 응답에 실려 있는 값과 같은 수준의 정보).
    """

    organization_id: str
    member_id: str
    contact_email: str


class UnavailableSlotsUpdate(BaseModel):
    """미팅 불가 슬롯 — 운영자 전용 쓰기(기업 측 PATCH는 app.bm에서 422로 거부, #OP)."""

    model_config = ConfigDict(extra="forbid")
    slots: list[str] = Field(default_factory=list)


# =============================================================================
# 미팅(Schedule Table) — 목록/운영자 취소
# =============================================================================
MeetingStatus = Literal["proposed", "accepted", "rejected", "cancelled", "completed"]


class MeetingListItem(BaseModel):
    """미팅 한 줄 — 기존 필드는 그대로 두고 취소 맥락·장소 표기를 덧붙였다(FE 어댑터 호환)."""

    id: str
    exhibitor_org_id: str
    buyer_org_id: str
    status: MeetingStatus
    matching_type: Literal["ai", "open", "forced", "on_site"]
    scheduled_start: datetime | None = None
    scheduled_end: datetime | None = None
    venue_id: str | None = None
    # 운영자가 미팅 목록에서 "어디서·왜 취소됐나"를 바로 보게 하는 파생/감사 필드.
    venue_type: VenueType | None = None
    venue_label: str | None = None
    cancelled_by: Literal["exhibitor", "buyer", "organizer"] | None = None
    cancelled_reason_code: str | None = None
    cancelled_reason_text: str | None = None
    updated_at: datetime | None = None


class MeetingListResponse(BaseModel):
    items: list[MeetingListItem]
    total: int
    limit: int
    offset: int


class MeetingCancelIn(BaseModel):
    """운영자 취소 사유. 전부 선택 — 기존 FE가 사유 없이 호출하던 계약을 깨지 않는다.

    ``reason_code`` 없이 ``reason_text``만 보내는 것도 허용한다(기존 화면이 자유서술 하나만
    보내는 형태였다). 참가자 취소와 달리 어휘를 강제하지 않는 건, 운영자 취소 사유가 정형
    어휘로 다 담기지 않는 현장 사정(장비 고장·동선 변경 등)을 포함하기 때문이다.
    """

    model_config = ConfigDict(extra="forbid")
    reason_code: str | None = None
    reason_text: str | None = Field(default=None, max_length=2000)


class MeetingCancelOut(BaseModel):
    id: str
    status: MeetingStatus


# =============================================================================
# 통역사 배정(#OP) — 참가기업별 통역사. 계정 체계는 추후, v1은 스키마+운영자 관리만.
# =============================================================================
class InterpreterCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(..., min_length=1)
    languages: list[Lang] | None = None
    phone: str | None = None
    email: str | None = None
    note: str | None = None


class InterpreterUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str | None = None
    languages: list[Lang] | None = None
    phone: str | None = None
    email: str | None = None
    note: str | None = None


class InterpreterOut(BaseModel):
    id: str
    event_id: str
    name: str
    languages: list[Lang] = Field(default_factory=list)
    phone: str | None = None
    email: str | None = None
    note: str | None = None
    assigned_organization_ids: list[str] = Field(default_factory=list)


class InterpreterAssignIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    organization_id: str


# =============================================================================
# 미팅 장소(venue) 프로비저닝(#OP) — 비즈매칭존 테이블 / 비즈니스룸
# =============================================================================
#: 콘솔이 만들고 고칠 수 있는 장소 종류. ``VenueType``에서 **booth를 뺀** 좁은 집합이다 —
#: 참가사 부스 장소는 미팅 신청 시점에 자동 생성되는 파생물이라 운영자가 손대는 자원이 아니다
#: (``app.admin.service.MANAGEABLE_VENUE_TYPES`` 주석 참고). 여기서 좁혀두면 잘못된 종류로
#: 만들려는 요청이 서비스까지 가지 않고 Pydantic 단계에서 422로 끊긴다.
ManageableVenueType = Literal["zone_table", "business_room"]


class VenueCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    venue_type: ManageableVenueType
    label: str = Field(..., min_length=1, max_length=100)


class VenueUpdate(BaseModel):
    """라벨만 바꾼다 — 종류를 바꾸는 건 수정이 아니라 다른 장소를 만드는 일이다."""

    model_config = ConfigDict(extra="forbid")
    label: str = Field(..., min_length=1, max_length=100)


class VenueOut(BaseModel):
    id: str
    event_id: str
    venue_type: VenueType
    label: str
    #: 이 장소를 참조하는 미팅 수(상태 무관) — 콘솔이 "삭제 가능한가"를 미리 보여주는 값.
    #: 0이 아니면 DELETE는 409(VENUE_IN_USE)로 막힌다.
    meeting_count: int = 0


# =============================================================================
# 참가 기업 역할 전환 — 슈퍼어드민 전용(#OP 역할 관리, 개발계획서 §7.3 연계)
# =============================================================================
class OrganizationRoleUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    role: ProfileRole  # "buyer" | "exhibitor" — 그 외 값은 여기서 422


class OrganizationRoleOut(BaseModel):
    id: str  # organization_id
    event_id: str
    is_exhibitor: bool
    is_buyer: bool


# =============================================================================
# 신청서 검토(승인/반려/수정요청) — 슈퍼어드민 전용(OP-003, bm-profile-fields §6 승인 상태머신)
# =============================================================================
#: 운영자가 내릴 수 있는 검토 결정 3종. registered/submitted 전이는 참가측 플로우(제출) 소관이라
#: 여기 없다 — 이 스키마는 "submitted → {approved,rejected,changes_requested}" 결정만 표현한다.
ApplicationReviewDecision = Literal["approved", "rejected", "changes_requested"]


class OrganizationReviewIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    status: ApplicationReviewDecision
    # 반려·변경요청 사유(승인은 보통 비움) — organization_event_roles.review_note 그대로 저장.
    note: str | None = Field(default=None, max_length=2000)


class OrganizationReviewOut(BaseModel):
    id: str  # organization_id
    event_id: str
    org_event_role_id: str
    application_status: ApplicationStatus
    reviewed_at: datetime | None = None
    reviewed_by: str | None = None
    review_note: str | None = None


# =============================================================================
# 운영자(Organizer) 관리 — 서브어드민 부여/회수(슈퍼어드민 전용). 슈퍼어드민(master)은 이 API로
# 만들거나 지울 수 없다(발주자 지시 — DB 직접 부여/조정 전용, backend/README.md).
# =============================================================================
class OrganizerGrantIn(BaseModel):
    """서브어드민 부여 입력 — 대상은 **이미 가입된 회원**을 로그인 이메일로 지정한다(2026-09-17).

    예전엔 회원 UUID를 손으로 입력받아, 오타·없는 ID도 그대로 ``organizers`` 행(유령 운영자)이 됐다.
    이제 서비스가 회원을 먼저 찾고 없으면 404다. ``member_id``(members.id)는 하위 호환으로만 받는다 —
    둘 중 정확히 하나. 화면은 이메일만 쓴다.
    """

    model_config = ConfigDict(extra="forbid")
    email: str | None = Field(default=None, min_length=1, max_length=320)
    member_id: str | None = Field(default=None, min_length=1)
    # Literal["sub"] 대신 커스텀 검증기를 쓴다 — "master는 API로 못 준다"는 사유를 담은 한국어
    # 메시지를 응답 422에 그대로 실어야 해서다(typing.Literal의 기본 에러 메시지는 사유를 담지 못함).
    permission_level: str

    @field_validator("permission_level")
    @classmethod
    def _sub_only(cls, v: str) -> str:
        if v == "master":
            raise ValueError("슈퍼어드민(master)은 API로 부여할 수 없습니다 — DB에서 직접 부여하세요")
        if v != "sub":
            raise ValueError("permission_level은 'sub'만 허용합니다")
        return v

    @model_validator(mode="after")
    def _exactly_one_target(self) -> "OrganizerGrantIn":
        has_email = bool(self.email and self.email.strip())
        has_member_id = bool(self.member_id and self.member_id.strip())
        if has_email == has_member_id:
            raise ValueError("부여 대상은 email 또는 member_id 중 하나로 지정하세요")
        return self


# =============================================================================
# 알림 발송 이력(#OP 알림 콘솔) — notification_dispatches 행 단위. 재발송은 대상별 1행 갱신
# (유니크 제약)이라 누적으로 셀 대상이 없어 resend_count는 0 고정(화면 낙관 갱신이 표시 담당).
# FE 확정 계약: frontend/lib/admin/types.ts ``AdminNotificationLog``.
# =============================================================================
class NotificationLogOut(BaseModel):
    id: str  # dispatch 행 id — 재발송 경로 키
    event_id: str
    type: str
    channel: str  # 'in_app' | 'email'
    recipient_org_id: str
    recipient_org_name: str
    meeting_id: str | None = None
    sent_at: datetime  # 미발송 행은 알림 생성 시각 폴백(정렬 키 보존)
    delivered: bool
    resend_count: int = 0


class NotificationLogListResponse(BaseModel):
    items: list[NotificationLogOut]


class NotificationResendOut(BaseModel):
    id: str
    channel: str
    delivered: bool
    sent_at: datetime | None = None


# =============================================================================
# 강제 배정 / AI 전체 포화배정(F-OP-005 Phase 3-4) — master 전용, "슈퍼관리자 자유도 최대"
# =============================================================================
class ForcedAssignmentIn(BaseModel):
    """운영자 강제 배정 입력 — 시간은 explicit(scheduled_start/end) 또는 slot_ids 중 하나만.

    수락 상태(accepted/proposed)는 입력에 없다 — 받는 쪽(바이어) 유형이 자동 결정한다(ADR-0005,
    F-OP-005 D2 폐기). 참가사의 소프트 불가슬롯은 무시된다(운영자 강제 — 하드 제약만 유지).
    """

    model_config = ConfigDict(extra="forbid")
    exhibitor_org_id: str
    buyer_org_id: str
    venue_id: str
    scheduled_start: datetime | None = None
    scheduled_end: datetime | None = None
    slot_ids: list[str] | None = None
    reason: str | None = Field(default=None, max_length=2000)

    @model_validator(mode="after")
    def _check_time_source(self) -> "ForcedAssignmentIn":
        if (self.scheduled_start is None) != (self.scheduled_end is None):
            raise ValueError("scheduled_start/scheduled_end는 함께 지정해야 합니다")
        has_explicit = self.scheduled_start is not None
        has_slots = bool(self.slot_ids)
        if has_explicit == has_slots:
            raise ValueError("scheduled_start/end 또는 slot_ids 중 정확히 하나를 지정해야 합니다")
        return self


class SaturationDraftItemOut(BaseModel):
    id: str
    exhibitor_org_id: str
    buyer_org_id: str
    venue_id: str | None = None
    scheduled_start: datetime
    scheduled_end: datetime
    status: Literal["draft", "confirmed", "skipped"]
    materialized_meeting_id: str | None = None
    seq_no: int | None = None


class SaturationRunOut(BaseModel):
    id: str
    event_id: str
    run_number: int
    min_guaranteed_slots: int
    status: Literal["draft", "confirmed", "discarded"]
    created_at: datetime
    confirmed_at: datetime | None = None
    items: list[SaturationDraftItemOut] = Field(default_factory=list)


class SaturationConfirmResultItem(BaseModel):
    id: str
    exhibitor_org_id: str
    buyer_org_id: str
    status: Literal["confirmed", "skipped"]
    materialized_meeting_id: str | None = None
    error_code: str | None = None
    error_message: str | None = None


class SaturationConfirmOut(BaseModel):
    run: SaturationRunOut
    confirmed_count: int
    skipped_count: int
    items: list[SaturationConfirmResultItem]


class OrganizerOut(BaseModel):
    """FE 확정 계약(frontend/lib/admin/types.ts ``AdminOrganizer``)과 필드 단위로 맞춘다.

    ``id``는 ``event_organizers.id``(이 행사에서의 배정 레코드) — FE가 회수(DELETE) 경로 키로
    그대로 되돌려준다. ``organizers.id``(계정 전역 신원)는 응답에 노출하지 않는다(FE 계약 밖).
    """

    id: str  # event_organizers.id — 회수 시 경로 키
    event_id: str
    member_id: str | None = None
    name: str
    email: str
    permission_level: str
    # sub(무역관) 관할 표시 — ADR-0013(KOTRA 무역관 등록 대리) 슬라이스 전까지 데이터가 없어 항상
    # null(스텁). FE 타입이 이미 nullable로 대비돼 있어 계약은 깨지지 않는다.
    trade_office: str | None = None
    granted_at: datetime  # event_organizers.created_at(ISO8601로 직렬화)


# =============================================================================
# GET /api/admin/me — "지금 로그인한 운영자"의 신원 + 행사별 권한등급
#
# 참가자 쪽 ``GET /api/me``(app.discover.schemas.MeOut)의 운영자판이다. 존재 이유도 같다: 화면이
# 사이드바에 그릴 이름·소속·연락처의 원천이 달리 없다(운영자는 ``organizations``에 소속된 참가
# 주체가 아니라 ``organizers`` 계정이라, MeOut 경로로는 신원이 안 잡힌다). 이게 없으면 프론트가
# 목업 인물("정세훈")을 그대로 그리고 그 이름이 대리작성·미팅취소 감사기록에까지 박힌다.
#
# ``events``가 리스트인 건 권한등급이 계정 전역이 아니라 **계정×행사** 단위이기 때문이다(ADR-0012)
# — MeOut.roles가 행사별 참가 역할을 싣는 것과 같은 이유. 화면은 지금 보고 있는 행사의 등급을
# 골라 쓴다. **이 값은 표시용이다** — 실제 조작 허용의 권위는 여전히 require_event_master /
# require_event_operator(경계 B)에 있다.
# =============================================================================
class AdminMeEventOut(BaseModel):
    """내가 이 행사에서 갖는 권한등급(ADR-0012). 배정된 행사 1건 = 1행."""

    event_id: str
    permission_level: str  # 'master' | 'sub'


class AdminMeOut(BaseModel):
    """현재 로그인한 운영자 본인의 표시용 신원 + 배정된 행사별 권한등급.

    표시 필드(name·email·phone·affiliation)는 전부 nullable이다 — 못 찾은 값은 **지어내지 않고**
    비운다(MeOut과 같은 원칙). 화면은 빈 값이면 그 줄을 숨긴다. 빈 문자열도 None으로 접어서
    내려보내므로(``build_admin_me``) 프론트가 공백 한 칸을 그리는 일이 없다.
    """

    member_id: str
    organizer_id: str
    name: str | None = None
    email: str | None = None
    phone: str | None = None
    #: 소속 표시 — 운영자 회원(members)이 속한 조직명. 못 찾으면 None.
    affiliation: str | None = None
    events: list[AdminMeEventOut]


# =============================================================================
# OP-001 운영 대시보드 — 원시 집계 입력(F-OP-001 / 이슈 #53).
#
# 여기서 비율·묶음 등을 계산하지 않는다 — FastAPI는 이 행사의 원시 사실(등록자 수·참가자·미팅·
# 리뷰·운영시간·포화배정 실행 이력)만 필터링해 돌려주고, frontend/lib/organizer/ops-metrics.ts의
# 이미 테스트된 순수 집계(aggregateOpsMetrics)가 그대로 계산한다(getHomeDashboard가 raw 미팅을
# 내려주고 FE가 buildHomeDashboardData로 집계하는 것과 동일 원칙 — 이 레포의 기존 관례). 필드는
# frontend/lib/organizer/ops-metrics.ts의 OpsMetricsInput·frontend/lib/organizer/saturation-status.ts의
# SaturationRun과 1:1 대응(단 snake_case) — FE http 클라이언트가 camelCase로 매핑한다.
# =============================================================================
class OpsRosterOut(BaseModel):
    exhibitor_registrants: int
    buyer_registrants: int


class OpsParticipantOut(BaseModel):
    org_id: str
    role: Literal["exhibitor", "buyer"]
    approved: bool  # application_status == 'approved'(ADR-0009)


class OpsMeetingOut(BaseModel):
    id: str
    exhibitor_org_id: str
    buyer_org_id: str
    status: MeetingStatus
    # 행사 로컬 타임존(Event.timezone)으로 변환된 시각 — FE 시간대 집계(hourlyDistribution)가
    # 문자열에서 시(hour)를 직접 잘라 읽으므로(Date 변환 없음) UTC 그대로 주면 KST 시연에서
    # 시간대가 어긋난다.
    scheduled_start: datetime | None = None
    saturation_run_id: str | None = None


class OpsReviewOut(BaseModel):
    meeting_id: str
    reviewer_org_id: str
    counterpart_noshow: bool
    self_noshow: bool


class OpsScheduleOut(BaseModel):
    operating_start: str  # "HH:MM"
    operating_end: str  # "HH:MM"
    slot_minutes: int
    #: 칸 사이 텀(분). FE ``ops-metrics.ts`` 의 하루 슬롯 총량이 **stride**(= slot_minutes + 이 값)로
    #: 나눠야 맞다 — slot_minutes 로 나누면 40분/텀5분 격자에서 총량이 부풀어 오른다(mt003gap0001).
    slot_gap_minutes: int
    #: 점심 블록 "HH:MM". 미설정(NULL)이면 둘 다 ``"00:00"`` — FE ``slotTimes`` 의 [lunchStart,
    #: lunchEnd) 판정이 빈 구간이 되어 아무 칸도 건너뛰지 않는다(``AssignmentScheduleSettingsOut`` 과
    #: 같은 관례). 하루 슬롯 총량은 stride만으로 세면 점심을 못 빼서 부풀어 오른다: 프로덕션
    #: 09:00~18:00/30분/점심12~13 은 18칸이 아니라 **16칸**이 맞고, 발주사 격자는 11이 아니라
    #: **10칸**이다. 그래서 FE가 백엔드 ``_day_slots`` 와 같은 규칙을 쓰는 ``organizer/schedule.ts
    #: slotTimes`` 로 위임할 수 있게 이 두 값을 함께 내려준다(집계는 FE, 원시 사실은 BE — 이 레포
    #: 관례는 유지한다).
    lunch_start: str
    lunch_end: str
    event_days: int


class OpsSaturationRunOut(BaseModel):
    run_number: int
    status: Literal["draft", "confirmed", "discarded"]
    created_at: datetime
    min_guaranteed_slots: int


class OpsMetricsOut(BaseModel):
    roster: OpsRosterOut
    participants: list[OpsParticipantOut]
    meetings: list[OpsMeetingOut]
    reviews: list[OpsReviewOut]
    schedule: OpsScheduleOut
    saturation_runs: list[OpsSaturationRunOut] = Field(default_factory=list)
    # 이 응답이 무엇을 셌는가 — 'event'(master: 행사 전역) | 'jurisdiction'(sub: 자기가 관리하는
    # 바이어의 매칭 활동만, 참가사 축 제외). 화면은 이 값으로 참가사 기준 위젯(슬롯 사용률·0건 참가사)을
    # 숨긴다 — 권한을 프론트가 추측하지 않고 응답이 스스로 밝힌다.
    scope: Literal["event", "jurisdiction"] = "event"


# =============================================================================
# OP-005 배정 스케줄 읽기(F-OP-005 Phase 6) — 배정 콘솔 그리드가 그대로 그릴 수 있는 조합 응답.
#
# 기업 카드는 ``app.discover.schemas.DiscoverOrgOut``을 그대로 재사용한다(탐색 카드 조립 —
# ``app.discover.service._load_profiles``/``_project`` — 을 admin에서도 쓴다, "bm 서비스 재사용"과
# 같은 원칙). 단 여기서는 승인·가시성 필터를 걸지 않는다 — 운영자는 미승인 기업도 강제배정 대상으로
# 볼 수 있어야 한다("슈퍼관리자 자유도 최대", F-OP-005 PRD).
#
# 추천(recommendation) 오버레이는 이 응답에 없다 — AI 매칭 추천 엔진은 별도 미구현 기능이라 계약
# 밖이다(FE는 이 값이 없으면 추천 없음으로 그린다, recsByOrgId를 채우지 않는다).
# =============================================================================
class AssignmentDateOut(BaseModel):
    id: str  # "2026-09-16"
    label: str  # "9/16"
    weekday: str  # "수"


class AssignmentScheduleSettingsOut(BaseModel):
    start_time: str  # "HH:MM" — event_schedule_settings.operating_start
    end_time: str
    slot_minutes: int  # events.slot_minutes(단일 진실원천, EventScheduleSettings에는 없다)
    # 점심 미설정(lunch_start/end가 NULL)이면 둘 다 "00:00" — FE slotTimes()의 [lunchStart,
    # lunchEnd) 판정이 빈 구간이 되어 자연히 아무 칸도 건너뛰지 않는다(지어낸 점심시간이 아니다).
    lunch_start: str
    lunch_end: str
    #: 칸 사이 텀(분). FE ``organizer/schedule.ts`` 의 ``slotTimes`` 가 stride = slot_minutes + 이 값으로
    #: 걸어야 발주사 격자(40분 상담 + 5분 텀)가 재현된다(mt003gap0001). 0이면 구동작과 동일.
    slot_gap_minutes: int
    #: 연속 슬롯을 이은 미팅 1건의 스팬 상한(분) — FE 슬롯 선택기의 "최대 N칸" 문구 대신 이 값을 쓴다.
    max_meeting_minutes: int
    min_slots: int


class AssignmentMeetingOut(BaseModel):
    """그리드 셀 1개(배정된 미팅). FE AssignmentMeeting과 필드 단위로 대응(snake_case) — 단
    attended/has_review는 이 미팅에 달린 리뷰를 뷰어 무관하게 객관적으로 뭉친 값이다(app.meetings.
    service.build_views의 뷰어별 관점과 다르다 — 그리드 셀은 특정 뷰어가 없다)."""

    id: str
    exhibitor_org_id: str
    buyer_org_id: str
    slot_id: str  # "YYYY-MM-DDTHH:MM"(행사 로컬 타임존) — frontend/lib/organizer/schedule.ts slotId()와 동일 형식
    status: MeetingStatus
    matching_type: Literal["ai", "open", "forced", "on_site"]
    duration_minutes: int | None = None
    # 리뷰 기반 실측값 — 아무도 회의록을 안 남겼으면 None(모름, 지어내지 않는다). 리뷰가 있으면
    # 노쇼 신고가 하나라도 있으면 False(가장 부정적인 신고 우선), 전부 참석 신고면 True.
    attended: bool | None = None
    has_review: bool = False  # 어느 한쪽이든 회의록(post_meeting_review)을 남겼으면 True.
    venue_label: str | None = None
    requested_by_org_id: str | None = None


class AssignmentContactOut(BaseModel):
    name: str
    title: str


class AssignmentScheduleOut(BaseModel):
    exhibitors: list[DiscoverOrgOut]
    buyers: list[DiscoverOrgOut]
    dates: list[AssignmentDateOut]
    settings: AssignmentScheduleSettingsOut
    meetings: list[AssignmentMeetingOut]
    # org_id → 비즈매칭 등록순(tie-break). organization_event_roles.created_at 오름차순 1부터.
    application_order: dict[str, int] = Field(default_factory=dict)
    # org_id → 신청 시 지정한 배정 불가 슬롯. **참가사만 실 저장소가 있다**(exhibitor_profiles.
    # unavailable_meeting_slots) — 바이어는 저장소가 없어 키 자체가 없다(빈 배열을 지어내지 않는다).
    unavailable_by_org_id: dict[str, list[str]] = Field(default_factory=dict)
    # org_id → 담당자(프로필의 첫 참석자). 참석자를 아직 안 채운 기업은 키가 없다.
    contacts_by_org_id: dict[str, AssignmentContactOut] = Field(default_factory=dict)
