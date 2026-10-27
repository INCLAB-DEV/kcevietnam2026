"""참가사 미팅 가능시간(불가 슬롯) 저장 컬럼 추가 (BM-002 / docs/db/bm-profile-fields §4.1·§7)

타겟 단계에서 설정한 '행사 기간 미팅 가능/불가' 선택을 저장한다. 기본은 전부 가능 → 불가 슬롯만
opt-out 으로 보관(키="YYYY-MM-DDTHH:MM"). 슬롯 그리드(운영시간·슬롯길이·행사일)는
event_schedule_settings/events 에서 파생하고, 여기엔 참가사의 '선택'만 둔다.
kst_available_time(자유텍스트, v1)을 구조화로 보강(§7 HITL 슬롯 구조화 일부 해소).

Revision ID: bm002slot01
Revises: bm002api0001
Create Date: 2026-06-29
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "bm002slot01"
down_revision: Union[str, None] = "bm002api0001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "exhibitor_profiles",
        sa.Column("unavailable_meeting_slots", postgresql.ARRAY(sa.Text()), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("exhibitor_profiles", "unavailable_meeting_slots")
