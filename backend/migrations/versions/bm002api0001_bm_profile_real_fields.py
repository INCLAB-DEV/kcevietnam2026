"""BM 프로필 실제 등록폼 필드로 교체 + 승인 게이트 + 부속 테이블 (#26 / docs/db/bm-profile-fields)

DX Korea 등록폼 + KOTRA 요구사항으로 잠정 컬럼을 대체한다:
- organizations: name → name_ko/name_en(둘 다 nullable), description/founded/employees 제거.
- keywords: code 추가, unique(label) → unique(category, code). 방산 13분야·기관유형 8종 시드.
- buyer/exhibitor_profiles: 잠정 컬럼 제거 + 실제 필드(위치·구간 enum·국영문·파일 FK·참가경로).
- exhibitor_products: name → name_ko + 영문/카테고리/HS코드.
- organization_event_roles: application_status 승인 상태머신 + 검토 컬럼.
- 신규: files, org_event_role_org_types, buyer/exhibitor_attendees, buyer/exhibitor_recommended_buyers.

Revision ID: bm002api0001
Revises: my002trn0001
Create Date: 2026-06-28
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "bm002api0001"
down_revision: Union[str, None] = "my002trn0001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


# 고정 분류 시드(bm-profile-fields §1.1) — (code, label, category)
_DEFENSE = [
    ("mobility", "기동장비"), ("firepower", "화력장비"), ("protection", "방호장비"),
    ("aviation", "항공장비"), ("unmanned_drone", "무인장비 및 드론"), ("maritime", "해양장비"),
    ("c4i_security", "지휘/통신/보안장비"), ("training", "훈련장비"),
    ("civmil_cooperation", "민군협력기술"), ("air_space", "Air&Space"),
    ("apparel_personal", "피복 및 개인장구류"), ("rescue_medical", "인명구조 및 의료장비"),
    ("other", "기타"),
]
_ORG_TYPE = [
    ("private_defense", "민간기업(군납 전문)"), ("private_commercial", "민간기업(민간 기술)"),
    ("association", "협회 및 단체"), ("government", "정부 및 공공기관"),
    ("exhibition_agent", "전시회 및 에이전트"), ("media", "미디어"),
    ("local_gov", "지자체 및 기관"), ("other", "기타"),
]

# CHECK 리터럴(모델과 동일 — 마이그레이션은 자기완결적이라 하드코딩)
_C = {
    "annual_sales_buyer": "('usd_lt_500k', 'usd_500k_1m', 'usd_1m_5m', 'usd_gt_5m')",
    "annual_sales_seller": "('krw_1_5', 'krw_5_10', 'krw_10_50', 'krw_50plus')",
    "employee_range": "('e_0_10', 'e_11_50', 'e_51_100', 'e_101plus')",
    "business_perf": "('none', 'usd_1_1m', 'usd_1m_5m', 'usd_5m_plus')",
    "travelers": "('t_0_500', 't_501_1000', 't_1001_5000', 't_5001_10000', 't_10000plus')",
    "price": "('krw_0_10m', 'krw_10_30m', 'krw_30_50m', 'krw_50_70m', 'krw_70_100m')",
    "route": "('re_1_2', 're_3_5', 're_6plus', 'new')",
    "channel": "('edm', 'official_letter', 'kotra_invitation', 'website_sns', 'media')",
}
_LANGS = "ARRAY['ko','en','zh','ja','ru','other']::text[]"


def upgrade() -> None:
    # === 1. keywords: code + unique(category, code), 고정 분류 시드 ===
    op.add_column("keywords", sa.Column("code", sa.Text(), nullable=True))
    op.drop_constraint("keywords_label_key", "keywords", type_="unique")
    op.create_unique_constraint("keywords_category_code_key", "keywords", ["category", "code"])
    keywords = sa.table(
        "keywords", sa.column("code", sa.Text), sa.column("label", sa.Text), sa.column("category", sa.Text)
    )
    op.bulk_insert(
        keywords,
        [{"code": c, "label": label, "category": "defense_field"} for c, label in _DEFENSE]
        + [{"code": c, "label": label, "category": "org_type"} for c, label in _ORG_TYPE],
    )

    # === 2. organizations: name → name_ko/name_en(nullable), 잠정 컬럼 제거 ===
    op.add_column("organizations", sa.Column("name_ko", sa.Text(), nullable=True))
    op.add_column("organizations", sa.Column("name_en", sa.Text(), nullable=True))
    op.execute("UPDATE organizations SET name_ko = name")  # 명단 업체명(국문) 백필
    op.drop_column("organizations", "name")
    op.drop_column("organizations", "description")
    op.drop_column("organizations", "founded")
    op.drop_column("organizations", "employees")

    # === 3. files (프로필 file FK보다 먼저) ===
    op.create_table(
        "files",
        sa.Column("id", sa.UUID(as_uuid=False), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("s3_key", sa.Text(), nullable=False),
        sa.Column("s3_version_id", sa.Text()),
        sa.Column("original_filename", sa.Text()),
        sa.Column("content_type", sa.Text()),
        sa.Column("byte_size", sa.BigInteger()),
        sa.Column("checksum_sha256", sa.Text()),
        sa.Column("purpose", sa.Text(), nullable=False),
        sa.Column("owner_org_id", sa.UUID(as_uuid=False)),
        sa.Column("uploaded_by_member_id", sa.UUID(as_uuid=False)),
        sa.Column("scan_status", sa.Text(), server_default=sa.text("'pending'"), nullable=False),
        sa.Column("retention_until", sa.Date()),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["owner_org_id"], ["organizations.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["uploaded_by_member_id"], ["members.id"], ondelete="SET NULL"),
        sa.CheckConstraint(
            "purpose IN ('company_logo', 'company_profile', 'company_profile_doc', 'smartfill_source')",
            name="files_purpose_check",
        ),
        sa.CheckConstraint("scan_status IN ('pending', 'clean', 'infected')", name="files_scan_status_check"),
        sa.PrimaryKeyConstraint("id"),
    )

    # === 4. organization_event_roles: 승인 상태머신 + 검토 컬럼 ===
    op.drop_constraint("organization_event_roles_application_status_check", "organization_event_roles", type_="check")
    op.create_check_constraint(
        "organization_event_roles_application_status_check",
        "organization_event_roles",
        "application_status IN ('registered', 'submitted', 'changes_requested', 'approved', 'rejected')",
    )
    op.add_column("organization_event_roles", sa.Column("reviewed_at", sa.DateTime(timezone=True)))
    op.add_column("organization_event_roles", sa.Column("reviewed_by", sa.UUID(as_uuid=False)))
    op.add_column("organization_event_roles", sa.Column("review_note", sa.Text()))
    op.create_foreign_key(
        "organization_event_roles_reviewed_by_fkey", "organization_event_roles", "organizers",
        ["reviewed_by"], ["id"], ondelete="SET NULL",
    )

    # === 5. buyer_profiles: 잠정 제거 + 실제 필드 ===
    op.drop_constraint("buyer_profiles_adoption_timeline_check", "buyer_profiles", type_="check")
    for col in ("looking_for", "use_environment", "required_spec", "adoption_stage",
                "budget_range", "adoption_timeline", "current_adoption"):
        op.drop_column("buyer_profiles", col)
    for col in ("continent", "country", "city_state", "zip_code", "address1", "address2", "tel",
                "last_year_best_buyer", "annual_sales_range", "employee_range",
                "business_perf_korea_3y", "travelers_korea_3y", "company_intro_en", "note",
                "participation_route", "new_acquisition_channel", "kst_available_time"):
        op.add_column("buyer_profiles", sa.Column(col, sa.Text()))
    op.add_column("buyer_profiles", sa.Column("kotra_member", sa.Boolean()))
    op.add_column("buyer_profiles", sa.Column("company_logo_file_id", sa.UUID(as_uuid=False)))
    op.add_column("buyer_profiles", sa.Column("company_profile_file_id", sa.UUID(as_uuid=False)))
    op.create_foreign_key("buyer_profiles_company_logo_file_id_fkey", "buyer_profiles", "files", ["company_logo_file_id"], ["id"], ondelete="SET NULL")
    op.create_foreign_key("buyer_profiles_company_profile_file_id_fkey", "buyer_profiles", "files", ["company_profile_file_id"], ["id"], ondelete="SET NULL")
    op.create_check_constraint("buyer_profiles_annual_sales_range_check", "buyer_profiles", f"annual_sales_range IN {_C['annual_sales_buyer']}")
    op.create_check_constraint("buyer_profiles_employee_range_check", "buyer_profiles", f"employee_range IN {_C['employee_range']}")
    op.create_check_constraint("buyer_profiles_business_perf_korea_3y_check", "buyer_profiles", f"business_perf_korea_3y IN {_C['business_perf']}")
    op.create_check_constraint("buyer_profiles_travelers_korea_3y_check", "buyer_profiles", f"travelers_korea_3y IN {_C['travelers']}")
    op.create_check_constraint("buyer_profiles_participation_route_check", "buyer_profiles", f"participation_route IN {_C['route']}")
    op.create_check_constraint("buyer_profiles_new_acquisition_channel_check", "buyer_profiles", f"new_acquisition_channel IN {_C['channel']}")
    op.create_check_constraint("buyer_profiles_acquisition_channel_route_check", "buyer_profiles", "new_acquisition_channel IS NULL OR participation_route = 'new'")

    # === 6. exhibitor_profiles: 잠정 제거 + 실제 필드 ===
    for col in ("strength", "achievements", "target_buyer_types", "target_buyer_nationalities", "target_org_types"):
        op.drop_column("exhibitor_profiles", col)
    for col in ("main_tel", "fax", "address_ko", "address_en", "annual_sales_range", "employee_range",
                "intro_ko", "intro_en", "product_intro_ko", "product_intro_en", "product_price_range",
                "preferred_buyer_country", "participation_route", "new_acquisition_channel", "kst_available_time"):
        op.add_column("exhibitor_profiles", sa.Column(col, sa.Text()))
    op.add_column("exhibitor_profiles", sa.Column("available_languages", postgresql.ARRAY(sa.Text())))
    op.add_column("exhibitor_profiles", sa.Column("kotra_member", sa.Boolean()))
    op.add_column("exhibitor_profiles", sa.Column("company_logo_file_id", sa.UUID(as_uuid=False)))
    op.add_column("exhibitor_profiles", sa.Column("company_profile_doc_file_id", sa.UUID(as_uuid=False)))
    op.create_foreign_key("exhibitor_profiles_company_logo_file_id_fkey", "exhibitor_profiles", "files", ["company_logo_file_id"], ["id"], ondelete="SET NULL")
    op.create_foreign_key("exhibitor_profiles_company_profile_doc_file_id_fkey", "exhibitor_profiles", "files", ["company_profile_doc_file_id"], ["id"], ondelete="SET NULL")
    op.create_check_constraint("exhibitor_profiles_annual_sales_range_check", "exhibitor_profiles", f"annual_sales_range IN {_C['annual_sales_seller']}")
    op.create_check_constraint("exhibitor_profiles_employee_range_check", "exhibitor_profiles", f"employee_range IN {_C['employee_range']}")
    op.create_check_constraint("exhibitor_profiles_product_price_range_check", "exhibitor_profiles", f"product_price_range IN {_C['price']}")
    op.create_check_constraint("exhibitor_profiles_participation_route_check", "exhibitor_profiles", f"participation_route IN {_C['route']}")
    op.create_check_constraint("exhibitor_profiles_new_acquisition_channel_check", "exhibitor_profiles", f"new_acquisition_channel IN {_C['channel']}")
    op.create_check_constraint("exhibitor_profiles_available_languages_check", "exhibitor_profiles", f"available_languages <@ {_LANGS}")
    op.create_check_constraint("exhibitor_profiles_acquisition_channel_route_check", "exhibitor_profiles", "new_acquisition_channel IS NULL OR participation_route = 'new'")

    # === 7. exhibitor_products: name → name_ko + 영문/카테고리/HS ===
    op.alter_column("exhibitor_products", "name", new_column_name="name_ko")
    for col in ("name_en", "category_ko", "category_en", "hs_code", "hs_description"):
        op.add_column("exhibitor_products", sa.Column(col, sa.Text()))

    # === 8. 부속 테이블 ===
    op.create_table(
        "org_event_role_org_types",
        sa.Column("org_event_role_id", sa.UUID(as_uuid=False), nullable=False),
        sa.Column("keyword_id", sa.UUID(as_uuid=False), nullable=False),
        sa.ForeignKeyConstraint(["org_event_role_id"], ["organization_event_roles.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["keyword_id"], ["keywords.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("org_event_role_id", "keyword_id"),
    )
    op.create_table(
        "buyer_attendees",
        sa.Column("id", sa.UUID(as_uuid=False), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("buyer_profile_id", sa.UUID(as_uuid=False), nullable=False),
        sa.Column("member_id", sa.UUID(as_uuid=False)),
        sa.Column("first_name", sa.Text()), sa.Column("last_name", sa.Text()),
        sa.Column("division", sa.Text()), sa.Column("job_title", sa.Text()),
        sa.Column("email", sa.Text()), sa.Column("tel", sa.Text()),
        sa.Column("mobile", sa.Text()), sa.Column("whatsapp_id", sa.Text()),
        sa.Column("messenger_id", sa.Text()),
        sa.Column("languages", postgresql.ARRAY(sa.Text())),
        sa.Column("interpreter_need", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column("interpreter_languages", postgresql.ARRAY(sa.Text())),
        sa.Column("sort_order", sa.Integer(), server_default=sa.text("0"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["buyer_profile_id"], ["buyer_profiles.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["member_id"], ["members.id"], ondelete="SET NULL"),
        sa.CheckConstraint(f"languages <@ {_LANGS}", name="buyer_attendees_languages_check"),
        sa.CheckConstraint(f"interpreter_languages <@ {_LANGS}", name="buyer_attendees_interpreter_languages_check"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("buyer_profile_id", "email", name="buyer_attendees_buyer_profile_id_email_key"),
    )
    op.create_table(
        "buyer_recommended_buyers",
        sa.Column("id", sa.UUID(as_uuid=False), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("buyer_profile_id", sa.UUID(as_uuid=False), nullable=False),
        sa.Column("continent", sa.Text()), sa.Column("country", sa.Text()),
        sa.Column("organization", sa.Text()), sa.Column("person_in_charge", sa.Text()),
        sa.Column("email", sa.Text()), sa.Column("tel", sa.Text()),
        sa.Column("resolved_organization_id", sa.UUID(as_uuid=False)),
        sa.Column("sort_order", sa.Integer(), server_default=sa.text("0"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["buyer_profile_id"], ["buyer_profiles.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["resolved_organization_id"], ["organizations.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_table(
        "exhibitor_attendees",
        sa.Column("id", sa.UUID(as_uuid=False), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("exhibitor_profile_id", sa.UUID(as_uuid=False), nullable=False),
        sa.Column("member_id", sa.UUID(as_uuid=False)),
        sa.Column("last_name_ko", sa.Text()), sa.Column("last_name_en", sa.Text()),
        sa.Column("first_name_ko", sa.Text()), sa.Column("first_name_en", sa.Text()),
        sa.Column("division_ko", sa.Text()), sa.Column("division_en", sa.Text()),
        sa.Column("title_ko", sa.Text()), sa.Column("title_en", sa.Text()),
        sa.Column("email", sa.Text()), sa.Column("tel", sa.Text()),
        sa.Column("mobile", sa.Text()), sa.Column("whatsapp_id", sa.Text()),
        sa.Column("languages", postgresql.ARRAY(sa.Text())),
        sa.Column("sort_order", sa.Integer(), server_default=sa.text("0"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["exhibitor_profile_id"], ["exhibitor_profiles.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["member_id"], ["members.id"], ondelete="SET NULL"),
        sa.CheckConstraint(f"languages <@ {_LANGS}", name="exhibitor_attendees_languages_check"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("exhibitor_profile_id", "email", name="exhibitor_attendees_exhibitor_profile_id_email_key"),
    )
    op.create_table(
        "exhibitor_recommended_buyers",
        sa.Column("id", sa.UUID(as_uuid=False), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("exhibitor_profile_id", sa.UUID(as_uuid=False), nullable=False),
        sa.Column("continent", sa.Text()), sa.Column("country", sa.Text()),
        sa.Column("org_name_en", sa.Text()), sa.Column("person_name_en", sa.Text()),
        sa.Column("email", sa.Text()), sa.Column("contact", sa.Text()),
        sa.Column("resolved_organization_id", sa.UUID(as_uuid=False)),
        sa.Column("sort_order", sa.Integer(), server_default=sa.text("0"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["exhibitor_profile_id"], ["exhibitor_profiles.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["resolved_organization_id"], ["organizations.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )


def downgrade() -> None:
    # ⚠ 의도적 lossy: 잠정 컬럼/신규 부속 데이터는 복원하지 않는다(그린필드·미배포 전제). 운영 데이터가
    #   쌓인 뒤 되돌리려면 사전에 JSON 백업 스냅샷이 필요하다(codex P1).
    # 부속 테이블
    op.drop_table("exhibitor_recommended_buyers")
    op.drop_table("exhibitor_attendees")
    op.drop_table("buyer_recommended_buyers")
    op.drop_table("buyer_attendees")
    op.drop_table("org_event_role_org_types")

    # exhibitor_products
    for col in ("hs_description", "hs_code", "category_en", "category_ko", "name_en"):
        op.drop_column("exhibitor_products", col)
    op.alter_column("exhibitor_products", "name_ko", new_column_name="name")

    # exhibitor_profiles
    for c in ("exhibitor_profiles_acquisition_channel_route_check", "exhibitor_profiles_available_languages_check",
              "exhibitor_profiles_new_acquisition_channel_check", "exhibitor_profiles_participation_route_check",
              "exhibitor_profiles_product_price_range_check", "exhibitor_profiles_employee_range_check",
              "exhibitor_profiles_annual_sales_range_check"):
        op.drop_constraint(c, "exhibitor_profiles", type_="check")
    op.drop_constraint("exhibitor_profiles_company_profile_doc_file_id_fkey", "exhibitor_profiles", type_="foreignkey")
    op.drop_constraint("exhibitor_profiles_company_logo_file_id_fkey", "exhibitor_profiles", type_="foreignkey")
    for col in ("company_profile_doc_file_id", "company_logo_file_id", "kotra_member", "available_languages",
                "kst_available_time", "new_acquisition_channel", "participation_route", "preferred_buyer_country",
                "product_price_range", "product_intro_en", "product_intro_ko", "intro_en", "intro_ko",
                "employee_range", "annual_sales_range", "address_en", "address_ko", "fax", "main_tel"):
        op.drop_column("exhibitor_profiles", col)
    op.add_column("exhibitor_profiles", sa.Column("strength", sa.Text()))
    op.add_column("exhibitor_profiles", sa.Column("achievements", postgresql.ARRAY(sa.Text())))
    op.add_column("exhibitor_profiles", sa.Column("target_buyer_types", sa.Text()))
    op.add_column("exhibitor_profiles", sa.Column("target_buyer_nationalities", sa.Text()))
    op.add_column("exhibitor_profiles", sa.Column("target_org_types", sa.Text()))

    # buyer_profiles
    for c in ("buyer_profiles_acquisition_channel_route_check", "buyer_profiles_new_acquisition_channel_check",
              "buyer_profiles_participation_route_check", "buyer_profiles_travelers_korea_3y_check",
              "buyer_profiles_business_perf_korea_3y_check", "buyer_profiles_employee_range_check",
              "buyer_profiles_annual_sales_range_check"):
        op.drop_constraint(c, "buyer_profiles", type_="check")
    op.drop_constraint("buyer_profiles_company_profile_file_id_fkey", "buyer_profiles", type_="foreignkey")
    op.drop_constraint("buyer_profiles_company_logo_file_id_fkey", "buyer_profiles", type_="foreignkey")
    for col in ("company_profile_file_id", "company_logo_file_id", "kotra_member", "kst_available_time",
                "new_acquisition_channel", "participation_route", "note", "company_intro_en",
                "travelers_korea_3y", "business_perf_korea_3y", "employee_range", "annual_sales_range",
                "last_year_best_buyer", "tel", "address2", "address1", "zip_code", "city_state",
                "country", "continent"):
        op.drop_column("buyer_profiles", col)
    op.add_column("buyer_profiles", sa.Column("looking_for", sa.Text()))
    op.add_column("buyer_profiles", sa.Column("use_environment", sa.Text()))
    op.add_column("buyer_profiles", sa.Column("required_spec", sa.Text()))
    op.add_column("buyer_profiles", sa.Column("adoption_stage", sa.Text()))
    op.add_column("buyer_profiles", sa.Column("budget_range", sa.Text()))
    op.add_column("buyer_profiles", sa.Column("adoption_timeline", sa.Text()))
    op.add_column("buyer_profiles", sa.Column("current_adoption", sa.Text()))
    op.create_check_constraint(
        "buyer_profiles_adoption_timeline_check", "buyer_profiles",
        "adoption_timeline IN ('within_6m', 'within_1y', 'within_2y', 'undecided')",
    )

    # organization_event_roles
    op.drop_constraint("organization_event_roles_reviewed_by_fkey", "organization_event_roles", type_="foreignkey")
    op.drop_column("organization_event_roles", "review_note")
    op.drop_column("organization_event_roles", "reviewed_by")
    op.drop_column("organization_event_roles", "reviewed_at")
    # 새 상태값을 옛 도메인으로 remap(approved→submitted, changes_requested/rejected→registered) —
    # 안 하면 옛 CHECK 복원이 기존 행에서 실패한다(codex P1-6).
    op.execute(
        "UPDATE organization_event_roles SET application_status = CASE "
        "WHEN application_status = 'approved' THEN 'submitted' "
        "WHEN application_status IN ('changes_requested', 'rejected') THEN 'registered' "
        "ELSE application_status END"
    )
    op.drop_constraint("organization_event_roles_application_status_check", "organization_event_roles", type_="check")
    op.create_check_constraint(
        "organization_event_roles_application_status_check", "organization_event_roles",
        "application_status IN ('registered', 'submitted')",
    )

    # files (프로필 file FK 제거 후)
    op.drop_table("files")

    # organizations
    op.add_column("organizations", sa.Column("name", sa.Text(), nullable=True))
    op.add_column("organizations", sa.Column("description", sa.Text()))
    op.add_column("organizations", sa.Column("founded", sa.Text()))
    op.add_column("organizations", sa.Column("employees", sa.Text()))
    op.execute("UPDATE organizations SET name = COALESCE(name_ko, name_en, '')")
    op.alter_column("organizations", "name", nullable=False)
    op.drop_column("organizations", "name_en")
    op.drop_column("organizations", "name_ko")

    # keywords
    op.execute("DELETE FROM keywords WHERE category IN ('defense_field', 'org_type')")
    op.drop_constraint("keywords_category_code_key", "keywords", type_="unique")
    op.drop_column("keywords", "code")
    op.create_unique_constraint("keywords_label_key", "keywords", ["label"])
