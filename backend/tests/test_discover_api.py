"""기업 탐색 API 통합 테스트 — 열람 범위 + **공개 프로젝션 유출 방지** + /api/me.

이 파일이 지키는 핵심 불변식:

- **유출 방지가 제1 관심사** — 탐색 응답은 화이트리스트 밖의 어떤 값도 실어서는 안 된다.
  프로필 행에 고유 마커를 심어두고, 응답 JSON 전체에 그 마커가 한 번도 나타나지 않는지 검사한다
  (엑셀 export의 ``test_excel_export.py::test_private_review_fields_not_leaked``와 같은 방식).
  키 이름도 함께 검사한다 — 값이 우연히 비어 있어도 필드가 생겼다는 사실 자체가 회귀다.
- **열람 범위는 행사 정책을 따른다** — 기본은 교차 역할만, ``allow_same_role_discovery``면 동종도.
- **노출은 approved부터** — 심사 중인 기업은 목록에도 단건에도 없다(단건은 403이 아니라 404).
- **자기 기업은 예외** — 가시성·승인 검사 없이 자기 카드를 볼 수 있다(화면이 내 카드를 그린다).

로컬 Postgres 없으면 conftest의 skip 패턴(migrated_db)에 따라 전체 skip.
"""

from __future__ import annotations

import itertools
import json
import uuid
from datetime import date, time, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select, text
from sqlalchemy.orm import sessionmaker

from app.auth.principal import Principal, get_current_principal
from app.db import get_session
from app.main import app
from app.models import (
    DEFAULT_PARTICIPANT_MENU,
    Booth,
    BuyerAttendee,
    BuyerInterestKeyword,
    BuyerProfile,
    BuyerRecommendedBuyer,
    Event,
    EventScheduleSettings,
    ExhibitorAttendee,
    ExhibitorKeyword,
    ExhibitorProduct,
    ExhibitorProfile,
    ExhibitorRecommendedBuyer,
    Hall,
    InterestedOrganization,
    Keyword,
    Member,
    Organization,
    OrganizationEventRole,
    Registrant,
)

_seq = itertools.count(1)

UNKNOWN_ID = "00000000-0000-0000-0000-000000000000"

# =============================================================================
# 공개 프로젝션의 계약 — 이 집합이 곧 "새면 안 되는 것"의 정의다
# =============================================================================
ALLOWED_CARD_KEYS = {
    "org_id",
    "role",
    "name",
    "buyer_subtype",
    "booth",
    "keywords",
    "exhibits",
    "description",
    "employee_range",
    "content_category",
}
ALLOWED_BOOTH_KEYS = {"hall_no", "hall_name", "code"}

#: 응답 어디에도 나타나면 안 되는 **키 이름 조각**. 값이 비어 있어도 필드가 생겼다는 것 자체가 회귀다.
#: (허용 키 중 이 조각을 포함하는 것이 없어야 한다 — 아래 test_forbidden_terms_do_not_match_allowed_keys)
FORBIDDEN_KEY_TERMS = (
    "email",
    "tel",
    "phone",
    "mobile",
    "whatsapp",
    "messenger",
    "fax",
    "business_reg",
    "annual_sales",
    "unavailable",
    "note",
    "recommend",
    "attendee",
    "address",
    "zip",
    "representative",
    "password",
    "kst_available",
    "last_year",
    "business_perf",
    "travelers",
    "participation_route",
    "acquisition",
    "kotra",
    "product_price",
    "preferred_buyer",
    "satisfaction",
    "follow_up",
    "transcript",
)

#: 비공개 컬럼에 심어두는 고유 마커 — 응답 JSON 어디에도 나타나면 안 된다.
#: enum 컬럼(매출구간)은 마커를 못 넣으므로 그 **값 자체**를 금칙 문자열로 넣는다.
MARKERS = (
    "MARKER-BIZREG-0000000000",
    "MARKER-EXH-COMPANY-EMAIL@nabi.test",
    "MARKER-EXH-MAIN-TEL",
    "MARKER-EXH-FAX",
    "MARKER-EXH-ADDRESS-국문주소",
    "MARKER-EXH-ADDRESS-DETAIL",
    "MARKER-EXH-ZIPCODE",
    "MARKER-EXH-REPRESENTATIVE-대표자",
    "MARKER-EXH-KST-TIME",
    "MARKER-EXH-UNAVAILABLE-SLOT",
    "MARKER-EXH-ATTENDEE-이름",
    "MARKER-EXH-ATTENDEE-EMAIL@nabi.test",
    "MARKER-EXH-ATTENDEE-TEL",
    "MARKER-EXH-ATTENDEE-MOBILE",
    "MARKER-EXH-ATTENDEE-WHATSAPP",
    "MARKER-EXH-RECOMMENDED-BUYER",
    "MARKER-EXH-RECOMMENDED-EMAIL@nabi.test",
    "MARKER-BUY-NOTE-비공개메모",
    "MARKER-BUY-TEL",
    "MARKER-BUY-ADDRESS1",
    "MARKER-BUY-CITY",
    "MARKER-BUY-BEST-BUYER",
    "MARKER-BUY-ATTENDEE-이름",
    "MARKER-BUY-ATTENDEE-EMAIL@nabi.test",
    "MARKER-BUY-ATTENDEE-TEL",
    "MARKER-BUY-ATTENDEE-MOBILE",
    "MARKER-BUY-ATTENDEE-WHATSAPP",
    "MARKER-BUY-RECOMMENDED-ORG",
    "MARKER-BUY-RECOMMENDED-EMAIL@nabi.test",
    # enum 비공개 값 — 매출구간은 탐색에 나가지 않는다(규모는 employee_range만 공개).
    "krw_50plus",
    "usd_gt_5m",
)


# =============================================================================
# 픽스처
# =============================================================================
@pytest.fixture()
def db_factory(migrated_db: str):
    engine = create_engine(migrated_db, future=True)
    TestSession = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)
    yield TestSession
    engine.dispose()


@pytest.fixture()
def client(db_factory):
    def _override_session():
        db = db_factory()
        try:
            yield db
        except Exception:
            db.rollback()
            raise
        finally:
            db.close()

    app.dependency_overrides[get_session] = _override_session
    yield TestClient(app, raise_server_exceptions=False)
    app.dependency_overrides.clear()


def _login_as(org_id: str, member_id: str | None = None) -> None:
    """인증을 override해 탐색 도메인 동작에만 집중한다(인증 계약은 test_demo_principal이 닫는다).

    ``member_id``를 생략하면 아무 회원에도 대응하지 않는 임의 UUID가 실린다 — 신원 조회가
    "못 찾음"으로 흐르는 상태다(그래도 탐색·역할 응답은 그대로 나와야 한다).
    """
    app.dependency_overrides[get_current_principal] = lambda: Principal(
        member_id=member_id or str(uuid.uuid4()), organization_id=str(org_id)
    )


class World:
    def __init__(self, **kwargs):
        self.__dict__.update(kwargs)


def _keyword(db, code: str, label: str) -> Keyword:
    """사업분야 키워드 — 마이그레이션 시드에 이미 있으면 그걸 쓴다(테스트가 마스터를 늘리지 않는다)."""
    found = db.execute(
        select(Keyword).where(Keyword.category == "business_field", Keyword.code == code)
    ).scalar_one_or_none()
    if found is None:
        found = Keyword(code=code, label=label, category="business_field")
        db.add(found)
        db.flush()
    return found


