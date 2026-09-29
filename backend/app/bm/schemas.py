"""BM 프로필 API 입출력 스키마(Pydantic). HTTP 경계 계약 — DB 모델과 분리.

실제 DX Korea 등록폼 필드(docs/db/bm-profile-fields). 고정 코드(사업분야8·카테고리3·기관유형8·구간
enum)는 Literal로 검증해 잘못된 코드를 422로 막는다. Literal 값은 ``app.models``의 코드 튜플과
일치해야 하며, 임포트 시 assert로 드리프트를 막는다.

단계별 PATCH는 **부분 저장**이라 모든 필드 Optional. ``model_dump(exclude_unset=True)``로 요청에
담긴 키만 적용한다(미제공 필드·다른 단계 불변). 목록 필드(카테고리·제품·담당자·추천)는 **전체 교체**.
"""

from __future__ import annotations

from typing import Literal, get_args

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app import models


def _reject_duplicate_emails(attendees: list | None) -> None:
    """배치 내 비-NULL 이메일 중복을 422로 거른다(UNIQUE(profile,email) IntegrityError 500 방지)."""
    if attendees:
        emails = [a.email for a in attendees if getattr(a, "email", None)]
        if len(emails) != len(set(emails)):
            raise ValueError("담당자 이메일이 중복됩니다")

# 고정 코드 Literal (models 코드 튜플 미러 — 드리프트는 아래 assert가 잡는다)
BusinessFieldCode = Literal[
    "game_production", "animation_distribution", "content_production", "music_platform",
    "newtech_content", "character_licensor", "webtoon_production", "music_production",
]
ContentCategoryCode = Literal["animation_character", "broadcasting", "comics_game_music"]
OrgTypeCode = Literal[
    "private_defense", "private_commercial", "association", "government",
    "exhibition_agent", "media", "local_gov", "other",
]
Lang = Literal["ko", "en", "zh", "ja", "ru", "vi", "other"]
ParticipationRoute = Literal["re_1_2", "re_3_5", "re_6plus", "new"]
AcquisitionChannel = Literal["edm", "official_letter", "kotra_invitation", "website_sns", "media"]
AnnualSalesBuyer = Literal["usd_lt_500k", "usd_500k_1m", "usd_1m_5m", "usd_gt_5m"]
AnnualSalesSeller = Literal["krw_1_5", "krw_5_10", "krw_10_50", "krw_50plus"]
EmployeeRange = Literal["e_0_10", "e_11_50", "e_51_100", "e_101plus"]
BusinessPerfKorea = Literal["none", "usd_1_1m", "usd_1m_5m", "usd_5m_plus"]
TravelersKorea = Literal["t_0_500", "t_501_1000", "t_1001_5000", "t_5001_10000", "t_10000plus"]
ProductPriceRange = Literal["krw_0_10m", "krw_10_30m", "krw_30_50m", "krw_50_70m", "krw_70_100m"]
BudgetRange = Literal["usd_lt_100k", "usd_100k_500k", "usd_500k_1m", "usd_1m_5m", "usd_5m_10m", "usd_10m_plus"]
AdoptionTimeline = Literal[
    "2026_h2", "2027_h1", "2027_h2", "2028_h1", "2028_h2",
    "2029_h1", "2029_h2", "2030_h1", "2030_h2", "undecided",
]

# Literal ↔ models 코드 튜플 일치 보장(둘 중 한쪽만 바뀌면 임포트 실패).
assert set(get_args(BusinessFieldCode)) == set(models.BUSINESS_FIELDS)
assert set(get_args(ContentCategoryCode)) == set(models.CONTENT_CATEGORIES)
assert set(get_args(OrgTypeCode)) == set(models.ORG_TYPES)
assert set(get_args(Lang)) == set(models.MEETING_LANGUAGES)
assert set(get_args(ParticipationRoute)) == set(models.PARTICIPATION_ROUTES)
assert set(get_args(AcquisitionChannel)) == set(models.ACQUISITION_CHANNELS)
assert set(get_args(AnnualSalesBuyer)) == set(models.ANNUAL_SALES_BUYER)
assert set(get_args(AnnualSalesSeller)) == set(models.ANNUAL_SALES_SELLER)
assert set(get_args(EmployeeRange)) == set(models.EMPLOYEE_RANGES)
assert set(get_args(BusinessPerfKorea)) == set(models.BUSINESS_PERF_KOREA)
assert set(get_args(TravelersKorea)) == set(models.TRAVELERS_KOREA)
assert set(get_args(ProductPriceRange)) == set(models.PRODUCT_PRICE_RANGES)
assert set(get_args(BudgetRange)) == set(models.BUDGET_RANGES)
assert set(get_args(AdoptionTimeline)) == set(models.ADOPTION_TIMELINES)


