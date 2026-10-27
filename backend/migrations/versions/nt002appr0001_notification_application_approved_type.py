"""NT-002 notifications.type에 application_approved 추가 — 신청 승인 완료 통지.

Revision ID: nt002appr0001
Revises: vilang0001
Create Date: 2026-09-12

운영자가 신청서를 승인해도 당사자에게 통지가 가지 않던 공백을 메운다(사장님 직접 결정,
2026-09-12). notifications_type_check에 7번째 값을 추가한다 — nt001type01과 동일 패턴.
"""

from typing import Sequence, Union

from alembic import op

revision: str = "nt002appr0001"
down_revision: Union[str, None] = "vilang0001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_OLD_CHECK = (
    "type IN ('meeting_requested', 'meeting_accepted', 'meeting_cancelled', "
    "'meeting_reminder', 'review_prompt', 'review_ready')"
)
_NEW_CHECK = (
    "type IN ('meeting_requested', 'meeting_accepted', 'meeting_cancelled', "
    "'meeting_reminder', 'review_prompt', 'review_ready', 'application_approved')"
)


def upgrade() -> None:
    op.drop_constraint("notifications_type_check", "notifications", type_="check")
    op.create_check_constraint("notifications_type_check", "notifications", _NEW_CHECK)


def downgrade() -> None:
    op.drop_constraint("notifications_type_check", "notifications", type_="check")
    op.create_check_constraint("notifications_type_check", "notifications", _OLD_CHECK)
