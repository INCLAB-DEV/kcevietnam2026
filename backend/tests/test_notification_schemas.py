"""8종 알림 payload 스냅샷 스키마 검증 (F-NT-001, ADR-0010).

DB 없이 순수 Pydantic 검증만 — 항상 돈다(conftest skip 대상 아님). NotificationType Literal과
PAYLOAD_MODEL_BY_TYPE이 models.NOTIFICATION_TYPES(DB CHECK 진실원천)와 어긋나면 임포트 시점에
바로 assert로 실패한다(app/notifications/schemas.py 모듈 레벨 assert) — 여기선 7종 커버리지와
필드 검증 규칙을 추가로 확인한다.
"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from app import models
from app.notifications.schemas import (
    PAYLOAD_MODEL_BY_TYPE,
    ApplicationApprovedPayload,
    MeetingAcceptedPayload,
    MeetingCancelledPayload,
    MeetingRejectedPayload,
    MeetingReminderPayload,
    MeetingRequestedPayload,
    ReviewPromptPayload,
    ReviewReadyPayload,
)


def test_payload_models_cover_all_eight_types():
    assert set(PAYLOAD_MODEL_BY_TYPE) == set(models.NOTIFICATION_TYPES)
    assert len(PAYLOAD_MODEL_BY_TYPE) == 8


@pytest.mark.parametrize(
    ("type_", "sample"),
    [
        ("meeting_requested", {"counterpart_org_name": "한화", "requested_by_role": "buyer"}),
        (
            "meeting_accepted",
            {
                "counterpart_org_name": "한화",
                "scheduled_start": "2026-09-03T10:00:00+09:00",
                "venue_label": "A홀 B-12 부스",
            },
        ),
        (
            "meeting_cancelled",
            {"counterpart_org_name": "한화", "scheduled_start": None, "cancelled_by_role": "exhibitor"},
        ),
        (
            "meeting_reminder",
            {
                "counterpart_org_name": "한화",
                "scheduled_start": "2026-09-03T10:00:00+09:00",
                "venue_label": None,
            },
        ),
        ("review_prompt", {"counterpart_org_name": "한화"}),
        ("review_ready", {"counterpart_org_name": "한화"}),
        (
            "meeting_rejected",
            {"counterpart_org_name": "한화", "scheduled_start": "2026-09-03T10:00:00+09:00"},
        ),
    ],
)
def test_payload_model_accepts_type_shape(type_, sample):
    model = PAYLOAD_MODEL_BY_TYPE[type_]
    instance = model.model_validate(sample)
    assert instance.counterpart_org_name == "한화"


def test_meeting_requested_rejects_unknown_role():
    with pytest.raises(ValidationError):
        MeetingRequestedPayload(counterpart_org_name="한화", requested_by_role="ceo")


def test_meeting_cancelled_requires_counterpart_role():
    with pytest.raises(ValidationError):
        MeetingCancelledPayload(counterpart_org_name="한화", cancelled_by_role="")


def test_meeting_accepted_venue_label_optional():
    p = MeetingAcceptedPayload(counterpart_org_name="한화", scheduled_start="2026-09-03T10:00:00+09:00")
    assert p.venue_label is None


def test_meeting_reminder_requires_scheduled_start():
    with pytest.raises(ValidationError):
        MeetingReminderPayload(counterpart_org_name="한화", venue_label="A-1")


def test_meeting_rejected_scheduled_start_optional():
    p = MeetingRejectedPayload(counterpart_org_name="한화")
    assert p.scheduled_start is None


def test_meeting_rejected_requires_counterpart_name():
    with pytest.raises(ValidationError):
        MeetingRejectedPayload()


def test_review_prompt_and_ready_only_need_counterpart_name():
    assert ReviewPromptPayload(counterpart_org_name="한화").counterpart_org_name == "한화"
    assert ReviewReadyPayload(counterpart_org_name="한화").counterpart_org_name == "한화"


def test_application_approved_payload_carries_own_org_and_role():
    # 다른 6종과 달리 counterpart_org_name이 아니라 org_name(승인된 본인 조직) + role을 담는다.
    p = ApplicationApprovedPayload(org_name="한화", role="exhibitor")
    assert p.org_name == "한화"
    assert p.role == "exhibitor"


def test_application_approved_rejects_unknown_role():
    with pytest.raises(ValidationError):
        ApplicationApprovedPayload(org_name="한화", role="ceo")
