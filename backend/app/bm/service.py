"""BM 프로필 — 단계별 부분 저장·조회·원자적 제출을 DB에 묶는 계층(ADR-0008/0009).

실제 등록폼 필드(docs/db/bm-profile-fields). DB 접근은 여기로 모은다. 라우트는 인증·소유권(403)만.

핵심 불변식:
- **부분 저장**: PATCH는 그 단계가 준 필드만 갱신(다른 단계·미제공 불변). 목록 필드(분류·제품·
  담당자·추천)는 전체 교체.
- **원자적 제출(D6/ADR-0009)**: 제출은 프로필 최종 저장 + ``submitted`` 전환을 한 트랜잭션으로.
- **승인 게이트(2단계, D5)**: 제출=submitted, 운영 승인=approved. **매칭 노출은 approved만.**
  멱등: 이미 approved면 제출/수정해도 approved 유지(되돌리지 않음).
"""

from __future__ import annotations

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.bm import schemas
from app.models import (
    BuyerAttendee,
    BuyerInterestKeyword,
    BuyerProfile,
    BuyerRecommendedBuyer,
    ExhibitorAttendee,
    ExhibitorKeyword,
    ExhibitorProduct,
    ExhibitorProfile,
    ExhibitorRecommendedBuyer,
    Keyword,
    OrganizationEventRole,
    OrgEventRoleOrgType,
    Organization,
)


class RoleMismatchError(Exception):
    """이 역할(org_event_role)이 요청한 프로필 종류가 아님 — 바이어 경로에 참가사 역할 등."""


class SubmitBlockedError(Exception):
    """제출 불가 상태 — 반려(rejected)는 종단이라 재제출할 수 없다(ADR-0009)."""


class SubmitValidationError(Exception):
    """제출 시 폼 불변식 위반 — DB CHECK로는 못 막는 '제출 완결성'을 여기서 강제(부분저장은 통과시키되)."""


# org 식별 컬럼 매핑(요청 키 → Organization 컬럼)
_ORG_FIELDS = {
    "organization_name_ko": "name_ko",
    "organization_name_en": "name_en",
    "business_reg_no": "business_reg_no",
    "website": "website",
}

_BUYER_SCALARS = frozenset({
    # 신청자 식별(담당자, BM-001 실배선) — contact_name_en·contact_email은 제출 필수(_validate_submit).
    "contact_name_ko", "contact_name_en", "contact_title_ko", "contact_title_en", "contact_email",
    "contact_language", "contact_interpreter_need",
    "continent", "country", "city_state", "zip_code", "address1", "address2", "tel",
    "last_year_best_buyer", "annual_sales_range", "employee_range", "business_perf_korea_3y",
    "travelers_korea_3y", "company_intro_ko", "company_intro_en", "budget_range", "adoption_timeline",
    "company_logo_file_id", "company_profile_file_id",
    "note", "participation_route", "new_acquisition_channel", "kst_available_time",
})
# 프로필 스칼라(직접 set/get). org 식별·목록·org_types는 별도 경로. 프론트 단계 정렬(BM-002)로
# 신규 필드 추가(부스 신고값·대표자·업태/종목·선호바이어 멀티) + 폐기 필드(product_intro·product_price_range·
# preferred_buyer_country·participation_route·kst_available_time·파일 FK)는 미수집(컬럼은 비파괴 보존).
_EXHIBITOR_SCALARS = frozenset({
    "booth_hall", "booth_pavilion", "booth_location", "booth_type", "booth_count",
    "representative_name_ko", "representative_name_en", "company_email", "zip_code",
    "business_type", "business_item",
    "main_tel", "fax", "address_ko", "address_detail", "address_en",
    "annual_sales_range", "employee_range", "available_languages", "intro_ko", "intro_en",
    "preferred_buyer_countries", "preferred_buyer_types",
    "unavailable_meeting_slots", "content_category",
})


def get_role(db: Session, org_event_role_id: str) -> OrganizationEventRole | None:
    return db.get(OrganizationEventRole, org_event_role_id)


