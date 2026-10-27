"""roster-import 통합 테스트 — 멱등성·eager 생성·raw 보존·게이트의 외부 관찰 동작(AC #50).

구현 세부가 아니라 "같은 파일 두 번 올리면 두 번째는 무변경"처럼 밖에서 보이는 결과만 검증한다.
"""

from __future__ import annotations

import uuid

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models import Member, Organization, OrganizationEventRole, Registrant
from app.roster.import_service import import_roster
from app.roster.parser import RosterRecord


def _rec(member_id: str, org_name: str, email: str | None, role: str | None = "exhibitor", **raw) -> RosterRecord:
    return RosterRecord(
        organizer_member_id=member_id,
        org_name=org_name,
        name=f"담당자-{member_id}",
        contact_email=email,
        role_hint=role,
        raw={"id": member_id, "name": org_name, "email": email or "", **raw},
    )


def _registrant_count(session: Session, event_id: str) -> int:
    return session.scalar(
        select(func.count()).select_from(Registrant).where(Registrant.event_id == event_id)
    )


# --- AC: 같은 파일 2회 → 레코드 수 불변(1회차 신규 N, 2회차 무변경 N) --------------
def test_same_snapshot_twice_is_idempotent(db_session, event):
    records = [_rec("m-1", "새한방산", "a@a.com"), _rec("m-2", "한울디펜스", "b@b.com")]

    first = import_roster(db_session, event.id, records)
    assert (first.added, first.updated, first.unchanged) == (2, 0, 0)
    assert _registrant_count(db_session, event.id) == 2

    second = import_roster(db_session, event.id, records)
    assert (second.added, second.updated, second.unchanged) == (0, 0, 2)
    assert _registrant_count(db_session, event.id) == 2  # 레코드 수 불변


# --- AC: 한 레코드 흡수 시 registrants+organizations+members+roles 함께 upsert -----
def test_one_record_eager_creates_all_four(db_session, event):
    import_roster(db_session, event.id, [_rec("m-1", "새한방산", "kim@a.com")])

    reg = db_session.scalars(select(Registrant).where(Registrant.organizer_member_id == "m-1")).one()
    org = db_session.scalars(select(Organization).where(Organization.name_ko == "새한방산")).one()
    member = db_session.scalars(select(Member).where(Member.email == "kim@a.com")).one()
    role = db_session.scalars(
        select(OrganizationEventRole).where(OrganizationEventRole.organization_id == org.id)
    ).one()

    assert reg.organization_id == org.id
    assert member.organization_id == org.id and member.registrant_id == reg.id
    assert role.event_id == event.id and role.is_exhibitor is True


# --- AC: org 중복 레이스 없음 — 같은 회사 다중 멤버가 org 1개 ----------------------
def test_same_company_multiple_members_no_org_dup(db_session, event):
    records = [
        _rec("m-1", "새한방산", "kim@a.com"),
        _rec("m-2", "새한방산", "lee@a.com"),  # 같은 회사, 다른 담당자
    ]
    import_roster(db_session, event.id, records)

    orgs = db_session.scalars(select(Organization).where(Organization.name_ko == "새한방산")).all()
    members = db_session.scalars(select(Member).where(Member.organization_id == orgs[0].id)).all()
    roles = db_session.scalars(
        select(OrganizationEventRole).where(OrganizationEventRole.organization_id == orgs[0].id)
    ).all()
    assert len(orgs) == 1  # 중복 org 없음
    assert len(members) == 2
    assert len(roles) == 1  # 기업당 이벤트 역할 1행


# --- AC: 적재된 role의 application_status 기본값=registered ------------------------
def test_application_status_defaults_to_registered(db_session, event):
    import_roster(db_session, event.id, [_rec("m-1", "새한방산", "a@a.com")])
    role = db_session.scalars(
        select(OrganizationEventRole).where(OrganizationEventRole.event_id == event.id)
    ).one()
    assert role.application_status == "registered"  # 매칭/배정 비노출 게이트(D6)


# --- role 출처유추: exhibitor/buyer 플래그가 role_hint로 갈린다 --------------------
def test_role_inference_sets_flags(db_session, event):
    import_roster(
        db_session,
        event.id,
        [_rec("m-1", "참가사", "a@a.com", role="exhibitor"), _rec("m-2", "바이어사", "b@b.com", role="buyer")],
    )
    ex = db_session.scalars(
        select(OrganizationEventRole)
        .join(Organization, OrganizationEventRole.organization_id == Organization.id)
        .where(Organization.name_ko == "참가사")
    ).one()
    bu = db_session.scalars(
        select(OrganizationEventRole)
        .join(Organization, OrganizationEventRole.organization_id == Organization.id)
        .where(Organization.name_ko == "바이어사")
    ).one()
    assert (ex.is_exhibitor, ex.is_buyer) == (True, False)
    assert (bu.is_exhibitor, bu.is_buyer) == (False, True)