def _add_role(db, event_id, org_id, *, exhibitor=False, buyer=False, status="approved", subtype=None):
    role = OrganizationEventRole(
        event_id=event_id,
        organization_id=org_id,
        is_exhibitor=exhibitor,
        is_buyer=buyer,
        buyer_subtype=subtype,
        application_status=status,
    )
    db.add(role)
    db.flush()
    return role


def _fill_exhibitor(db, role, *, with_booth=True, event_id=None) -> ExhibitorProfile:
    """참가사 프로필 — **공개 필드와 비공개 마커를 함께** 채운다(유출 검사가 의미 있으려면 둘 다 필요)."""
    profile = ExhibitorProfile(
        org_event_role_id=role.id,
        # 공개 대상
        intro_ko="오리지널 애니메이션과 캐릭터 IP를 제작하는 콘텐츠 기업",
        intro_en="Content studio producing original animation and character IP.",
        employee_range="e_11_50",
        content_category="animation_character",
        # 비공개 — 탐색에 나가면 안 되는 것들
        company_email="MARKER-EXH-COMPANY-EMAIL@nabi.test",
        main_tel="MARKER-EXH-MAIN-TEL",
        fax="MARKER-EXH-FAX",
        address_ko="MARKER-EXH-ADDRESS-국문주소",
        address_detail="MARKER-EXH-ADDRESS-DETAIL",
        zip_code="MARKER-EXH-ZIPCODE",
        representative_name_ko="MARKER-EXH-REPRESENTATIVE-대표자",
        kst_available_time="MARKER-EXH-KST-TIME",
        annual_sales_range="krw_50plus",
        unavailable_meeting_slots=["MARKER-EXH-UNAVAILABLE-SLOT"],
    )
    if with_booth:
        hall = Hall(event_id=event_id, hall_no=f"7-{next(_seq)}", hall_name="7홀")
        db.add(hall)
        db.flush()
        booth = Booth(hall_id=hall.id, code="A-12")
        db.add(booth)
        db.flush()
        profile.booth_id = booth.id
    db.add(profile)
    db.flush()

    db.add_all(
        [
            ExhibitorProduct(
                exhibitor_profile_id=profile.id,
                name_ko="오리지널 애니메이션 시리즈",
                business_field="content_production",
                sort_order=0,
            ),
            ExhibitorProduct(
                exhibitor_profile_id=profile.id,
                name_ko="캐릭터 라이선싱 패키지",
                business_field="character_licensor",
                sort_order=1,
            ),
            ExhibitorAttendee(
                exhibitor_profile_id=profile.id,
                last_name_ko="MARKER-EXH-ATTENDEE-이름",
                email="MARKER-EXH-ATTENDEE-EMAIL@nabi.test",
                tel="MARKER-EXH-ATTENDEE-TEL",
                mobile="MARKER-EXH-ATTENDEE-MOBILE",
                whatsapp_id="MARKER-EXH-ATTENDEE-WHATSAPP",
            ),
            ExhibitorRecommendedBuyer(
                exhibitor_profile_id=profile.id,
                org_name_en="MARKER-EXH-RECOMMENDED-BUYER",
                email="MARKER-EXH-RECOMMENDED-EMAIL@nabi.test",
            ),
            ExhibitorKeyword(
                exhibitor_profile_id=profile.id,
                keyword_id=_keyword(db, "content_production", "콘텐츠 제작").id,
            ),
        ]
    )
    db.flush()
    return profile


def _fill_buyer(db, role) -> BuyerProfile:
    profile = BuyerProfile(
        org_event_role_id=role.id,
        # 공개 대상
        company_intro_en="Content investment group sourcing animation and character IP.",
        employee_range="e_101plus",
        # 비공개
        note="MARKER-BUY-NOTE-비공개메모",
        tel="MARKER-BUY-TEL",
        address1="MARKER-BUY-ADDRESS1",
        city_state="MARKER-BUY-CITY",
        last_year_best_buyer="MARKER-BUY-BEST-BUYER",
        annual_sales_range="usd_gt_5m",
    )
    db.add(profile)
    db.flush()
    db.add_all(
        [
            BuyerAttendee(
                buyer_profile_id=profile.id,
                last_name="MARKER-BUY-ATTENDEE-이름",
                email="MARKER-BUY-ATTENDEE-EMAIL@nabi.test",
                tel="MARKER-BUY-ATTENDEE-TEL",
                mobile="MARKER-BUY-ATTENDEE-MOBILE",
                whatsapp_id="MARKER-BUY-ATTENDEE-WHATSAPP",
            ),
            BuyerRecommendedBuyer(
                buyer_profile_id=profile.id,
                organization="MARKER-BUY-RECOMMENDED-ORG",
                email="MARKER-BUY-RECOMMENDED-EMAIL@nabi.test",
            ),
            BuyerInterestKeyword(
                buyer_profile_id=profile.id, keyword_id=_keyword(db, "music_production", "음악 제작").id
            ),
        ]
    )
    db.flush()
    return profile


def _seed_world(db_factory, *, allow_same_role_discovery: bool = False) -> World:
    """행사 1 + 참가사 1 + 바이어 1(둘 다 승인·프로필 완비). 비공개 필드는 전부 마커로 채워둔다."""
    n = next(_seq)
    db = db_factory()
    try:
        event = Event(
            name="DX Korea 2026",
            slug=f"dv-{n}-{uuid.uuid4().hex[:8]}",
            exhibition_start=date.today() + timedelta(days=15),
            exhibition_end=date.today() + timedelta(days=18),
            allow_same_role_discovery=allow_same_role_discovery,
        )
        exhibitor = Organization(
            name_ko="한빛스튜디오",
            name_en="Hanbit Defense",
            business_reg_no="MARKER-BIZREG-0000000000",
        )
        buyer = Organization(name_ko=None, name_en="Seoul Content Partners")
        db.add_all([event, exhibitor, buyer])
        db.flush()

        exhibitor_role = _add_role(db, event.id, exhibitor.id, exhibitor=True)
        buyer_role = _add_role(
            db, event.id, buyer.id, buyer=True, subtype="hosted"
        )
        _fill_exhibitor(db, exhibitor_role, event_id=event.id)
        _fill_buyer(db, buyer_role)

        db.commit()
        return World(
            event_id=event.id,
            exhibitor_org=exhibitor.id,
            buyer_org=buyer.id,
            exhibitor_role_id=exhibitor_role.id,
            buyer_role_id=buyer_role.id,
        )
    finally:
        db.close()


def _set_participant_menu(db_factory, event_id: str, value: str) -> None:
    """행사 설정 행을 만들어 참가자 메뉴를 정한다(어드민 PATCH가 하는 일을 DB에 직접)."""
    db = db_factory()
    try:
        db.add(EventScheduleSettings(event_id=event_id, participant_menu=value))
        db.commit()
    finally:
        db.close()


