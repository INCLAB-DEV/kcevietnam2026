"""MY-002 전사 작업(transcription_jobs) 영속화 — 인메모리 저장소를 DB 테이블로 교체

Revision ID: my002job0001
Revises: bm003nokotra
Create Date: 2026-09-07

app.services.transcription_jobs.TranscriptionJobStore 가 프로세스 메모리 dict로 작업 상태를
들고 있었다(데모 전제 명시). ECS 다중 태스크에선 접수(POST)와 폴링(GET)이 다른 프로세스에
떨어질 수 있어 깨진다 — 이 테이블로 옮겨 어느 프로세스가 받아도 조회되게 한다.

기존 TranscriptionJob 데이터클래스 필드(job_id, meeting_id, org_id, status, draft, error)를
그대로 컬럼화. draft 는 StructureDraftResponse 를 opaque JSON으로 저장(스키마 결합 없음).
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "my002job0001"
down_revision: Union[str, None] = "bm003nokotra"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "transcription_jobs",
        sa.Column("id", sa.UUID(as_uuid=False), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("meeting_id", sa.UUID(as_uuid=False), nullable=False),
        sa.Column("org_id", sa.UUID(as_uuid=False), nullable=False),
        sa.Column("status", sa.Text(), server_default=sa.text("'pending'"), nullable=False),
        sa.Column("draft", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.CheckConstraint("status IN ('pending', 'done', 'error')", name="transcription_jobs_status_check"),
        sa.ForeignKeyConstraint(["meeting_id"], ["meetings.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["org_id"], ["organizations.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "transcription_jobs_meeting_id_org_id_idx", "transcription_jobs", ["meeting_id", "org_id"]
    )


def downgrade() -> None:
    op.drop_index("transcription_jobs_meeting_id_org_id_idx", table_name="transcription_jobs")
    op.drop_table("transcription_jobs")
