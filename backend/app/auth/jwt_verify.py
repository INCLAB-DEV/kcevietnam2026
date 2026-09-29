"""jwt-verify — Cognito 발급 JWT의 JWKS/RS256 검증(ADR-0008, F-AU-001 경계 B / AC4).

**FastAPI가 Cognito를 소유한다.** Next.js는 Cognito·JWKS에 직접 붙지 않고, 토큰 검증도
FastAPI 한 곳에 집중한다. Cognito가 RS256으로 서명한 토큰을 받아 **유저풀의 JWKS 공개키로
서명·클레임을 검증**한다(NABI가 직접 서명하지 않는다 — 검증자 역할).

검증 규칙:
- 헤더의 ``kid``로 JWKS에서 공개키를 찾는다(없으면 거부).
- **RS256 서명**을 그 공개키로 검증한다(위조·다른 키 서명 거부).
- ``exp`` 만료, ``iss``(유저풀 issuer), ``token_use``를 대조한다.
- **토큰 종류(id/access)를 명시로 받아** 종류별 클레임을 검증한다 — Cognito ID 토큰은
  앱 클라이언트 ID가 ``aud``에, **access 토큰은 ``client_id``에** 담긴다(access엔 ``aud``가
  없다). 종류를 고정하지 않으면 access 토큰이 ``aud`` 부재로 오탐 거부되거나, 엉뚱한 종류의
  토큰을 받아들이게 된다.

JWKS 자체를 **네트워크에서 가져오고 캐시**하는 일(Cognito ``.well-known/jwks.json``)은 이
모듈 밖 어댑터 소관이다 — 여기서는 JWKS를 **입력으로 받아** 순수 검증만 한다. 유저풀 ID·키
회전 정책은 인프라 결정(HITL)이라 이 모듈에 박지 않는다.

PyJWT([crypto])는 이 한 모듈에만 가둔다 — RS256/JWKS 세부가 호출자로 새지 않도록 얇게 감싼다.
"""

from __future__ import annotations

from typing import Any, Literal

import jwt
from jwt import PyJWKSet

# 검증할 토큰 종류 — Cognito가 발급하는 두 종류. 종류별 클레임 규칙이 다르다.
TokenUse = Literal["id", "access"]


class JwtVerificationError(Exception):
    """JWT 검증 실패의 베이스 — 호출자는 이 타입으로 일괄 거부 처리할 수 있다."""


class SigningKeyNotFoundError(JwtVerificationError):
    """토큰 헤더의 kid에 해당하는 공개키가 JWKS에 없음(키 회전 미반영 등)."""


class TokenExpiredError(JwtVerificationError):
    """``exp`` 만료 — 세션 토큰 수명 초과."""


class InvalidSignatureError(JwtVerificationError):
    """서명 불일치 — 위조되었거나 다른 키로 서명됨."""


class InvalidIssuerError(JwtVerificationError):
    """``iss`` 불일치 — 기대한 Cognito 유저풀이 발급한 토큰이 아님."""


class InvalidAudienceError(JwtVerificationError):
    """``aud``/``client_id`` 불일치 — 기대한 앱 클라이언트용 토큰이 아님."""


class InvalidTokenUseError(JwtVerificationError):
    """``token_use`` 불일치 — ID 토큰을 기대한 자리에 access 토큰(또는 그 반대)."""


class MalformedTokenError(JwtVerificationError):
    """토큰 구조·알고리즘이 잘못됨(RS256 아님, 헤더 손상 등)."""


class MalformedJwksError(JwtVerificationError):
    """JWKS가 비었거나 깨짐 — 검증할 키가 없다(캐시/회전 장애, 잘못된 응답 등).

    토큰이 아니라 **검증자 측 입력(JWKS)** 의 문제지만, 호출자가 ``JwtVerificationError``
    하나로 인증 거부를 처리할 수 있도록 같은 경계 안에서 던진다(원시 PyJWT 예외 누수 방지).
    """


