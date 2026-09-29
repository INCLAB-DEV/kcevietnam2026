"""기업 탐색 서비스 — 열람 범위 판정 + 공개 프로젝션 조립.

**검사 순서는 미팅 슬라이스와 같다**(``meetings.service.resolve_pair`` 주석 참고):
존재 404 → 승인 403 → 가시성 403. 순서가 어긋나면 "승인 전이라 못 본다"와 "그 기업은 원래 못
본다"가 뒤바뀌어 화면이 엉뚱한 안내를 띄운다.

**규칙은 재구현하지 않는다.** 행사 자동 해석은 ``meetings.service.resolve_event_id``를, 열람 범위는
``domain.visibility_rules.can_view_organization``을 그대로 쓴다. 탐색에서는 보이는데 미팅 신청은
막히는(혹은 그 반대) 상태를 만들지 않으려면 두 경로가 **같은 함수**를 봐야 한다.

**목록은 배치로 읽는다.** 기업마다 프로필·부스·품목·키워드를 따로 조회하면 50개 기업에 200번
쿼리가 나간다. ``_load_profiles``가 필요한 전부를 역할 id 집합 하나로 미리 모아 온다.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Sequence
from uuid import UUID

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.auth.principal import Principal
from app.domain.visibility_rules import can_view_organization
from app.meetings import service as meetings_service
from app.models import (
    Booth,
    BuyerInterestKeyword,
    BuyerProfile,
    Event,
    EventScheduleSettings,
    ExhibitorKeyword,
    ExhibitorProduct,
    ExhibitorProfile,
    Hall,
    InterestedOrganization,
    Keyword,
    Member,
    Organization,
    OrganizationEventRole,
    Registrant,
)

#: 카드 정렬·단건 선택의 결정적 순서. dual-role 기업은 참가사 카드가 먼저다.
ROLE_ORDER: tuple[str, ...] = ("exhibitor", "buyer")

#: 탐색에 노출되는 최소 승인 상태(models.OrganizationEventRole 주석 "매칭 노출은 approved부터").
APPROVED = "approved"

#: 지원 로케일. 이외의 값은 422가 아니라 ``DEFAULT_LOCALE``로 관대하게 접는다 — 로케일은 표시
#: 선택지지 권한이 아니라서, 오타 하나로 화면이 통째로 에러가 되는 편이 더 나쁘다.
LOCALES: tuple[str, ...] = ("ko", "en")
DEFAULT_LOCALE = "ko"


def normalize_locale(value: str | None) -> str:
    """쿼리로 들어온 로케일 문자열 → 지원 로케일. 모르는 값·None은 전부 기본(ko)."""
    normalized = str(value).strip().lower() if value is not None else ""
    return normalized if normalized in LOCALES else DEFAULT_LOCALE


class DiscoverError(Exception):
    """탐색 API의 도메인 거부 — 라우터가 ``{"code", "message"}`` 바디로 환산한다.

    HTTP 상태를 예외가 들고 있는 이유는 미팅 슬라이스와 같다 — "왜 거부됐는가"와 "어떤 종류의
    거부인가"는 같은 판단에서 나오므로, 라우터의 별도 매핑표로 떼면 코드를 추가할 때 한쪽을
    잊어 500이 난다.
    """

    def __init__(self, code: str, message: str, status_code: int) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code

    def to_detail(self) -> dict:
        return {"code": self.code, "message": self.message}


class DiscoverNotFoundError(Exception):
    """자원 부재 — 라우터가 404. **존재를 숨기는 경로에도 쓴다**(미승인 기업 단건 조회 등)."""


# =============================================================================
# 해석 — 행사 · 역할 · 승인
# =============================================================================
def _is_uuid(value: str) -> bool:
    try:
        UUID(value)
        return True
    except (ValueError, AttributeError, TypeError):
        return False


def _resolve_event(db: Session, viewer_org_id: str, event_id: str | None) -> Event:
    """행사 특정 — 미팅 슬라이스의 자동 해석기를 그대로 쓰고 예외 타입만 환산한다.

    같은 판단(참가 행사가 하나면 자동, 여럿이면 400 EVENT_AMBIGUOUS)을 두 번 구현하지 않는다.
    예외만 이 슬라이스의 것으로 바꿔 라우터가 한 종류의 도메인 예외만 알면 되게 한다.

    ``event_id``가 uuid 형식이 아니면 조회 전에 404로 끊는다 — uuid 컬럼에 임의 문자열을 넣으면
    Postgres가 22P02로 트랜잭션 자체를 깨서 "없는 행사"라는 정상 404가 500이 된다.
    """
    try:
        resolved = meetings_service.resolve_event_id(db, viewer_org_id, event_id)
    except meetings_service.MeetingError as exc:
        raise DiscoverError(exc.code, exc.message, exc.status_code) from exc

    if not _is_uuid(str(resolved)):
        raise DiscoverNotFoundError("행사를 찾을 수 없습니다")
    event = db.get(Event, resolved)
    if event is None:
        raise DiscoverNotFoundError("행사를 찾을 수 없습니다")
    return event


def _load_role(db: Session, event_id: str, org_id: str) -> OrganizationEventRole | None:
    if not _is_uuid(str(org_id)):
        return None
    return db.execute(
        select(OrganizationEventRole).where(
            OrganizationEventRole.event_id == event_id,
            OrganizationEventRole.organization_id == org_id,
        )
    ).scalar_one_or_none()


def _roles_of(role_row: OrganizationEventRole) -> tuple[str, ...]:
    """역할 행 → 실제로 선언된 역할들(선언 순서는 ``ROLE_ORDER`` 고정)."""
    return tuple(
        name
        for name, declared in (
            ("exhibitor", role_row.is_exhibitor),
            ("buyer", role_row.is_buyer),
        )
        if declared
    )


def _require_viewer(db: Session, event: Event, org_id: str) -> OrganizationEventRole:
    """뷰어의 참가 역할 — 없거나 역할이 하나도 선언되지 않았으면 403.

    역할 행은 있는데 참가사도 바이어도 아닌 상태(등록만 되고 역할 미확정)는 열람 주체가 될 수
    없다 — 어느 역할로 보는지 정할 수 없으면 열람 범위 판정 자체가 성립하지 않는다.
    """
    viewer = _load_role(db, str(event.id), org_id)
    if viewer is None or not _roles_of(viewer):
        raise DiscoverError("NOT_PARTICIPANT", "이 행사의 참가 기업이 아닙니다.", 403)
    return viewer


def _require_approved(viewer: OrganizationEventRole) -> None:
    if viewer.application_status != APPROVED:
        raise DiscoverError(
            "PROFILE_NOT_APPROVED",
            "참가 신청이 승인된 뒤에 다른 기업을 열람할 수 있습니다.",
            403,
        )


def _visible_roles(
    viewer_roles: Sequence[str], target_roles: Sequence[str], *, allow_same_role: bool
) -> tuple[str, ...]:
    """뷰어에게 보이는 대상 역할들 — 어느 역할로든 볼 수 있으면 그 역할 카드가 나온다.

    뷰어가 dual-role이면 ``any()``다(미팅 ``resolve_pair``와 같은 선례) — 참가사로서는 못 봐도
    바이어로서 볼 수 있으면 보이는 게 맞다. 반대로 대상이 dual-role이면 **역할별로 따로** 판정해
    보이는 역할만 카드가 된다.
    """
    return tuple(
        theirs
        for theirs in ROLE_ORDER
        if theirs in target_roles
        and any(
            can_view_organization(mine, theirs, allow_same_role_discovery=allow_same_role)
            for mine in viewer_roles
        )
    )


# =============================================================================
# 배치 로딩 — 목록에서 N+1을 내지 않는다
# =============================================================================
@dataclass(frozen=True, slots=True)
class _ProfileIndex:
    """역할 id 집합 하나로 미리 긁어온 프로필 파생값들. 값이 없으면 그냥 없는 것(빈 값)."""

    exhibitor_by_role: dict[str, ExhibitorProfile] = field(default_factory=dict)
    buyer_by_role: dict[str, BuyerProfile] = field(default_factory=dict)
    #: exhibitor_profile_id → (hall_no, hall_name, booth code). 부스 미배정이면 키 자체가 없다.
    booth_by_profile: dict[str, tuple[str, str, str]] = field(default_factory=dict)
    exhibits_by_profile: dict[str, list[str]] = field(default_factory=dict)
    exhibitor_keywords: dict[str, list[str]] = field(default_factory=dict)
    buyer_keywords: dict[str, list[str]] = field(default_factory=dict)


def _group(rows) -> dict[str, list[str]]:
    grouped: dict[str, list[str]] = {}
    for key, value in rows:
        grouped.setdefault(str(key), []).append(value)
    return grouped


def _load_profiles(
    db: Session, role_rows: Sequence[OrganizationEventRole], *, locale: str = DEFAULT_LOCALE
) -> _ProfileIndex:
    """카드 조립에 필요한 프로필·부스·품목·키워드를 **역할 수와 무관하게 상수 번** 조회한다.

    로케일은 **SQL에서** 접는다(``coalesce``) — 파이썬으로 두 컬럼을 다 실어와 고르면 정렬도
    파이썬에서 다시 해야 하고, 그러면 "표시 라벨 순"이라는 정렬 계약이 조회와 조립 두 곳에
    흩어진다. 폴백은 일관되게 "영문이 없으면 국문"이다(``label_en ?? label``).
    """
    role_ids = [str(row.id) for row in role_rows]
    if not role_ids:
        return _ProfileIndex()

    keyword_label = (
        func.coalesce(Keyword.label_en, Keyword.label) if locale == "en" else Keyword.label
    )
    product_name = (
        func.coalesce(ExhibitorProduct.name_en, ExhibitorProduct.name_ko)
        if locale == "en"
        else ExhibitorProduct.name_ko
    )

    exhibitor_rows = list(
        db.execute(
            select(ExhibitorProfile).where(ExhibitorProfile.org_event_role_id.in_(role_ids))
        ).scalars().all()
    )
    buyer_rows = list(
        db.execute(
            select(BuyerProfile).where(BuyerProfile.org_event_role_id.in_(role_ids))
        ).scalars().all()
    )
    exhibitor_ids = [str(row.id) for row in exhibitor_rows]
    buyer_ids = [str(row.id) for row in buyer_rows]

    booths: dict[str, tuple[str, str, str]] = {}
    exhibits: dict[str, list[str]] = {}
    exhibitor_keywords: dict[str, list[str]] = {}
    if exhibitor_ids:
        booths = {
            str(profile_id): (hall_no, hall_name, code)
            for profile_id, hall_no, hall_name, code in db.execute(
                select(ExhibitorProfile.id, Hall.hall_no, Hall.hall_name, Booth.code)
                .join(Booth, Booth.id == ExhibitorProfile.booth_id)
                .join(Hall, Hall.id == Booth.hall_id)
                .where(ExhibitorProfile.id.in_(exhibitor_ids))
            ).all()
        }
        exhibits = _group(
            db.execute(
                select(ExhibitorProduct.exhibitor_profile_id, product_name)
                .where(ExhibitorProduct.exhibitor_profile_id.in_(exhibitor_ids))
                # 등록 순서(sort_order)가 화면 표시 순서다. 동순위는 id로 고정해 응답이 흔들리지 않게.
                .order_by(ExhibitorProduct.sort_order, ExhibitorProduct.id)
            ).all()
        )
        exhibitor_keywords = _group(
            db.execute(
                select(ExhibitorKeyword.exhibitor_profile_id, keyword_label)
                .join(Keyword, Keyword.id == ExhibitorKeyword.keyword_id)
                .where(
                    ExhibitorKeyword.exhibitor_profile_id.in_(exhibitor_ids),
                    # exhibitor_keywords는 bm.service._replace_categories가 항상
                    # category='business_field'로만 링크한다(org_type은 별도 테이블
                    # org_event_role_org_types를 쓴다) — 방어적 네임스페이스 필터, 현재는 no-op.
                    Keyword.category == "business_field",
                )
                .order_by(keyword_label)
            ).all()
        )

    buyer_keywords: dict[str, list[str]] = {}
    if buyer_ids:
        buyer_keywords = _group(
            db.execute(
                select(BuyerInterestKeyword.buyer_profile_id, keyword_label)
                .join(Keyword, Keyword.id == BuyerInterestKeyword.keyword_id)
                .where(
                    BuyerInterestKeyword.buyer_profile_id.in_(buyer_ids),
                    # buyer_interest_keywords도 동일하게 business_field 전용 링크 — 위와 같은 이유.
                    Keyword.category == "business_field",
                )
                .order_by(keyword_label)
            ).all()
        )

    return _ProfileIndex(
        exhibitor_by_role={str(row.org_event_role_id): row for row in exhibitor_rows},
        buyer_by_role={str(row.org_event_role_id): row for row in buyer_rows},
        booth_by_profile=booths,
        exhibits_by_profile=exhibits,
        exhibitor_keywords=exhibitor_keywords,
        buyer_keywords=buyer_keywords,
    )


# =============================================================================
# 공개 프로젝션
# =============================================================================
def display_name(org: Organization | None, *, locale: str = DEFAULT_LOCALE) -> str:
    """표시용 기업명 — 로케일 우선 컬럼이 먼저고, 없으면 반대쪽으로 폴백, 둘 다 없으면 빈 문자열.

    ko는 ``name_ko ?? name_en``, en은 ``name_en ?? name_ko``다. 폴백을 두는 건 명단 임포트 단계의
    기업이 한쪽 이름만 갖고 있기 때문이다 — en 화면에서 국문명이라도 보이는 편이 이름 없는 카드보다 낫다.

    ``notifications.service.org_display_name``처럼 org id로 폴백하지 **않는다**. 알림 본문은 빈
    화면을 막으려 id라도 보여주지만, 탐색 카드에 uuid가 기업명으로 뜨면 그건 이름이 아니라
    잡음이다 — 없으면 없는 대로 비우고 화면이 자리표시자를 고르게 한다.
    """
    if org is None:
        return ""
    if locale == "en":
        return org.name_en or org.name_ko or ""
    return org.name_ko or org.name_en or ""


def _project(
    role_row: OrganizationEventRole,
    org: Organization | None,
    role: str,
    index: _ProfileIndex,
    *,
    locale: str = DEFAULT_LOCALE,
) -> dict:
    """(기업, 역할) → 공개 카드 dict. **여기서 담는 키가 곧 공개 범위다.**

    프로필이 아직 없는 기업(엑셀 임포트만 된 상태)도 카드가 나온다 — 이름과 역할만 있고 나머지는
    빈 값이다. "프로필이 없으니 목록에서 빼자"는 선택지는 없다: 대리작성 전 기업이 통째로 사라지면
    화면이 참가기업 수를 잘못 보여준다.

    **로케일은 키가 아니라 값만 바꾼다** — ``name_en``/``intro_en`` 같은 필드를 따로 더하지
    않는다. 키를 늘리면 화이트리스트가 로케일마다 갈라져 유출 방지 테스트가 무엇을 지키는지
    흐려지고, 화면도 "어느 키를 읽어야 하나"를 매번 분기해야 한다.
    """
    card = {
        "org_id": str(role_row.organization_id),
        "role": role,
        "name": display_name(org, locale=locale),
        "buyer_subtype": None,
        "booth": None,
        "keywords": [],
        "exhibits": [],
        "description": None,
        "employee_range": None,
        "content_category": None,
    }

    if role == "exhibitor":
        profile = index.exhibitor_by_role.get(str(role_row.id))
        if profile is None:
            return card
        profile_id = str(profile.id)
        booth = index.booth_by_profile.get(profile_id)
        card["booth"] = (
            {"hall_no": booth[0], "hall_name": booth[1], "code": booth[2]} if booth else None
        )
        card["keywords"] = index.exhibitor_keywords.get(profile_id, [])
        card["exhibits"] = index.exhibits_by_profile.get(profile_id, [])
        card["description"] = (
            (profile.intro_en or profile.intro_ko)
            if locale == "en"
            else (profile.intro_ko or profile.intro_en)
        )
        card["employee_range"] = profile.employee_range
        card["content_category"] = profile.content_category
        return card

    # 바이어 — 부스도 전시품목도 없다(구조적으로 None/빈 목록이지 "아직 안 채운" 값이 아니다).
    card["buyer_subtype"] = role_row.buyer_subtype
    profile = index.buyer_by_role.get(str(role_row.id))
    if profile is None:
        return card
    profile_id = str(profile.id)
    card["keywords"] = index.buyer_keywords.get(profile_id, [])
    # 바이어 소개는 스키마상 영문 컬럼 하나뿐이라(해외 바이어 전제) 로케일과 무관하게 그대로 쓴다.
    card["description"] = profile.company_intro_en
    card["employee_range"] = profile.employee_range
    return card


# =============================================================================
# 목록 / 단건
# =============================================================================
def list_organizations(
    db: Session, *, principal: Principal, event_id: str | None, locale: str = DEFAULT_LOCALE
) -> tuple[list[dict], int]:
    """열람 가능한 참가기업 카드 목록.

    순서: 행사 해석 → 뷰어 역할(403 NOT_PARTICIPANT) → 뷰어 승인(403 PROFILE_NOT_APPROVED) →
    대상 필터(approved + 가시성). 자기 기업은 목록에서 뺀다 — 탐색은 "다른 기업 찾기"이고,
    자기 카드는 단건 조회로 따로 가져간다.

    **정렬은 로케일과 무관하게 국문명 기준**이다 — 같은 행사의 카드 순서가 언어를 바꿀 때마다
    재배열되면 "3번째 카드"라는 사용자의 기억이 깨진다. 표시 값만 로케일을 탄다.
    """
    locale = normalize_locale(locale)
    event = _resolve_event(db, principal.organization_id, event_id)
    viewer = _require_viewer(db, event, principal.organization_id)
    _require_approved(viewer)
    viewer_roles = _roles_of(viewer)

    rows = db.execute(
        select(OrganizationEventRole, Organization)
        .join(Organization, Organization.id == OrganizationEventRole.organization_id)
        .where(
            OrganizationEventRole.event_id == event.id,
            # 노출은 승인부터 — 심사 중인 기업이 탐색에 미리 뜨면 안 된다.
            OrganizationEventRole.application_status == APPROVED,
            OrganizationEventRole.organization_id != principal.organization_id,
        )
        # 이름순(국문 우선). 동명·무명 기업이 섞여도 응답 순서가 흔들리지 않게 id로 고정한다.
        .order_by(Organization.name_ko, Organization.name_en, OrganizationEventRole.id)
    ).all()

    index = _load_profiles(db, [role_row for role_row, _ in rows], locale=locale)
    items = [
        _project(role_row, org, role, index, locale=locale)
        for role_row, org in rows
        for role in _visible_roles(
            viewer_roles, _roles_of(role_row), allow_same_role=event.allow_same_role_discovery
        )
    ]
    return items, len(items)


def get_organization(
    db: Session,
    *,
    principal: Principal,
    org_id: str,
    event_id: str | None,
    locale: str = DEFAULT_LOCALE,
) -> dict:
    """기업 카드 1장.

    **자기 기업은 가시성 검사를 건너뛴다** — 화면이 뷰어 자신의 카드를 같은 모양으로 그리는 데
    쓰기 때문이다. 같은 역할끼리 열람이 막힌 행사(기본값)에서 참가사가 자기 카드를 못 보는 건
    규칙의 의도가 아니다. 승인 검사도 자기 카드에는 걸지 않는다(승인 전에도 내 카드는 내 것이다).

    타 기업은 미팅 슬라이스와 같은 순서다: 존재/노출(404) → 뷰어 승인(403) → 가시성(403).
    미승인 기업을 403이 아니라 **404로 숨기는** 건 의도적이다 — 403은 "그 기업은 있다"를 알려준다.
    """
    locale = normalize_locale(locale)
    event = _resolve_event(db, principal.organization_id, event_id)
    viewer = _require_viewer(db, event, principal.organization_id)

    if str(org_id) == str(principal.organization_id):
        org = db.get(Organization, principal.organization_id)
        return _project(
            viewer,
            org,
            _roles_of(viewer)[0],
            _load_profiles(db, [viewer], locale=locale),
            locale=locale,
        )

    target = _load_role(db, str(event.id), org_id)
    if target is None or target.application_status != APPROVED:
        raise DiscoverNotFoundError("기업을 찾을 수 없습니다")

    _require_approved(viewer)

    visible = _visible_roles(
        _roles_of(viewer), _roles_of(target), allow_same_role=event.allow_same_role_discovery
    )
    if not visible:
        raise DiscoverError("NOT_VISIBLE", "이 기업은 열람할 수 없습니다.", 403)

    org = db.get(Organization, org_id)
    # dual-role 기업은 참가사 카드를 먼저 낸다(ROLE_ORDER) — 단건 응답은 카드 1장이므로 어느
    # 역할을 보여줄지 결정적이어야 한다. 두 역할을 다 보려면 목록에서 두 카드로 나온다.
    return _project(
        target, org, visible[0], _load_profiles(db, [target], locale=locale), locale=locale
    )


# =============================================================================
# /api/me — 뷰어 자신의 참가 컨텍스트
# =============================================================================
@dataclass(frozen=True, slots=True)
class _Identity:
    """뷰어 본인의 표시용 신원. 못 찾은 값은 지어내지 않고 None으로 둔다."""

    name: str | None = None
    email: str | None = None
    phone: str | None = None
    title: str | None = None


def _resolve_identity(db: Session, member_id: str) -> _Identity:
    """주체 키 → 이름·이메일·연락처·직함.

    주체 키는 두 종류다(``auth.principal._demo_org_id``와 **같은 갈래**):

    - **UUID** — ``members.id``. 그 행에서 바로 읽는다.
    - **비-UUID**(``mbr-buyer-01`` 등) — 명단 적재층의 ``registrants.organizer_member_id``.
      그 registrant를 가리키는 ``members`` 행이 있으면(명단→회원 승격 완료) 회원 쪽이 우선이고,
      없으면 registrant의 신고값(name·contact_email·contact_phone)으로 폴백한다.

    ⚠ **UUID 여부를 조회 전에 판별한다.** ``members.id``는 uuid 컬럼이라 비-UUID 문자열을 비교에
    넣으면 Postgres가 22P02로 트랜잭션 자체를 깨서 500이 난다(principal의 같은 주의사항).

    회원 쪽이 우선인 이유: registrant는 주최사가 준 명단 스냅샷이고 members는 그 뒤의 갱신을
    반영한다 — 같은 사람의 값이 갈라졌다면 나중 것이 맞다. 직함(title)은 registrants에 대응
    컬럼이 아예 없어 폴백 경로에서는 None이다.
    """
    if _is_uuid(member_id):
        member = db.get(Member, member_id)
        if member is None:
            return _Identity()
        return _Identity(
            name=member.name, email=member.email, phone=member.phone, title=member.title
        )

    registrant = db.execute(
        select(Registrant)
        .where(Registrant.organizer_member_id == member_id)
        .order_by(Registrant.created_at.desc())
        .limit(1)
    ).scalar_one_or_none()
    if registrant is None:
        return _Identity()

    member = db.execute(
        select(Member).where(Member.registrant_id == registrant.id)
    ).scalar_one_or_none()
    if member is not None:
        return _Identity(
            name=member.name, email=member.email, phone=member.phone, title=member.title
        )
    return _Identity(
        name=registrant.name, email=registrant.contact_email, phone=registrant.contact_phone
    )


def build_me(db: Session, *, principal: Principal) -> dict:
    """내 기업 + 참가 중인 모든 행사의 역할·승인 상태 + 뷰어 본인의 신원.

    행사로 좁히지 않는다 — 화면이 "지금 어떤 행사에 무슨 자격으로 들어와 있는가"를 알아야 탐색·
    미팅 진입 가능 여부를 판단할 수 있고, 그 판단 자체가 행사 선택보다 앞선다.

    신원(member_*)을 여기 싣는 건 화면이 사이드바·마이페이지를 그릴 원천이 달리 없기 때문이다.
    **남의 정보가 아니라 뷰어 자신의 정보**라 탐색 카드의 유출 방지 화이트리스트와 충돌하지 않는다.
    """
    org = db.get(Organization, principal.organization_id)
    identity = _resolve_identity(db, principal.member_id)
    # 행사를 함께 읽어 전시 기간(미팅이 열리는 날짜 창)을 실어 보낸다 — 프론트 미팅 타임라인이
    # 날짜 탭을 하드코딩하지 않고 이 값으로 그리게 하려는 것이다(하드코딩이면 행사일이 바뀔 때
    # 그 날짜의 실 미팅이 탭에서 조용히 사라진다).
    # 운영 설정도 함께 읽는다 — 칸 사이 텀은 events가 아니라 event_schedule_settings 값이라,
    # 이게 없으면 프론트 타임라인이 텀 0으로 폴백해 40분/텀5분 행사에서 미팅이 잘못된 행에
    # 그려진다(mt003gap0001). 행이 없는 행사(설정 미생성)는 outerjoin이라 None으로 온다.
    rows = db.execute(
        select(OrganizationEventRole, Event, EventScheduleSettings)
        .join(Event, Event.id == OrganizationEventRole.event_id)
        .outerjoin(EventScheduleSettings, EventScheduleSettings.event_id == Event.id)
        .where(OrganizationEventRole.organization_id == principal.organization_id)
        .order_by(OrganizationEventRole.created_at, OrganizationEventRole.id)
    ).all()
    return {
        "organization_id": str(principal.organization_id),
        "organization_name": display_name(org),
        "organization_name_en": org.name_en if org is not None else None,
        "member_name": identity.name,
        "member_email": identity.email,
        "member_phone": identity.phone,
        "member_title": identity.title,
        "roles": [
            {
                "event_id": str(row.event_id),
                "org_event_role_id": str(row.id),
                "is_exhibitor": row.is_exhibitor,
                "is_buyer": row.is_buyer,
                "buyer_subtype": row.buyer_subtype,
                "application_status": row.application_status,
                # 전시 기간(YYYY-MM-DD) — 미설정 행사면 None이라 화면이 폴백을 고른다.
                "exhibition_start": str(event.exhibition_start) if event.exhibition_start else None,
                "exhibition_end": str(event.exhibition_end) if event.exhibition_end else None,
                # 격자 모양 — 참가자 미팅 타임라인(timeline.ts)이 칸 길이·텀을 여기서 받는다.
                # 없으면 프런트가 30분/텀0으로 폴백해 40분/텀5분 행사에서 미팅이 잘못된 행에
                # 그려진다(mt003gap0001). 설정 행이 없는 행사는 텀 0(= 간격과 길이가 같던 구행동).
                "slot_minutes": event.slot_minutes,
                "slot_gap_minutes": schedule.slot_gap_minutes if schedule is not None else 0,
            }
            for row, event, schedule in rows
        ],
    }


# =============================================================================
# 관심기업(북마크) — H-01: 서버 영속화(interested_organizations)
#
# `/discover`의 담기/해제가 localStorage(nabi:discover:bookmarks) 단독으로만 남아 다른 기기·
# 브라우저에서 사라지던 버그(H-01)의 서버 절반. 유니크 키는 (event_id, owner_org_id,
# target_org_id) — 뷰어의 org가 owner, 카드를 누른 대상이 target이다.
# =============================================================================
def _require_bookmarkable_target(
    db: Session, event: Event, viewer: OrganizationEventRole, target_org_id: str
) -> None:
    """담을 수 있는 대상인지 — 존재/승인(404) → 가시성(403). 단건 조회(get_organization)와 같은 순서.

    탐색에서 카드가 안 보이면 애초에 토글 버튼이 안 뜨지만, 다른 경로(예: 관심기업 탭에서 남은
    stale id)로 들어온 요청까지 서버가 한 번 더 막는다 — 화면 검사만 믿지 않는다.
    """
    target = _load_role(db, str(event.id), target_org_id)
    if target is None or target.application_status != APPROVED:
        raise DiscoverNotFoundError("기업을 찾을 수 없습니다")
    visible = _visible_roles(
        _roles_of(viewer), _roles_of(target), allow_same_role=event.allow_same_role_discovery
    )
    if not visible:
        raise DiscoverError("NOT_VISIBLE", "이 기업은 열람할 수 없습니다.", 403)


def list_bookmarks(db: Session, *, principal: Principal, event_id: str | None) -> list[dict]:
    """뷰어(owner org)가 이 행사에서 담은 관심기업 전부. 최근 담은 순."""
    event = _resolve_event(db, principal.organization_id, event_id)
    _require_viewer(db, event, principal.organization_id)

    rows = db.execute(
        select(InterestedOrganization)
        .where(
            InterestedOrganization.event_id == event.id,
            InterestedOrganization.owner_org_id == principal.organization_id,
        )
        .order_by(InterestedOrganization.created_at.desc())
    ).scalars().all()
    return [{"target_org_id": str(row.target_org_id), "source": row.source} for row in rows]


def add_bookmark(
    db: Session,
    *,
    principal: Principal,
    event_id: str | None,
    target_org_id: str,
    source: str | None,
) -> dict:
    """관심기업 등록 — **멱등**: 이미 담겨 있으면 기존 행(원래 출처)을 그대로 돌려준다.

    출처를 나중 호출로 덮어쓰지 않는 이유는 프론트 ``toggleBookmark`` 주석과 같다: "첫 등록
    출처가 보존된다" — 같은 기업을 AI 탭에서 담고 전체 탭에서 다시 누르면 해제가 되지, 출처가
    슬쩍 바뀌면 안 된다(운영팀의 AI 추천 대 전체탐색 전환율 집계가 틀어진다).
    """
    event = _resolve_event(db, principal.organization_id, event_id)
    viewer = _require_viewer(db, event, principal.organization_id)
    _require_approved(viewer)
    _require_bookmarkable_target(db, event, viewer, target_org_id)

    existing = db.execute(
        select(InterestedOrganization).where(
            InterestedOrganization.event_id == event.id,
            InterestedOrganization.owner_org_id == principal.organization_id,
            InterestedOrganization.target_org_id == target_org_id,
        )
    ).scalar_one_or_none()
    if existing is not None:
        return {"target_org_id": str(existing.target_org_id), "source": existing.source}

    row = InterestedOrganization(
        event_id=event.id,
        owner_org_id=principal.organization_id,
        target_org_id=target_org_id,
        source=source,
    )
    db.add(row)
    db.commit()
    return {"target_org_id": str(row.target_org_id), "source": row.source}


def remove_bookmark(
    db: Session, *, principal: Principal, event_id: str | None, target_org_id: str
) -> None:
    """관심기업 해제 — **멱등**: 담겨 있지 않아도 무해하게 통과(에러를 내지 않는다).

    등록과 달리 대상의 승인/가시성을 다시 검사하지 않는다 — 이미 담긴 뒤 대상이 미승인으로
    바뀌어도(드문 경우) 빼는 동작까지 막히면 사용자가 죽은 카드를 못 치우게 된다.
    """
    event = _resolve_event(db, principal.organization_id, event_id)
    _require_viewer(db, event, principal.organization_id)

    row = db.execute(
        select(InterestedOrganization).where(
            InterestedOrganization.event_id == event.id,
            InterestedOrganization.owner_org_id == principal.organization_id,
            InterestedOrganization.target_org_id == target_org_id,
        )
    ).scalar_one_or_none()
    if row is None:
        return
    db.delete(row)
    db.commit()


__all__ = [
    "DEFAULT_LOCALE",
    "LOCALES",
    "DiscoverError",
    "DiscoverNotFoundError",
    "add_bookmark",
    "build_me",
    "display_name",
    "get_organization",
    "list_bookmarks",
    "list_organizations",
    "normalize_locale",
    "remove_bookmark",
]
