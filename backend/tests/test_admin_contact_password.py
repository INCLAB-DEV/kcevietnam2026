"""담당자 계정 비밀번호 — 단건 등록 시 설정 + 등록 이후 재설정(발주자 지시 2026-09-21).

배경: 단건 등록(``POST .../organizations``)은 ``contact_email``로 members 행을 만들면서
``password_hash``를 NULL로 뒀다 — 그 계정은 **로그인할 수 없다**(app.auth.local_verify는 해시가
없는 회원을 거부). 명단 업로드에는 공통 비밀번호가 있는데 단건 등록에는 없었고, 등록 이후 다시
정해줄 경로도 없었다. 이 슬라이스가 둘 다 연다:

- ``POST .../organizations``의 선택 필드 ``contact_password``
- ``PATCH .../organizations/{id}/contact-password``

고정하는 규칙:
- **정책·해시는 단일 정본**(app.auth.credentials) — 자체가입·명단 업로드와 같은 규칙. 위반이면
  아무것도 쓰기 전에 422.
- **관할(ADR-0012, 명단 업로드 미러)** — master는 이 행사 전역, sub는 자기 관리 바이어만. sub가
  참가사를 등록하거나 참가사·남의 바이어의 비밀번호를 건드리면 403. sub가 만든 바이어는 그 sub
  관할(``managing_organizer_id``)로 들어간다.
- **운영자 계정은 대상이 될 수 없다** — ``organizers.member_id``가 가리키는 회원이면 누가 불러도
  409. (없으면 sub가 관할 기업 담당자로 등록된 master 계정에 새 비밀번호를 심어 탈취할 수 있다.)
- **평문은 응답 어디에도 실리지 않는다** — 직렬화된 응답 본문 전체를 검사한다.

전부 override 없이 **실 가드 배선**(StubSessionAuthenticator + 행사별 디렉터리)으로 돈다 —
sub의 organizer_id는 ``resolve_organizer_id``가 실제 organizers 행에서 찾는다
(test_admin_sub_operator_console.py와 같은 관례).
"""

from __future__ import annotations

import itertools
import uuid

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from app.auth.dx_korea_verify import VerifyOk
from app.auth.local_verify import LocalCredentialVerifier
from app.auth.organizer_guard import (
    PERMISSION_MASTER,
    InMemoryEventOperatorDirectory,
    StubSessionAuthenticator,
    get_authenticator,
    get_operator_directory,
)
from app.db import get_session
from app.main import app
from app.models import (
    Event,
    EventOrganizer,
    Member,
    Organization,
    OrganizationEventRole,
    Organizer,
)

_seq = itertools.count(1)

# 정책 통과(8자+영문+숫자). 응답·에러 어디에도 나오면 안 되는 문자열이라 테스트 안에서만 쓴다.
PASSWORD = "NabiContact2026"
NEW_PASSWORD = "NabiReset2026x"


# =============================================================================
# 픽스처 — 실 가드 배선
# =============================================================================
@pytest.fixture()
def db_factory(migrated_db: str):
    engine = create_engine(migrated_db, future=True)
    TestSession = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)
    yield TestSession
    engine.dispose()


@pytest.fixture()
def wired_client(db_factory):
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
    app.dependency_overrides[get_authenticator] = StubSessionAuthenticator
    yield TestClient(app, raise_server_exceptions=False)
    app.dependency_overrides.clear()


