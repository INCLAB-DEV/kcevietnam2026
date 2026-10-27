"""cognito-pool 계약 테스트 — 실 Cognito 어댑터를 FakeCognitoIdp로 검증한다(F-AU-001, 1단계 로컬).

``AwsCognitoUserPool``이 ``session_issue.CognitoUserPool`` 프로토콜을 충족하는지(get_or_create
멱등·발급 토큰이 실제 RS256 검증을 통과·매핑 복원), ``resolve_member_key``/``verify_session_token``
(kid-miss 재시도)/``CognitoSessionAuthenticator``가 계약대로 동작하는지 boto3·네트워크 없이 닫는다.
"""

from __future__ import annotations

import pytest
from botocore.exceptions import ClientError, EndpointConnectionError
from cryptography.hazmat.primitives.asymmetric import rsa

from app.auth.cognito_pool import (
    AwsCognitoUserPool,
    CognitoAuthError,
    CognitoConfigurationError,
    CognitoServiceError,
    CognitoSessionAuthenticator,
    CognitoThrottledError,
    resolve_member_key,
    verify_session_token,
)
from app.auth.jwks_cache import CognitoJwks
from app.auth.jwt_verify import JwtVerificationError
from app.auth.organizer_guard import UnauthenticatedError
from app.auth.session_issue import issue_session
from tests.fake_cognito_idp import (
    FakeCognitoIdp,
    InvalidPasswordException,
    NotAuthorizedException,
    TooManyRequestsException,
    jwks_for,
)

ISSUER = "https://cognito-idp.ap-northeast-2.amazonaws.com/pool-XYZ"
CLIENT_ID = "app-client-123"
KID = "key-2026-06"


def _gen_key() -> rsa.RSAPrivateKey:
    return rsa.generate_private_key(public_exponent=65537, key_size=2048)


def _pool(fake: FakeCognitoIdp) -> AwsCognitoUserPool:
    return AwsCognitoUserPool(
        user_pool_id="pool-XYZ",
        app_client_id=CLIENT_ID,
        region="ap-northeast-2",
        password_secret="test-password-secret",
        client=fake,
    )


# =============================================================================
# AwsCognitoUserPool — session_issue.CognitoUserPool 프로토콜 계약
# =============================================================================
def test_find_account_returns_none_for_unknown_member():
    fake = FakeCognitoIdp(issuer=ISSUER, client_id=CLIENT_ID, signing_key=_gen_key(), kid=KID)
    pool = _pool(fake)
    assert pool.find_account("mbr-nowhere") is None


def test_get_or_create_account_is_idempotent():
    fake = FakeCognitoIdp(issuer=ISSUER, client_id=CLIENT_ID, signing_key=_gen_key(), kid=KID)
    pool = _pool(fake)

    first, created_first = pool.get_or_create_account("mbr-buyer-01")
    second, created_second = pool.get_or_create_account("mbr-buyer-01")

    assert created_first is True
    assert created_second is False
    assert first == second  # 같은 cognito_sub — 새 계정이 또 생기지 않았다.
    assert pool.find_account("mbr-buyer-01") == first


def test_get_or_create_absorbs_username_exists_race():
    """admin_create_user가 UsernameExistsException을 던지는 레이스 — 기존 계정으로 흡수한다."""
    fake = FakeCognitoIdp(issuer=ISSUER, client_id=CLIENT_ID, signing_key=_gen_key(), kid=KID)
    pool = _pool(fake)
    # 이미 존재하는 것처럼 먼저 만들어둔다(다른 요청이 이겼다고 흉내).
    winner, _ = pool.get_or_create_account("mbr-race-01")

    account, created = pool.get_or_create_account("mbr-race-01")

    assert created is False
    assert account == winner


def test_issue_tokens_returns_rs256_verifiable_id_token():
    key = _gen_key()
    fake = FakeCognitoIdp(issuer=ISSUER, client_id=CLIENT_ID, signing_key=key, kid=KID)
    pool = _pool(fake)
    account, _ = pool.get_or_create_account("mbr-buyer-02")

    tokens = pool.issue_tokens(account)

    jwks = jwks_for(key, kid=KID)
    claims = verify_session_token(
        tokens.id_token, CognitoJwks(ISSUER, static_override=jwks), issuer=ISSUER, client_id=CLIENT_ID
    )
    # cognito:username == member_id — admin_create_user(Username=member_id)로 만들었으므로
    # resolve_member_key가 컬럼 신설 없이 회원ID를 복원할 수 있다.
    assert resolve_member_key(claims) == "mbr-buyer-02"
    assert tokens.refresh_token is not None


