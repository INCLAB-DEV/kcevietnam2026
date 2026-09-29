"""jwt-verify 계약 테스트 — Cognito 발급 JWT의 JWKS/RS256 검증(F-AU-001 AC4).

테스트용 RSA 키쌍을 만들어 **가짜 Cognito JWKS**처럼 쓴다(테스트가 Cognito 역할로 RS256
서명, 검증자가 JWKS로 검증). 유효 토큰은 통과, 위조·다른 키·만료·iss/aud(또는 client_id)
불일치·미존재 kid·token_use 혼동은 거부됨을 확인한다. ID 토큰(aud)과 access 토큰(client_id)
두 계약을 모두 닫는다. 실 Cognito 없이 검증 계약을 닫는다.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

from app.auth.jwt_verify import (
    InvalidAudienceError,
    InvalidIssuerError,
    InvalidSignatureError,
    InvalidTokenUseError,
    JwtVerificationError,
    MalformedJwksError,
    MalformedTokenError,
    SigningKeyNotFoundError,
    TokenExpiredError,
    verify_jwt,
)

ISSUER = "https://cognito-idp.ap-northeast-2.amazonaws.com/pool-XYZ"
AUDIENCE = "app-client-123"
KID = "key-2026-06"


def _gen_key() -> rsa.RSAPrivateKey:
    return rsa.generate_private_key(public_exponent=65537, key_size=2048)


def _jwks(private_key: rsa.RSAPrivateKey, kid: str = KID) -> dict:
    """공개키 → Cognito 형태의 JWKS(``{"keys": [...]}``)."""
    jwk = jwt.algorithms.RSAAlgorithm.to_jwk(private_key.public_key(), as_dict=True)
    jwk.update({"kid": kid, "alg": "RS256", "use": "sig"})
    return {"keys": [jwk]}


def _sign(
    private_key: rsa.RSAPrivateKey,
    *,
    kid: str = KID,
    issuer: str = ISSUER,
    token_use: str = "id",
    audience: str | None = AUDIENCE,
    client_id: str | None = None,
    expires_in: timedelta = timedelta(hours=1),
) -> str:
    """Cognito 토큰 흉내 — ID 토큰은 aud, access 토큰은 client_id 클레임을 담는다."""
    now = datetime.now(timezone.utc)
    claims: dict = {
        "sub": "sub-M-1001",
        "iss": issuer,
        "token_use": token_use,
        "iat": now,
        "exp": now + expires_in,
    }
    if audience is not None:
        claims["aud"] = audience
    if client_id is not None:
        claims["client_id"] = client_id
    pem = private_key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    )
    return jwt.encode(claims, pem, algorithm="RS256", headers={"kid": kid})


def _access(private_key: rsa.RSAPrivateKey, **kw) -> str:
    """access 토큰 — aud 없이 client_id 클레임으로 앱 클라이언트를 식별."""
    return _sign(private_key, token_use="access", audience=None, client_id=AUDIENCE, **kw)


def test_valid_id_token_verifies_and_returns_claims():
    key = _gen_key()
    token = _sign(key)
    claims = verify_jwt(token, _jwks(key), issuer=ISSUER, client_id=AUDIENCE)
    assert claims["sub"] == "sub-M-1001"
    assert claims["iss"] == ISSUER
    assert claims["token_use"] == "id"


def test_valid_access_token_verifies_via_client_id_claim():
    key = _gen_key()
    token = _access(key)
    claims = verify_jwt(token, _jwks(key), issuer=ISSUER, client_id=AUDIENCE, token_use="access")
    assert claims["client_id"] == AUDIENCE
    assert claims["token_use"] == "access"


def test_access_token_with_wrong_client_id_rejected():
    key = _gen_key()
    token = _sign(key, token_use="access", audience=None, client_id="other-client")
    with pytest.raises(InvalidAudienceError):
        verify_jwt(token, _jwks(key), issuer=ISSUER, client_id=AUDIENCE, token_use="access")


def test_token_use_mismatch_rejected():
    key = _gen_key()
    # aud는 맞지만 token_use가 access — ID 토큰을 기대한 자리라 거부.
    token = _sign(key, token_use="access", audience=AUDIENCE)
    with pytest.raises(InvalidTokenUseError):
        verify_jwt(token, _jwks(key), issuer=ISSUER, client_id=AUDIENCE, token_use="id")


def test_token_signed_by_other_key_rejected():
    signer, attacker_jwks = _gen_key(), _jwks(_gen_key())
    token = _sign(signer)  # 신뢰 키로 서명했지만 JWKS는 다른 키 → 서명 불일치.
    with pytest.raises(InvalidSignatureError):
        verify_jwt(token, attacker_jwks, issuer=ISSUER, client_id=AUDIENCE)


def test_tampered_token_rejected():
    key = _gen_key()
    token = _sign(key)
    # payload 한 글자 훼손 → 서명 깨짐.
    head, payload, sig = token.split(".")
    tampered = f"{head}.{payload[:-2] + ('AB' if payload[-2:] != 'AB' else 'CD')}.{sig}"
    with pytest.raises(InvalidSignatureError):
        verify_jwt(tampered, _jwks(key), issuer=ISSUER, client_id=AUDIENCE)


def test_expired_token_rejected():
    key = _gen_key()
    token = _sign(key, expires_in=timedelta(minutes=-5))  # 이미 만료.
    with pytest.raises(TokenExpiredError):
        verify_jwt(token, _jwks(key), issuer=ISSUER, client_id=AUDIENCE)


def test_wrong_issuer_rejected():
    key = _gen_key()
    token = _sign(key, issuer="https://evil.example.com/pool")
    with pytest.raises(InvalidIssuerError):
        verify_jwt(token, _jwks(key), issuer=ISSUER, client_id=AUDIENCE)


def test_wrong_audience_rejected():
    key = _gen_key()
    token = _sign(key, audience="some-other-client")
    with pytest.raises(InvalidAudienceError):
        verify_jwt(token, _jwks(key), issuer=ISSUER, client_id=AUDIENCE)


def test_unknown_kid_rejected():
    key = _gen_key()
    token = _sign(key, kid="rotated-away")
    # JWKS는 KID만 들고 있음 → 토큰 kid 매칭 실패.
    with pytest.raises(SigningKeyNotFoundError):
        verify_jwt(token, _jwks(key, kid=KID), issuer=ISSUER, client_id=AUDIENCE)


def test_garbage_token_rejected_as_malformed():
    key = _gen_key()
    with pytest.raises(MalformedTokenError):
        verify_jwt("not.a.jwt", _jwks(key), issuer=ISSUER, client_id=AUDIENCE)


@pytest.mark.parametrize("bad_jwks", [{"keys": []}, {}, {"keys": [{"kty": "RSA"}]}])
def test_empty_or_malformed_jwks_raises_controlled_error(bad_jwks):
    # 빈/깨진 JWKS는 원시 PyJWT 예외가 아니라 검증자 경계 안 에러로 환산돼야 한다.
    key = _gen_key()
    token = _sign(key)
    with pytest.raises(MalformedJwksError) as exc:
        verify_jwt(token, bad_jwks, issuer=ISSUER, client_id=AUDIENCE)
    # 호출자가 JwtVerificationError 하나로 인증 거부를 처리할 수 있어야 한다(500 누수 방지).
    assert isinstance(exc.value, JwtVerificationError)