class _World:
    """한 행사 + master + sub A/B(각자 바이어) + 참가사 + 담당자 없는 기업.

    회원ID는 테스트마다 유일하게 만든다 — migrated_db는 세션 스코프 공유 DB라 organizers.member_id가
    다른 테스트와 겹치면 resolve_organizer_id가 엉뚱한 행을 집는다. 이메일도 members.email이
    unique라 같은 이유로 태그를 붙인다.
    """

    def __init__(self, db_factory) -> None:
        self.tag = uuid.uuid4().hex[:8]
        self.db_factory = db_factory
        self.event_id = self._event()
        self.master_member = f"mbr-master-{self.tag}"
        self.sub_a_member = f"mbr-sub-a-{self.tag}"
        self.sub_b_member = f"mbr-sub-b-{self.tag}"
        self.sub_a = self._organizer(self.sub_a_member)
        self.sub_b = self._organizer(self.sub_b_member)

        self.exhibitor = self._org_role(slug="exh", name="참가사", is_exhibitor=True)
        self.buyer_a = self._org_role(slug="buyer-a", name="A바이어", is_buyer=True, managing=self.sub_a)
        self.buyer_b = self._org_role(slug="buyer-b", name="B바이어", is_buyer=True, managing=self.sub_b)
        # 담당자(members) 없이 만들어진 기업 — 비밀번호를 걸 계정 자체가 없다(404).
        self.buyer_no_contact = self._org_role(
            slug="buyer-bare", name="담당자없는바이어", is_buyer=True, managing=self.sub_a, contact=False
        )

    @property
    def directory(self) -> InMemoryEventOperatorDirectory:
        return InMemoryEventOperatorDirectory(
            {
                (self.master_member, self.event_id): "master",
                (self.sub_a_member, self.event_id): "sub",
                (self.sub_b_member, self.event_id): "sub",
            }
        )

    @staticmethod
    def auth(member_id: str) -> dict[str, str]:
        return {"Authorization": f"Bearer access-{member_id}-1"}

    def email_of(self, org_id: str) -> str | None:
        db = self.db_factory()
        try:
            member = db.scalars(select(Member).where(Member.organization_id == org_id)).first()
            return member.email if member else None
        finally:
            db.close()

    def password_hash_of(self, org_id: str) -> str | None:
        db = self.db_factory()
        try:
            member = db.scalars(select(Member).where(Member.organization_id == org_id)).first()
            return member.password_hash if member else None
        finally:
            db.close()

    # --- 시드 -------------------------------------------------------------------
    def _event(self) -> str:
        db = self.db_factory()
        try:
            ev = Event(name="비밀번호 행사", slug=f"contact-pw-{next(_seq)}-{uuid.uuid4().hex[:8]}")
            db.add(ev)
            db.commit()
            return str(ev.id)
        finally:
            db.close()

    def _organizer(self, member_id: str) -> str:
        db = self.db_factory()
        try:
            o = Organizer(name=f"운영자 {member_id}", email=f"{member_id}@example.com", member_id=member_id)
            db.add(o)
            db.commit()
            return str(o.id)
        finally:
            db.close()

    def _org_role(self, *, slug, name, is_exhibitor=False, is_buyer=False, managing=None, contact=True) -> str:
        # ⚠ 담당자 이메일은 소문자 ASCII로 만든다 — LocalCredentialVerifier가 입력을 lower()해서
        # 조회하므로(app.auth.local_verify), 대문자가 섞인 시드 이메일은 로그인 검증에서 안 잡힌다.
        # 기업명에도 태그를 붙인다 — migrated_db는 세션 스코프 공유 DB라, 이름으로 기업을 찾는
        # 다른 파일의 테스트(예: test_roster_import)가 여기서 커밋한 동명 기업까지 집어 깨진다.
        db = self.db_factory()
        try:
            org = Organization(name_ko=f"{name}-{self.tag}")
            db.add(org)
            db.flush()
            db.add(
                OrganizationEventRole(
                    organization_id=org.id, event_id=self.event_id,
                    is_exhibitor=is_exhibitor, is_buyer=is_buyer, managing_organizer_id=managing,
                )
            )
            if contact:
                db.add(
                    Member(
                        organization_id=org.id, name=f"{name} 담당",
                        email=f"{slug}-{self.tag}@example.com",
                    )
                )
            db.commit()
            return str(org.id)
        finally:
            db.close()

    # --- 크로스이벤트 비밀번호 탈취 방지(P0) 테스트 전용 헬퍼 ----------------------------
    def add_event(self) -> str:
        """두 번째 행사 — 한 조직이 이 행사와 함께 참가할 수 있게."""
        db = self.db_factory()
        try:
            ev = Event(name="다른 행사", slug=f"contact-pw-other-{next(_seq)}-{uuid.uuid4().hex[:8]}")
            db.add(ev)
            db.commit()
            return str(ev.id)
        finally:
            db.close()

    def add_role_in_event(self, organization_id: str, event_id: str, *, is_buyer: bool = True) -> None:
        """기존 조직에 다른 행사의 role을 하나 더 얹는다 — "이 조직이 여러 행사에 걸쳐 있다"를 만든다."""
        db = self.db_factory()
        try:
            db.add(
                OrganizationEventRole(
                    organization_id=organization_id, event_id=event_id, is_buyer=is_buyer
                )
            )
            db.commit()
        finally:
            db.close()

    def grant_master(self, member_id: str, event_id: str) -> str:
        """이 회원을 그 행사의 진짜 EventOrganizer master로 만든다.

        ``check_single_event_org``는 이 스위트의 나머지 검사와 달리 (가짜) InMemoryEventOperatorDirectory
        가 아니라 **실 EventOrganizer 테이블**을 직접 본다 — "얽힌 다른 모든 행사에서 master인가"는
        이 행사 하나의 권한 판정이 아니라 여러 행사를 가로지르는 사실이라 가짜 디렉터리로 대신할 수
        없다(app.admin.guard.resolve_organizer_id와 같은 get-or-create로 신원을 먼저 고정한다).
        """
        from app.admin.guard import resolve_organizer_id

        db = self.db_factory()
        try:
            organizer_id = resolve_organizer_id(db, member_id)
            db.add(
                EventOrganizer(
                    event_id=event_id, organizer_id=organizer_id, permission_level=PERMISSION_MASTER
                )
            )
            db.commit()
            return organizer_id
        finally:
            db.close()