def test_derived_password_is_stable_and_member_specific():
    fake = FakeCognitoIdp(issuer=ISSUER, client_id=CLIENT_ID, signing_key=_gen_key(), kid=KID)
    pool = _pool(fake)
    assert pool._derived_password("mbr-a") == pool._derived_password("mbr-a")
    assert pool._derived_password("mbr-a") != pool._derived_password("mbr-b")


def test_secret_hash_is_none_when_app_client_secret_unset():
    fake = FakeCognitoIdp(issuer=ISSUER, client_id=CLIENT_ID, signing_key=_gen_key(), kid=KID)
    pool = _pool(fake)
    assert pool._secret_hash("mbr-a") is None


def test_secret_hash_computed_when_app_client_secret_given():
    fake = FakeCognitoIdp(issuer=ISSUER, client_id=CLIENT_ID, signing_key=_gen_key(), kid=KID)
    pool = AwsCognitoUserPool(
        user_pool_id="pool-XYZ",
        app_client_id=CLIENT_ID,
        region="ap-northeast-2",
        password_secret="test-password-secret",
        app_client_secret="a-real-secret",
        client=fake,
    )
    h1 = pool._secret_hash("mbr-a")
    assert h1 is not None
    assert h1 == pool._secret_hash("mbr-a")  # 결정적
    assert h1 != pool._secret_hash("mbr-b")


# =============================================================================
# session_issue.issue_session과의 통합 — 재방문 멱등성까지 실 어댑터로 닫는다
# =============================================================================
def test_issue_session_returning_visit_does_not_recreate_account():
    fake = FakeCognitoIdp(issuer=ISSUER, client_id=CLIENT_ID, signing_key=_gen_key(), kid=KID)
    pool = _pool(fake)

    first = issue_session("mbr-buyer-03", pool, consent_satisfied=True)
    second = issue_session("mbr-buyer-03", pool, consent_satisfied=True)

    assert first.is_new_account is True
    assert second.is_new_account is False
    assert first.account == second.account


# =============================================================================
# resolve_member_key
# =============================================================================
def test_resolve_member_key_prefers_cognito_username_over_sub():
    claims = {"cognito:username": "mbr-buyer-01", "sub": "aws-internal-sub-uuid"}
    assert resolve_member_key(claims) == "mbr-buyer-01"


def test_resolve_member_key_falls_back_to_sub():
    claims = {"sub": "mbr-buyer-01"}
    assert resolve_member_key(claims) == "mbr-buyer-01"


def test_resolve_member_key_none_when_both_missing():
    assert resolve_member_key({}) is None


# =============================================================================
# verify_session_token — kid-miss 강제 재fetch 후 1회 재시도
# =============================================================================
def fake_pool_account(fake: FakeCognitoIdp):
    return _pool(fake).get_or_create_account("mbr-kid-miss-01")


def test_verify_session_token_retries_once_on_kid_miss():
    key = _gen_key()
    fake = FakeCognitoIdp(issuer=ISSUER, client_id=CLIENT_ID, signing_key=key, kid=KID)
    account, _ = fake_pool_account(fake)
    tokens = _pool(fake).issue_tokens(account)

    # 캐시가 처음엔 회전 전 키(다른 kid)를 주다가, force_refresh 이후에야 진짜 키를 준다.
    stale_jwks = jwks_for(_gen_key(), kid="stale-kid")
    calls = {"n": 0}

    def _fetcher(url: str) -> dict:
        calls["n"] += 1
        if calls["n"] == 1:
            return stale_jwks
        return jwks_for(key, kid=KID)

    provider = CognitoJwks(ISSUER, fetcher=_fetcher)
    claims = verify_session_token(tokens.id_token, provider, issuer=ISSUER, client_id=CLIENT_ID)

    assert resolve_member_key(claims) == account.member_id
    assert calls["n"] == 2  # 최초 시도(옛 kid) + force_refresh 재시도(진짜 키)