# --- raw 보존 round-trip: 원본 컬럼이 통째로 저장된다 ------------------------------
def test_raw_preserved_round_trip(db_session, event):
    rec = _rec("m-1", "새한방산", "a@a.com", 업종="방산전자", 부스="A-101")
    import_roster(db_session, event.id, [rec])
    stored = db_session.scalars(select(Registrant).where(Registrant.organizer_member_id == "m-1")).one()
    assert stored.raw["업종"] == "방산전자"
    assert stored.raw["부스"] == "A-101"


# --- 명단 필드 변경 → updated 집계 ------------------------------------------------
def test_changed_field_counts_as_updated(db_session, event):
    import_roster(db_session, event.id, [_rec("m-1", "구회사명", "a@a.com")])
    result = import_roster(db_session, event.id, [_rec("m-1", "새회사명", "a@a.com")])
    assert (result.added, result.updated, result.unchanged) == (0, 1, 0)
    reg = db_session.scalars(select(Registrant).where(Registrant.organizer_member_id == "m-1")).one()
    assert reg.org_name == "새회사명"  # 최신값으로 덮어쓰기


# --- codex P1 #3: 이메일 정정(A→B)이 import를 깨지 않고 같은 멤버를 갱신한다 ----------
def test_member_email_correction_updates_same_member(db_session, event):
    import_roster(db_session, event.id, [_rec("m-1", "새한방산", "old@a.com")])
    result = import_roster(db_session, event.id, [_rec("m-1", "새한방산", "new@a.com")])  # abort 없이 통과
    assert (result.added, result.updated, result.unchanged) == (0, 1, 0)
    reg = db_session.scalars(
        select(Registrant).where(Registrant.event_id == event.id, Registrant.organizer_member_id == "m-1")
    ).one()
    members = db_session.scalars(select(Member).where(Member.registrant_id == reg.id)).all()
    assert len(members) == 1  # 두 번째 멤버를 만들지 않음(registrant_id 키)
    assert members[0].email == "new@a.com"  # 최신 이메일로 갱신


# --- codex P1 #4: 서로 다른 회원ID가 이메일을 공유해도 첫 멤버를 빼앗지 않는다 ----------
def test_duplicate_email_does_not_steal_member(db_session, event):
    import_roster(db_session, event.id, [_rec("m-1", "회사A", "dup@a.com")])
    reg1 = db_session.scalars(select(Registrant).where(Registrant.organizer_member_id == "m-1")).one()
    import_roster(db_session, event.id, [_rec("m-2", "회사B", "dup@a.com")])

    member = db_session.scalars(select(Member).where(Member.email == "dup@a.com")).one()
    assert member.registrant_id == reg1.id  # 첫 registrant가 멤버를 유지(재배정 없음)
    # m-2는 registrant로는 적재되되 충돌 이메일이라 멤버는 안 생긴다(소유권 진동 방지).
    reg2 = db_session.scalars(select(Registrant).where(Registrant.organizer_member_id == "m-2")).one()
    assert db_session.scalars(select(Member).where(Member.registrant_id == reg2.id)).first() is None


# --- 미리보기 diff: 갱신 건의 컬럼별 old→new(매핑 안 된 컬럼까지) -----------------------
def test_update_collects_column_diff_including_unmapped(db_session, event):
    import_roster(db_session, event.id, [_rec("m-1", "새한방산", "a@a.com", 업종="방산전자")])
    # 매핑 컬럼(기업명)과 비매핑 컬럼(업종)이 동시에 바뀐 스냅샷
    result = import_roster(db_session, event.id, [_rec("m-1", "새한방산(정정)", "a@a.com", 업종="항공우주")])
    assert result.updated == 1
    (change,) = result.changes
    assert change["organizer_member_id"] == "m-1"
    assert change["columns"]["name"] == {"old": "새한방산", "new": "새한방산(정정)"}
    assert change["columns"]["업종"] == {"old": "방산전자", "new": "항공우주"}


# --- 한 import에서 기존 멤버 2명을 같은 새 이메일로 재배정 → commit 충돌 안 남(autoflush 무관) ---
def test_two_members_reassigned_to_same_email_no_commit_collision(db_session, event):
    db_session.autoflush = False  # 운영 SessionLocal 재현
    import_roster(db_session, event.id, [_rec("m-1", "회사A", "a@a.com"), _rec("m-2", "회사B", "b@b.com")])
    # 둘 다 같은 새 이메일로 바꾸는 스냅샷 — 갱신 분기 flush 없으면 commit 때 UNIQUE 충돌
    import_roster(db_session, event.id, [_rec("m-1", "회사A", "shared@a.com"), _rec("m-2", "회사B", "shared@a.com")])
    db_session.flush()  # 충돌이면 여기서 IntegrityError
    holders = db_session.scalars(select(Member).where(Member.email == "shared@a.com")).all()
    assert len(holders) == 1  # 먼저 처리된 멤버만 새 이메일 점유, 둘째는 충돌 회피로 옛 이메일 유지


