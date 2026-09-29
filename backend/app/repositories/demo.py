"""데모 시드 리포지토리 — 키 없이 로컬 end-to-end 테스트용.

요청된 meeting_id 가 없으면 고정 데모 미팅(참가사 exh-1 ↔ 바이어 buyer-1, AI 매칭)을 즉석 생성한다.
FE MOCK_ACCOUNTS 의 orgId(exh-1/buyer-1)와 맞춰 두 계정(as=exhibitor/buyer) 모두 동작한다.
운영에는 절대 쓰지 않는다(NABI_DEMO_SEED=true 일 때만 deps 가 선택).
"""

from __future__ import annotations

from app.domain.review_provenance_binding import MatchingType
from app.repositories.base import MeetingView
from app.repositories.memory import InMemoryRepository

DEMO_EXHIBITOR = "exh-1"
DEMO_BUYER = "buyer-1"


class DemoInMemoryRepository(InMemoryRepository):
    def get_meeting(self, meeting_id: str) -> MeetingView | None:
        existing = super().get_meeting(meeting_id)
        if existing is not None:
            return existing
        meeting = MeetingView(
            meeting_id=meeting_id,
            event_id="demo-event",
            exhibitor_org_id=DEMO_EXHIBITOR,
            buyer_org_id=DEMO_BUYER,
            matching_type=MatchingType.AI,
            ai_score=0.9,
            ai_score_reasons=["제품 적합성", "기술 성숙도"],
        )
        self.add_meeting(meeting)
        return meeting