# =============================================================================
# 고정 분류 해소(code ↔ keyword) + 멀티 교체
# =============================================================================
def _keyword_ids_for_codes(db: Session, category: str, codes: list[str]) -> list[str]:
    """코드 목록 → keyword_id 목록(순서·중복 제거 보존). 코드는 Literal 검증을 통과한 값.

    시드가 누락/손상돼 코드를 못 찾으면 **조용히 버리지 않고** 즉시 실패한다(delete 전에 raise라
    부분 저장이 빈 집합으로 덮이지 않는다 — codex P1).
    """
    rows = db.execute(
        select(Keyword.code, Keyword.id).where(Keyword.category == category)
    ).all()
    by_code = {code: kid for code, kid in rows}
    out, seen = [], set()
    for c in codes:
        if c in seen:
            continue
        if c not in by_code:
            raise RuntimeError(f"분류 시드 누락: category={category!r} code={c!r}")
        seen.add(c)
        out.append(by_code[c])
    return out


def _codes_for_profile(db: Session, link_model, fk: str, profile_id: str, category: str) -> list[str]:
    """프로필에 연결된 분류 코드(정렬 — 결정적 노출)."""
    return sorted(
        db.execute(
            select(Keyword.code)
            .join(link_model, link_model.keyword_id == Keyword.id)
            .where(getattr(link_model, fk) == profile_id, Keyword.category == category)
        ).scalars()
    )


def _replace_categories(db, link_model, fk, profile_id, category, codes):
    db.execute(delete(link_model).where(getattr(link_model, fk) == profile_id))
    for kid in _keyword_ids_for_codes(db, category, codes or []):
        db.add(link_model(**{fk: profile_id, "keyword_id": kid}))


def _replace_org_types(db: Session, role_id: str, codes: list[str]) -> None:
    db.execute(delete(OrgEventRoleOrgType).where(OrgEventRoleOrgType.org_event_role_id == role_id))
    for kid in _keyword_ids_for_codes(db, "org_type", codes or []):
        db.add(OrgEventRoleOrgType(org_event_role_id=role_id, keyword_id=kid))


def _org_type_codes(db: Session, role_id: str) -> list[str]:
    return sorted(
        db.execute(
            select(Keyword.code)
            .join(OrgEventRoleOrgType, OrgEventRoleOrgType.keyword_id == Keyword.id)
            .where(OrgEventRoleOrgType.org_event_role_id == role_id, Keyword.category == "org_type")
        ).scalars()
    )


def _apply_org_fields(db: Session, role: OrganizationEventRole, data: dict) -> None:
    if _ORG_FIELDS.keys() & data.keys():
        org = db.get(Organization, role.organization_id)
        if org is not None:
            for key, col in _ORG_FIELDS.items():
                if key in data:
                    setattr(org, col, data[key])


# =============================================================================
# 바이어 프로필(F-BM-001)
# =============================================================================
def _find_buyer(db, role_id):
    return db.execute(select(BuyerProfile).where(BuyerProfile.org_event_role_id == role_id)).scalar_one_or_none()


def _ensure_buyer(db, role):
    profile = _find_buyer(db, role.id)
    if profile is None:
        profile = BuyerProfile(org_event_role_id=role.id)
        db.add(profile)
        db.flush()
    return profile


def _replace_buyer_attendees(db: Session, profile_id: str, attendees: list[dict]) -> None:
    db.execute(delete(BuyerAttendee).where(BuyerAttendee.buyer_profile_id == profile_id))
    for i, a in enumerate(attendees):
        db.add(BuyerAttendee(buyer_profile_id=profile_id, sort_order=i, **a))


def _replace_buyer_recommended(db: Session, profile_id: str, recs: list[dict]) -> None:
    db.execute(delete(BuyerRecommendedBuyer).where(BuyerRecommendedBuyer.buyer_profile_id == profile_id))
    for i, r in enumerate(recs):
        db.add(BuyerRecommendedBuyer(buyer_profile_id=profile_id, sort_order=i, **r))