def verify_jwt(
    token: str,
    jwks: dict[str, Any],
    *,
    issuer: str,
    client_id: str,
    token_use: TokenUse = "id",
    leeway: float = 0,
) -> dict[str, Any]:
    """Cognito JWT를 JWKS/RS256으로 검증하고 클레임을 돌려준다.

    토큰 종류(``token_use``)를 명시로 받아 종류별 클레임을 검증한다:
    - ``"id"``  — 앱 클라이언트 ID가 ``aud`` 클레임에 담긴다(PyJWT가 직접 대조).
    - ``"access"`` — Cognito access 토큰엔 ``aud``가 없고 ``client_id`` 클레임에 담긴다
      → ``aud`` 검증을 끄고 ``client_id``를 직접 대조한다.
    두 경우 모두 ``token_use`` 클레임이 기대값과 일치하는지 확인한다(종류 혼동 차단).

    Args:
        token: 검증할 JWT(Cognito 발급).
        jwks: 유저풀 JWKS(``{"keys": [...]}`` 형태) — 어댑터가 가져와 넘긴다.
        issuer: 기대 issuer(예: ``https://cognito-idp.{region}.amazonaws.com/{poolId}``).
        client_id: 기대 앱 클라이언트 ID(ID 토큰은 ``aud``, access 토큰은 ``client_id``로 대조).
        token_use: 기대 토큰 종류(``"id"`` 기본 / ``"access"``).
        leeway: 시계 오차 허용(초).

    Returns:
        검증된 클레임 dict.

    Raises:
        MalformedJwksError: JWKS가 비었거나 깨져 검증할 키가 없을 때.
        SigningKeyNotFoundError: kid에 맞는 공개키가 JWKS에 없을 때.
        TokenExpiredError: 토큰이 만료됐을 때.
        InvalidSignatureError: 서명이 위조/불일치일 때.
        InvalidIssuerError / InvalidAudienceError: iss/aud(또는 client_id) 클레임 불일치.
        InvalidTokenUseError: token_use가 기대 종류와 다를 때.
        MalformedTokenError: 토큰 구조·알고리즘이 잘못됐을 때.
    """
    try:
        signing_key = _select_key(token, jwks)
    except jwt.InvalidTokenError as exc:  # 헤더 파싱 실패 등
        raise MalformedTokenError(str(exc)) from exc

    # ID 토큰은 aud로, access 토큰은 client_id 클레임으로 앱 클라이언트를 식별한다.
    if token_use == "id":
        required = ["exp", "iss", "aud", "token_use"]
        decode_kwargs: dict[str, Any] = {"audience": client_id}
        options = {"require": required}
    else:
        required = ["exp", "iss", "client_id", "token_use"]
        decode_kwargs = {}
        options = {"require": required, "verify_aud": False}

    try:
        claims = jwt.decode(
            token,
            key=signing_key,
            algorithms=["RS256"],  # Cognito는 RS256만 — 알고리즘 혼동(none/HS) 차단.
            issuer=issuer,
            leeway=leeway,
            options=options,
            **decode_kwargs,
        )
    except jwt.ExpiredSignatureError as exc:
        raise TokenExpiredError(str(exc)) from exc
    except jwt.InvalidIssuerError as exc:
        raise InvalidIssuerError(str(exc)) from exc
    except jwt.InvalidAudienceError as exc:
        raise InvalidAudienceError(str(exc)) from exc
    except jwt.InvalidSignatureError as exc:
        raise InvalidSignatureError(str(exc)) from exc
    except jwt.InvalidAlgorithmError as exc:
        raise MalformedTokenError(str(exc)) from exc
    except jwt.InvalidTokenError as exc:  # 그 외 구조·클레임 오류
        raise MalformedTokenError(str(exc)) from exc

    # 토큰 종류 일치 확인 — ID 토큰을 access 자리에(또는 그 반대) 쓰는 혼동을 막는다.
    if claims.get("token_use") != token_use:
        raise InvalidTokenUseError(
            f"token_use={claims.get('token_use')!r} — 기대 {token_use!r}와 다르다"
        )

    # access 토큰은 aud가 없으므로 client_id 클레임을 직접 대조한다.
    if token_use == "access" and claims.get("client_id") != client_id:
        raise InvalidAudienceError(
            f"client_id={claims.get('client_id')!r} — 기대 {client_id!r}와 다르다"
        )

    return claims


def _select_key(token: str, jwks: dict[str, Any]) -> Any:
    """토큰 헤더의 kid로 JWKS에서 서명 검증용 공개키를 고른다.

    Raises:
        MalformedJwksError: JWKS가 비었거나 깨져 키 집합을 만들 수 없을 때.
        SigningKeyNotFoundError: kid에 맞는 키가 JWKS에 없을 때.
    """
    header = jwt.get_unverified_header(token)
    kid = header.get("kid")
    try:
        # 빈/깨진 JWKS는 PyJWKSetError(InvalidTokenError 아님)를 던진다 → 경계 안으로 환산.
        key_set = PyJWKSet.from_dict(jwks)
    except jwt.PyJWTError as exc:
        raise MalformedJwksError(f"JWKS를 해석할 수 없다: {exc}") from exc
    for key in key_set.keys:
        if key.key_id == kid:
            return key.key
    raise SigningKeyNotFoundError(f"JWKS에 kid={kid!r} 공개키가 없다")
