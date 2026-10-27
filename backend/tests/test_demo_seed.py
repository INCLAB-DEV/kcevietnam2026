"""데모 시드 멱등성 테스트 — 여러 번 돌려도 같은 상태로 수렴하는지.

데모 중에 데이터가 꼬이면 "그냥 다시 돌리면 된다"가 이 스크립트의 계약이다(app/demo_seed.py).
그 계약이 깨지면 재실행이 기업·제품·키워드·미팅·알림을 복제해서 화면이 같은 카드/알림을 두 번
보여준다 — 데모 당일에 발견하기 가장 나쁜 종류의 버그라 테스트로 못박는다.

탐색 데모가 **비어 보이지 않는지**(소개·전시품목·키워드가 실제로 깔렸는지)와, 미팅/알림
데모가 **온전히 다 보이는지**(신청·수락대기·완료·취소가 전부 있는지)도 함께 확인한다.
"""

from __future__ import annotations

import pytest
from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import Session

from app.auth.organizer_guard import PERMISSION_MASTER
from app.demo_seed import (
    DEMO_BUSINESS_FIELDS,
    DEMO_BUYER_CONTACTS,
    DEMO_BUYER_PROFILES,
    DEMO_EXHIBITORS,
    DEMO_MEETINGS,
    DEMO_OPERATOR_MEMBER_ID,
    DEMO_PARTICIPANTS,
    DEMO_PHONES,
    seed,
    seed_notifications,
)
from app.models import (
    BuyerInterestKeyword,
    BuyerProfile,
    EventOrganizer,
    ExhibitorKeyword,
    ExhibitorProduct,
    ExhibitorProfile,
    Keyword,
    Meeting,
    Member,
    Notification,
    Organization,
    OrganizationEventRole,
    Organizer,
    Registrant,
)

COUNTED = (
    Organization,
    OrganizationEventRole,
    ExhibitorProfile,
    ExhibitorProduct,
    ExhibitorKeyword,
    BuyerProfile,
    BuyerInterestKeyword,
    Meeting,
    Notification,
)


@pytest.fixture()
def db(migrated_db: str):
    """격리 DB에 트랜잭션을 열고 끝에 롤백 — 시드가 커밋해도 테스트 밖으로 새지 않는다.

    ``seed_notifications``가 부르는 ``notify_*``는 내부에서 ``db.commit()``을 하지만, 이 세션은
    ``join_transaction_mode="create_savepoint"``로 외부 트랜잭션에 물려 있어 그 커밋은 SAVEPOINT
    해제일 뿐이다 — 테스트 끝의 ``transaction.rollback()``이 전부 되돌린다.
    """
    engine = create_engine(migrated_db, future=True)
    connection = engine.connect()
    transaction = connection.begin()
    session = Session(bind=connection, join_transaction_mode="create_savepoint")
    try:
        yield session
    finally:
        session.close()
        transaction.rollback()
        connection.close()
        engine.dispose()


def _counts(db: Session) -> dict[str, int]:
    return {
        model.__name__: db.execute(select(func.count()).select_from(model)).scalar_one()
        for model in COUNTED
    }


def _seed_all(db: Session) -> dict:
    """seed() + seed_notifications()를 한 번에 — 실제 CLI(main())가 커밋 후 잇는 순서와 동일하게
    호출한다(빈 DB라 D9 충돌 없이 미팅 5건이 전부 만들어진다는 전제)."""
    result = seed(db)
    db.flush()
    notif_result = seed_notifications(db, result["meetings"])
    result["notifications_created"] = notif_result["created"]
    return result


def test_seed_is_idempotent_across_three_runs(db: Session):
    _seed_all(db)
    db.flush()
    first = _counts(db)

    _seed_all(db)
    _seed_all(db)
    db.flush()

    assert _counts(db) == first


