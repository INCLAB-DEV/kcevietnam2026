"""NT-003 notifications.type에 meeting_rejected 추가 — 미팅 거절 통지.

Revision ID: nt003rej0001
Revises: nt002appr0001
Create Date: 2026-09-15

미팅 거절 시 신청한 쪽(awaiting 반대편)에 통지가 가지 않던 공백을 메운다(발주자 요청,
GitHub #4 · docs/backlog/qa-fix-plan-2026-09-15.md F3). nt002appr0001과 동일 패턴으로
notifications_type_check에 8번째 값을 추가한다.
"""

from typing import Sequence, Union

from alembic import op

revision: str = "nt003rej0001"
down_revision: Union[str, None] = "nt002appr0001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_OLD_CHECK = (
    "type IN ('meeting_requested', 'meeting_accepted', 'meeting_cancelled', "
    "'meeting_reminder', 'review_prompt', 'review_ready', 'application_approved')"
)
_NEW_CHECK = (
    "type IN ('meeting_requested', 'meeting_accepted', 'meeting_cancelled', "
    "'meeting_reminder', 'review_prompt', 'review_ready', 'application_approved', "
    "'meeting_rejected')"
)


def upgrade() -> None:
    op.drop_constraint("notifications_type_check", "notifications", type_="check")
    op.create_check_constraint("notifications_type_check", "notifications", _NEW_CHECK)


def downgrade() -> None:
    op.drop_constraint("notifications_type_check", "notifications", type_="check")
    op.create_check_constraint("notifications_type_check", "notifications", _OLD_CHECK)
