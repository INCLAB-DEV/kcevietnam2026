"""참가자용 미팅 API의 요청/응답 계약 (F-MT-001).

케이스 규약은 레포 전체와 동일하게 **snake_case**(bm/admin과 같다). 입력 모델은
``extra="forbid"`` — 오타 난 필드가 조용히 무시되지 않는다. 상태·역할·사유 코드는 Literal로
좁혀 잘못된 어휘가 서비스 계층까지 내려가지 않게 한다.

사유 코드 어휘는 DB CHECK가 아니라 **여기서만** 강제된다(mt001meet01 결정 — 어휘 미확정이라
변경이 마이그레이션을 요구하지 않게 뒀다). 그래서 ``app.models``의 튜플과 이 Literal이 갈라지면
곧바로 구멍이 되므로, 모듈 임포트 시점에 assert로 드리프트를 잡는다(NOTIFICATION_TYPES와 같은 패턴).
"""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Literal, get_args

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.models import MEETING_CANCEL_REASONS, MEETING_REJECT_REASONS, VENUE_TYPES

MeetingStatus = Literal["proposed", "accepted", "rejected", "cancelled", "completed"]
ActorRole = Literal["exhibitor", "buyer", "organizer"]
PartyRole = Literal["exhibitor", "buyer"]
VenueType = Literal["booth", "zone_table", "business_room"]
CancelReasonCode = Literal["schedule_conflict", "counterpart_request", "internal_change", "other"]
RejectReasonCode = Literal["interest_mismatch", "schedule_unavailable", "other"]

# 어휘 드리프트 방어 — 모델 상수와 Literal이 갈라지면 임포트 시점에 터진다.
assert get_args(CancelReasonCode) == MEETING_CANCEL_REASONS
assert get_args(RejectReasonCode) == MEETING_REJECT_REASONS
assert get_args(VenueType) == VENUE_TYPES

#: 입력에서만 허용하는 장소 유형 별칭 → 캐노니컬(DB 어휘). 응답은 언제나 캐노니컬만 낸다.
#: 프런트 행사설정(`frontend/lib/event/event-settings.ts`)이 matching_zone을, 모달 UI가 table/room을
#: 쓰고 있어 입력만 너그럽게 받는다 — 어휘를 DB 쪽으로 수렴시키는 편도(one-way) 매핑.
VENUE_TYPE_ALIASES: dict[str, str] = {
    "booth": "booth",
    "zone_table": "zone_table",
    "business_room": "business_room",
    "table": "zone_table",
    "matching_zone": "zone_table",
    "room": "business_room",
}


def canonical_venue_type(value: str) -> str:
    """입력 장소 유형을 캐노니컬 DB 어휘로 환산. 모르는 값이면 ValueError."""
    try:
        return VENUE_TYPE_ALIASES[value]
    except KeyError:
        allowed = ", ".join(sorted(VENUE_TYPE_ALIASES))
        raise ValueError(f"알 수 없는 장소 유형: {value!r} (허용: {allowed})") from None


# =============================================================================
# 요청
# =============================================================================
class MeetingCreateIn(BaseModel):
    """미팅 신청 — 상대 org + 연속 슬롯 + 장소 유형.

    ``event_id``/``my_role``은 보통 생략한다. 내 org의 참가 행사가 하나뿐이면 event는 자동 해석되고,
    내 역할이 하나뿐이면 방향(참가사/바이어)도 자동 결정된다. 둘 다 모호할 때만 명시한다.
    """

    model_config = ConfigDict(extra="forbid")

    counterpart_org_id: str
    slot_ids: Annotated[list[str], Field(min_length=1, max_length=3)]
    venue_type: str
    #: zone_table/business_room에서 사용자가 고른 구체적 자리(``MeetingVenue.label``, 예: "T-03").
    #: 생략하면 그 유형의 빈 자리 중 첫 번째가 자동 배정된다(기존 동작 그대로). booth는 상대
    #: 참가사의 부스로 결정적이라 이 필드를 보지 않는다(H-02).
    venue_label: str | None = Field(default=None, max_length=200)
    event_id: str | None = None
    my_role: PartyRole | None = None
    request_reason: str | None = Field(default=None, max_length=2000)

    @field_validator("venue_type")
    @classmethod
    def _canonical(cls, value: str) -> str:
        return canonical_venue_type(value)


class MeetingAcceptIn(BaseModel):
    """수락 — 참석자를 함께 지정할 수 있다(생략하면 참석자 명단은 그대로)."""

    model_config = ConfigDict(extra="forbid")
    attendee_member_ids: list[str] | None = None


class MeetingRejectIn(BaseModel):
    """거절 — 수신측 전용. 'other'면 자유서술이 필수(사유 없는 거절 금지)."""

    model_config = ConfigDict(extra="forbid")
    reason_code: RejectReasonCode
    reason_text: str | None = Field(default=None, max_length=2000)


class MeetingCancelIn(BaseModel):
    """취소 — proposed면 신청측만, accepted면 양측 누구나."""

    model_config = ConfigDict(extra="forbid")
    reason_code: CancelReasonCode
    reason_text: str | None = Field(default=None, max_length=2000)


class MeetingParticipantsIn(BaseModel):
    """참석자 지정 — 내 org 소속 member만. 이 목록이 내 org 참석자의 전체 상태가 된다(치환)."""

    model_config = ConfigDict(extra="forbid")
    member_ids: list[str] = Field(default_factory=list)