def test_seed_fills_discovery_content(db: Session):
    """탐색 카드가 비어 보이지 않게 — 참가사 5곳 소개·전시품목·키워드, 바이어 소개·관심분야."""
    result = seed(db)
    db.flush()

    for spec in DEMO_EXHIBITORS:
        exhibitor_org_id = result["organizations"][spec.member_id]
        profile = db.execute(
            select(ExhibitorProfile)
            .join(
                OrganizationEventRole,
                OrganizationEventRole.id == ExhibitorProfile.org_event_role_id,
            )
            .where(OrganizationEventRole.organization_id == exhibitor_org_id)
        ).scalar_one()
        assert profile.intro_ko
        assert profile.employee_range
        products = db.execute(
            select(ExhibitorProduct.name_ko)
            .where(ExhibitorProduct.exhibitor_profile_id == profile.id)
            .order_by(ExhibitorProduct.sort_order)
        ).scalars().all()
        assert list(products) == [name_ko for name_ko, _, _ in spec.products]
        keyword_count = db.execute(
            select(func.count())
            .select_from(ExhibitorKeyword)
            .where(ExhibitorKeyword.exhibitor_profile_id == profile.id)
        ).scalar_one()
        assert keyword_count == len(spec.keywords)

    for member_id, (intro_en, keyword_codes, employee_range) in DEMO_BUYER_PROFILES.items():
        buyer_profile = db.execute(
            select(BuyerProfile)
            .join(
                OrganizationEventRole,
                OrganizationEventRole.id == BuyerProfile.org_event_role_id,
            )
            .where(OrganizationEventRole.organization_id == result["organizations"][member_id])
        ).scalar_one()
        assert buyer_profile.company_intro_en == intro_en
        assert buyer_profile.employee_range == employee_range
        linked = db.execute(
            select(func.count())
            .select_from(BuyerInterestKeyword)
            .where(BuyerInterestKeyword.buyer_profile_id == buyer_profile.id)
        ).scalar_one()
        assert linked == len(keyword_codes)


def _has_hangul(value: str | None) -> bool:
    return any("가" <= ch <= "힣" for ch in value or "")


def test_seed_fills_english_content_for_en_locale(db: Session):
    """en 로케일 탐색이 값을 채울 수 있게 — 기업명(영문)·소개(영문)·제품명(영문)·분야 라벨(영문).

    핵심 회귀는 ``organizations.name_en``에 **국문 상호가 그대로 복사되던 버그**다. 그 상태에서는
    영문 화면이 "한빛디펜스"를 영문 기업명으로 보여준다 — 값이 비어 있는 것보다 나쁜, 조용한 오류라
    "영문 컬럼에 한글이 없다"까지 못박는다.
    """
    result = seed(db)
    db.flush()

    for spec in DEMO_EXHIBITORS:
        org = db.get(Organization, result["organizations"][spec.member_id])
        assert org.name_ko == spec.org_name
        assert org.name_en == spec.org_name_en
        assert not _has_hangul(org.name_en), f"{spec.org_name}의 영문명에 한글이 들어갔다"

        profile = db.execute(
            select(ExhibitorProfile)
            .join(
                OrganizationEventRole,
                OrganizationEventRole.id == ExhibitorProfile.org_event_role_id,
            )
            .where(OrganizationEventRole.organization_id == org.id)
        ).scalar_one()
        assert profile.intro_en and not _has_hangul(profile.intro_en)

        names_en = db.execute(
            select(ExhibitorProduct.name_en)
            .where(ExhibitorProduct.exhibitor_profile_id == profile.id)
            .order_by(ExhibitorProduct.sort_order)
        ).scalars().all()
        assert list(names_en) == [name_en for _, name_en, _ in spec.products]

    # 사업분야 8종 전체가 영문 라벨을 갖는다 — 데모 참가사가 링크하지 않은 분야도 필터·드롭다운에 뜬다.
    labels = db.execute(
        select(Keyword.code, Keyword.label_en).where(Keyword.category == "business_field")
    ).all()
    by_code = {code: label_en for code, label_en in labels}
    for code, (_, label_en) in DEMO_BUSINESS_FIELDS.items():
        assert by_code[code] == label_en


def test_seed_fills_contact_phone_for_sidebar(db: Session):
    """``/api/me``의 member_phone 원천 — 회원 행과 명단 적재층 양쪽에 같은 번호를 둔다."""
    result = seed(db)
    db.flush()

    for member_id, *_ in DEMO_PARTICIPANTS:
        org_id = result["organizations"][member_id]
        registrant = db.execute(
            select(Registrant).where(
                Registrant.organizer_member_id == member_id,
                Registrant.organization_id == org_id,
            )
        ).scalar_one()
        member = db.execute(
            select(Member).where(Member.email == f"{member_id}@demo.nabi.test")
        ).scalar_one()
        assert registrant.contact_phone == DEMO_PHONES[member_id]
        assert member.phone == DEMO_PHONES[member_id]
        assert member.title == "매니저"


def test_seed_fills_buyer_contact_fields(db: Session):
    """BM-001 실배선 — 데모 바이어 3사의 신청자 식별(담당자) 필드가 채워져야 제출 필수검증을 만족한다."""
    result = seed(db)
    db.flush()

    for member_id, (name_en, title_en, email, language, interpreter_need) in DEMO_BUYER_CONTACTS.items():
        buyer_profile = db.execute(
            select(BuyerProfile)
            .join(OrganizationEventRole, OrganizationEventRole.id == BuyerProfile.org_event_role_id)
            .where(OrganizationEventRole.organization_id == result["organizations"][member_id])
        ).scalar_one()
        assert buyer_profile.contact_name_en == name_en
        assert buyer_profile.contact_title_en == title_en
        assert buyer_profile.contact_email == email
        assert buyer_profile.contact_language == language
        assert buyer_profile.contact_interpreter_need == interpreter_need