def _add_org(
    db_factory, world: World, *, name: str, exhibitor=False, buyer=False, status="approved",
    subtype=None, with_profile: bool = False,
) -> str:
    """행사에 기업을 하나 더 붙인다(승인 상태·역할·프로필 유무를 케이스별로 바꿔가며 쓴다)."""
    db = db_factory()
    try:
        org = Organization(name_ko=name)
        db.add(org)
        db.flush()
        role = _add_role(
            db, world.event_id, org.id, exhibitor=exhibitor, buyer=buyer, status=status,
            subtype=subtype,
        )
        if with_profile and exhibitor:
            _fill_exhibitor(db, role, with_booth=False, event_id=world.event_id)
        if with_profile and buyer:
            _fill_buyer(db, role)
        db.commit()
        return org.id
    finally:
        db.close()


def _add_i18n_exhibitor(
    db_factory,
    world: World,
    *,
    name_ko: str | None,
    name_en: str | None,
    intro_ko: str | None,
    intro_en: str | None,
    keyword_label: str,
    keyword_label_en: str | None,
    product_name_ko: str,
    product_name_en: str | None,
) -> str:
    """국/영 값을 한 쌍씩 직접 지정한 참가사 하나 — 로케일 선택과 폴백을 동시에 검사할 수 있게.

    키워드는 **매번 새 행**을 만든다(코드에 uuid 조각). 마이그레이션이 깔아둔 사업분야 8종 마스터를
    건드리면 세션 스코프 DB를 공유하는 다른 테스트의 기대값(``label_en``이 NULL이라는 전제)을
    바꿔버려 실행 순서에 따라 결과가 달라진다.
    """
    db = db_factory()
    try:
        org = Organization(name_ko=name_ko, name_en=name_en)
        db.add(org)
        db.flush()
        role = _add_role(db, world.event_id, org.id, exhibitor=True)
        profile = ExhibitorProfile(
            org_event_role_id=role.id, intro_ko=intro_ko, intro_en=intro_en
        )
        db.add(profile)
        db.flush()
        keyword = Keyword(
            code=f"i18n-{uuid.uuid4().hex[:8]}",
            label=keyword_label,
            label_en=keyword_label_en,
            category="business_field",
        )
        db.add(keyword)
        db.flush()
        db.add_all(
            [
                ExhibitorProduct(
                    exhibitor_profile_id=profile.id,
                    name_ko=product_name_ko,
                    name_en=product_name_en,
                    sort_order=0,
                ),
                ExhibitorKeyword(exhibitor_profile_id=profile.id, keyword_id=keyword.id),
            ]
        )
        db.commit()
        return str(org.id)
    finally:
        db.close()


# =============================================================================
# 유출 방지 — 이 파일의 제1 관심사
# =============================================================================
def _walk_keys(node, found: set[str]) -> None:
    if isinstance(node, dict):
        for key, value in node.items():
            found.add(key)
            _walk_keys(value, found)
    elif isinstance(node, list):
        for item in node:
            _walk_keys(item, found)


def _assert_no_leak(body) -> None:
    """응답에 금칙 키·마커 값이 하나도 없어야 한다."""
    keys: set[str] = set()
    _walk_keys(body, keys)
    for key in keys:
        for term in FORBIDDEN_KEY_TERMS:
            assert term not in key.lower(), f"금칙 필드가 응답에 나타났다: {key}"

    blob = json.dumps(body, ensure_ascii=False)
    for marker in MARKERS:
        assert marker not in blob, f"비공개 값이 응답에 새어나왔다: {marker}"


def test_forbidden_terms_do_not_match_allowed_keys():
    """금칙어 목록이 허용 키를 오탐하지 않는지 — 검사 자체가 무의미해지는 걸 막는다(메타 테스트)."""
    for key in ALLOWED_CARD_KEYS | ALLOWED_BOOTH_KEYS | {"items", "total"}:
        for term in FORBIDDEN_KEY_TERMS:
            assert term not in key.lower(), f"금칙어 {term!r}가 허용 키 {key!r}를 오탐한다"


class TestNoLeak:
    def test_list_exposes_only_whitelisted_fields(self, client, db_factory):
        world = _seed_world(db_factory)
        _login_as(world.buyer_org)

        resp = client.get("/api/discover/organizations", params={"event_id": world.event_id})

        assert resp.status_code == 200
        body = resp.json()
        assert body["items"], "검사할 카드가 없으면 유출 테스트가 무의미하다"
        for item in body["items"]:
            assert set(item) == ALLOWED_CARD_KEYS
            if item["booth"] is not None:
                assert set(item["booth"]) == ALLOWED_BOOTH_KEYS
        _assert_no_leak(body)

    def test_detail_exposes_only_whitelisted_fields(self, client, db_factory):
        world = _seed_world(db_factory)
        _login_as(world.buyer_org)

        resp = client.get(f"/api/discover/organizations/{world.exhibitor_org}")

        assert resp.status_code == 200
        body = resp.json()
        assert set(body) == ALLOWED_CARD_KEYS
        assert set(body["booth"]) == ALLOWED_BOOTH_KEYS
        _assert_no_leak(body)

    def test_buyer_card_hides_buyer_private_fields(self, client, db_factory):
        """바이어 카드도 같은 화이트리스트다(노트·연락처·매출구간 비노출)."""
        world = _seed_world(db_factory)
        _login_as(world.exhibitor_org)

        resp = client.get(f"/api/discover/organizations/{world.buyer_org}")

        assert resp.status_code == 200
        body = resp.json()
        assert set(body) == ALLOWED_CARD_KEYS
        _assert_no_leak(body)


# =============================================================================
# 공개 프로젝션의 내용
# =============================================================================
class TestProjection:
    def test_exhibitor_card_contents(self, client, db_factory):
        world = _seed_world(db_factory)
        _login_as(world.buyer_org)

        card = client.get(f"/api/discover/organizations/{world.exhibitor_org}").json()

        assert card["org_id"] == world.exhibitor_org
        assert card["role"] == "exhibitor"
        assert card["name"] == "한빛스튜디오"
        assert card["buyer_subtype"] is None
        assert card["booth"] == {"hall_no": card["booth"]["hall_no"], "hall_name": "7홀", "code": "A-12"}
        assert card["keywords"] == ["콘텐츠 제작"]
        # 전시품목은 sort_order 순서를 그대로 유지한다.
        assert card["exhibits"] == ["오리지널 애니메이션 시리즈", "캐릭터 라이선싱 패키지"]
        assert card["description"] == "오리지널 애니메이션과 캐릭터 IP를 제작하는 콘텐츠 기업"
        assert card["employee_range"] == "e_11_50"
        assert card["content_category"] == "animation_character"

    def test_buyer_card_contents(self, client, db_factory):
        world = _seed_world(db_factory)
        _login_as(world.exhibitor_org)

        card = client.get(f"/api/discover/organizations/{world.buyer_org}").json()

        assert card["role"] == "buyer"
        # 국문명이 없으면 영문명으로 폴백한다(uuid를 이름 자리에 넣지 않는다).
        assert card["name"] == "Seoul Content Partners"
        assert card["buyer_subtype"] == "hosted"
        assert card["booth"] is None
        assert card["exhibits"] == []
        assert card["keywords"] == ["음악 제작"]
        assert card["description"] == "Content investment group sourcing animation and character IP."
        assert card["employee_range"] == "e_101plus"
        assert card["content_category"] is None

    def test_org_without_profile_listed_with_name_and_role_only(self, client, db_factory):
        """대리작성 전(프로필 없음) 기업도 목록에 나온다 — 빈 값으로 정직하게."""
        world = _seed_world(db_factory)
        bare = _add_org(db_factory, world, name="프로필없는바이어", buyer=True)
        _login_as(world.exhibitor_org)

        body = client.get("/api/discover/organizations", params={"event_id": world.event_id}).json()

        card = next(item for item in body["items"] if item["org_id"] == bare)
        assert card["name"] == "프로필없는바이어"
        assert card["role"] == "buyer"
        assert card["booth"] is None
        assert card["keywords"] == []
        assert card["exhibits"] == []
        assert card["description"] is None
        assert card["employee_range"] is None


