"""session-issue 계약 테스트 — 최초=발급+세션, 재방문=기존 계정 세션(F-AU-001 AC3).

"재방문 시 신규 발급 안 함"을 유저풀의 ``created_count``로 관찰한다. 약관 게이트(최초 진입
필수 동의)도 검증한다(D4).
"""

import pytest

from app.auth.session_issue import (
    CognitoUserPool,
    ConsentNotSatisfiedError,
    InMemoryCognitoUserPool,
    issue_session,
)


def test_pool_satisfies_port_interface():
    assert isinstance(InMemoryCognitoUserPool(), CognitoUserPool)


def test_first_login_provisions_account_and_session():
    pool = InMemoryCognitoUserPool()
    result = issue_session("M-1001", pool, consent_satisfied=True)

    assert result.is_new_account is True
    assert result.account.member_id == "M-1001"
    assert result.tokens.id_token  # 세션 토큰이 발급됨
    assert pool.created_count == 1


def test_revisit_uses_existing_account_without_new_issuance():
    pool = InMemoryCognitoUserPool()
    first = issue_session("M-1001", pool, consent_satisfied=True)
    # 재방문 — 약관을 다시 요구하지 않아도(consent_satisfied=False) 기존 계정으로 세션.
    second = issue_session("M-1001", pool, consent_satisfied=False)

    assert second.is_new_account is False
    assert second.account == first.account  # 동일 계정
    assert pool.created_count == 1  # 신규 발급이 더 일어나지 않음(멱등)


def test_revisit_issues_a_fresh_session():
    pool = InMemoryCognitoUserPool()
    first = issue_session("M-1001", pool, consent_satisfied=True)
    second = issue_session("M-1001", pool, consent_satisfied=False)
    # 같은 계정이라도 세션(토큰)은 매번 새로 난다.
    assert second.tokens.id_token != first.tokens.id_token


def test_first_login_blocked_until_required_consent():
    pool = InMemoryCognitoUserPool()
    with pytest.raises(ConsentNotSatisfiedError):
        issue_session("M-1001", pool, consent_satisfied=False)
    # 게이트에 막혔으면 계정이 발급되지 않아야 한다.
    assert pool.created_count == 0
    assert pool.find_account("M-1001") is None


def test_distinct_members_get_distinct_accounts():
    pool = InMemoryCognitoUserPool()
    a = issue_session("M-1001", pool, consent_satisfied=True)
    b = issue_session("M-2002", pool, consent_satisfied=True)
    assert a.account.member_id != b.account.member_id
    assert pool.created_count == 2


class _RacingPool(InMemoryCognitoUserPool):
    """동시 첫로그인 레이스 흉내 — 두 요청 모두 find에서 None을 본다(아직 미발급).

    실제 발급(get_or_create)만 원자적이라, 둘이 동시에 들어와도 한쪽만 created=True.
    """

    def find_account(self, member_id):
        return None  # 양쪽 racer가 "계정 없음"을 보고 발급 경로로 진입


def test_concurrent_first_login_loser_classified_as_existing():
    pool = _RacingPool()
    # 두 요청 모두 consent를 통과하고 발급으로 들어오지만, 발급은 원자적.
    winner = issue_session("M-1001", pool, consent_satisfied=True)
    loser = issue_session("M-1001", pool, consent_satisfied=True)

    assert winner.is_new_account is True
    assert loser.is_new_account is False  # 진 쪽은 기존 계정 취급 — 두 계정이 안 생긴다
    assert loser.account == winner.account
    assert pool.created_count == 1
