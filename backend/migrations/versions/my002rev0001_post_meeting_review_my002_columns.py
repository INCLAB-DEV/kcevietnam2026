"""MY-002 리뷰 컬럼 추가 — post_meeting_reviews에 만족도/Fit태그/녹음·전사·보고문서

Revision ID: my002rev0001
Revises: a1c0n5ent0001
Create Date: 2026-06-28

PR#68 초기 ERD의 post_meeting_reviews에 MY-002(미팅 회의록)가 쓰는 컬럼을 더한다:
  satisfaction_rating(1~5), fit_reason_tags(JSONB), audio_s3_key, transcript,
  report_sections(JSONB), report_confirmed_at. 모두 nullable — 기존 행 무손실.
전사·녹음은 업로더 전용 비공개(ADR-0004), 상대 비노출은 API 노출규칙이 보장한다.
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "my002rev0001"
down_revision: Union[str, None] = "a1c0n5ent0001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("post_meeting_reviews", sa.Column("satisfaction_rating", sa.Integer(), nullable=True))
    op.add_column(
        "post_meeting_reviews",
        sa.Column("fit_reason_tags", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
    )
    op.add_column("post_meeting_reviews", sa.Column("audio_s3_key", sa.Text(), nullable=True))
    op.add_column("post_meeting_reviews", sa.Column("transcript", sa.Text(), nullable=True))
    op.add_column(
        "post_meeting_reviews",
        sa.Column("report_sections", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
    )
    op.add_column(
        "post_meeting_reviews",
        sa.Column("report_confirmed_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_check_constraint(
        "post_meeting_reviews_satisfaction_rating_check",
        "post_meeting_reviews",
        "satisfaction_rating BETWEEN 1 AND 5",
    )


def downgrade() -> None:
    op.drop_constraint(
        "post_meeting_reviews_satisfaction_rating_check", "post_meeting_reviews", type_="check"
    )
    op.drop_column("post_meeting_reviews", "report_confirmed_at")
    op.drop_column("post_meeting_reviews", "report_sections")
    op.drop_column("post_meeting_reviews", "transcript")
    op.drop_column("post_meeting_reviews", "audio_s3_key")
    op.drop_column("post_meeting_reviews", "fit_reason_tags")
    op.drop_column("post_meeting_reviews", "satisfaction_rating")