class _PatchBase(BaseModel):
    model_config = ConfigDict(extra="forbid")  # 오타·잘못된 단계 필드는 422


# =============================================================================
# 자식 컬렉션 입력 (전체 교체 단위)
# =============================================================================
class BuyerAttendeeIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    first_name: str | None = None
    last_name: str | None = None
    division: str | None = None
    job_title: str | None = None
    email: str | None = None
    tel: str | None = None
    mobile: str | None = None
    whatsapp_id: str | None = None
    messenger_id: str | None = None
    languages: list[Lang] | None = None
    interpreter_need: bool = False
    interpreter_languages: list[Lang] | None = None


class RecommendedBuyerIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    continent: str | None = None
    country: str | None = None
    organization: str | None = None
    person_in_charge: str | None = None
    email: str | None = None
    tel: str | None = None


class ProductIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name_ko: str = Field(..., min_length=1)
    name_en: str | None = None
    business_field: BusinessFieldCode | None = None  # 사업분야(business_field, 8종) 코드
    category_ko: str | None = None  # (구) 자유텍스트 — business_field로 대체
    category_en: str | None = None
    hs_code: str | None = None
    hs_description: str | None = None
    spec: str | None = None  # 사양(국문)
    spec_en: str | None = None  # 사양(영문)
    price_range: ProductPriceRange | None = None  # 제품별 가격대(프로필 단위에서 이동)


class ExhibitorAttendeeIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    last_name_ko: str | None = None
    last_name_en: str | None = None
    first_name_ko: str | None = None
    first_name_en: str | None = None
    division_ko: str | None = None
    division_en: str | None = None
    title_ko: str | None = None
    title_en: str | None = None
    email: str | None = None
    tel: str | None = None
    mobile: str | None = None
    whatsapp_id: str | None = None
    languages: list[Lang] | None = None


class ExhibitorRecommendedBuyerIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    continent: str | None = None
    country: str | None = None
    org_name_en: str | None = None
    person_name_en: str | None = None
    email: str | None = None
    contact: str | None = None


# =============================================================================
# 바이어 단계 PATCH (F-BM-001)
# =============================================================================
class BuyerStep1(_PatchBase):
    """1 조직 정보 — 식별(org)·위치·규모·구간·기관유형."""

    organization_name_ko: str | None = None
    organization_name_en: str | None = None
    business_reg_no: str | None = None
    website: str | None = None
    # 신청자 식별(담당자, 신규 2026-06-29) — contact_name_en·contact_email은 제출 필수(제출
    # 완결성은 DB CHECK가 아니라 service._validate_submit이 강제, 부분저장은 그대로 허용).
    # contact_language는 FE Lang(현재 en/vi)과 backend MEETING_LANGUAGES가 어휘가 달라 Literal
    # 검증 없이 자유 문자열로 받는다(로케일 확장 시 API 변경 불필요).
    contact_name_ko: str | None = None
    contact_name_en: str | None = None
    contact_title_ko: str | None = None
    contact_title_en: str | None = None
    contact_email: str | None = None
    contact_language: str | None = None
    contact_interpreter_need: bool | None = None
    continent: str | None = None
    country: str | None = None
    city_state: str | None = None
    zip_code: str | None = None
    address1: str | None = None
    address2: str | None = None
    tel: str | None = None
    last_year_best_buyer: str | None = None
    annual_sales_range: AnnualSalesBuyer | None = None
    employee_range: EmployeeRange | None = None
    business_perf_korea_3y: BusinessPerfKorea | None = None
    travelers_korea_3y: TravelersKorea | None = None
    org_types: list[OrgTypeCode] | None = None


class BuyerStep2(_PatchBase):
    """2 관심분야·소개. (파일은 업로드 슬라이스가 소유권·purpose 검증과 함께 추가 — codex P1)"""

    interest_categories: list[BusinessFieldCode] | None = None
    company_intro_ko: str | None = None  # 신규(2026-06-29) — company_intro_en 국문 짝
    company_intro_en: str | None = None
    budget_range: BudgetRange | None = None  # 신규(2026-06-29) — 지출 가능 예산(USD)
    adoption_timeline: AdoptionTimeline | None = None  # 신규(2026-06-29) — 도입 시기
    note: str | None = None