def _apply_buyer_fields(db, profile, role, data: dict) -> None:
    """부분 저장 — data에 담긴 키만 적용. 목록 필드는 null=no-op, []=비우기(codex P2)."""
    _apply_org_fields(db, role, data)
    if data.get("org_types") is not None:
        _replace_org_types(db, role.id, data["org_types"])
    if data.get("interest_categories") is not None:
        _replace_categories(db, BuyerInterestKeyword, "buyer_profile_id", profile.id, "business_field", data["interest_categories"])
    if data.get("attendees") is not None:
        _replace_buyer_attendees(db, profile.id, data["attendees"])
    if data.get("recommended_buyers") is not None:
        _replace_buyer_recommended(db, profile.id, data["recommended_buyers"])
    for col in _BUYER_SCALARS & data.keys():
        setattr(profile, col, data[col])


def get_buyer_profile(db: Session, role: OrganizationEventRole) -> schemas.BuyerProfileResponse:
    org = db.get(Organization, role.organization_id)
    profile = _find_buyer(db, role.id)
    base = dict(
        org_event_role_id=str(role.id),
        application_status=role.application_status,
        organization_name_ko=org.name_ko if org else None,
        organization_name_en=org.name_en if org else None,
        business_reg_no=org.business_reg_no if org else None,
        website=org.website if org else None,
        org_types=_org_type_codes(db, role.id),
    )
    if profile is None:
        return schemas.BuyerProfileResponse(**base)
    scalars = {c: getattr(profile, c) for c in _BUYER_SCALARS}
    attendees = [
        schemas.BuyerAttendeeOut(
            first_name=a.first_name, last_name=a.last_name, division=a.division, job_title=a.job_title,
            email=a.email, tel=a.tel, mobile=a.mobile, whatsapp_id=a.whatsapp_id, messenger_id=a.messenger_id,
            languages=a.languages, interpreter_need=a.interpreter_need, interpreter_languages=a.interpreter_languages,
        )
        for a in db.execute(select(BuyerAttendee).where(BuyerAttendee.buyer_profile_id == profile.id).order_by(BuyerAttendee.sort_order)).scalars()
    ]
    recs = [
        schemas.RecommendedBuyerOut(
            continent=r.continent, country=r.country, organization=r.organization,
            person_in_charge=r.person_in_charge, email=r.email, tel=r.tel,
        )
        for r in db.execute(select(BuyerRecommendedBuyer).where(BuyerRecommendedBuyer.buyer_profile_id == profile.id).order_by(BuyerRecommendedBuyer.sort_order)).scalars()
    ]
    return schemas.BuyerProfileResponse(
        **base, **scalars,
        interest_categories=_codes_for_profile(db, BuyerInterestKeyword, "buyer_profile_id", profile.id, "business_field"),
        attendees=attendees, recommended_buyers=recs,
    )


def patch_buyer_step(db, role, data: dict) -> schemas.BuyerProfileResponse:
    _require_buyer(role)
    profile = _ensure_buyer(db, role)
    _apply_buyer_fields(db, profile, role, data)
    db.commit()
    db.refresh(role)
    return get_buyer_profile(db, role)


def submit_buyer(db, role, data: dict | None) -> schemas.BuyerProfileResponse:
    """제출 — 최종 저장 + submitted 전환을 한 트랜잭션으로(원자, D6). 멱등(approved 유지)."""
    _require_buyer(role)
    _guard_submittable_status(role)
    profile = _ensure_buyer(db, role)
    if data:
        _apply_buyer_fields(db, profile, role, data)
    _validate_submit(profile)
    _promote_to_submitted(db, role)
    db.commit()
    db.refresh(role)
    return get_buyer_profile(db, role)


# =============================================================================
# 셀러 프로필(F-BM-002)
# =============================================================================
def _find_exhibitor(db, role_id):
    return db.execute(select(ExhibitorProfile).where(ExhibitorProfile.org_event_role_id == role_id)).scalar_one_or_none()


def _ensure_exhibitor(db, role):
    profile = _find_exhibitor(db, role.id)
    if profile is None:
        profile = ExhibitorProfile(org_event_role_id=role.id)
        db.add(profile)
        db.flush()
    return profile


def _replace_products(db: Session, profile_id: str, products: list[dict]) -> None:
    db.execute(delete(ExhibitorProduct).where(ExhibitorProduct.exhibitor_profile_id == profile_id))
    for i, p in enumerate(products):
        db.add(ExhibitorProduct(exhibitor_profile_id=profile_id, sort_order=i, **p))


