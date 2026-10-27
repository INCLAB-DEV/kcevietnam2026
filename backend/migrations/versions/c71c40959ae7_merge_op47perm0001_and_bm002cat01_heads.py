"""merge heads: op47perm0001 ↔ bm002cat01 (배포 차단 P0 — multiple heads 해소)

bm002api0001 이후 두 브랜치가 병렬로 갈라져 head가 2개였다(alembic upgrade head 실패):
- op47perm0001: 운영자 권한을 organizers→event_organizers로 이동 + organization_event_roles에
  바이어 소유권 링크(managing_organizer_id/created_by_organizer_id) 추가.
- bm002slot01→bm002align01→bm002cat01: exhibitor_profiles/exhibitor_products 컬럼 추가 체인.
두 브랜치는 겹치는 테이블·컬럼이 없어(권한 계열 vs 참가사 프로필 계열) 스키마 충돌 없음 —
순수 head 정리 목적의 no-op 머지.

Revision ID: c71c40959ae7
Revises: op47perm0001, bm002cat01
Create Date: 2026-08-28 14:56:07.097302
"""
from typing import Sequence, Union

revision: str = "c71c40959ae7"
down_revision: Union[str, None] = ("op47perm0001", "bm002cat01")
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
