"""가입 이메일 인증코드 테이블 — email_verification_codes (#9 실존 이메일 인증)

Revision ID: ev001code0001
Revises: nt003rej0001
Create Date: 2026-09-15

발주자 정정(2026-09-15): "실존하는 이메일인지 체크하는 방법이 없다" — 가입 중 코드 확인 방식으로
확정. 자체 가입(app.auth.signup_service, authfe0001) 흐름에 이메일 인증 단계를 끼워 넣는다.

평문 코드는 저장하지 않는다(code_hash만, app.auth.email_verification_service). 재발송 시 같은
email의 기존 미소비 코드는 consumed_at을 채워 무효화하고, 검증 실패 5회 초과 시에도 같은 방식으로
무효화한다 — 별도 상태 컬럼 없이 consumed_at 하나로 "더 이상 쓸 수 없음"을 표현한다.
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "ev001code0001"
down_revision: Union[str, None] = "nt003rej0001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "email_verification_codes",
        sa.Column("id", postgresql.UUID(as_uuid=False), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("email", sa.Text(), nullable=False),
        sa.Column("code_hash", sa.Text(), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("consumed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("attempt_count", sa.Integer(), nullable=False, server_default=sa.text("0")),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.PrimaryKeyConstraint("id", name="email_verification_codes_pkey"),
    )
    op.create_index(
        "ix_email_verification_codes_email_created_at",
        "email_verification_codes",
        ["email", "created_at"],
    )


def downgrade() -> None:
    op.drop_index("ix_email_verification_codes_email_created_at", table_name="email_verification_codes")
    op.drop_table("email_verification_codes")