# =============================================================================
# 열람 범위(§8) — 행사 정책
# =============================================================================
class TestVisibility:
    def test_buyer_sees_exhibitor_not_other_buyers(self, client, db_factory):
        world = _seed_world(db_factory)
        other_buyer = _add_org(db_factory, world, name="다른바이어", buyer=True)
        _login_as(world.buyer_org)

        body = client.get("/api/discover/organizations", params={"event_id": world.event_id}).json()

        assert [item["org_id"] for item in body["items"]] == [world.exhibitor_org]
        assert other_buyer not in {item["org_id"] for item in body["items"]}
        assert body["total"] == 1

    def test_exhibitor_does_not_see_other_exhibitors(self, client, db_factory):
        world = _seed_world(db_factory)
        rival = _add_org(db_factory, world, name="경쟁참가사", exhibitor=True)
        _login_as(world.exhibitor_org)

        body = client.get("/api/discover/organizations", params={"event_id": world.event_id}).json()

        assert rival not in {item["org_id"] for item in body["items"]}
        assert [item["org_id"] for item in body["items"]] == [world.buyer_org]

    def test_same_role_visible_when_event_policy_allows(self, client, db_factory):
        world = _seed_world(db_factory, allow_same_role_discovery=True)
        rival = _add_org(db_factory, world, name="경쟁참가사", exhibitor=True)
        _login_as(world.exhibitor_org)

        body = client.get("/api/discover/organizations", params={"event_id": world.event_id}).json()

        assert rival in {item["org_id"] for item in body["items"]}

    def test_self_excluded_from_list(self, client, db_factory):
        world = _seed_world(db_factory)
        _login_as(world.exhibitor_org)

        body = client.get("/api/discover/organizations", params={"event_id": world.event_id}).json()

        assert world.exhibitor_org not in {item["org_id"] for item in body["items"]}

    def test_dual_role_target_yields_one_card_per_visible_role(self, client, db_factory):
        """참가사이자 바이어인 기업 — 뷰어(바이어)에게는 참가사 카드만 보인다(동종 열람 차단)."""
        world = _seed_world(db_factory)
        dual = _add_org(db_factory, world, name="양쪽다", exhibitor=True, buyer=True, subtype="pre_registered")
        _login_as(world.buyer_org)

        body = client.get("/api/discover/organizations", params={"event_id": world.event_id}).json()

        dual_cards = [item for item in body["items"] if item["org_id"] == dual]
        assert [card["role"] for card in dual_cards] == ["exhibitor"]

    def test_dual_role_target_yields_two_cards_when_same_role_allowed(self, client, db_factory):
        world = _seed_world(db_factory, allow_same_role_discovery=True)
        dual = _add_org(db_factory, world, name="양쪽다", exhibitor=True, buyer=True, subtype="pre_registered")
        _login_as(world.buyer_org)

        body = client.get("/api/discover/organizations", params={"event_id": world.event_id}).json()

        dual_cards = [item for item in body["items"] if item["org_id"] == dual]
        # 참가사 카드가 먼저(ROLE_ORDER), 바이어 카드가 뒤.
        assert [card["role"] for card in dual_cards] == ["exhibitor", "buyer"]
        assert dual_cards[1]["buyer_subtype"] == "pre_registered"
        # total은 기업 수가 아니라 **카드 수**다.
        assert body["total"] == len(body["items"])

    def test_dual_role_viewer_sees_both_sides(self, client, db_factory):
        """뷰어가 dual-role이면 어느 역할로든 보이면 보인다(미팅 resolve_pair와 같은 any())."""
        world = _seed_world(db_factory)
        dual_viewer = _add_org(db_factory, world, name="양쪽다뷰어", exhibitor=True, buyer=True)
        _login_as(dual_viewer)

        body = client.get("/api/discover/organizations", params={"event_id": world.event_id}).json()

        assert {item["org_id"] for item in body["items"]} == {world.exhibitor_org, world.buyer_org}


# =============================================================================
# 승인 상태 — 노출은 approved부터
# =============================================================================
class TestApproval:
    @pytest.mark.parametrize("status", ["registered", "submitted", "changes_requested", "rejected"])
    def test_unapproved_target_not_listed(self, client, db_factory, status):
        world = _seed_world(db_factory)
        pending = _add_org(db_factory, world, name="심사중바이어", buyer=True, status=status)
        _login_as(world.exhibitor_org)

        body = client.get("/api/discover/organizations", params={"event_id": world.event_id}).json()

        assert pending not in {item["org_id"] for item in body["items"]}

    def test_unapproved_target_detail_is_404_not_403(self, client, db_factory):
        """미승인 기업은 **존재를 숨긴다** — 403이면 "그 기업은 있다"를 알려주는 셈이다."""
        world = _seed_world(db_factory)
        pending = _add_org(db_factory, world, name="심사중바이어", buyer=True, status="submitted")
        _login_as(world.exhibitor_org)

        resp = client.get(f"/api/discover/organizations/{pending}")

        assert resp.status_code == 404
        assert resp.json()["detail"]["code"] == "NOT_FOUND"

    def test_unapproved_viewer_403(self, client, db_factory):
        world = _seed_world(db_factory)
        pending_viewer = _add_org(db_factory, world, name="심사중참가사", exhibitor=True, status="submitted")
        _login_as(pending_viewer)

        resp = client.get("/api/discover/organizations", params={"event_id": world.event_id})

        assert resp.status_code == 403
        assert resp.json()["detail"]["code"] == "PROFILE_NOT_APPROVED"

    def test_unapproved_viewer_can_still_see_own_card(self, client, db_factory):
        """승인 전에도 내 카드는 내 것 — 화면이 "이렇게 보입니다" 미리보기를 그린다."""
        world = _seed_world(db_factory)
        pending_viewer = _add_org(
            db_factory, world, name="심사중참가사", exhibitor=True, status="submitted",
            with_profile=True,
        )
        _login_as(pending_viewer)

        resp = client.get(f"/api/discover/organizations/{pending_viewer}")

        assert resp.status_code == 200
        assert resp.json()["org_id"] == pending_viewer
        assert resp.json()["role"] == "exhibitor"