def test_seed_bootstraps_operator_master(db: Session):
    """운영자(mbr-org-01)가 데모 행사의 master로 DB 배정돼야 한다 — 없으면 GET /api/admin/events가
    빈 목록으로 보인다(list_events_for_organizer는 organizer_guard 인메모리 배정이 아니라 DB를
    조회, 모듈 docstring 참고)."""
    result = seed(db)
    db.flush()

    organizer = db.execute(
        select(Organizer).where(Organizer.member_id == DEMO_OPERATOR_MEMBER_ID)
    ).scalar_one()
    assignment = db.execute(
        select(EventOrganizer).where(
            EventOrganizer.event_id == result["event_id"], EventOrganizer.organizer_id == organizer.id
        )
    ).scalar_one()
    assert assignment.permission_level == PERMISSION_MASTER

    # 재시드해도 organizer/배정이 복제되지 않는다(멱등).
    seed(db)
    db.flush()
    organizer_count = db.execute(
        select(func.count()).select_from(Organizer).where(Organizer.member_id == DEMO_OPERATOR_MEMBER_ID)
    ).scalar_one()
    assignment_count = db.execute(
        select(func.count()).select_from(EventOrganizer).where(
            EventOrganizer.event_id == result["event_id"], EventOrganizer.organizer_id == organizer.id
        )
    ).scalar_one()
    assert organizer_count == 1
    assert assignment_count == 1


def test_reseed_repairs_wrong_organization_name_en(db: Session):
    """재시드가 이름까지 수렴시킨다 — 예전 시드가 남긴 잘못된 ``name_en``(국문 복사)을 덮어쓴다."""
    result = seed(db)
    db.flush()
    org_id = result["organizations"]["mbr-exh-01"]
    org = db.get(Organization, org_id)
    org.name_en = "픽셀아츠 스튜디오"  # 버그가 있던 시절의 값을 재현
    db.flush()

    seed(db)
    db.flush()

    assert db.get(Organization, org_id).name_en == "PixelArts Studio"


def test_seed_keeps_participants_approved(db: Session):
    """탐색·미팅 노출은 approved부터 — 데모는 승인된 상태에서 시작해야 화면이 채워진다."""
    result = seed(db)
    db.flush()

    statuses = db.execute(
        select(OrganizationEventRole.application_status).where(
            OrganizationEventRole.organization_id.in_(list(result["organizations"].values()))
        )
    ).scalars().all()
    assert set(statuses) == {"approved"}


def test_seed_creates_five_meetings_covering_every_status(db: Session):
    """빈 DB(D9 충돌 없음)에서는 미팅 5건이 전부 만들어지고, 신청/수락대기(양방향)/완료/취소가
    골고루 섞여 있어야 화면 데모가 온전하다."""
    result = seed(db)
    db.flush()

    assert result["meeting_warnings"] == []
    assert set(result["meetings"]) == {spec.key for spec in DEMO_MEETINGS}

    statuses = {
        spec.key: db.get(Meeting, result["meetings"][spec.key]).status for spec in DEMO_MEETINGS
    }
    assert statuses == {
        "m1": "accepted",
        "m2": "proposed",
        "m3": "proposed",
        "m4": "completed",
        "m5": "cancelled",
    }


def test_seed_notifications_are_idempotent_and_no_duplicates(db: Session):
    """알림 7행(신청받음 2 + 확정 2 + 취소 1 + 리뷰안내 2)이 한 번만 생기고, 재실행해도 늘지 않는다.

    ``migrated_db``는 세션 스코프라 다른 테스트 파일이 커밋한 알림이 같은 테이블에 남아 있을 수
    있다 — 그래서 전체 테이블이 아니라 **이 테스트가 만든 미팅 id에 한정**해서 센다.
    """
    result = seed(db)
    db.flush()
    meeting_ids = list(result["meetings"].values())

    def _notification_count() -> int:
        return db.execute(
            select(func.count())
            .select_from(Notification)
            .where(Notification.meeting_id.in_(meeting_ids))
        ).scalar_one()

    first = seed_notifications(db, result["meetings"])
    assert len(first["created"]) == 7
    assert _notification_count() == 7

    # 같은 미팅에 다시 알림을 발화해도(멱등 유니크) 중복 행이 생기지 않는다.
    second = seed_notifications(db, result["meetings"])
    assert second["created"] == []
    assert _notification_count() == 7
