"""K-콘텐츠 택소노미 피벗 — 방산13(defense_field) → 사업분야8(business_field) + 카테고리3(content_category)

도메인 택소노미를 방산 전시(KADEX)에서 K-콘텐츠(애니메이션/캐릭터·방송·만화웹툰/게임/음악)로 전면
교체한다(발주사 확정 스펙). 데이터는 1:1 매핑이 없어 폐기·재시드 전제(demo_seed.py가 K-콘텐츠
기업 5곳으로 다시 채운다).

- ``exhibitor_products.category``(text+CHECK, 방산13) → **컬럼 rename** ``business_field``(text+CHECK,
  사업분야8). CHECK 제약도 이름·값 교체. 기존 값은 새 어휘와 호환되지 않아 rename 전에 NULL로 비운다.
- ``keywords``: namespace ``'defense_field'`` 13행 삭제 → ``'business_field'`` 8행 삽입(셀러
  전시품목·바이어 관심분야 공용 멀티선택 — ``exhibitor_keywords``/``buyer_interest_keywords``가 그대로
  참조). ``keywords.category`` 컬럼 자체는 namespace 식별자라 건드리지 않는다.
- ``exhibitor_profiles.content_category``: **신규 스칼라** text+CHECK(카테고리3, nullable, 셀러
  전용 단일선택) — keyword 조인이 아니다. discover 카드 태그 쿼리(``exhibitor_keywords`` JOIN
  ``keywords``)가 namespace를 필터하지 않아, 조인에 넣으면 8분야 태그와 3카테고리가 뒤섞인다.
  Hall 필터를 대체하는 회사 분류축(단일선택 성격 + 필터 단순화 + 기존 enum 컬럼과 동일 패턴).
- 네이티브 Postgres ENUM 타입은 이 레포에 없다(전부 text+CHECK) — enum 타입 수술 불필요.

Revision ID: kct001tax01
Revises: i18n0001
Create Date: 2026-09-05
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "kct001tax01"
down_revision: Union[str, None] = "i18n0001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

# 사업분야(business_field, 셀러·바이어 공용·멀티선택, 8종) — app.models.BUSINESS_FIELDS와 동일값.
_BUSINESS_FIELDS = (
    "game_production", "animation_distribution", "content_production", "music_platform",
    "newtech_content", "character_licensor", "webtoon_production", "music_production",
)
# 카테고리(content_category, 셀러 전용·단일선택, 3종) — app.models.CONTENT_CATEGORIES와 동일값.
_CONTENT_CATEGORIES = ("animation_character", "broadcasting", "comics_game_music")

# keywords 마스터 시드(code, label_ko, label_en) — demo_seed.DEMO_BUSINESS_FIELDS와 반드시 동일값
# 유지(다르면 재시드가 마스터 라벨을 조용히 덮어쓴다 — bm002api0001/i18n0001과 같은 선례).
_BUSINESS_FIELD_LABELS: list[tuple[str, str, str]] = [
    ("game_production", "게임 제작", "Game Production"),
    ("animation_distribution", "애니메이션 유통 및 배급", "Animation Distribution"),
    ("content_production", "콘텐츠 제작", "Content Production"),
    ("music_platform", "음악 플랫폼", "Music Platform"),
    ("newtech_content", "신기술융합콘텐츠", "New-Tech Convergence Content"),
    ("character_licensor", "캐릭터 라이센서", "Character Licensor"),
    ("webtoon_production", "만화웹툰 제작", "Comics & Webtoon Production"),
    ("music_production", "음악 제작", "Music Production"),
]

# downgrade 복원용 — 폐기 전 방산13 마스터(bm002api0001 ko 라벨 + i18n0001 이후 demo_seed.py
# DEMO_DEFENSE_FIELDS en 라벨과 동일값). best-effort 복원이지, 이 리비전 이후 실제로 입력된
# 방산분야 데이터(이미 폐기·재시드 대상)까지 되살리는 것은 아니다.
_DEFENSE_FIELD_LABELS: list[tuple[str, str, str]] = [
    ("mobility", "기동장비", "Mobility Equipment"),
    ("firepower", "화력장비", "Firepower Equipment"),
    ("protection", "방호장비", "Protection Equipment"),
    ("aviation", "항공장비", "Aviation Equipment"),
    ("unmanned_drone", "무인장비 및 드론", "Unmanned Systems & Drones"),
    ("maritime", "해양장비", "Maritime Equipment"),
    ("c4i_security", "지휘/통신/보안장비", "C4I, Communication & Security"),
    ("training", "훈련장비", "Training Equipment"),
    ("civmil_cooperation", "민군협력기술", "Civil-Military Cooperation Technology"),
    ("air_space", "Air&Space", "Air & Space"),
    ("apparel_personal", "피복 및 개인장구류", "Apparel & Personal Equipment"),
    ("rescue_medical", "인명구조 및 의료장비", "Rescue & Medical Equipment"),
    ("other", "기타", "Other"),
]


def _check(column: str, values: tuple[str, ...]) -> str:
    joined = ", ".join(f"'{v}'" for v in values)
    return f"{column} IN ({joined})"


def upgrade() -> None:
    # === 1. exhibitor_products: category(방산13) → business_field(사업분야8) ===
    op.drop_constraint("exhibitor_products_category_check", "exhibitor_products", type_="check")
    # 구 코드(방산13)는 새 CHECK와 호환되지 않는다 — rename 전에 비운다(재시드가 다시 채운다).
    op.execute("UPDATE exhibitor_products SET category = NULL")
    op.alter_column("exhibitor_products", "category", new_column_name="business_field")
    op.create_check_constraint(
        "exhibitor_products_business_field_check",
        "exhibitor_products",
        _check("business_field", _BUSINESS_FIELDS),
    )

    # === 2. exhibitor_profiles: content_category(카테고리3) 신규 스칼라 — nullable, 셀러 전용 ===
    op.add_column("exhibitor_profiles", sa.Column("content_category", sa.Text(), nullable=True))
    op.create_check_constraint(
        "exhibitor_profiles_content_category_check",
        "exhibitor_profiles",
        _check("content_category", _CONTENT_CATEGORIES),
    )

    # === 3. keywords: defense_field(13) 마스터 삭제 → business_field(8) 마스터 삽입 ===
    # exhibitor_keywords/buyer_interest_keywords는 keyword_id FK라 부모 삭제 시 CASCADE로 링크도
    # 함께 지워진다(구 방산 링크는 어차피 폐기 대상). 새 마스터는 이 링크가 참조할 8종을 심는다.
    op.execute("DELETE FROM keywords WHERE category = 'defense_field'")
    keywords = sa.table(
        "keywords",
        sa.column("code", sa.Text),
        sa.column("label", sa.Text),
        sa.column("label_en", sa.Text),
        sa.column("category", sa.Text),
    )
    op.bulk_insert(
        keywords,
        [
            {"code": code, "label": label_ko, "label_en": label_en, "category": "business_field"}
            for code, label_ko, label_en in _BUSINESS_FIELD_LABELS
        ],
    )


def downgrade() -> None:
    # 역순 — 스키마는 완전 복원, 데이터는 best-effort(이 리비전 하위에서 입력된 값은 이미 폐기 전제).
    # ⚠ 데이터 손실 경고: 이 downgrade는 스키마(컬럼·CHECK·keywords 마스터)는 upgrade 이전 상태로
    # 완전히 되돌리지만, upgrade 적용 이후 실제로 입력된 business_field/content_category 데이터는
    # 복원 대상이 아니라 NULL로 소실된다(exhibitor_products.business_field는 UPDATE ... SET NULL,
    # exhibitor_profiles.content_category는 컬럼 자체가 drop). 데모/테스트 환경 전제이며, 운영
    # 데이터 무손실 다운그레이드를 보장하지 않는다.
    op.execute("DELETE FROM keywords WHERE category = 'business_field'")
    keywords = sa.table(
        "keywords",
        sa.column("code", sa.Text),
        sa.column("label", sa.Text),
        sa.column("label_en", sa.Text),
        sa.column("category", sa.Text),
    )
    op.bulk_insert(
        keywords,
        [
            {"code": code, "label": label_ko, "label_en": label_en, "category": "defense_field"}
            for code, label_ko, label_en in _DEFENSE_FIELD_LABELS
        ],
    )

    op.drop_constraint("exhibitor_profiles_content_category_check", "exhibitor_profiles", type_="check")
    op.drop_column("exhibitor_profiles", "content_category")

    op.drop_constraint("exhibitor_products_business_field_check", "exhibitor_products", type_="check")
    op.execute("UPDATE exhibitor_products SET business_field = NULL")
    op.alter_column("exhibitor_products", "business_field", new_column_name="category")
    op.create_check_constraint(
        "exhibitor_products_category_check",
        "exhibitor_products",
        _check("category", (
            "mobility", "firepower", "protection", "aviation", "unmanned_drone", "maritime",
            "c4i_security", "training", "civmil_cooperation", "air_space", "apparel_personal",
            "rescue_medical", "other",
        )),
    )
