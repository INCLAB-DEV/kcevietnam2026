"""대리작성 신청을 실제 신청 상태로 전환하고 기존 건을 매칭 풀에 포함한다.

Revision ID: proxyapp0001
Revises: lc001mail01
Create Date: 2026-09-16

기존 대리작성은 프로필만 저장하고 application_status를 registered로 남겨, 화면에는 계속
"미신청"으로 보이고 매칭 대상(approved)에도 들어가지 않았다. 새 쓰기 경로는 master 작성 시
즉시 approved, sub 작성 시 submitted로 전환한다. 이 마이그레이션도 작성자의 현재 행사 권한을
확인해 기존 master 작성은 approved, 나머지는 submitted로 백필한다.
"""

from typing import Sequence, Union

from alembic import op

revision: str = "proxyapp0001"
down_revision: Union[str, None] = "lc001mail01"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_MIGRATION_REVIEW_NOTE = "기존 대리작성 신청 자동 승인 (proxyapp0001)"


def upgrade() -> None:
    op.execute(
        f"""
        UPDATE organization_event_roles
           SET application_status = 'approved',
               reviewed_at = CURRENT_TIMESTAMP,
               reviewed_by = proxy_written_by_organizer_id,
               review_note = '{_MIGRATION_REVIEW_NOTE}'
         WHERE application_status = 'registered'
           AND proxy_written_by_organizer_id IS NOT NULL
           AND EXISTS (
               SELECT 1
                 FROM event_organizers eo
                WHERE eo.event_id = organization_event_roles.event_id
                  AND eo.organizer_id = organization_event_roles.proxy_written_by_organizer_id
                  AND eo.permission_level = 'master'
           )
        """
    )
    op.execute(
        """
        UPDATE organization_event_roles
           SET application_status = 'submitted'
         WHERE application_status = 'registered'
           AND proxy_written_by_organizer_id IS NOT NULL
        """
    )


def downgrade() -> None:
    op.execute(
        """
        UPDATE organization_event_roles
           SET application_status = 'registered'
         WHERE application_status = 'submitted'
           AND proxy_written_by_organizer_id IS NOT NULL
        """
    )
    op.execute(
        f"""
        UPDATE organization_event_roles
           SET application_status = 'registered',
               reviewed_at = NULL,
               reviewed_by = NULL,
               review_note = NULL
         WHERE application_status = 'approved'
           AND review_note = '{_MIGRATION_REVIEW_NOTE}'
           AND reviewed_by = proxy_written_by_organizer_id
        """
    )