@pytest.fixture()
def world(db_factory, wired_client) -> _World:
    w = _World(db_factory)
    app.dependency_overrides[get_operator_directory] = lambda: w.directory
    return w


def _create(client, world, member_id, **body):
    payload = {"name_ko": f"새기업-{world.tag}-{next(_seq)}", "role": "buyer", **body}
    return client.post(
        f"/api/admin/events/{world.event_id}/organizations",
        json=payload,
        headers=world.auth(member_id),
    )


def _set_password(client, world, member_id, org_id, password=NEW_PASSWORD):
    return client.patch(
        f"/api/admin/events/{world.event_id}/organizations/{org_id}/contact-password",
        json={"password": password},
        headers=world.auth(member_id),
    )


def _verify_login(db_factory, email: str, password: str):
    db = db_factory()
    try:
        return LocalCredentialVerifier(db).verify(email, password)
    finally:
        db.close()


# =============================================================================
# 단건 등록 + 비밀번호
# =============================================================================
def test_create_with_password_lets_the_new_member_log_in(wired_client, db_factory, world):
    email = f"new-contact-{world.tag}@example.com"
    resp = _create(
        wired_client, world, world.master_member,
        contact_name="김담당", contact_email=email, contact_password=PASSWORD,
    )
    assert resp.status_code == 201

    # 실제 로그인 검증자로 확인한다 — "해시가 들어갔다"가 아니라 "이 계정으로 들어올 수 있다".
    assert isinstance(_verify_login(db_factory, email, PASSWORD), VerifyOk)
    assert not isinstance(_verify_login(db_factory, email, "WrongPass123"), VerifyOk)


def test_create_without_password_keeps_hash_null(wired_client, world):
    email = f"no-pw-{world.tag}@example.com"
    resp = _create(wired_client, world, world.master_member, contact_email=email)
    assert resp.status_code == 201
    assert world.password_hash_of(resp.json()["id"]) is None


@pytest.mark.parametrize("bad_password", ["short1", "onlyletters", "12345678"])
def test_create_password_policy_violation_writes_nothing(wired_client, db_factory, world, bad_password):
    name = f"정책위반-{world.tag}"
    resp = _create(
        wired_client, world, world.master_member,
        name_ko=name, contact_email=f"policy-{world.tag}@example.com", contact_password=bad_password,
    )
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "PASSWORD_POLICY"
    assert bad_password not in resp.text  # 에러 응답에도 입력값을 싣지 않는다

    db = db_factory()
    try:
        assert db.scalars(select(Organization).where(Organization.name_ko == name)).first() is None
        assert (
            db.scalars(select(Member).where(Member.email == f"policy-{world.tag}@example.com")).first()
            is None
        )
    finally:
        db.close()