def _replace_exhibitor_attendees(db: Session, profile_id: str, attendees: list[dict]) -> None:
    db.execute(delete(ExhibitorAttendee).where(ExhibitorAttendee.exhibitor_profile_id == profile_id))
    for i, a in enumerate(attendees):
        db.add(ExhibitorAttendee(exhibitor_profile_id=profile_id, sort_order=i, **a))


def _replace_exhibitor_recommended(db: Session, profile_id: str, recs: list[dict]) -> None:
    db.execute(delete(ExhibitorRecommendedBuyer).where(ExhibitorRecommendedBuyer.exhibitor_profile_id == profile_id))
    for i, r in enumerate(recs):
        db.add(ExhibitorRecommendedBuyer(exhibitor_profile_id=profile_id, sort_order=i, **r))


def _apply_exhibitor_fields(db, profile, role, data: dict) -> None:
    """부분 저장 — 목록 필드는 null=no-op, []=비우기(codex P2)."""
    _apply_org_fields(db, role, data)
    if data.get("org_types") is not None:
        _replace_org_types(db, role.id, data["org_types"])
    if data.get("exhibition_categories") is not None:
        _replace_categories(db, ExhibitorKeyword, "exhibitor_profile_id", profile.id, "business_field", data["exhibition_categories"])
    if data.get("products") is not None:
        _replace_products(db, profile.id, data["products"])
    if data.get("attendees") is not None:
        _replace_exhibitor_attendees(db, profile.id, data["attendees"])
    if data.get("recommended_buyers") is not None:
        _replace_exhibitor_recommended(db, profile.id, data["recommended_buyers"])
    for col in _EXHIBITOR_SCALARS & data.keys():
        setattr(profile, col, data[col])


def get_exhibitor_profile(db: Session, role: OrganizationEventRole) -> schemas.ExhibitorProfileResponse:
    org = db.get(Organization, role.organization_id)
    profile = _find_exhibitor(db, role.id)
    base = dict(
        org_event_role_id=str(role.id),
        application_status=role.application_status,
        organization_name_ko=org.name_ko if org else None,
        organization_name_en=org.name_en if org else None,
        business_reg_no=org.business_reg_no if org else None,
        website=org.website if org else None,
        org_types=_org_type_codes(db, role.id),
    )
    if profile is None:
        return schemas.ExhibitorProfileResponse(**base)
    scalars = {c: getattr(profile, c) for c in _EXHIBITOR_SCALARS}
    # ARRAY 컬럼은 None이면 [] 표준화(응답 계약 기본값)
    for _arr in ("available_languages", "unavailable_meeting_slots",
                 "preferred_buyer_countries", "preferred_buyer_types"):
        scalars[_arr] = scalars.get(_arr) or []
    products = [
        schemas.ProductOut(
            name_ko=p.name_ko, name_en=p.name_en, business_field=p.business_field,
            category_ko=p.category_ko, category_en=p.category_en,
            hs_code=p.hs_code, hs_description=p.hs_description, spec=p.spec,
            spec_en=p.spec_en, price_range=p.price_range,
        )
        for p in db.execute(select(ExhibitorProduct).where(ExhibitorProduct.exhibitor_profile_id == profile.id).order_by(ExhibitorProduct.sort_order)).scalars()
    ]
    attendees = [
        schemas.ExhibitorAttendeeOut(
            last_name_ko=a.last_name_ko, last_name_en=a.last_name_en, first_name_ko=a.first_name_ko,
            first_name_en=a.first_name_en, division_ko=a.division_ko, division_en=a.division_en,
            title_ko=a.title_ko, title_en=a.title_en, email=a.email, tel=a.tel, mobile=a.mobile,
            whatsapp_id=a.whatsapp_id, languages=a.languages,
        )
        for a in db.execute(select(ExhibitorAttendee).where(ExhibitorAttendee.exhibitor_profile_id == profile.id).order_by(ExhibitorAttendee.sort_order)).scalars()
    ]
    recs = [
        schemas.ExhibitorRecommendedBuyerOut(
            continent=r.continent, country=r.country, org_name_en=r.org_name_en,
            person_name_en=r.person_name_en, email=r.email, contact=r.contact,
        )
        for r in db.execute(select(ExhibitorRecommendedBuyer).where(ExhibitorRecommendedBuyer.exhibitor_profile_id == profile.id).order_by(ExhibitorRecommendedBuyer.sort_order)).scalars()
    ]
    return schemas.ExhibitorProfileResponse(
        **base, **scalars,
        exhibition_categories=_codes_for_profile(db, ExhibitorKeyword, "exhibitor_profile_id", profile.id, "business_field"),
        products=products, attendees=attendees, recommended_buyers=recs,
    )


