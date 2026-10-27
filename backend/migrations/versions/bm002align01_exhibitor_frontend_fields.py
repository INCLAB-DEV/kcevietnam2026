"""참가사 프로필 프론트 정렬 — 신규 필드 컬럼 추가 (BM-002 #28, docs/db/bm-profile-fields §4)

프론트 폼(BM-002)이 실제로 수집하는 필드를 백엔드에 반영(codex P1 단계계약 정렬):
- exhibitor_profiles: 부스 신고값 스냅샷(booth_hall/pavilion/location/type/count), 대표자명(국/영),
  회사 이메일/우편번호/상세주소, 업태/종목, 선호 바이어 국가/구분(멀티 text[]).
- exhibitor_products: 사양(영문) spec_en, 제품별 가격대 price_range(프로필 단위 product_price_range에서 이동).
폐기 필드(product_intro_*·product_price_range·preferred_buyer_country·participation_route·
kst_available_time)는 비파괴 보존(컬럼 유지, API 미수집).

Revision ID: bm002align01
Revises: bm002slot01
Create Date: 2026-06-29
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "bm002align01"
down_revision: Union[str, None] = "bm002slot01"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_PROFILE_TEXT_COLS = [
    "booth_hall", "booth_pavilion", "booth_location", "booth_type",
    "representative_name_ko", "representative_name_en", "company_email",
    "zip_code", "business_type", "business_item", "address_detail",
]


def upgrade() -> None:
    for col in _PROFILE_TEXT_COLS:
        op.add_column("exhibitor_profiles", sa.Column(col, sa.Text(), nullable=True))
    op.add_column("exhibitor_profiles", sa.Column("booth_count", sa.Integer(), nullable=True))
    op.add_column(
        "exhibitor_profiles",
        sa.Column("preferred_buyer_countries", postgresql.ARRAY(sa.Text()), nullable=True),
    )
    op.add_column(
        "exhibitor_profiles",
        sa.Column("preferred_buyer_types", postgresql.ARRAY(sa.Text()), nullable=True),
    )
    op.add_column("exhibitor_products", sa.Column("spec_en", sa.Text(), nullable=True))
    op.add_column("exhibitor_products", sa.Column("price_range", sa.Text(), nullable=True))
    op.create_check_constraint(
        "exhibitor_products_price_range_check",
        "exhibitor_products",
        "price_range IN ('krw_0_10m', 'krw_10_30m', 'krw_30_50m', 'krw_50_70m', 'krw_70_100m')",
    )


def downgrade() -> None:
    op.drop_constraint("exhibitor_products_price_range_check", "exhibitor_products", type_="check")
    op.drop_column("exhibitor_products", "price_range")
    op.drop_column("exhibitor_products", "spec_en")
    op.drop_column("exhibitor_profiles", "preferred_buyer_types")
    op.drop_column("exhibitor_profiles", "preferred_buyer_countries")
    op.drop_column("exhibitor_profiles", "booth_count")
    for col in reversed(_PROFILE_TEXT_COLS):
        op.drop_column("exhibitor_profiles", col)