def test_verify_session_token_gives_up_after_one_retry():
    key = _gen_key()
    fake = FakeCognitoIdp(issuer=ISSUER, client_id=CLIENT_ID, signing_key=key, kid=KID)
    account, _ = fake_pool_account(fake)
    tokens = _pool(fake).issue_tokens(account)

    # force_refresh를 해도 계속 옛 kid — 1회 재시도 후엔 그대로 실패해야 한다(무한 재시도 금지).
    stale_jwks = jwks_for(_gen_key(), kid="stale-kid")
    provider = CognitoJwks(ISSUER, fetcher=lambda url: stale_jwks)
    with pytest.raises(JwtVerificationError):
        verify_session_token(tokens.id_token, provider, issuer=ISSUER, client_id=CLIENT_ID)


# =============================================================================
# CognitoSessionAuthenticator — organizer_guard.SessionAuthenticator 계약
# =============================================================================
def _authenticator(fake: FakeCognitoIdp) -> CognitoSessionAuthenticator:
    return CognitoSessionAuthenticator(
        provider=CognitoJwks(ISSUER, static_override=fake.jwks()),
        issuer=ISSUER,
        client_id=CLIENT_ID,
    )


def test_authenticator_identifies_member_from_valid_id_token():
    key = _gen_key()
    fake = FakeCognitoIdp(issuer=ISSUER, client_id=CLIENT_ID, signing_key=key, kid=KID)
    account, _ = _pool(fake).get_or_create_account("mbr-org-77")
    tokens = _pool(fake).issue_tokens(account)

    member_id = _authenticator(fake).identify(f"Bearer {tokens.id_token}")

    assert member_id == "mbr-org-77"


def test_authenticator_rejects_missing_header():
    fake = FakeCognitoIdp(issuer=ISSUER, client_id=CLIENT_ID, signing_key=_gen_key(), kid=KID)
    with pytest.raises(UnauthenticatedError):
        _authenticator(fake).identify(None)


def test_authenticator_rejects_malformed_bearer():
    fake = FakeCognitoIdp(issuer=ISSUER, client_id=CLIENT_ID, signing_key=_gen_key(), kid=KID)
    with pytest.raises(UnauthenticatedError):
        _authenticator(fake).identify("not-a-bearer-token")


def test_authenticator_rejects_garbage_token():
    fake = FakeCognitoIdp(issuer=ISSUER, client_id=CLIENT_ID, signing_key=_gen_key(), kid=KID)
    with pytest.raises(UnauthenticatedError):
        _authenticator(fake).identify("Bearer not.a.jwt")


def test_authenticator_rejects_access_token_in_id_slot():
    """세션 토큰은 항상 id 토큰이어야 한다 — access 토큰을 넣으면 token_use 불일치로 거부."""
    key = _gen_key()
    fake = FakeCognitoIdp(issuer=ISSUER, client_id=CLIENT_ID, signing_key=key, kid=KID)
    account, _ = _pool(fake).get_or_create_account("mbr-org-78")
    tokens = _pool(fake).issue_tokens(account)

    with pytest.raises(UnauthenticatedError):
        _authenticator(fake).identify(f"Bearer {tokens.access_token}")


# =============================================================================
# boto3 예외 처리 — 크로스벤더 보안 리뷰 반영(500 누수 차단, 각 예외를 서비스 전용 타입으로 래핑)
# =============================================================================
def test_issue_tokens_wraps_not_authorized_as_cognito_auth_error():
    """admin_initiate_auth의 NotAuthorizedException은 500이 아니라 CognitoAuthError로 래핑된다.

    정상 흐름에선 안 나는 경로(파생 비번은 우리가 직접 심으므로 항상 일치)지만, 비번 로테이션
    드리프트 같은 방어적 시나리오를 강제로 재현한다.
    """
    fake = FakeCognitoIdp(issuer=ISSUER, client_id=CLIENT_ID, signing_key=_gen_key(), kid=KID)
    pool = _pool(fake)
    account, _ = pool.get_or_create_account("mbr-drift-01")
    fake.force_error("admin_initiate_auth", NotAuthorizedException("Incorrect username or password"))

    with pytest.raises(CognitoAuthError):
        pool.issue_tokens(account)