# =============================================================================
# 거부 경로 — 코드 매트릭스
# =============================================================================
class TestRejections:
    def test_non_participant_403(self, client, db_factory):
        world = _seed_world(db_factory)
        outsider = Organization(name_ko="행사밖기업")
        db = db_factory()
        try:
            db.add(outsider)
            db.commit()
            outsider_id = outsider.id
        finally:
            db.close()
        _login_as(outsider_id)

        resp = client.get("/api/discover/organizations", params={"event_id": world.event_id})

        assert resp.status_code == 403
        assert resp.json()["detail"]["code"] == "NOT_PARTICIPANT"

    def test_invisible_target_detail_403(self, client, db_factory):
        world = _seed_world(db_factory)
        rival = _add_org(db_factory, world, name="경쟁참가사", exhibitor=True)
        _login_as(world.exhibitor_org)

        resp = client.get(f"/api/discover/organizations/{rival}")

        assert resp.status_code == 403
        assert resp.json()["detail"]["code"] == "NOT_VISIBLE"

    def test_self_detail_bypasses_visibility(self, client, db_factory):
        """동종 열람이 막힌 행사에서도 자기 카드는 열린다."""
        world = _seed_world(db_factory)
        _login_as(world.exhibitor_org)

        resp = client.get(f"/api/discover/organizations/{world.exhibitor_org}")

        assert resp.status_code == 200
        assert resp.json()["org_id"] == world.exhibitor_org

    def test_unknown_org_404(self, client, db_factory):
        world = _seed_world(db_factory)
        _login_as(world.exhibitor_org)

        assert client.get(f"/api/discover/organizations/{UNKNOWN_ID}").status_code == 404

    def test_malformed_org_id_404(self, client, db_factory):
        world = _seed_world(db_factory)
        _login_as(world.exhibitor_org)

        resp = client.get("/api/discover/organizations/not-a-uuid")

        assert resp.status_code == 404
        assert resp.json()["detail"]["code"] == "NOT_FOUND"

    def test_malformed_event_id_404(self, client, db_factory):
        world = _seed_world(db_factory)
        _login_as(world.exhibitor_org)

        resp = client.get("/api/discover/organizations", params={"event_id": "not-a-uuid"})

        assert resp.status_code == 404

    def test_event_ambiguous_400_when_multiple_events(self, client, db_factory):
        world = _seed_world(db_factory)
        db = db_factory()
        try:
            second = Event(name="다른 행사", slug=f"dv-2nd-{uuid.uuid4().hex[:8]}")
            db.add(second)
            db.flush()
            _add_role(db, second.id, world.exhibitor_org, exhibitor=True)
            db.commit()
        finally:
            db.close()
        _login_as(world.exhibitor_org)

        resp = client.get("/api/discover/organizations")

        assert resp.status_code == 400
        assert resp.json()["detail"]["code"] == "EVENT_AMBIGUOUS"

    def test_event_id_omitted_resolves_single_event(self, client, db_factory):
        world = _seed_world(db_factory)
        _login_as(world.exhibitor_org)

        resp = client.get("/api/discover/organizations")

        assert resp.status_code == 200
        assert [item["org_id"] for item in resp.json()["items"]] == [world.buyer_org]

    def test_unauthenticated_401(self, client, db_factory):
        _seed_world(db_factory)
        app.dependency_overrides.pop(get_current_principal, None)

        assert client.get("/api/discover/organizations").status_code == 401
        assert client.get(f"/api/discover/organizations/{UNKNOWN_ID}").status_code == 401


# =============================================================================
# GET /api/me
# =============================================================================
class TestMe:
    def test_returns_org_and_all_event_roles(self, client, db_factory):
        world = _seed_world(db_factory)
        _login_as(world.exhibitor_org)

        resp = client.get("/api/me")

        assert resp.status_code == 200
        body = resp.json()
        assert body["organization_id"] == world.exhibitor_org
        assert body["organization_name"] == "한빛스튜디오"
        assert len(body["roles"]) == 1
        role = body["roles"][0]
        assert role == {
            "event_id": world.event_id,
            "org_event_role_id": world.exhibitor_role_id,
            "is_exhibitor": True,
            "is_buyer": False,
            "buyer_subtype": None,
            "application_status": "approved",
            # 전시 기간도 함께 내려간다 — 미팅 타임라인 날짜 탭이 이 값으로 그려진다(하드코딩 금지).
            # 기대값도 _seed_world와 **같은 상대식**으로 계산한다 — 절대 날짜를 박으면 시드가
            # date.today() 기준이라 작성한 그 날에만 통과하고 다음날부터 깨진다(실제로 깨졌다).
            "exhibition_start": (date.today() + timedelta(days=15)).isoformat(),
            "exhibition_end": (date.today() + timedelta(days=18)).isoformat(),
            # 격자 모양도 함께 내려간다(mt003gap0001) — 참가자 미팅 타임라인이 칸 길이·텀을 이 값으로
            # 끊는다. 없으면 프런트가 30분/텀0 으로 폴백해 40분/텀5분 행사에서 미팅이 잘못된 행에
            # 그려진다. slot_minutes 는 _seed_world 의 events 기본값(30), 텀은 설정 행 기본값(0).
            "slot_minutes": 30,
            "slot_gap_minutes": 0,
            # 운영시간·점심도 같은 이유로 함께 내려간다 — 칸 길이·텀만 보내면 "어디서 시작하는가"가
            # 빠져서, 10:00 시작 행사에서 참가자 격자(09:00 폴백)가 백엔드 격자와 한 시각도 안 겹친다.
            # 이 시드는 event_schedule_settings 행을 만들지 않으므로 전부 None(화면이 폴백을 고른다).
            "operating_start": None,
            "operating_end": None,
            "lunch_start": None,
            "lunch_end": None,
            # 참가자 메뉴(nv001menu0001) — 설정 행이 없는 행사는 기본값(미팅만)이다. 화면이 왼쪽 메뉴·
            # 도착 화면을 이 값으로 고른다.
            "participant_menu": "meetings_only",
        }

    def test_participant_menu_follows_event_schedule_settings(self, client, db_factory):
        """행사 설정이 '전체 메뉴'면 그 행사의 역할 행에 실린다 — 참가사·바이어 둘 다 같은 값을 본다."""
        world = _seed_world(db_factory)
        _set_participant_menu(db_factory, world.event_id, "full")

        for org in (world.exhibitor_org, world.buyer_org):
            _login_as(org)
            assert client.get("/api/me").json()["roles"][0]["participant_menu"] == "full"

    def test_participant_menu_default_is_the_same_with_or_without_a_settings_row(
        self, client, db_factory
    ):
        """설정 행이 없는 행사와, 행은 있지만 메뉴를 건드린 적 없는 행사(= 마이그레이션 백필 상태)가 같은
        기본값을 받는다 — 운영자가 설정 화면을 열어 행이 생겼다고 참가자 화면이 바뀌면 안 된다."""
        world = _seed_world(db_factory)
        _login_as(world.buyer_org)
        without_row = client.get("/api/me").json()["roles"][0]["participant_menu"]

        db = db_factory()
        try:
            db.add(EventScheduleSettings(event_id=world.event_id, slot_gap_minutes=5))
            db.commit()
        finally:
            db.close()
        with_row = client.get("/api/me").json()["roles"][0]["participant_menu"]

        assert without_row == with_row == DEFAULT_PARTICIPANT_MENU == "meetings_only"

    def test_participant_menu_is_per_event(self, client, db_factory):
        """행사 단위 값이다 — 같은 기업이 두 행사에 참가하면 행사마다 자기 설정을 받는다."""
        world = _seed_world(db_factory)
        db = db_factory()
        try:
            second = Event(name="다른 행사", slug=f"dv-menu-{uuid.uuid4().hex[:8]}")
            db.add(second)
            db.flush()
            _add_role(db, second.id, world.exhibitor_org, exhibitor=True)
            db.commit()
            second_id = second.id
        finally:
            db.close()
        _set_participant_menu(db_factory, second_id, "full")
        _login_as(world.exhibitor_org)

        by_event = {role["event_id"]: role for role in client.get("/api/me").json()["roles"]}

        assert by_event[world.event_id]["participant_menu"] == "meetings_only"
        assert by_event[second_id]["participant_menu"] == "full"

    def test_meetings_only_does_not_close_any_api(self, client, db_factory):
        """화면 구성용 값이다 — '미팅만'인 행사에서도 탐색·상세·관심기업 API는 그대로 열려 있다(ADR-0015)."""
        world = _seed_world(db_factory)
        _set_participant_menu(db_factory, world.event_id, "meetings_only")
        _login_as(world.buyer_org)

        listing = client.get("/api/discover/organizations")
        assert listing.status_code == 200
        assert [card["org_id"] for card in listing.json()["items"]] == [world.exhibitor_org]
        assert client.get(f"/api/discover/organizations/{world.exhibitor_org}").status_code == 200
        bookmark = client.post(
            "/api/discover/bookmarks", json={"target_org_id": world.exhibitor_org, "source": "all"}
        )
        assert bookmark.status_code == 201

    def test_carries_operating_hours_and_lunch_from_schedule_settings(self, client, db_factory):
        """설정 행이 있으면 운영시간·점심이 "HH:MM"으로 실린다 — 참가자 타임라인 격자의 원천."""
        world = _seed_world(db_factory)
        db = db_factory()
        try:
            db.add(
                EventScheduleSettings(
                    event_id=world.event_id,
                    operating_start=time(10, 0),
                    operating_end=time(18, 10),
                    lunch_start=time(12, 10),
                    lunch_end=time(13, 0),
                    slot_gap_minutes=5,
                )
            )
            db.commit()
        finally:
            db.close()
        _login_as(world.exhibitor_org)

        role = client.get("/api/me").json()["roles"][0]

        assert role["operating_start"] == "10:00"
        assert role["operating_end"] == "18:10"
        assert role["lunch_start"] == "12:10"
        assert role["lunch_end"] == "13:00"
        assert role["slot_gap_minutes"] == 5

    def test_buyer_subtype_and_status_are_exposed(self, client, db_factory):
        world = _seed_world(db_factory)
        _login_as(world.buyer_org)

        body = client.get("/api/me").json()

        assert body["organization_name"] == "Seoul Content Partners"
        assert body["roles"][0]["is_buyer"] is True
        assert body["roles"][0]["buyer_subtype"] == "hosted"
        assert body["roles"][0]["application_status"] == "approved"

    def test_lists_every_event_the_org_participates_in(self, client, db_factory):
        world = _seed_world(db_factory)
        db = db_factory()
        try:
            second = Event(name="다른 행사", slug=f"dv-me-{uuid.uuid4().hex[:8]}")
            db.add(second)
            db.flush()
            _add_role(db, second.id, world.exhibitor_org, buyer=True, status="submitted")
            db.commit()
            second_id = second.id
        finally:
            db.close()
        _login_as(world.exhibitor_org)

        body = client.get("/api/me").json()

        by_event = {role["event_id"]: role for role in body["roles"]}
        assert set(by_event) == {world.event_id, second_id}
        assert by_event[second_id]["application_status"] == "submitted"

    def test_unauthenticated_401(self, client, db_factory):
        _seed_world(db_factory)
        app.dependency_overrides.pop(get_current_principal, None)

        assert client.get("/api/me").status_code == 401