def test_create_password_without_contact_email_is_422(wired_client, db_factory, world):
    name = f"이메일없음-{world.tag}"
    resp = _create(wired_client, world, world.master_member, name_ko=name, contact_password=PASSWORD)
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "PASSWORD_WITHOUT_CONTACT_EMAIL"

    db = db_factory()
    try:
        assert db.scalars(select(Organization).where(Organization.name_ko == name)).first() is None
    finally:
        db.close()


def test_create_response_never_echoes_the_password(wired_client, world):
    resp = _create(
        wired_client, world, world.master_member,
        contact_email=f"echo-{world.tag}@example.com", contact_password=PASSWORD,
    )
    assert resp.status_code == 201
    assert PASSWORD not in resp.text  # 직렬화된 본문 전체 — 필드를 하나씩 보지 않는다


# =============================================================================
# 단건 등록 관할 — sub는 바이어만, 만든 바이어는 자기 관할로
# =============================================================================
def test_sub_creates_buyer_inside_its_own_jurisdiction(wired_client, db_factory, world):
    email = f"sub-created-{world.tag}@example.com"
    resp = _create(
        wired_client, world, world.sub_a_member,
        role="buyer", contact_email=email, contact_password=PASSWORD,
    )
    assert resp.status_code == 201
    org_id = resp.json()["id"]

    db = db_factory()
    try:
        role = db.scalars(
            select(OrganizationEventRole).where(OrganizationEventRole.organization_id == org_id)
        ).one()
        # 만든 sub 관할로 들어가야 그 sub가 이어서 조회·관리할 수 있다(명단 업로드와 같은 규칙).
        assert str(role.managing_organizer_id) == world.sub_a
    finally:
        db.close()
    assert isinstance(_verify_login(db_factory, email, PASSWORD), VerifyOk)


def test_sub_cannot_create_an_exhibitor(wired_client, db_factory, world):
    name = f"sub참가사-{world.tag}"
    resp = _create(wired_client, world, world.sub_a_member, name_ko=name, role="exhibitor")
    assert resp.status_code == 403

    db = db_factory()
    try:
        assert db.scalars(select(Organization).where(Organization.name_ko == name)).first() is None
    finally:
        db.close()


def test_master_created_buyer_stays_unmanaged(wired_client, db_factory, world):
    """master 등록은 종전대로 무관리(NULL) — 이 슬라이스가 기존 동작을 바꾸지 않았음을 고정한다."""
    resp = _create(wired_client, world, world.master_member, role="buyer")
    assert resp.status_code == 201
    db = db_factory()
    try:
        role = db.scalars(
            select(OrganizationEventRole).where(
                OrganizationEventRole.organization_id == resp.json()["id"]
            )
        ).one()
        assert role.managing_organizer_id is None
    finally:
        db.close()


# =============================================================================
# 등록 이후 비밀번호 재설정
# =============================================================================
def test_master_resets_any_contact_password(wired_client, db_factory, world):
    resp = _set_password(wired_client, world, world.master_member, world.exhibitor)
    assert resp.status_code == 200
    assert resp.json()["contact_email"] == world.email_of(world.exhibitor)
    assert isinstance(
        _verify_login(db_factory, world.email_of(world.exhibitor), NEW_PASSWORD), VerifyOk
    )


def test_master_reset_response_never_echoes_the_password(wired_client, world):
    resp = _set_password(wired_client, world, world.master_member, world.buyer_a)
    assert resp.status_code == 200
    # 비밀번호도 해시도 응답에 없다 — 식별 정보(기업/회원/이메일)만.
    assert NEW_PASSWORD not in resp.text
    assert set(resp.json()) == {"organization_id", "member_id", "contact_email"}
    assert "$2b$" not in resp.text


def test_sub_resets_its_own_buyer(wired_client, db_factory, world):
    resp = _set_password(wired_client, world, world.sub_a_member, world.buyer_a)
    assert resp.status_code == 200
    assert isinstance(_verify_login(db_factory, world.email_of(world.buyer_a), NEW_PASSWORD), VerifyOk)


def test_sub_cannot_reset_another_subs_buyer(wired_client, world):
    before = world.password_hash_of(world.buyer_b)
    resp = _set_password(wired_client, world, world.sub_a_member, world.buyer_b)
    assert resp.status_code == 403
    assert world.password_hash_of(world.buyer_b) == before