def patch_exhibitor_step(db, role, data: dict) -> schemas.ExhibitorProfileResponse:
    _require_exhibitor(role)
    profile = _ensure_exhibitor(db, role)
    _apply_exhibitor_fields(db, profile, role, data)
    db.commit()
    db.refresh(role)
    return get_exhibitor_profile(db, role)


def submit_exhibitor(db, role, data: dict | None) -> schemas.ExhibitorProfileResponse:
    _require_exhibitor(role)
    _guard_submittable_status(role)
    profile = _ensure_exhibitor(db, role)
    if data:
        _apply_exhibitor_fields(db, profile, role, data)
    _validate_submit(profile)
    _promote_to_submitted(db, role)
    db.commit()
    db.refresh(role)
    return get_exhibitor_profile(db, role)


# =============================================================================
# 승격 + 매칭 노출
# =============================================================================
def _guard_submittable_status(role: OrganizationEventRole) -> None:
    """반려(rejected)는 종단이라 재제출 불가(ADR-0009, codex P1). 그 외 상태는 제출 가능."""
    if role.application_status == "rejected":
        raise SubmitBlockedError("반려된 신청은 재제출할 수 없습니다")


def _validate_submit(profile) -> None:
    """제출 완결성 — DB CHECK로 못 막는 폼 불변식(부분저장은 통과시킴, codex P1).

    - '신규 참가(route=new)'면 획득 채널이 있어야 한다(바이어·참가사 공용).
    - 바이어는 신청자 영문 이름·이메일이 제출 필수(BM-001, FE StepBasicInfoSchema와 동일 기준 —
      DB 컬럼은 nullable이라 부분저장은 계속 허용하고, 여기서만 제출을 막는다).
    """
    if profile.participation_route == "new" and not profile.new_acquisition_channel:
        raise SubmitValidationError("신규 참가는 획득 경로(new_acquisition_channel)를 선택해야 합니다")
    if isinstance(profile, BuyerProfile):
        if not profile.contact_name_en:
            raise SubmitValidationError("신청자 영문 이름(contact_name_en)을 입력해야 합니다")
        if not profile.contact_email:
            raise SubmitValidationError("신청자 이메일(contact_email)을 입력해야 합니다")


def _promote_to_submitted(db: Session, role: OrganizationEventRole) -> None:
    """제출 전환 — registered/changes_requested/submitted → submitted. approved는 유지(멱등, D5).

    rejected는 _guard_submittable_status가 먼저 막는다. 제출 트랜잭션의 한 축(다른 축은 프로필
    최종 저장). 같은 세션·단일 commit이라 한쪽 예외 시 함께 롤백된다(반쪽 제출 차단).
    """
    if role.application_status != "approved":
        role.application_status = "submitted"


def select_exposed_org_ids(db: Session, event_id: str, *, role: str) -> list[str]:
    """매칭에 노출되는 org id — **approved만**(작성 중·미승인 제외, D5)."""
    flag = OrganizationEventRole.is_buyer if role == "buyer" else OrganizationEventRole.is_exhibitor
    rows = db.execute(
        select(OrganizationEventRole.organization_id).where(
            OrganizationEventRole.event_id == event_id,
            OrganizationEventRole.application_status == "approved",
            flag.is_(True),
        )
    ).scalars().all()
    return [str(x) for x in rows]


def _require_buyer(role: OrganizationEventRole) -> None:
    if not role.is_buyer:
        raise RoleMismatchError("바이어 역할이 아닙니다 — 참가사는 /exhibitor 경로를 씁니다")


def _require_exhibitor(role: OrganizationEventRole) -> None:
    if not role.is_exhibitor:
        raise RoleMismatchError("참가사 역할이 아닙니다 — 바이어는 /buyer 경로를 씁니다")
