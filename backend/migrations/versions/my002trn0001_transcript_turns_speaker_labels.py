"""MY-002 화자별 전사 — post_meeting_reviews.transcript_turns(JSONB) 추가

Revision ID: my002trn0001
Revises: my002rev0001
Create Date: 2026-06-28

전사 원문을 화자별(우리/상대) turns([{who, text}])로 AI 추정·라벨링해 저장한다(#97).
transcript 와 동일하게 업로더 전용 비공개(ADR-0004) — 상대 비노출은 API 노출규칙이 보장한다.
nullable — 기존 행 무손실.
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "my002trn0001"
down_revision: Union[str, None] = "my002rev0001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "post_meeting_reviews",
        sa.Column("transcript_turns", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("post_meeting_reviews", "transcript_turns")
