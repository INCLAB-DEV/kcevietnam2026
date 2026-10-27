"""OP-005 Phase 2 — saturation_draft_items 테이블 신설 (스키마만, 로직 없음)

전체 포화배정 run(saturation_batch_runs)의 미확정 제안을 항목 단위로 추적하는 draft 테이블.
proposed-Meeting 재사용은 참가자 노출·D9(활성 쌍 유니크) 오염이라 기각, JSON blob은 항목 단위
추적·부분 confirm/skip이 안 돼 기각 — 별도 테이블로 신설(op005-assignment-design 참고).

confirm 시 각 draft 항목이 book_meeting() 프리미티브로 물질화되며 materialized_meeting_id 에
그 결과 meetings.id 가 링크된다(status: draft → confirmed/skipped). 기존 테이블은 무변경 —
meetings.matching_type CHECK 확장 없음('ai' 재사용 + saturation_run_id IS NOT NULL로 식별).

Revision ID: op005sat0001
Revises: bm001buy0001
Create Date: 2026-09-07
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "op005sat0001"
down_revision: Union[str, None] = "bm001buy0001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "saturation_draft_items",
        sa.Column("id", sa.UUID(as_uuid=False), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("saturation_run_id", sa.UUID(as_uuid=False), nullable=False),
        sa.Column("exhibitor_org_id", sa.UUID(as_uuid=False), nullable=False),
        sa.Column("buyer_org_id", sa.UUID(as_uuid=False), nullable=False),
        sa.Column("venue_id", sa.UUID(as_uuid=False), nullable=True),
        sa.Column("scheduled_start", sa.DateTime(timezone=True), nullable=False),
        sa.Column("scheduled_end", sa.DateTime(timezone=True), nullable=False),
        sa.Column("status", sa.Text(), server_default=sa.text("'draft'"), nullable=False),
        sa.Column("materialized_meeting_id", sa.UUID(as_uuid=False), nullable=True),
        sa.Column("seq_no", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.CheckConstraint(
            "status IN ('draft', 'confirmed', 'skipped')", name="saturation_draft_items_status_check"
        ),
        sa.ForeignKeyConstraint(
            ["saturation_run_id"], ["saturation_batch_runs.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(["exhibitor_org_id"], ["organizations.id"]),
        sa.ForeignKeyConstraint(["buyer_org_id"], ["organizations.id"]),
        sa.ForeignKeyConstraint(["venue_id"], ["meeting_venues.id"]),
        sa.ForeignKeyConstraint(["materialized_meeting_id"], ["meetings.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "saturation_run_id", "buyer_org_id", "exhibitor_org_id",
            name="saturation_draft_items_run_id_buyer_org_id_exhibitor_org_id_key",
        ),
    )


def downgrade() -> None:
    op.drop_table("saturation_draft_items")