# =============================================================================
# GET /api/me — 뷰어 본인의 신원(사이드바·마이페이지 원천)
# =============================================================================
class TestMeIdentity:
    """신원 필드는 **뷰어 자신의 것**이라 탐색 카드의 유출 방지 화이트리스트와 별개다.

    주체 키 두 갈래(UUID=members.id / 비-UUID=registrants.organizer_member_id)를 모두 닫는다 —
    데모 로그인은 후자를 내고, 자체 회원가입은 전자를 낸다. 한쪽만 되면 데모 화면이나 실 화면
    중 하나에서 사이드바가 빈다.
    """

    def test_uuid_member_resolves_from_members_row(self, client, db_factory):
        world = _seed_world(db_factory)
        db = db_factory()
        try:
            member = Member(
                organization_id=world.exhibitor_org,
                name="김한빛",
                email=f"me-{uuid.uuid4().hex[:8]}@nabi.test",
                title="해외영업팀장",
                phone="010-2201-0001",
            )
            db.add(member)
            db.commit()
            member_id = str(member.id)
            member_email = member.email
        finally:
            db.close()
        _login_as(world.exhibitor_org, member_id=member_id)

        body = client.get("/api/me").json()

        assert body["member_name"] == "김한빛"
        assert body["member_email"] == member_email
        assert body["member_phone"] == "010-2201-0001"
        assert body["member_title"] == "해외영업팀장"
        assert body["organization_name"] == "한빛스튜디오"
        assert body["organization_name_en"] == "Hanbit Defense"

    def test_demo_subject_prefers_member_linked_to_registrant(self, client, db_factory):
        """비-UUID 주체라도 그 명단 행을 가리키는 회원이 있으면 회원 값이 이긴다(나중 갱신 반영)."""
        world = _seed_world(db_factory)
        subject = f"mbr-buyer-{uuid.uuid4().hex[:6]}"
        db = db_factory()
        try:
            registrant = Registrant(
                event_id=world.event_id,
                organizer_member_id=subject,
                organization_id=world.buyer_org,
                name="명단에 적힌 이름",
                contact_email="roster@nabi.test",
                contact_phone="010-0000-0000",
                raw={"source": "test"},
            )
            db.add(registrant)
            db.flush()
            db.add(
                Member(
                    organization_id=world.buyer_org,
                    registrant_id=registrant.id,
                    name="Nguyen Van A",
                    email=f"member-{uuid.uuid4().hex[:8]}@nabi.test",
                    title="Procurement Manager",
                    phone="010-2202-0001",
                )
            )
            db.commit()
        finally:
            db.close()
        _login_as(world.buyer_org, member_id=subject)

        body = client.get("/api/me").json()

        assert body["member_name"] == "Nguyen Van A"
        assert body["member_phone"] == "010-2202-0001"
        assert body["member_title"] == "Procurement Manager"

    def test_demo_subject_falls_back_to_registrant_when_no_member(self, client, db_factory):
        """명단만 적재되고 회원 승격 전인 주체 — 신고값으로 채우고 직함은 None(대응 컬럼 없음)."""
        world = _seed_world(db_factory)
        subject = f"mbr-exh-{uuid.uuid4().hex[:6]}"
        db = db_factory()
        try:
            db.add(
                Registrant(
                    event_id=world.event_id,
                    organizer_member_id=subject,
                    organization_id=world.exhibitor_org,
                    name="한빛스튜디오 담당자",
                    contact_email="exh@nabi.test",
                    contact_phone="010-2201-0009",
                    raw={"source": "test"},
                )
            )
            db.commit()
        finally:
            db.close()
        _login_as(world.exhibitor_org, member_id=subject)

        body = client.get("/api/me").json()

        assert body["member_name"] == "한빛스튜디오 담당자"
        assert body["member_email"] == "exh@nabi.test"
        assert body["member_phone"] == "010-2201-0009"
        assert body["member_title"] is None

    def test_unknown_subject_leaves_identity_empty_but_still_answers(self, client, db_factory):
        """신원을 못 찾아도 200이다 — 참가 역할은 org에 매달려 있지 회원에 매달려 있지 않다."""
        world = _seed_world(db_factory)
        _login_as(world.exhibitor_org)  # 아무 회원에도 대응하지 않는 UUID

        body = client.get("/api/me").json()

        assert body["member_name"] is None
        assert body["member_email"] is None
        assert body["member_phone"] is None
        assert body["member_title"] is None
        assert len(body["roles"]) == 1

    def test_organization_name_en_is_none_when_absent(self, client, db_factory):
        world = _seed_world(db_factory)
        org_id = _add_org(db_factory, world, name="국문만있는기업", exhibitor=True)
        _login_as(org_id)

        body = client.get("/api/me").json()

        assert body["organization_name"] == "국문만있는기업"
        assert body["organization_name_en"] is None


