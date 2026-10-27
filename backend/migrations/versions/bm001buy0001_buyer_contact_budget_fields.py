"""바이어 프로필 실배선 — 신청자 식별(contact_*)·회사소개 국문·예산/도입시기 컬럼 추가 (BM-001)

FE 폼(lib/apply/types.ts BuyerProfileDraft)이 이미 수집하는 필드를 백엔드에 반영(참가사 BM-002
bm002align01과 동일한 "프론트 정렬" 패턴). buyer_profiles:
- 신청자 식별(신규, 2026-06-29): contact_name_ko/en · contact_title_ko/en · contact_email ·
  contact_language · contact_interpreter_need. contact_name_en·contact_email은 제출 필수이나
  DB CHECK가 아니라 서비스 계층(bm/service._validate_submit)에서 강제(부분저장은 계속 허용).
  contact_language는 FE Lang(현재 en/vi)이 backend MEETING_LANGUAGES(ko/en/zh/ja/ru/other)와
  다른 별개 어휘라 CHECK 없이 text — vi가 CHECK 위반으로 막히는 걸 방지.
- 회사소개 국문(company_intro_ko) — 기존 company_intro_en의 국문 짝.
- 지출 가능 예산(budget_range)·도입 시기(adoption_timeline) — FE BudgetRange/AdoptionTimeline
  구간 CHECK(app.models.BUDGET_RANGES/ADOPTION_TIMELINES).

Revision ID: bm001buy0001
Revises: my002job0001
Create Date: 2026-09-07
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "bm001buy0001"
down_revision: Union[str, None] = "my002job0001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_TEXT_COLS = [
    "contact_name_ko", "contact_name_en", "contact_title_ko", "contact_title_en",
    "contact_email", "contact_language", "company_intro_ko",
]

_BUDGET_RANGES = ("usd_lt_100k", "usd_100k_500k", "usd_500k_1m", "usd_1m_5m", "usd_5m_10m", "usd_10m_plus")
_ADOPTION_TIMELINES = (
    "2026_h2", "2027_h1", "2027_h2", "2028_h1", "2028_h2",
    "2029_h1", "2029_h2", "2030_h1", "2030_h2", "undecided",
)


def upgrade() -> None:
    for col in _TEXT_COLS:
        op.add_column("buyer_profiles", sa.Column(col, sa.Text(), nullable=True))
    op.add_column("buyer_profiles", sa.Column("contact_interpreter_need", sa.Boolean(), nullable=True))
    op.add_column("buyer_profiles", sa.Column("budget_range", sa.Text(), nullable=True))
    op.add_column("buyer_profiles", sa.Column("adoption_timeline", sa.Text(), nullable=True))
    op.create_check_constraint(
        "buyer_profiles_budget_range_check",
        "buyer_profiles",
        "budget_range IN (" + ", ".join(f"'{v}'" for v in _BUDGET_RANGES) + ")",
    )
    op.create_check_constraint(
        "buyer_profiles_adoption_timeline_check",
        "buyer_profiles",
        "adoption_timeline IN (" + ", ".join(f"'{v}'" for v in _ADOPTION_TIMELINES) + ")",
    )


def downgrade() -> None:
    op.drop_constraint("buyer_profiles_adoption_timeline_check", "buyer_profiles", type_="check")
    op.drop_constraint("buyer_profiles_budget_range_check", "buyer_profiles", type_="check")
    op.drop_column("buyer_profiles", "adoption_timeline")
    op.drop_column("buyer_profiles", "budget_range")
    op.drop_column("buyer_profiles", "contact_interpreter_need")
    for col in reversed(_TEXT_COLS):
        op.drop_column("buyer_profiles", col)
