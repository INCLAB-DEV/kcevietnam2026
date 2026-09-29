"""local-verify 단위 테스트(app.auth.local_verify) — 순수 합성 로직은 DB 없이, 실 조회는
conftest.py의 ``db_session``/``event`` 픽스처(savepoint 롤백, Postgres 미가용 시 skip)로 검증한다.
"""

from __future__ import annotations

import bcrypt
import pytest
from sqlalchemy.orm import Session

from app.auth.dx_korea_verify import RejectionReason, VerifyOk, VerifyRejected
from app.auth.local_verify import (
    ChainedRegistrantDirectory,
    ChainedVerifier,
    LocalCredentialVerifier,
    LocalRegistrantDirectory,
)
from app.auth.registrant_mapping import RegistrantRef
from app.models import Event, Member, Organization, OrganizationEventRole


# =============================================================================
# ChainedVerifier — 순수 합성 로직, DB 불필요
# =============================================================================
class _FakeVerifier:
    def __init__(self, result):
        self._result = result
        self.called_with: tuple[str, str] | None = None

    def verify(self, username: str, password: str):
        self.called_with = (username, password)
        return self._result


def test_chained_verifier_returns_first_success():
    first = _FakeVerifier(VerifyRejected(RejectionReason.INVALID_CREDENTIALS))
    second = _FakeVerifier(VerifyOk(member_id="mbr-2"))
    chain = ChainedVerifier([first, second])

    result = chain.verify("u", "p")
    assert result == VerifyOk(member_id="mbr-2")
    assert first.called_with == ("u", "p")
    assert second.called_with == ("u", "p")


def test_chained_verifier_short_circuits_on_first_success():
    first = _FakeVerifier(VerifyOk(member_id="mbr-1"))
    second = _FakeVerifier(VerifyOk(member_id="mbr-2"))
    chain = ChainedVerifier([first, second])

    result = chain.verify("u", "p")
    assert result == VerifyOk(member_id="mbr-1")
    assert second.called_with is None  # 두 번째는 아예 호출되지 않는다


def test_chained_verifier_all_reject_returns_last_rejection():
    first = _FakeVerifier(VerifyRejected(RejectionReason.INVALID_CREDENTIALS))
    second = _FakeVerifier(VerifyRejected(RejectionReason.ACCOUNT_LOCKED))
    chain = ChainedVerifier([first, second])

    result = chain.verify("u", "p")
    assert result == VerifyRejected(RejectionReason.ACCOUNT_LOCKED)


# =============================================================================
# ChainedRegistrantDirectory — 순수 합성 로직, DB 불필요
# =============================================================================
class _FakeDirectory:
    def __init__(self, ref: RegistrantRef | None):
        self._ref = ref

    def find_by_member_id(self, member_id: str) -> RegistrantRef | None:
        return self._ref


def test_chained_directory_returns_first_found():
    ref = RegistrantRef(registrant_id="r1", member_id="m1", is_exhibitor=True, is_buyer=False)
    chain = ChainedRegistrantDirectory([_FakeDirectory(None), _FakeDirectory(ref)])
    assert chain.find_by_member_id("m1") == ref


def test_chained_directory_returns_none_when_all_miss():
    chain = ChainedRegistrantDirectory([_FakeDirectory(None), _FakeDirectory(None)])
    assert chain.find_by_member_id("nobody") is None


# =============================================================================
# LocalRegistrantDirectory — UUID 형식 아닌 회원ID(데모 mbr-*)는 DB 없이 즉시 None
# =============================================================================
def test_local_registrant_directory_returns_none_for_non_uuid_without_touching_db():
    directory = LocalRegistrantDirectory(db=None)  # type: ignore[arg-type]
    assert directory.find_by_member_id("mbr-buyer-01") is None


# =============================================================================
# LocalCredentialVerifier / LocalRegistrantDirectory — 실 DB 조회(Postgres 필요, conftest 스킵 규칙)
# =============================================================================
def _make_member(db_session: Session, org: Organization, *, password: str | None, email: str) -> Member:
    password_hash = (
        bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")
        if password is not None
        else None
    )
    member = Member(organization_id=org.id, name="테스터", email=email, password_hash=password_hash)
    db_session.add(member)
    db_session.flush()
    return member


@pytest.fixture
def org(db_session: Session) -> Organization:
    o = Organization(name_ko="로컬검증테스트기업")
    db_session.add(o)
    db_session.flush()
    return o


def test_local_credential_verifier_accepts_correct_password(db_session: Session, org: Organization):
    member = _make_member(db_session, org, password="abcd1234", email="ok@example.com")
    verifier = LocalCredentialVerifier(db_session)

    result = verifier.verify("ok@example.com", "abcd1234")
    assert result == VerifyOk(member_id=str(member.id))


def test_local_credential_verifier_rejects_wrong_password(db_session: Session, org: Organization):
    _make_member(db_session, org, password="abcd1234", email="wrongpw@example.com")
    verifier = LocalCredentialVerifier(db_session)

    result = verifier.verify("wrongpw@example.com", "not-the-password")
    assert result == VerifyRejected(RejectionReason.INVALID_CREDENTIALS)


def test_local_credential_verifier_rejects_unknown_email(db_session: Session):
    verifier = LocalCredentialVerifier(db_session)
    result = verifier.verify("nobody@example.com", "whatever1")
    assert result == VerifyRejected(RejectionReason.INVALID_CREDENTIALS)


def test_local_credential_verifier_rejects_roster_imported_member_without_password(
    db_session: Session, org: Organization
):
    # 명단 임포트로 생긴 담당자 — password_hash NULL. 로컬 로그인 대상이 아니다(DX Korea 경로 전용).
    _make_member(db_session, org, password=None, email="roster-only@example.com")
    verifier = LocalCredentialVerifier(db_session)

    result = verifier.verify("roster-only@example.com", "anything1")
    assert result == VerifyRejected(RejectionReason.INVALID_CREDENTIALS)


def test_local_registrant_directory_resolves_role_and_profile_flag(db_session: Session, org: Organization, event: Event):
    member = _make_member(db_session, org, password="abcd1234", email="withrole@example.com")
    role = OrganizationEventRole(organization_id=org.id, event_id=event.id, is_buyer=True)
    db_session.add(role)
    db_session.flush()

    directory = LocalRegistrantDirectory(db_session)
    ref = directory.find_by_member_id(str(member.id))

    assert ref is not None
    assert ref.member_id == str(member.id)
    assert ref.is_buyer is True
    assert ref.is_exhibitor is False
    assert ref.application_status == "registered"
    assert ref.has_profile is False  # buyer_profiles 행이 아직 없음


def test_local_registrant_directory_none_when_member_has_no_role(db_session: Session, org: Organization):
    member = _make_member(db_session, org, password="abcd1234", email="norole@example.com")
    directory = LocalRegistrantDirectory(db_session)
    assert directory.find_by_member_id(str(member.id)) is None


def test_local_registrant_directory_none_when_member_missing(db_session: Session):
    directory = LocalRegistrantDirectory(db_session)
    assert directory.find_by_member_id("11111111-1111-1111-1111-111111111111") is None
