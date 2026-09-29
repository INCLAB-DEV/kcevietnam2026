"""event_organizers.created_at 추가 — 운영자 목록 API의 granted_at 계약 충족

Revision ID: orggrant0001
Revises: authfe0001
Create Date: 2026-08-28

app.admin.schemas.OrganizerOut.granted_at(``event_organizers.created_at``, non-null)과
app.admin.router._organizer_out가 이미 이 컬럼을 전제하고 있었는데(#OP 운영자 목록/부여, adminvn0001
슬라이스), 실제로는 한 번도 마이그레이션되지 않았다 — Postgres 통합 테스트가 그동안 로컬에 Postgres가
없어 전부 skip돼 왔던 탓에 ``AttributeError: 'EventOrganizer' object has no attribute 'created_at'``이
드러나지 않고 있었다. 기존 배정 행의 배정 시각은 알 길이 없으니 마이그레이션 시점을 백필값으로 쓴다
(서버 디폴트 now()와 동일 규칙 — 신규 행은 INSERT 시각이 곧 배정 시각).
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "orggrant0001"
down_revision: Union[str, None] = "authfe0001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "event_organizers",
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
    )


def downgrade() -> None:
    op.drop_column("event_organizers", "created_at")
