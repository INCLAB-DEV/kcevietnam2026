"""KOTRA 회원 여부 필드 삭제 — exhibitor_profiles/buyer_profiles.kotra_member 컬럼 drop

REQ-06B(PPT 슬라이드6 확정) — 참가사/바이어 신청서의 "KOTRA 회원 여부" 필드를 전 계층에서 제거한다.
스키마 원본은 ``docs/db/bm-profile-fields.md`` §3.1(buyer_profiles)·§4.1(exhibitor_profiles) —
문서도 이 리비전과 함께 갱신 대상(HITL 후속). 두 테이블 모두 단순 nullable Boolean 컬럼이고
CHECK 제약·FK가 걸려 있지 않아 컬럼 하나만 drop하면 된다(kotra_invitation은 별개 필드 —
AcquisitionChannel 열거값 "어떻게 알고 왔는지"이지 회원 여부가 아니라 그대로 둔다).

Revision ID: bm003nokotra
Revises: kct001tax01
Create Date: 2026-09-05
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "bm003nokotra"
down_revision: Union[str, None] = "kct001tax01"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.drop_column("exhibitor_profiles", "kotra_member")
    op.drop_column("buyer_profiles", "kotra_member")


def downgrade() -> None:
    # 데이터 손실 경고: 컬럼만 복원한다 — upgrade 이전에 입력돼 있던 kotra_member 값은
    # drop 시점에 이미 사라져 되살릴 수 없다(데모/테스트 환경 전제, kct001tax01과 같은 패턴).
    op.add_column("buyer_profiles", sa.Column("kotra_member", sa.Boolean(), nullable=True))
    op.add_column("exhibitor_profiles", sa.Column("kotra_member", sa.Boolean(), nullable=True))
