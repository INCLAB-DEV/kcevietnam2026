"""NT-001 notifications.type에 review_ready 추가 — 회의록 정리 완료(AI 전사·구조화 완료) 통지.

Revision ID: nt001type01
Revises: c71c40959ae7
Create Date: 2026-08-28

ADR-0010(알림 모델)은 알림 6종(신청받음/수락됨/취소됨/10분 리마인더/리뷰입력안내/회의록정리완료)을
정의한다. 초기 스키마(416bbb825e07)의 notifications_type_check는 5종만 반영했고 review_ready가
빠져 있었다 — FE 목업(frontend/lib/home/notification.ts NotificationType)은 이미 6종을 타입
계약으로 쓰고 있어 백엔드 CHECK 제약을 여기서 맞춘다(#44 알림 시스템 슬라이스).
"""

from typing import Sequence, Union

from alembic import op

revision: str = "nt001type01"
down_revision: Union[str, None] = "c71c40959ae7"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_OLD_CHECK = (
    "type IN ('meeting_requested', 'meeting_accepted', 'meeting_cancelled', "
    "'meeting_reminder', 'review_prompt')"
)
_NEW_CHECK = (
    "type IN ('meeting_requested', 'meeting_accepted', 'meeting_cancelled', "
    "'meeting_reminder', 'review_prompt', 'review_ready')"
)


def upgrade() -> None:
    op.drop_constraint("notifications_type_check", "notifications", type_="check")
    op.create_check_constraint("notifications_type_check", "notifications", _NEW_CHECK)


def downgrade() -> None:
    op.drop_constraint("notifications_type_check", "notifications", type_="check")
    op.create_check_constraint("notifications_type_check", "notifications", _OLD_CHECK)
