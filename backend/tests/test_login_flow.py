"""login 오케스트레이터 통합 계약 테스트 — 검증→매핑→세션 한 흐름(F-AU-001 AC1·AC3).

모듈 더블(스텁 verifier / 인메모리 directory·pool)을 엮어 외부에서 관찰 가능한 로그인
결과만 본다: 성공(세션·최초/재방문), not-found, 거부 사유.
"""

import pytest

from app.auth.dx_korea_verify import RejectionReason, StubDxKoreaVerifier
from app.auth.login import (
    LoginRegistrantNotFound,
    LoginRejected,
    LoginSucceeded,
    authenticate_and_issue_session,
)
from app.auth.registrant_mapping import InMemoryRegistrantDirectory, RegistrantRef
from app.auth.session_issue import ConsentNotSatisfiedError, InMemoryCognitoUserPool

_BUYER_REF = RegistrantRef(
    registrant_id="R-1", member_id="M-1001", is_exhibitor=False, is_buyer=True, role_hint="buyer"
)


def _verifier() -> StubDxKoreaVerifier:
    return StubDxKoreaVerifier(
        credentials={
            ("buyer01", "pw-good"): "M-1001",  # 명단에 적재된 회원
            ("ghost01", "pw-good"): "M-7777",  # 검증은 통과하나 명단에 없음
        }
    )


def _directory() -> InMemoryRegistrantDirectory:
    return InMemoryRegistrantDirectory({"M-1001": _BUYER_REF})


def _run(username, password, *, pool, consent_satisfied=True):
    return authenticate_and_issue_session(
        username,
        password,
        verifier=_verifier(),
        directory=_directory(),
        pool=pool,
        consent_satisfied=consent_satisfied,
    )


# --- AC1: 성공 → 회원ID → 적재 레코드 매핑 + 세션 ----------------------------
def test_successful_login_maps_registrant_and_issues_session():
    pool = InMemoryCognitoUserPool()
    outcome = _run("buyer01", "pw-good", pool=pool)

    assert isinstance(outcome, LoginSucceeded)
    assert outcome.registrant is _BUYER_REF
    assert outcome.session.is_new_account is True
    assert outcome.session.account.member_id == "M-1001"
    assert outcome.session.tokens.id_token
    # 역할(buyer)로 결정된 진입 라우트가 로그인 결과에 실려 나온다(#22).
    assert outcome.route == "/home"
    assert outcome.roles == ("buyer",)


# --- AC1: 검증 통과했지만 적재 레코드 없음 → not-found -----------------------
def test_verified_but_unregistered_member_is_not_found():
    pool = InMemoryCognitoUserPool()
    outcome = _run("ghost01", "pw-good", pool=pool)

    assert isinstance(outcome, LoginRegistrantNotFound)
    assert outcome.member_id == "M-7777"
    assert pool.created_count == 0  # 매핑 실패면 계정도 안 난다


# --- AC1: 검증 실패 → 거부 사유 ----------------------------------------------
def test_failed_verification_returns_rejection_reason():
    pool = InMemoryCognitoUserPool()
    outcome = _run("buyer01", "wrong-pw", pool=pool)

    assert isinstance(outcome, LoginRejected)
    assert outcome.reason is RejectionReason.INVALID_CREDENTIALS
    assert pool.created_count == 0


# --- AC3: 최초=발급, 재방문=기존 계정(신규 발급 없음) ------------------------
def test_first_then_revisit_reuses_account():
    pool = InMemoryCognitoUserPool()
    first = _run("buyer01", "pw-good", pool=pool)
    # 재방문 — 약관 재요구 없이(consent_satisfied=False) 기존 계정 세션.
    second = _run("buyer01", "pw-good", pool=pool, consent_satisfied=False)

    assert isinstance(first, LoginSucceeded) and isinstance(second, LoginSucceeded)
    assert first.session.is_new_account is True
    assert second.session.is_new_account is False
    assert second.session.account == first.session.account
    assert pool.created_count == 1


# --- 게이트: 최초 진입 + 필수 약관 미동의 → 계정 발급 차단 -------------------
def test_first_login_without_consent_is_gated():
    pool = InMemoryCognitoUserPool()
    with pytest.raises(ConsentNotSatisfiedError):
        _run("buyer01", "pw-good", pool=pool, consent_satisfied=False)
    assert pool.created_count == 0