class BuyerStep3(_PatchBase):
    """3 담당자(복수)."""

    attendees: list[BuyerAttendeeIn] | None = None

    @model_validator(mode="after")
    def _check_emails(self):
        _reject_duplicate_emails(self.attendees)
        return self


class BuyerStep4(_PatchBase):
    """4 참가정보·추천."""

    participation_route: ParticipationRoute | None = None
    new_acquisition_channel: AcquisitionChannel | None = None
    kst_available_time: str | None = None
    recommended_buyers: list[RecommendedBuyerIn] | None = None


# =============================================================================
# 셀러 단계 PATCH (F-BM-002)
# =============================================================================
class ExhibitorStep1(_PatchBase):
    """1 기본정보(회원가입 등록 정보 — 식별·부스 신고값·대표자·연락·주소·업태/종목·담당자).

    프론트 단계 정렬(BM-002): 부스는 Hall>관>부스위치 신고값 스냅샷, 담당자(복수)는 기본정보로 통합.
    """

    organization_name_ko: str | None = None
    organization_name_en: str | None = None
    business_reg_no: str | None = None
    booth_hall: str | None = None
    booth_pavilion: str | None = None
    booth_location: str | None = None
    booth_type: str | None = None
    booth_count: int | None = None
    representative_name_ko: str | None = None
    representative_name_en: str | None = None
    company_email: str | None = None
    main_tel: str | None = None
    fax: str | None = None
    zip_code: str | None = None
    address_ko: str | None = None
    address_detail: str | None = None
    address_en: str | None = None
    business_type: str | None = None
    business_item: str | None = None
    attendees: list[ExhibitorAttendeeIn] | None = None

    @model_validator(mode="after")
    def _check_emails(self):
        _reject_duplicate_emails(self.attendees)
        return self


class ExhibitorStep2(_PatchBase):
    """2 회사소개 — 소개(국/영) + 보강정보(홈페이지·연매출·직원수·언어)."""

    intro_ko: str | None = None
    intro_en: str | None = None
    website: str | None = None
    annual_sales_range: AnnualSalesSeller | None = None
    employee_range: EmployeeRange | None = None
    available_languages: list[Lang] | None = None


class ExhibitorStep3(_PatchBase):
    """3 전시품목 — 제품(복수, 가격대·사양 국/영 제품별)·사업분야(8, 멀티)·카테고리(3, 단일선택)."""

    products: list[ProductIn] | None = None
    exhibition_categories: list[BusinessFieldCode] | None = None
    content_category: ContentCategoryCode | None = None


class ExhibitorStep4(_PatchBase):
    """4 타겟 — 선호 바이어 국가/구분(멀티).

    ``unavailable_meeting_slots``(미팅 불가 슬롯)는 **여기 없다 — 의도적**(#OP 슈퍼어드민 콘솔).
    "미팅 불가 시간대는 기업 측에서 설정 불가(운영자 전용)"로 정책이 바뀌어, 이 필드는 이제
    ``PATCH /api/admin/events/{event_id}/organizations/{org_id}/unavailable-slots``(운영자 전용)로만
    쓴다. ``_PatchBase``가 ``extra="forbid"``라 기업 principal이 이 필드를 보내면 조용히 드롭되지
    않고 **422**로 명시 거부된다(fail-closed) — 컬럼 자체(``ExhibitorProfile.unavailable_meeting_slots``)
    와 조회 응답(``ExhibitorProfileResponse``)은 그대로 유지, 쓰기 경로만 이관.
    """

    preferred_buyer_countries: list[str] | None = None
    preferred_buyer_types: list[OrgTypeCode] | None = None


BUYER_STEP_MODELS: dict[int, type[_PatchBase]] = {1: BuyerStep1, 2: BuyerStep2, 3: BuyerStep3, 4: BuyerStep4}
EXHIBITOR_STEP_MODELS: dict[int, type[_PatchBase]] = {
    1: ExhibitorStep1, 2: ExhibitorStep2, 3: ExhibitorStep3, 4: ExhibitorStep4
}


class BuyerProfilePatch(BuyerStep1, BuyerStep2, BuyerStep3, BuyerStep4):
    """제출 시 최종 편집(선택) — 전 단계 합집합, 모두 Optional."""