# =============================================================================
# locale — 응답 **키는 불변**, 값만 로케일로 고른다
# =============================================================================
class TestLocale:
    """en 로케일은 새 필드를 더하지 않는다. 화이트리스트가 로케일마다 갈라지면 유출 방지 테스트가
    무엇을 지키는지 흐려지고, 화면도 매번 "어느 키를 읽나"를 분기해야 한다."""

    def _en_org(self, db_factory, world) -> str:
        return _add_i18n_exhibitor(
            db_factory,
            world,
            name_ko="가온에어로",
            name_en="Gaon Aero",
            intro_ko="항공 부품 기업입니다.",
            intro_en="Aerospace components manufacturer.",
            keyword_label="항공장비",
            keyword_label_en="Aviation Equipment",
            product_name_ko="복합소재 날개 세트",
            product_name_en="Composite Wing Set",
        )

    def _ko_only_org(self, db_factory, world) -> str:
        return _add_i18n_exhibitor(
            db_factory,
            world,
            name_ko="한글만디펜스",
            name_en=None,
            intro_ko="국문 소개만 있는 기업입니다.",
            intro_en=None,
            keyword_label="방호장비",
            keyword_label_en=None,
            product_name_ko="방호 패널",
            product_name_en=None,
        )

    def test_locale_en_selects_english_values(self, client, db_factory):
        world = _seed_world(db_factory)
        org_id = self._en_org(db_factory, world)
        _login_as(world.buyer_org)

        card = client.get(
            f"/api/discover/organizations/{org_id}", params={"locale": "en"}
        ).json()

        assert card["name"] == "Gaon Aero"
        assert card["description"] == "Aerospace components manufacturer."
        assert card["keywords"] == ["Aviation Equipment"]
        assert card["exhibits"] == ["Composite Wing Set"]

    def test_default_locale_is_korean(self, client, db_factory):
        world = _seed_world(db_factory)
        org_id = self._en_org(db_factory, world)
        _login_as(world.buyer_org)

        card = client.get(f"/api/discover/organizations/{org_id}").json()

        assert card["name"] == "가온에어로"
        assert card["description"] == "항공 부품 기업입니다."
        assert card["keywords"] == ["항공장비"]
        assert card["exhibits"] == ["복합소재 날개 세트"]

    def test_locale_en_falls_back_to_korean_when_translation_missing(self, client, db_factory):
        """영문이 없으면 국문으로 — 번역 공백이 카드를 통째로 비우면 안 된다."""
        world = _seed_world(db_factory)
        org_id = self._ko_only_org(db_factory, world)
        _login_as(world.buyer_org)

        card = client.get(
            f"/api/discover/organizations/{org_id}", params={"locale": "en"}
        ).json()

        assert card["name"] == "한글만디펜스"
        assert card["description"] == "국문 소개만 있는 기업입니다."
        assert card["keywords"] == ["방호장비"]
        assert card["exhibits"] == ["방호 패널"]

    def test_unknown_locale_is_treated_as_korean(self, client, db_factory):
        """모르는 로케일은 422가 아니라 ko — 표시 선택지 하나의 오타로 화면이 죽지 않게."""
        world = _seed_world(db_factory)
        org_id = self._en_org(db_factory, world)
        _login_as(world.buyer_org)

        resp = client.get(
            f"/api/discover/organizations/{org_id}", params={"locale": "fr-FR"}
        )

        assert resp.status_code == 200
        assert resp.json()["name"] == "가온에어로"

    def test_locale_en_list_keeps_whitelist_and_leaks_nothing(self, client, db_factory):
        """en에서도 화이트리스트는 **정확히 같다** — 유출 방지 계약은 로케일과 무관하다."""
        world = _seed_world(db_factory)
        self._en_org(db_factory, world)
        _login_as(world.buyer_org)

        resp = client.get(
            "/api/discover/organizations", params={"event_id": world.event_id, "locale": "en"}
        )

        assert resp.status_code == 200
        body = resp.json()
        assert body["items"]
        for item in body["items"]:
            assert set(item) == ALLOWED_CARD_KEYS
            if item["booth"] is not None:
                assert set(item["booth"]) == ALLOWED_BOOTH_KEYS
        _assert_no_leak(body)

    def test_locale_en_detail_keeps_whitelist(self, client, db_factory):
        world = _seed_world(db_factory)
        _login_as(world.buyer_org)

        resp = client.get(
            f"/api/discover/organizations/{world.exhibitor_org}", params={"locale": "en"}
        )

        assert resp.status_code == 200
        body = resp.json()
        assert set(body) == ALLOWED_CARD_KEYS
        assert set(body["booth"]) == ALLOWED_BOOTH_KEYS
        _assert_no_leak(body)

    def test_buyer_card_description_is_locale_independent(self, client, db_factory):
        """바이어 소개는 스키마상 영문 컬럼 하나뿐이라 ko에서도 그 값이 그대로 나온다."""
        world = _seed_world(db_factory)
        _login_as(world.exhibitor_org)

        ko = client.get(f"/api/discover/organizations/{world.buyer_org}").json()
        en = client.get(
            f"/api/discover/organizations/{world.buyer_org}", params={"locale": "en"}
        ).json()

        assert ko["description"] == en["description"]
        assert ko["description"].startswith("Content investment group")

    def test_locale_en_names_the_hall_by_its_number(self, client, db_factory):
        """홀 이름에는 영문 컬럼이 없다 — en이면 한국어 이름("7홀") 대신 홀 번호로 부른다.

        키는 그대로고(``hall_name``) 값만 바뀐다. ko 응답은 저장값 그대로다.
        """
        world = _seed_world(db_factory)
        _login_as(world.buyer_org)
        path = f"/api/discover/organizations/{world.exhibitor_org}"

        ko = client.get(path).json()["booth"]
        en = client.get(path, params={"locale": "en"}).json()["booth"]

        assert ko["hall_name"] == "7홀"
        assert en == {
            "hall_no": ko["hall_no"],
            "hall_name": f"Hall {ko['hall_no']}",
            "code": "A-12",
        }