def test_sub_cannot_reset_an_exhibitor(wired_client, world):
    """읽기 관할은 sub에게 참가사를 열어주지만(check_jurisdiction), 쓰기는 master 전용이다."""
    before = world.password_hash_of(world.exhibitor)
    resp = _set_password(wired_client, world, world.sub_a_member, world.exhibitor)
    assert resp.status_code == 403
    assert world.password_hash_of(world.exhibitor) == before


def test_reset_policy_violation_is_422_and_writes_nothing(wired_client, world):
    before = world.password_hash_of(world.buyer_a)
    resp = _set_password(wired_client, world, world.master_member, world.buyer_a, password="short1")
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "PASSWORD_POLICY"
    assert "short1" not in resp.text
    assert world.password_hash_of(world.buyer_a) == before


def test_reset_without_contact_member_is_404(wired_client, world):
    resp = _set_password(wired_client, world, world.master_member, world.buyer_no_contact)
    assert resp.status_code == 404
    assert resp.json()["detail"]["code"] == "NO_CONTACT_MEMBER"


def test_reset_unknown_organization_is_404(wired_client, world):
    resp = _set_password(
        wired_client, world, world.master_member, "00000000-0000-0000-0000-000000000000"
    )
    assert resp.status_code == 404


def test_reset_requires_an_event_operator(wired_client, world):
    resp = wired_client.patch(
        f"/api/admin/events/{world.event_id}/organizations/{world.buyer_a}/contact-password",
        json={"password": NEW_PASSWORD},
    )
    assert resp.status_code == 401


# =============================================================================
# 운영자 계정 보호 — 누가 불러도 거부(권한이 아니라 대상의 성격)
# =============================================================================
def _make_contact_an_operator(world) -> None:
    """이 기업 담당자(members 행)를 운영자 계정으로 만든다 — organizers.member_id = members.id.

    실제로 벌어지는 경로 그대로다: 로컬 계정으로 로그인한 운영자에게 어드민 가드가
    ``resolve_organizer_id``로 organizers 행을 붙인다(app.admin.guard).
    """
    db = world.db_factory()
    try:
        member = db.scalars(select(Member).where(Member.organization_id == world.buyer_a)).one()
        db.add(
            Organizer(
                name="운영자 겸 담당자",
                email=f"op-contact-{world.tag}@example.com",
                member_id=str(member.id),
            )
        )
        db.commit()
    finally:
        db.close()


def test_sub_cannot_set_an_operator_accounts_password(wired_client, world):
    _make_contact_an_operator(world)
    before = world.password_hash_of(world.buyer_a)
    resp = _set_password(wired_client, world, world.sub_a_member, world.buyer_a)
    assert resp.status_code == 409
    assert resp.json()["detail"]["code"] == "OPERATOR_ACCOUNT"
    assert world.password_hash_of(world.buyer_a) == before


def test_master_cannot_set_an_operator_accounts_password_either(wired_client, world):
    _make_contact_an_operator(world)
    before = world.password_hash_of(world.buyer_a)
    resp = _set_password(wired_client, world, world.master_member, world.buyer_a)
    assert resp.status_code == 409
    assert resp.json()["detail"]["code"] == "OPERATOR_ACCOUNT"
    assert world.password_hash_of(world.buyer_a) == before


# =============================================================================
# 크로스이벤트 비밀번호 탈취 방지(P0, 발주자 지시 2026-09-21) — members.password_hash는
# 행사 무관 전역이라, 한 조직이 여러 행사에 걸쳐 있으면 이 행사 권한만으로 다른 행사의 로그인까지
# 바꿔버릴 수 있었다(get_contact_member가 organization_id만 보고 찾는다).
# =============================================================================
def test_single_event_org_password_reset_still_works(wired_client, world):
    """이 org가 이 행사에만 있으면(기존 동작) 평소대로 통과한다 — 회귀 방지."""
    resp = _set_password(wired_client, world, world.master_member, world.buyer_a)
    assert resp.status_code == 200


def test_sub_blocked_when_its_own_buyer_also_belongs_to_another_event(wired_client, world):
    event2 = world.add_event()
    world.add_role_in_event(world.buyer_a, event2)
    before = world.password_hash_of(world.buyer_a)
    resp = _set_password(wired_client, world, world.sub_a_member, world.buyer_a)
    assert resp.status_code == 409
    assert resp.json()["detail"]["code"] == "MULTI_EVENT_ORG"
    assert world.password_hash_of(world.buyer_a) == before