class ExhibitorProfilePatch(ExhibitorStep1, ExhibitorStep2, ExhibitorStep3, ExhibitorStep4):
    """제출 시 최종 편집(선택) — 전 단계 합집합, 모두 Optional."""


# =============================================================================
# 조회 응답 (저장된 단계 보존 — 이어쓰기 입력)
# =============================================================================
ApplicationStatus = Literal["registered", "submitted", "changes_requested", "approved", "rejected"]


class BuyerAttendeeOut(BuyerAttendeeIn):
    pass


class RecommendedBuyerOut(RecommendedBuyerIn):
    pass


class ProductOut(BaseModel):
    name_ko: str
    name_en: str | None = None
    business_field: BusinessFieldCode | None = None
    category_ko: str | None = None
    category_en: str | None = None
    hs_code: str | None = None
    hs_description: str | None = None
    spec: str | None = None
    spec_en: str | None = None
    price_range: ProductPriceRange | None = None


class ExhibitorAttendeeOut(ExhibitorAttendeeIn):
    pass


class ExhibitorRecommendedBuyerOut(ExhibitorRecommendedBuyerIn):
    pass


class BuyerProfileResponse(BaseModel):
    org_event_role_id: str
    application_status: ApplicationStatus
    organization_name_ko: str | None = None
    organization_name_en: str | None = None
    business_reg_no: str | None = None
    website: str | None = None
    contact_name_ko: str | None = None
    contact_name_en: str | None = None
    contact_title_ko: str | None = None
    contact_title_en: str | None = None
    contact_email: str | None = None
    contact_language: str | None = None
    contact_interpreter_need: bool | None = None
    continent: str | None = None
    country: str | None = None
    city_state: str | None = None
    zip_code: str | None = None
    address1: str | None = None
    address2: str | None = None
    tel: str | None = None
    last_year_best_buyer: str | None = None
    annual_sales_range: AnnualSalesBuyer | None = None
    employee_range: EmployeeRange | None = None
    business_perf_korea_3y: BusinessPerfKorea | None = None
    travelers_korea_3y: TravelersKorea | None = None
    org_types: list[OrgTypeCode] = Field(default_factory=list)
    interest_categories: list[BusinessFieldCode] = Field(default_factory=list)
    company_intro_ko: str | None = None
    company_intro_en: str | None = None
    budget_range: BudgetRange | None = None
    adoption_timeline: AdoptionTimeline | None = None
    company_logo_file_id: str | None = None
    company_profile_file_id: str | None = None
    note: str | None = None
    participation_route: ParticipationRoute | None = None
    new_acquisition_channel: AcquisitionChannel | None = None
    kst_available_time: str | None = None
    attendees: list[BuyerAttendeeOut] = Field(default_factory=list)
    recommended_buyers: list[RecommendedBuyerOut] = Field(default_factory=list)


class ExhibitorProfileResponse(BaseModel):
    org_event_role_id: str
    application_status: ApplicationStatus
    # 1 기본정보
    organization_name_ko: str | None = None
    organization_name_en: str | None = None
    business_reg_no: str | None = None
    booth_hall: str | None = None
    booth_pavilion: str | None = None
    booth_location: str | None = None
    booth_type: str | None = None
    booth_count: int | None = None
    representative_name_ko: str | None = None
    representative_name_en: str | None = None
    company_email: str | None = None
    main_tel: str | None = None
    fax: str | None = None
    zip_code: str | None = None
    address_ko: str | None = None
    address_detail: str | None = None
    address_en: str | None = None
    business_type: str | None = None
    business_item: str | None = None
    attendees: list[ExhibitorAttendeeOut] = Field(default_factory=list)
    # 2 회사소개
    intro_ko: str | None = None
    intro_en: str | None = None
    website: str | None = None
    annual_sales_range: AnnualSalesSeller | None = None
    employee_range: EmployeeRange | None = None
    available_languages: list[Lang] = Field(default_factory=list)
    # 3 전시품목
    exhibition_categories: list[BusinessFieldCode] = Field(default_factory=list)
    content_category: ContentCategoryCode | None = None
    products: list[ProductOut] = Field(default_factory=list)
    # 4 타겟
    preferred_buyer_countries: list[str] = Field(default_factory=list)
    preferred_buyer_types: list[OrgTypeCode] = Field(default_factory=list)
    unavailable_meeting_slots: list[str] = Field(default_factory=list)
    # 참가자 구분(매칭 차원, 폼 미수집이나 join 유지)
    org_types: list[OrgTypeCode] = Field(default_factory=list)
