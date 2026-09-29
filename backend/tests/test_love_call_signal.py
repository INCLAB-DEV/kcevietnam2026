"""love-call-signal 외부 동작 테스트 — 노출 규칙이 핵심(PRD Testing Decisions).

- Love Call 은 상대 조회 응답에 보인다(공개 단방향).
- Follow-up Intent · Fit Assessment · 만족도 등은 상대 응답에서 절대 노출되지 않는다(비공개).
- 양측이 서로 보내면 Mutual 로 격상(채널 자동개설은 v1 제외).
"""

import pytest

from app.domain.love_call_signal import (
    LoveCallError,
    PRIVATE_REVIEW_FIELDS,
    assert_no_private_fields,
    is_mutual,
    love_call_visible_to,
    mutual_escalation_signal,
    send_love_call,
    serialize_review_for,
)

EXHIBITOR = "org-exhibitor"
BUYER = "org-buyer"
OUTSIDER = "org-outsider"
MEETING = "meeting-1"


def _full_review() -> dict:
    return {
        "meeting_id": MEETING,
        "reviewer_org_id": EXHIBITOR,
        "satisfaction": 5,
        "follow_up_intent": "yes",
        "fit_rating": "good",
        "fit_reason": "기술 성숙도 높음",
        "fit_reason_tags": ["기술 성숙도", "도입 시기"],
        "counterpart_noshow": False,
        "transcript": "내부 전사 원문...",
        "report_sections": {"discussion": ["..."], "agreements": [], "actions": []},
    }


class TestSendAndMutual:
    def test_cannot_love_call_self(self):
        with pytest.raises(LoveCallError):
            send_love_call(MEETING, EXHIBITOR, EXHIBITOR)

    def test_one_way_not_mutual(self):
        calls = [send_love_call(MEETING, EXHIBITOR, BUYER)]
        assert is_mutual(calls, EXHIBITOR, BUYER) is False

    def test_both_directions_is_mutual(self):
        calls = [
            send_love_call(MEETING, EXHIBITOR, BUYER),
            send_love_call(MEETING, BUYER, EXHIBITOR),
        ]
        assert is_mutual(calls, EXHIBITOR, BUYER) is True

    def test_mutual_signal_does_not_open_channel_in_v1(self):
        calls = [
            send_love_call(MEETING, EXHIBITOR, BUYER),
            send_love_call(MEETING, BUYER, EXHIBITOR),
        ]
        sig = mutual_escalation_signal(calls, EXHIBITOR, BUYER)
        assert sig["mutual"] is True
        assert sig["open_channel"] is False  # 2026-06-14: 채널 자동개설 v1 제외
        assert sig["review_for_rematch"] is True


class TestVisibility:
    def test_love_call_visible_to_recipient(self):
        lc = send_love_call(MEETING, EXHIBITOR, BUYER)
        assert love_call_visible_to(lc, BUYER) is True  # 받는 쪽 = 공개 신호

    def test_love_call_visible_to_sender(self):
        lc = send_love_call(MEETING, EXHIBITOR, BUYER)
        assert love_call_visible_to(lc, EXHIBITOR) is True

    def test_love_call_hidden_from_third_party(self):
        lc = send_love_call(MEETING, EXHIBITOR, BUYER)
        assert love_call_visible_to(lc, OUTSIDER) is False


class TestExposureBoundary:
    def test_owner_sees_full_review(self):
        view = serialize_review_for(
            _full_review(), reviewer_org_id=EXHIBITOR, requesting_org_id=EXHIBITOR
        )
        assert view["fit_rating"] == "good"
        assert view["follow_up_intent"] == "yes"
        assert view["satisfaction"] == 5

    def test_counterpart_never_sees_private_fields(self):
        view = serialize_review_for(
            _full_review(), reviewer_org_id=EXHIBITOR, requesting_org_id=BUYER
        )
        for f in PRIVATE_REVIEW_FIELDS:
            assert f not in view, f"비공개 필드 {f} 가 상대에게 노출됨"
        # 공개 가능한 보고 본문은 남아도 됨(별도 권한 흐름) — 비공개만 제거됨을 확인.
        assert "report_sections" in view

    def test_third_party_also_stripped(self):
        view = serialize_review_for(
            _full_review(), reviewer_org_id=EXHIBITOR, requesting_org_id=OUTSIDER
        )
        assert not (PRIVATE_REVIEW_FIELDS & view.keys())

    def test_assert_no_private_fields_passes_clean_payload(self):
        assert_no_private_fields({"report_sections": {}, "meeting_id": MEETING})

    def test_assert_no_private_fields_raises_on_leak(self):
        with pytest.raises(LoveCallError):
            assert_no_private_fields({"fit_rating": "good"})