def test_master_blocked_when_org_is_in_another_event_it_doesnt_master(wired_client, world):
    """이 행사의 master라도 **다른** 행사엔 권한이 없으면 걸린다 — master라서 예외는 아니다."""
    event2 = world.add_event()
    world.add_role_in_event(world.buyer_a, event2)
    before = world.password_hash_of(world.buyer_a)
    resp = _set_password(wired_client, world, world.master_member, world.buyer_a)
    assert resp.status_code == 409
    assert resp.json()["detail"]["code"] == "MULTI_EVENT_ORG"
    assert world.password_hash_of(world.buyer_a) == before


def test_master_of_all_involved_events_is_allowed(wired_client, db_factory, world):
    event2 = world.add_event()
    world.add_role_in_event(world.buyer_a, event2)
    world.grant_master(world.master_member, event2)
    resp = _set_password(wired_client, world, world.master_member, world.buyer_a)
    assert resp.status_code == 200
    assert isinstance(_verify_login(db_factory, world.email_of(world.buyer_a), NEW_PASSWORD), VerifyOk)


# =============================================================================
# 422 검증 오류가 평문을 반사하지 않는다(P1, 발주자 지시 2026-09-21) — FastAPI 기본
# RequestValidationError 바디는 각 에러에 ``input``을 그대로 싣는다. 전역 핸들러(app.main)가
# input/ctx를 걷어내는지 확인한다. loc/msg는 남아 있어야 클라이언트가 어느 필드가 왜 틀렸는지 안다.
# =============================================================================
def test_wrong_typed_password_422_does_not_echo_the_value(wired_client, world):
    secret_looking_value = 20260921135900  # 숫자로 보내 pydantic 타입 검증에서 걸리게 한다
    resp = wired_client.patch(
        f"/api/admin/events/{world.event_id}/organizations/{world.buyer_a}/contact-password",
        json={"password": secret_looking_value},
        headers=world.auth(world.master_member),
    )
    assert resp.status_code == 422
    assert str(secret_looking_value) not in resp.text
    errors = resp.json()["detail"]
    assert isinstance(errors, list) and errors
    for error in errors:
        assert "input" not in error
        assert "ctx" not in error
        assert error["loc"][-1] == "password"  # 어느 필드가 틀렸는지는 여전히 알 수 있다


# =============================================================================
# bcrypt 72바이트 상한(P1, 발주자 지시 2026-09-21) — 넘기면 (500이 아니라) 422로 거부한다.
# 경계값 자체는 backend/tests/test_password_policy.py(순수 함수 단위 테스트)가 더 촘촘히 본다.
# =============================================================================
def test_reset_with_73_byte_password_is_422_not_500(wired_client, world):
    too_long = "Ab1" + "a" * 70  # 73바이트
    before = world.password_hash_of(world.buyer_a)
    resp = _set_password(wired_client, world, world.master_member, world.buyer_a, password=too_long)
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "PASSWORD_POLICY"
    assert too_long not in resp.text
    assert world.password_hash_of(world.buyer_a) == before


# =============================================================================
# 이메일 정규화(P2, 발주자 지시 2026-09-21) — 단건 등록이 대문자 섞인 이메일을 그대로 저장하면
# 로그인 검증자(lower()로 조회)가 못 찾는다. strip+lower해 저장하는지 확인한다.
# =============================================================================
def test_create_with_mixed_case_email_can_log_in_with_lowercase(wired_client, db_factory, world):
    mixed_case_email = f"Mixed-{world.tag}@Case.com"
    resp = _create(
        wired_client, world, world.master_member,
        contact_name="김담당", contact_email=mixed_case_email, contact_password=PASSWORD,
    )
    assert resp.status_code == 201
    assert isinstance(_verify_login(db_factory, mixed_case_email.lower(), PASSWORD), VerifyOk)

    db = db_factory()
    try:
        member = db.scalars(select(Member).where(Member.organization_id == resp.json()["id"])).one()
        assert member.email == mixed_case_email.lower()
    finally:
        db.close()