# =============================================================================
# 응답 — 미팅
# =============================================================================
class MeetingOut(BaseModel):
    """미팅 한 건 — **뷰어(내 org) 기준**으로 상대·리뷰 필드가 채워진다.

    같은 미팅이라도 참가사가 볼 때와 바이어가 볼 때 ``counterpart_*``/``has_review``/``attended``가
    다르다. 서버가 뷰어 기준으로 계산해 내려주므로 클라이언트가 "내가 어느 쪽인지"를 다시 따지지
    않아도 된다.
    """

    id: str
    event_id: str
    status: MeetingStatus
    # 행사 타임존 오프셋이 실린 ISO 문자열(예: 2026-09-16T09:00:00+09:00) — 클라이언트가 UTC를
    # 로컬로 되돌릴 필요 없이 그대로 표시한다.
    scheduled_start: datetime | None = None
    scheduled_end: datetime | None = None
    duration_minutes: int | None = None
    # 위 offset을 만드는 데 쓴 IANA 타임존(``events.timezone``) — FE가 Intl.DateTimeFormat으로
    # 다시 포맷할 때(예: 요일 라벨) 문자열을 새로 하드코딩하지 않도록 원천을 그대로 실어 보낸다.
    event_timezone: str

    exhibitor_org_id: str
    buyer_org_id: str
    requested_by: ActorRole | None = None
    requested_by_org_id: str | None = None  # 파생 — organizer 생성이면 None
    awaiting_org_id: str | None = None
    counterpart_org_id: str
    counterpart_name: str

    venue_id: str | None = None
    venue_type: VenueType | None = None
    venue_label: str | None = None

    has_review: bool  # 뷰어 org가 남긴 리뷰가 있는가
    # 뷰어가 참석했는가 — **상대**가 남긴 리뷰의 counterpart_noshow가 뷰어의 노쇼를 뜻한다.
    # 상대 리뷰가 없으면 알 수 없으므로 None(false로 단정하지 않는다).
    attended: bool | None = None

    request_reason: str | None = None
    cancelled_at: datetime | None = None
    cancelled_by: ActorRole | None = None
    cancelled_by_org_id: str | None = None
    cancelled_reason_code: str | None = None
    cancelled_reason_text: str | None = None
    rejected_at: datetime | None = None
    rejected_by_org_id: str | None = None
    rejected_reason_code: str | None = None
    rejected_reason_text: str | None = None

    created_at: datetime
    updated_at: datetime


class MeetingListResponse(BaseModel):
    items: list[MeetingOut]
    total: int
    limit: int
    offset: int


# =============================================================================
# 응답 — 가용 슬롯
# =============================================================================
class TimeSlotOut(BaseModel):
    """슬롯 한 칸. ``id``는 ``"YYYY-MM-DDTHH:MM"``(신청 시 그대로 되돌려 보낸다)."""

    id: str
    time: str  # "HH:MM"
    available: bool


class MeetingDateOut(BaseModel):
    id: str  # "YYYY-MM-DD"
    label: str  # "9/16"
    weekday: str  # "화"
    morning: list[TimeSlotOut]
    afternoon: list[TimeSlotOut]


class VenueBadgeOut(BaseModel):
    text: str
    tone: Literal["available", "limited", "unavailable"]


class VenueNumberOut(BaseModel):
    """개별 좌석/룸 — ``value``가 곧 ``meeting_venues.label``이다."""

    value: str
    available: bool


class VenueOptionOut(BaseModel):
    """장소 유형 한 줄. ``kind``는 **캐노니컬 DB 어휘**(booth/zone_table/business_room)."""

    kind: VenueType
    name: str
    description: str
    badge: VenueBadgeOut | None = None
    numbers: list[VenueNumberOut] | None = None


class AvailabilityOut(BaseModel):
    """미팅 신청 모달이 필요로 하는 전부 — 날짜·슬롯·장소·초안·수락모드.

    ``acceptance_mode``는 "이 상대에게 신청하면 즉시 확정되는가"(ADR-0005 수락 규칙)를 미리
    알려준다 — 초청 바이어에게 신청하면 수락 단계 없이 바로 잡히므로 화면 문구가 달라진다.
    """

    dates: list[MeetingDateOut]
    venues: list[VenueOptionOut]
    draft_reason: str
    acceptance_mode: Literal["immediate", "pending"]
    slot_minutes: int
    #: 칸 사이 텀(분) — 간격(stride) = ``slot_minutes + slot_gap_minutes``. ``TimeSlotOut`` 이
    #: 시작 시각(``id``/``time``)만 싣고 종료 시각을 안 실으므로, 참가자 화면이 "선택한 구간의
    #: 종료 시각"과 소요시간 라벨을 스스로 계산하려면 이 값이 필요하다(mt003gap0001). 없으면
    #: 화면이 40분 상담을 "10:00 - 10:30" 으로 찍는다(구 ``slot-selection.ts`` 의 30분 하드코딩).
    slot_gap_minutes: int
    #: 연속 슬롯을 이은 미팅 1건의 스팬 상한(분). 구버전의 "최대 3칸"을 대체한다 — 칸 수로 제한하면
    #: 40분 슬롯에서 3칸이 130분이 되어 원래 기준(1시간 반)을 넘기 때문이다.
    max_meeting_minutes: int
    timezone: str
