"""i18n 데이터 레벨 — keywords.label_en(영문 표시 라벨) 추가

Revision ID: i18n0001
Revises: mt001meet01
Create Date: 2026-09-02

참가자 화면의 "완전한" ko/en 요건(docs/backlog/i18n-full-bilingual.md)은 UI 문구뿐 아니라
**데이터 콘텐츠까지** 번역하라고 한다. 기업명·소개·제품명은 이미 국/영 컬럼 쌍을 갖고 있는데
(``organizations.name_ko/name_en``, ``exhibitor_profiles.intro_ko/intro_en``,
``exhibitor_products.name_ko/name_en``) 분류 키워드만 국문 라벨 하나뿐이라, en 로케일에서
탐색 카드의 keywords만 한국어로 남는다. 그 구멍을 메운다.

``code``(영문 슬러그)를 그대로 보여주는 선택지는 없다 — 'unmanned_drone'은 식별자지 표시
라벨이 아니다. nullable로 두는 건 의도적이다: 번역이 없는 키워드는 국문 라벨로 폴백한다
(``label_en ?? label``). 빈 문자열로 채우면 "번역 없음"과 "번역이 빈 값"을 구분할 수 없다.
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "i18n0001"
down_revision: Union[str, None] = "mt001meet01"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("keywords", sa.Column("label_en", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("keywords", "label_en")
