"""merge heads: adminvn0001 ↔ nt001type01 (병렬 슬라이스 head 정리)

c71c40959ae7 이후 두 브랜치가 병렬로 갈라져 head가 2개였다(alembic upgrade head 실패):
- adminvn0001: 슈퍼어드민 콘솔 + 베트남 피벗(events 정책 컬럼·organizers.member_id·대리작성 감사·
  interpreters/interpreter_assignments).
- nt001type01: notifications.type CHECK에 review_ready 추가.
두 브랜치는 겹치는 테이블·컬럼이 없어(어드민/행사 계열 vs 알림 타입 CHECK) 스키마 충돌 없음 —
순수 head 정리 목적의 no-op 머지.

Revision ID: adminnt0001
Revises: adminvn0001, nt001type01
Create Date: 2026-08-28
"""
from typing import Sequence, Union

revision: str = "adminnt0001"
down_revision: Union[str, None] = ("adminvn0001", "nt001type01")
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