# --- codex P1 #2: 같은 회사 다중 멤버에서도 role은 1행(autoflush 무관) -----------------
def test_same_org_multiple_members_single_role_no_dup(db_session, event):
    # autoflush=False(운영 SessionLocal)에서도 intra-import role 중복이 안 생기는지.
    db_session.autoflush = False
    import_roster(
        db_session,
        event.id,
        [_rec("m-1", "새한방산", "a@a.com"), _rec("m-2", "새한방산", "b@b.com")],
    )
    org = db_session.scalars(select(Organization).where(Organization.name_ko == "새한방산")).one()
    roles = db_session.scalars(
        select(OrganizationEventRole).where(OrganizationEventRole.organization_id == org.id)
    ).all()
    assert len(roles) == 1


def test_category_import_persists_without_changing_approval(db_session, event):
    from app.models import ExhibitorProfile
    rec = _rec("category-member", "합성기업", "category@example.com")
    rec.content_category = "broadcasting"
    import_roster(db_session, event.id, [rec])
    profile = db_session.scalars(select(ExhibitorProfile).join(OrganizationEventRole).where(OrganizationEventRole.event_id == event.id)).one()
    assert profile.content_category == "broadcasting"
    role = db_session.get(OrganizationEventRole, profile.org_event_role_id)
    assert role.application_status == "registered"
    rec.content_category = "animation_character"
    outcome = import_roster(db_session, event.id, [rec])
    assert profile.content_category == "broadcasting"
    assert len(outcome.warnings) == 1
    rec.content_category = None
    import_roster(db_session, event.id, [rec])
    assert profile.content_category == "broadcasting"


def test_conflicting_company_rows_do_not_choose_last_category(db_session, event):
    from app.models import ExhibitorProfile
    first = _rec("one", "같은 합성기업", None)
    second = _rec("two", "같은 합성기업", None)
    first.content_category = "broadcasting"
    second.content_category = "animation_character"
    result = import_roster(db_session, event.id, [first, second])
    assert db_session.scalars(select(ExhibitorProfile).join(OrganizationEventRole).where(OrganizationEventRole.event_id == event.id)).first() is None
    assert result.warnings[0]["reason"] == "category_conflict"


def test_category_alias_and_invalid_value_report(db_session, event):
    from app.roster.parser import to_records
    headers = ["id", "name", "tab", "카테고리"]
    records, _ = to_records(headers, [
        dict(zip(headers, ["one", "합성1", "exhibitor", "만화, 웹툰/게임/음악"])),
        dict(zip(headers, ["two", "합성2", "exhibitor", "정의되지 않은 값"])),
    ], None)
    assert records[0].content_category == "comics_game_music"
    result = import_roster(db_session, event.id, records)
    assert result.warnings == [{"organizer_member_id": "two", "reason": "invalid_category"}]


def test_category_reimport_reports_unchanged_after_initial_enrichment(db_session, event):
    rec = _rec("same", "합성3", None)
    import_roster(db_session, event.id, [rec])
    rec.content_category = "broadcasting"
    assert import_roster(db_session, event.id, [rec]).updated == 1
    assert import_roster(db_session, event.id, [rec]).unchanged == 1


# --- 이메일 정규화(P2) — 로그인 검증자(app.auth.local_verify)는 lower()로 조회하므로 명단
# 업로드도 단건 등록(app.admin.service.create_organization)과 같이 strip+lower해 저장해야
# 대문자 섞인 이메일 계정이 로그인할 수 있다. -----------------------------------------------
def test_import_normalizes_contact_email_case(db_session, event):
    # db_session은 이 테스트 끝에 롤백되지만(다른 roster_import 테스트와 서로 격리), migrated_db는
    # 세션 전체가 공유하는 실 DB라 다른 파일(예: test_admin_contact_password.py)이 실제로 커밋해둔
    # 이메일과 members.email UNIQUE가 부딪힐 수 있다 — 그래서 이 테스트만의 고유 이메일을 쓴다.
    email = f"Mixed-{uuid.uuid4().hex[:8]}@Case.com"
    rec = _rec("case-1", "이메일대소문자기업", email)
    import_roster(db_session, event.id, [rec])
    org_id = db_session.scalars(
        select(Organization.id).where(Organization.name_ko == "이메일대소문자기업")
    ).one()
    member = db_session.scalars(select(Member).where(Member.organization_id == org_id)).one()
    assert member.email == email.lower()
