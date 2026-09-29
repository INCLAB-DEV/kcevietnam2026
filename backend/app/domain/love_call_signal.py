"""love-call-signal — Love Call 단방향 전송·Mutual 격상 판정과 공개/비공개 노출 경계.

PRD F-MY-002 D7~D9 / ADR-0004:
- Love Call 은 상대 Organization 에 가는 **공개 단방향** 신호 (화답 불요).
- 양측이 서로 보내면 **Mutual Love Call** 로 격상 → NABI 가 추가 매칭(후속 미팅) 검토 신호로만 사용.
  v1 은 대화 채널을 자동 개설하지 않는다(2026-06-14 결정; conversation_channels 는 backlog).
- **비공개 항목(Follow-up Intent · Fit Assessment · 만족도 · counterpart_noshow)은 상대 응답에서
  절대 노출되지 않는다.** 이 노출 규칙이 본 모듈의 핵심 검증 대상이다.

DB·HTTP 를 모른다. 식별자는 문자열(org id)로 다룬다.
"""

from __future__ import annotations

from dataclasses import dataclass

# 상대(counterpart) 응답에서 절대 새어나가면 안 되는 비공개 리뷰 필드.
PRIVATE_REVIEW_FIELDS: frozenset[str] = frozenset(
    {
        "satisfaction",
        "follow_up_intent",
        "fit_rating",
        "fit_reason",
        "fit_reason_tags",
        "counterpart_noshow",
        "transcript",
        "transcript_turns",  # 화자별 전사 — 전사 원문과 동일한 비공개 원천, 상대에게 절대 노출 금지.
        "audio_s3_key",  # 원본 녹음 S3 키 — 비공개 원천, 상대에게 절대 노출 금지.
    }
)


class LoveCallError(ValueError):
    """Love Call 규칙 위반(자기 자신에게 전송 등)."""


@dataclass(frozen=True)
class LoveCall:
    """단방향 신호 1건. (meeting_id, from_org_id, to_org_id) 가 유일."""

    meeting_id: str
    from_org_id: str
    to_org_id: str


def send_love_call(meeting_id: str, from_org_id: str, to_org_id: str) -> LoveCall:
    """단방향 Love Call 1건을 만든다. 자기 자신에게는 보낼 수 없다."""
    if from_org_id == to_org_id:
        raise LoveCallError("자기 자신에게 Love Call 을 보낼 수 없습니다")
    return LoveCall(meeting_id=meeting_id, from_org_id=from_org_id, to_org_id=to_org_id)


def is_mutual(love_calls: list[LoveCall], org_a: str, org_b: str) -> bool:
    """org_a→org_b 와 org_b→org_a 가 모두 존재하면 Mutual."""
    pairs = {(lc.from_org_id, lc.to_org_id) for lc in love_calls}
    return (org_a, org_b) in pairs and (org_b, org_a) in pairs


def mutual_escalation_signal(love_calls: list[LoveCall], org_a: str, org_b: str) -> dict:
    """Mutual 성립 시 NABI 추가매칭 검토용 신호를 만든다.

    v1: 채널 자동 개설 안 함(open_channel=False). 신호만 표시한다.
    """
    mutual = is_mutual(love_calls, org_a, org_b)
    return {
        "mutual": mutual,
        # 2026-06-14 결정: Mutual = 추가매칭 검토 신호. 대화 채널 자동개설은 v1 제외(backlog).
        "open_channel": False,
        "review_for_rematch": mutual,
    }


def love_call_visible_to(love_call: LoveCall, requesting_org_id: str) -> bool:
    """Love Call 은 받는 쪽(to_org)에게 보이는 공개 신호. 보낸 쪽도 자기 발신을 본다.

    제3자에게는 보이지 않는다.
    """
    return requesting_org_id in (love_call.to_org_id, love_call.from_org_id)


def serialize_review_for(
    review: dict,
    *,
    reviewer_org_id: str,
    requesting_org_id: str,
) -> dict:
    """리뷰 레코드를 요청자 관점으로 직렬화한다.

    - 본인(reviewer_org_id == requesting_org_id): 전체 필드 노출(자기 리뷰 열람·수정).
    - 그 외(상대·제3자): 비공개 필드를 **전부 제거**한다. Love Call 은 별도 경로(love_calls)로만
      전달되며 이 응답에는 비공개 평가가 절대 섞이지 않는다.

    review 는 평탄한 dict 라고 가정(직렬화 어댑터가 ORM→dict 변환을 끝낸 뒤 호출).
    """
    if requesting_org_id == reviewer_org_id:
        return dict(review)
    return {k: v for k, v in review.items() if k not in PRIVATE_REVIEW_FIELDS}


def assert_no_private_fields(payload: dict) -> None:
    """방어선: 상대에게 나가는 payload 에 비공개 필드가 한 개라도 있으면 즉시 실패.

    API 응답·내보내기 직전 호출해 회귀를 막는다(노출 규칙의 마지막 게이트).
    """
    leaked = PRIVATE_REVIEW_FIELDS & payload.keys()
    if leaked:
        raise LoveCallError(f"비공개 필드가 노출되었습니다: {sorted(leaked)}")
