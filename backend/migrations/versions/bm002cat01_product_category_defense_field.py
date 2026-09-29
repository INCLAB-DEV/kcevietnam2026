"""전시 제품 카테고리를 전시품목 분야(방산13) 코드로 (BM-002 #28, docs/db/bm-profile-fields §4.2)

제품 카테고리를 자유텍스트(category_ko/en)에서 전시품목 분야 13 중 선택으로 변경.
exhibitor_products.category(defense_field 코드, CHECK) 추가. 기존 category_ko/en은 비파괴 보존.

Revision ID: bm002cat01
Revises: bm002align01
Create Date: 2026-06-29
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "bm002cat01"
down_revision: Union[str, None] = "bm002align01"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_DEFENSE = (
    "mobility, firepower, protection, aviation, unmanned_drone, maritime, c4i_security, "
    "training, civmil_cooperation, air_space, apparel_personal, rescue_medical, other"
)
_CHECK = "category IN (" + ", ".join(f"'{c.strip()}'" for c in _DEFENSE.split(",")) + ")"


def upgrade() -> None:
    op.add_column("exhibitor_products", sa.Column("category", sa.Text(), nullable=True))
    op.create_check_constraint("exhibitor_products_category_check", "exhibitor_products", _CHECK)


def downgrade() -> None:
    op.drop_constraint("exhibitor_products_category_check", "exhibitor_products", type_="check")
    op.drop_column("exhibitor_products", "category")
