"""알림 API 요청/응답 스키마 + 타입별 payload 스냅샷 스키마 (F-NT-001, ADR-0010).

ADR-0010: "payload는 하이브리드(방법 3) — meeting_id는 컬럼, 표시 데이터는 jsonb 스냅샷... 형태는
Pydantic/TS로 강제". 여기 8종 Payload 모델이 그 Pydantic 쪽 강제다. TS 쪽은 FE 목업의
frontend/lib/notifications/types.ts(사실상의 타입 계약) — 필드는 snake_case로 두되(백엔드 관례),
의미는 그쪽과 1:1 대응한다.
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal, get_args

from pydantic import BaseModel, ConfigDict

from app import models

CounterpartRole = Literal["exhibitor", "buyer", "organizer"]

# models.NOTIFICATION_TYPES(DB CHECK 제약 진실원천)과 동일 집합이어야 한다 — 드리프트는 아래 assert가 잡는다.
NotificationType = Literal[
    "meeting_requested", "meeting_accepted", "meeting_cancelled",
    "meeting_reminder", "review_prompt", "review_ready", "application_approved",
    "meeting_rejected",
]
assert set(get_args(NotificationType)) == set(models.NOTIFICATION_TYPES)


# =============================================================================
# 타입별 payload 스냅샷 (생성 시점 박제 — 사후 미팅 변경에 영향받지 않는다)
# =============================================================================
class MeetingRequestedPayload(BaseModel):
    counterpart_org_name: str
    requested_by_role: CounterpartRole


class MeetingAcceptedPayload(BaseModel):
    counterpart_org_name: str
    scheduled_start: str  # ISO8601(KST offset 포함)
    venue_label: str | None = None


class MeetingCancelledPayload(BaseModel):
    counterpart_org_name: str
    scheduled_start: str | None = None
    cancelled_by_role: CounterpartRole


class MeetingRejectedPayload(BaseModel):
    """미팅 거절 통지 — 신청한 쪽(거절당한 쪽) 1행. 거절 사유는 1차에서 미노출(GitHub #4 권고) —
    상대 기업명·제안했던 시간 정도만 담는다. 사유를 보여주면 거절하는 쪽이 부담을 느껴 사유
    선택을 회피할 수 있어, 신청자에게는 "다른 시간으로 다시 신청해 보세요" 수준의 안내만 한다.
    """

    counterpart_org_name: str
    scheduled_start: str | None = None


class MeetingReminderPayload(BaseModel):
    counterpart_org_name: str
    scheduled_start: str
    venue_label: str | None = None


class ReviewPromptPayload(BaseModel):
    counterpart_org_name: str


class ReviewReadyPayload(BaseModel):
    """비동기 전사·구조화가 끝나 회의록 초안이 준비됐다는 통지(F-MY-002 job done)."""

    counterpart_org_name: str


class ApplicationApprovedPayload(BaseModel):
    """신청 승인 완료 통지 — 상대 기업이 아니라 **내 기업**의 표시 정보다(다른 5종과 다름).

    meeting_id 없는 이벤트형 통지라 counterpart_org_name 개념이 없다. org_name은 승인된
    본인 조직명, role은 그 조직이 이 행사에서 신청한 역할(참가사/바이어).
    """

    org_name: str
    role: CounterpartRole


PAYLOAD_MODEL_BY_TYPE: dict[str, type[BaseModel]] = {
    "meeting_requested": MeetingRequestedPayload,
    "meeting_accepted": MeetingAcceptedPayload,
    "meeting_cancelled": MeetingCancelledPayload,
    "meeting_reminder": MeetingReminderPayload,
    "review_prompt": ReviewPromptPayload,
    "review_ready": ReviewReadyPayload,
    "application_approved": ApplicationApprovedPayload,
    "meeting_rejected": MeetingRejectedPayload,
}
assert set(PAYLOAD_MODEL_BY_TYPE) == set(models.NOTIFICATION_TYPES)


# =============================================================================
# API 응답/요청
# =============================================================================
class NotificationOut(BaseModel):
    """인박스 행 1개(전체 필드 평탄 — 노출 규칙 없음, org 공유라 참석자 전원이 같은 걸 본다)."""

    model_config = ConfigDict(from_attributes=True)

    id: str
    type: NotificationType
    meeting_id: str | None
    due_at: datetime | None
    payload: dict | None
    created_at: datetime
    read_at: datetime | None
    read_by_member_id: str | None
    #: 최초로 읽은 담당자 이름 — 인박스가 "읽음 {이름}"을 그리는 값. ORM 속성이 아니라 라우터가
    #: ``service.read_by_member_names``로 일괄 해석해 채운다(목록에서 N+1을 내지 않으려고).
    #: 읽지 않았거나(read_by_member_id NULL) 기록할 수 없는 주체였거나(데모 subject) 회원 행이
    #: 사라졌으면(FK SET NULL) None — 그때는 화면이 이름 없이 "읽음"만 보여준다.
    read_by_member_name: str | None = None


class InboxResponse(BaseModel):
    items: list[NotificationOut]
    unread_count: int
    next_cursor: str | None = None


# 읽음 처리에는 요청 바디가 없다. 예전엔 ``MarkReadRequest.member_id``로 클라이언트가 "내가
# 읽었다"를 자기신고했는데(Principal 미연결 시절), 지금은 읽은 주체를 세션에서 도출한다 —
# 감사 기록을 그 기록의 대상이 스스로 써넣으면 기록이 아니라 주장이 된다(router 참고).
class MarkAllReadResponse(BaseModel):
    updated_count: int
