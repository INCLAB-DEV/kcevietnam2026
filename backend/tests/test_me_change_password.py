"""참가자 셀프 비밀번호 변경 — ``POST /api/me/change-password``(발주자 요구사항 2026-09-30).

배경: 명단 업로드(``app.roster``)가 공통 비밀번호를 일괄로 심어놓은 상태라, 참가사 담당자가 자기
로그인 비밀번호를 스스로 바꿀 길이 없었다.

고정하는 규칙:
- **해시 갱신이 로그인에 실제로 반영된다** — "password_hash가 바뀌었다"로 만족하지 않고
  ``LocalCredentialVerifier``로 **옛 비밀번호 거부 / 새 비밀번호 통과**까지 확인한다. 이게 이 기능의
  핵심이고, 검증자를 거치지 않으면 "해시는 바뀌었는데 로그인은 안 되는" 회귀를 놓친다.
- **현재 비밀번호를 모르면 아무것도 안 바뀐다** — 403(INVALID_CREDENTIALS)이면서 해시 불변.
- **정책은 단일 정본**(``app.auth.credentials``) — 위반은 422 PASSWORD_POLICY, 해시 불변. 규칙을
  라우터에서 새로 만들지 않았음을 여기서 고정한다.
- **로컬 비밀번호가 없는 계정은 409**(NO_LOCAL_PASSWORD) — 입력값 오류가 아니라 계정 상태 충돌.
- **평문·해시는 응답 어디에도 실리지 않는다** — 직렬화된 본문 전체를 검사한다
  (``test_admin_contact_password.py``와 같은 방식).

인증은 ``get_current_principal`` override로 고정한다(``test_discover_api.py`` 관례) — 도메인 동작에
집중하고, 401 계약만 override를 걷어내 따로 확인한다.

로컬 Postgres 없으면 conftest의 skip 패턴(``migrated_db``)에 따라 전체 skip.
"""

from __future__ import annotations

import itertools
import uuid

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from app.auth.credentials import hash_password
from app.auth.dx_korea_verify import VerifyOk
from app.auth.local_verify import LocalCredentialVerifier
from app.auth.principal import Principal, get_current_principal
from app.db import get_session
from app.main import app
from app.models import Member, Organization

_seq = itertools.count(1)

ENDPOINT = "/api/me/change-password"

# 정책 통과(8자+영문+숫자). 응답·에러 어디에도 나오면 안 되는 문자열이라 테스트 안에서만 쓴다.
PASSWORD = "NabiOriginal2026"
NEW_PASSWORD = "NabiChanged2026"


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


class _Account:
    """기업 하나 + 담당자 한 명. ``password`` None이면 ``password_hash``를 NULL로 둔다.

    이메일은 소문자 ASCII + 유일 태그로 만든다 — ``LocalCredentialVerifier``가 입력을 lower()해서
    조회하고(``app.auth.local_verify``), ``migrated_db``는 세션 스코프 공유 DB라 ``members.email``
    unique가 다른 테스트와 충돌할 수 있다.
    """

    def __init__(self, db_factory, *, password: str | None) -> None:
        self.db_factory = db_factory
        self.tag = uuid.uuid4().hex[:8]
        self.email = f"self-pw-{self.tag}@example.com"
        db = db_factory()
        try:
            org = Organization(name_ko=f"셀프변경기업-{self.tag}-{next(_seq)}")
            db.add(org)
            db.flush()
            member = Member(
                organization_id=org.id,
                name="김담당",
                email=self.email,
                password_hash=hash_password(password) if password is not None else None,
            )
            db.add(member)
            db.commit()
            self.org_id = str(org.id)
            self.member_id = str(member.id)
        finally:
            db.close()

    @property
    def password_hash(self) -> str | None:
        db = self.db_factory()
        try:
            return db.scalars(select(Member).where(Member.id == self.member_id)).one().password_hash
        finally:
            db.close()

    def verify_login(self, password: str):
        """실제 로그인 검증자로 확인한다 — "해시가 바뀌었다"가 아니라 "이 값으로 들어올 수 있다"."""
        db = self.db_factory()
        try:
            return LocalCredentialVerifier(db).verify(self.email, password)
        finally:
            db.close()


@pytest.fixture()
def account(db_factory) -> _Account:
    return _Account(db_factory, password=PASSWORD)


def _login_as(account: _Account) -> None:
    app.dependency_overrides[get_current_principal] = lambda: Principal(
        member_id=account.member_id, organization_id=account.org_id
    )


def _change(client: TestClient, current: str = PASSWORD, new: str = NEW_PASSWORD):
    return client.post(ENDPOINT, json={"current_password": current, "new_password": new})


# =============================================================================
# 성공 — 해시 교체가 로그인에 반영된다
# =============================================================================
def test_change_password_switches_the_login_credential(client, account):
    _login_as(account)
    before = account.password_hash

    resp = _change(client)

    assert resp.status_code == 200
    assert resp.json() == {"ok": True}
    assert account.password_hash != before
    # 이 기능의 핵심 — 옛 비밀번호로는 못 들어오고, 새 비밀번호로는 들어온다.
    assert not isinstance(account.verify_login(PASSWORD), VerifyOk)
    assert isinstance(account.verify_login(NEW_PASSWORD), VerifyOk)


def test_success_response_never_echoes_the_password_or_hash(client, account):
    _login_as(account)

    resp = _change(client)

    assert resp.status_code == 200
    # 직렬화된 본문 전체 — 필드를 하나씩 보지 않는다.
    assert NEW_PASSWORD not in resp.text
    assert PASSWORD not in resp.text
    assert "$2b$" not in resp.text
    assert set(resp.json()) == {"ok"}


# =============================================================================
# 거부 — 어느 경우에도 해시는 그대로 남는다
# =============================================================================
def test_wrong_current_password_is_403_and_changes_nothing(client, account):
    _login_as(account)
    before = account.password_hash

    resp = _change(client, current="WrongCurrent2026")

    assert resp.status_code == 403
    assert resp.json()["detail"]["code"] == "INVALID_CREDENTIALS"
    assert account.password_hash == before
    assert isinstance(account.verify_login(PASSWORD), VerifyOk)  # 옛 비밀번호가 여전히 유효


@pytest.mark.parametrize("bad_password", ["short", "onlyletters", "12345678"])
def test_policy_violation_is_422_and_changes_nothing(client, account, bad_password):
    _login_as(account)
    before = account.password_hash

    resp = _change(client, new=bad_password)

    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "PASSWORD_POLICY"
    assert bad_password not in resp.text  # 에러 응답에도 입력값을 싣지 않는다
    assert account.password_hash == before


def test_same_password_is_422(client, account):
    _login_as(account)
    before = account.password_hash

    resp = _change(client, new=PASSWORD)

    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "SAME_PASSWORD"
    assert PASSWORD not in resp.text
    assert account.password_hash == before


def test_member_without_local_password_is_409(client, db_factory):
    """``password_hash``가 NULL인 계정(DX Korea 검증 대상) — 여기서 바꿀 수 있는 대상이 아니다."""
    bare = _Account(db_factory, password=None)
    _login_as(bare)

    resp = _change(client)

    assert resp.status_code == 409
    assert resp.json()["detail"]["code"] == "NO_LOCAL_PASSWORD"
    assert bare.password_hash is None


def test_unauthenticated_401(client, account):
    """override를 걷어내고 헤더 없이 부르면 401 — 실 인증 경로가 이 라우트를 지킨다."""
    app.dependency_overrides.pop(get_current_principal, None)
    before = account.password_hash

    resp = _change(client)

    assert resp.status_code == 401
    assert account.password_hash == before