def test_get_or_create_account_wraps_throttle_on_create_as_cognito_throttled_error():
    """admin_create_user의 TooManyRequestsException(throttling)은 CognitoThrottledError로 래핑된다."""
    fake = FakeCognitoIdp(issuer=ISSUER, client_id=CLIENT_ID, signing_key=_gen_key(), kid=KID)
    pool = _pool(fake)
    fake.force_error("admin_create_user", TooManyRequestsException("slow down"))

    with pytest.raises(CognitoThrottledError):
        pool.get_or_create_account("mbr-throttle-01")


def test_get_or_create_account_wraps_throttle_on_set_password_as_cognito_throttled_error():
    """admin_set_user_password의 throttling도 동일하게 CognitoThrottledError로 래핑된다."""
    fake = FakeCognitoIdp(issuer=ISSUER, client_id=CLIENT_ID, signing_key=_gen_key(), kid=KID)
    pool = _pool(fake)
    fake.force_error("admin_set_user_password", TooManyRequestsException("slow down"))

    with pytest.raises(CognitoThrottledError):
        pool.get_or_create_account("mbr-throttle-02")


def test_get_or_create_account_wraps_invalid_password_as_configuration_error():
    """admin_set_user_password의 InvalidPasswordException은 CognitoConfigurationError로 래핑된다.

    파생 비밀번호(_derived_password)가 유저풀 정책을 항상 충족하도록 만들어졌으므로, 정상
    흐름에서 이 예외가 나면 구현 버그 신호다 — 그 신호를 명확한 타입으로 구분한다.
    """
    fake = FakeCognitoIdp(issuer=ISSUER, client_id=CLIENT_ID, signing_key=_gen_key(), kid=KID)
    pool = _pool(fake)
    fake.force_error("admin_set_user_password", InvalidPasswordException("policy violation"))

    with pytest.raises(CognitoConfigurationError):
        pool.get_or_create_account("mbr-badpw-01")


def test_get_or_create_account_wraps_generic_client_error_as_cognito_service_error():
    """UsernameExists/Throttle/InvalidPassword 이외의 실 botocore ClientError는 CognitoServiceError로."""
    fake = FakeCognitoIdp(issuer=ISSUER, client_id=CLIENT_ID, signing_key=_gen_key(), kid=KID)
    pool = _pool(fake)
    fake.force_error(
        "admin_create_user",
        ClientError({"Error": {"Code": "InternalErrorException", "Message": "boom"}}, "AdminCreateUser"),
    )

    with pytest.raises(CognitoServiceError):
        pool.get_or_create_account("mbr-generic-err-01")


def test_get_or_create_account_wraps_boto_core_error_as_cognito_service_error():
    """ClientError가 아닌 BotoCoreError(네트워크 장애 등)도 CognitoServiceError로 래핑된다."""
    fake = FakeCognitoIdp(issuer=ISSUER, client_id=CLIENT_ID, signing_key=_gen_key(), kid=KID)
    pool = _pool(fake)
    fake.force_error("admin_create_user", EndpointConnectionError(endpoint_url="https://example.com"))

    with pytest.raises(CognitoServiceError):
        pool.get_or_create_account("mbr-generic-err-02")


def test_find_account_does_not_swallow_non_user_not_found_errors():
    """find_account는 UserNotFoundException만 None으로 흡수하고, 그 외는 삼키지 않고 래핑해 던진다."""
    fake = FakeCognitoIdp(issuer=ISSUER, client_id=CLIENT_ID, signing_key=_gen_key(), kid=KID)
    pool = _pool(fake)
    fake.force_error("admin_get_user", TooManyRequestsException("slow down"))

    with pytest.raises(CognitoThrottledError):
        pool.find_account("mbr-lookup-throttle-01")


def test_get_or_create_account_username_exists_then_find_account_error_is_wrapped_not_500():
    """UsernameExists 흡수 경로에서 find_account가 다른 예외를 던지면, 그대로도 500이 아니라
    래핑된 서비스 예외로 전파된다(원본 UsernameExistsException으로 되돌아가지 않는다).
    """
    fake = FakeCognitoIdp(issuer=ISSUER, client_id=CLIENT_ID, signing_key=_gen_key(), kid=KID)
    pool = _pool(fake)
    pool.get_or_create_account("mbr-race-err-01")  # 이미 존재하게 만들어 재호출 시 UsernameExists 유도

    fake.force_error("admin_get_user", TooManyRequestsException("slow down"))
    with pytest.raises(CognitoThrottledError):
        pool.get_or_create_account("mbr-race-err-01")
