"""운영자 권한을 계정×행사 단위로 — permission_level 이동 + 바이어 소유권 링크(ADR-0012)

Revision ID: op47perm0001
Revises: bm002api0001
Create Date: 2026-06-28

ADR-0012(#47): 운영자 권한등급(master/sub)은 계정 전역이 아니라 계정×행사 단위다.
- organizers.permission_level(전역) → event_organizers.permission_level(행사별). 기존 행은 organizer_id
  로 옛 전역값을 백필한 뒤 NOT NULL·옛 컬럼 drop → 기존 데이터가 있어도 안전(codex P2).
- organization_event_roles 에 바이어 소유권 링크 2개 추가(sub 관할 정의, nullable·재배정 가능):
  managing_organizer_id(현재 관리 운영자) + created_by_organizer_id(최초 등록 운영자).

downgrade는 전역 컬럼을 복원하되, 행사별→전역은 본질적으로 손실이라(한 계정이 행사마다 등급이 다를 수
있음) "한 행사라도 master면 master"로 best-effort 역유도한다.
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "op47perm0001"
down_revision: Union[str, None] = "bm002api0001"  # 머지 후 단일 head 유지 — bm-002 마이그레이션 뒤로 선형화
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # 1. permission_level: organizers(전역) → event_organizers(행사별). 기존 값을 organizer_id로 백필해 보존.
    op.add_column("event_organizers", sa.Column("permission_level", sa.Text(), nullable=True))
    op.execute(
        "UPDATE event_organizers eo SET permission_level = o.permission_level "
        "FROM organizers o WHERE o.id = eo.organizer_id"
    )
    op.alter_column("event_organizers", "permission_level", existing_type=sa.Text(), nullable=False)
    op.create_check_constraint(
        "event_organizers_permission_level_check",
        "event_organizers",
        "permission_level IN ('master', 'sub')",
    )
    # 백필 후에만 옛 전역 컬럼을 제거(PG가 DROP COLUMN 시 의존 CHECK 자동 제거).
    op.drop_column("organizers", "permission_level")

    # 2. 바이어 소유권 링크(sub 관할) — nullable, 재배정 가능. 운영자 삭제 시 SET NULL(소유 흔적만 끊김).
    op.add_column(
        "organization_event_roles",
        sa.Column(
            "managing_organizer_id",
            postgresql.UUID(as_uuid=False),
            sa.ForeignKey("organizers.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )
    op.add_column(
        "organization_event_roles",
        sa.Column(
            "created_by_organizer_id",
            postgresql.UUID(as_uuid=False),
            sa.ForeignKey("organizers.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )


def downgrade() -> None:
    op.drop_column("organization_event_roles", "created_by_organizer_id")
    op.drop_column("organization_event_roles", "managing_organizer_id")

    # 전역 컬럼 복원 — 행사별→전역은 손실이라 best-effort: 한 행사라도 master면 master, 아니면 'sub'.
    # event_organizers.permission_level 을 드롭하기 전에 역유도해야 값을 읽을 수 있다.
    op.add_column(
        "organizers",
        sa.Column("permission_level", sa.Text(), nullable=False, server_default=sa.text("'sub'")),
    )
    op.execute(
        "UPDATE organizers o SET permission_level = 'master' "
        "WHERE EXISTS (SELECT 1 FROM event_organizers eo "
        "WHERE eo.organizer_id = o.id AND eo.permission_level = 'master')"
    )
    op.create_check_constraint(
        "organizers_permission_level_check",
        "organizers",
        "permission_level IN ('master', 'sub')",
    )
    op.drop_column("event_organizers", "permission_level")  # PG가 의존 CHECK 자동 제거