def _label_en_column_count(connection) -> int:
    return connection.execute(
        text(
            "SELECT count(*) FROM information_schema.columns"
            " WHERE table_name = 'keywords' AND column_name = 'label_en'"
        )
    ).scalar_one()


def test_migration_up_down_roundtrip(empty_db_url):
    """i18n0001(keywords.label_en)이 깨끗이 내려갔다 다시 올라오는지(kct001tax01도 함께 왕복한다 — head)."""
    from alembic import command
    from alembic.config import Config

    from app.config import settings

    original = settings.database_url
    settings.database_url = empty_db_url
    cfg = Config("alembic.ini")
    engine = create_engine(empty_db_url, future=True)
    try:
        command.upgrade(cfg, "head")
        with engine.connect() as c:
            assert _label_en_column_count(c) == 1

        command.downgrade(cfg, "mt001meet01")
        with engine.connect() as c:
            assert _label_en_column_count(c) == 0

        command.upgrade(cfg, "head")
        with engine.connect() as c:
            assert _label_en_column_count(c) == 1
            # 재적용 후에도 사업분야 국문 라벨 마스터(kct001tax01 시드)는 그대로 — 왕복이 비파괴다.
            assert (
                c.execute(
                    text("SELECT count(*) FROM keywords WHERE category = 'business_field'")
                ).scalar_one()
                == 8
            )
    finally:
        engine.dispose()
        settings.database_url = original


# =============================================================================
# 관심기업(북마크) — H-01: 서버 영속화(interested_organizations)
# =============================================================================
class TestBookmarks:
    def test_add_then_list_reflects_it(self, client, db_factory):
        world = _seed_world(db_factory)
        _login_as(world.buyer_org)

        resp = client.post(
            "/api/discover/bookmarks",
            params={"event_id": world.event_id},
            json={"target_org_id": world.exhibitor_org, "source": "all"},
        )
        assert resp.status_code == 201
        assert resp.json() == {"target_org_id": world.exhibitor_org, "source": "all"}

        body = client.get("/api/discover/bookmarks", params={"event_id": world.event_id}).json()
        assert body["items"] == [{"target_org_id": world.exhibitor_org, "source": "all"}]

    def test_add_is_idempotent_and_preserves_original_source(self, client, db_factory):
        """두 번째 담기 호출은 새 출처로 덮지 않는다 — 첫 등록 출처가 보존된다(전환율 집계 보호)."""
        world = _seed_world(db_factory)
        _login_as(world.buyer_org)

        first = client.post(
            "/api/discover/bookmarks",
            params={"event_id": world.event_id},
            json={"target_org_id": world.exhibitor_org, "source": "ai"},
        )
        second = client.post(
            "/api/discover/bookmarks",
            params={"event_id": world.event_id},
            json={"target_org_id": world.exhibitor_org, "source": "all"},
        )

        assert first.status_code == 201
        assert second.status_code == 201
        assert second.json()["source"] == "ai"

        db = db_factory()
        try:
            rows = db.execute(
                select(InterestedOrganization).where(
                    InterestedOrganization.event_id == world.event_id,
                    InterestedOrganization.owner_org_id == world.buyer_org,
                )
            ).scalars().all()
            assert len(rows) == 1
        finally:
            db.close()

    def test_remove_then_not_listed(self, client, db_factory):
        world = _seed_world(db_factory)
        _login_as(world.buyer_org)
        client.post(
            "/api/discover/bookmarks",
            params={"event_id": world.event_id},
            json={"target_org_id": world.exhibitor_org, "source": "all"},
        )

        resp = client.delete(
            f"/api/discover/bookmarks/{world.exhibitor_org}", params={"event_id": world.event_id}
        )

        assert resp.status_code == 204
        body = client.get("/api/discover/bookmarks", params={"event_id": world.event_id}).json()
        assert body["items"] == []

    def test_remove_is_idempotent_when_never_bookmarked(self, client, db_factory):
        world = _seed_world(db_factory)
        _login_as(world.buyer_org)

        resp = client.delete(
            f"/api/discover/bookmarks/{world.exhibitor_org}", params={"event_id": world.event_id}
        )

        assert resp.status_code == 204

    def test_bookmarks_are_scoped_to_owner_org(self, client, db_factory):
        """다른 기업이 같은 대상을 담아도 서로 섞이지 않는다(owner_org_id 스코프)."""
        world = _seed_world(db_factory)
        other_buyer = _add_org(db_factory, world, name="다른바이어", buyer=True)
        _login_as(other_buyer)
        client.post(
            "/api/discover/bookmarks",
            params={"event_id": world.event_id},
            json={"target_org_id": world.exhibitor_org, "source": "all"},
        )

        _login_as(world.buyer_org)
        body = client.get("/api/discover/bookmarks", params={"event_id": world.event_id}).json()

        assert body["items"] == []

    def test_add_rejects_invisible_target(self, client, db_factory):
        """열람 범위 밖의 기업은 담을 수도 없다(NOT_VISIBLE) — 화면 검사만 믿지 않는다."""
        world = _seed_world(db_factory)
        rival = _add_org(db_factory, world, name="경쟁참가사", exhibitor=True)
        _login_as(world.exhibitor_org)

        resp = client.post(
            "/api/discover/bookmarks",
            params={"event_id": world.event_id},
            json={"target_org_id": rival, "source": "all"},
        )

        assert resp.status_code == 403
        assert resp.json()["detail"]["code"] == "NOT_VISIBLE"

    def test_add_unknown_target_404(self, client, db_factory):
        world = _seed_world(db_factory)
        _login_as(world.exhibitor_org)

        resp = client.post(
            "/api/discover/bookmarks",
            params={"event_id": world.event_id},
            json={"target_org_id": UNKNOWN_ID, "source": "all"},
        )

        assert resp.status_code == 404

    def test_add_rejects_unapproved_viewer(self, client, db_factory):
        world = _seed_world(db_factory)
        pending_viewer = _add_org(
            db_factory, world, name="심사중참가사", exhibitor=True, status="submitted"
        )
        _login_as(pending_viewer)

        resp = client.post(
            "/api/discover/bookmarks",
            params={"event_id": world.event_id},
            json={"target_org_id": world.buyer_org, "source": "all"},
        )

        assert resp.status_code == 403
        assert resp.json()["detail"]["code"] == "PROFILE_NOT_APPROVED"

    def test_add_rejects_extra_field(self, client, db_factory):
        """스키마 밖 필드는 조용히 무시되지 않고 422(extra=forbid) — 반복 버그 패턴 방지."""
        world = _seed_world(db_factory)
        _login_as(world.buyer_org)

        resp = client.post(
            "/api/discover/bookmarks",
            params={"event_id": world.event_id},
            json={"target_org_id": world.exhibitor_org, "source": "all", "bogus": "x"},
        )

        assert resp.status_code == 422

    def test_unauthenticated_401(self, client, db_factory):
        world = _seed_world(db_factory)
        app.dependency_overrides.pop(get_current_principal, None)

        assert client.get("/api/discover/bookmarks").status_code == 401
        assert (
            client.post(
                "/api/discover/bookmarks", json={"target_org_id": world.exhibitor_org}
            ).status_code
            == 401
        )
        assert client.delete(f"/api/discover/bookmarks/{world.exhibitor_org}").status_code == 401
