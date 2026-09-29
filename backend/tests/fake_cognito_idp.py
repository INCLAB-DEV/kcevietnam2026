"""fake-cognito-idp — boto3 ``cognito-idp`` 클라이언트를 흉내내는 인메모리 테스트 더블.

``AwsCognitoUserPool(client=FakeCognitoIdp(...))``로 주입해 실 AWS 없이 admin API 계약(멱등 발급,
UsernameExistsException 레이스 처리)을 검증한다. ``admin_initiate_auth``가 발급하는 토큰은
``test_jwt_verify.py``와 같은 방식으로 RSA 키쌍을 실제 RS256 서명해, 검증자(``verify_session_token``/
``verify_jwt``)까지 이어붙는 계약을 코드 몇 줄로 닫는다 — 진짜 Cognito를 흉내낸 서명된 JWT다.

예외 시뮬레이션 훅(``force_error``): ``AwsCognitoUserPool``의 boto3 예외 처리(throttling·
NotAuthorized·InvalidPassword·기타 ``ClientError``/``BotoCoreError``)를 실 AWS 없이 검증하기 위해,
다음 호출에서 지정한 예외를 강제로 던지게 하는 훅을 둔다. "기타 ClientError/BotoCoreError" 경로는
이 더블도 실제 ``botocore.exceptions.ClientError``/``BotoCoreError`` 인스턴스를 그대로 던져(가짜
서브클래스가 아니라 진짜 타입) ``AwsCognitoUserPool``이 실 클라이언트와 동일한 ``isinstance`` 분기로
잡게 한다.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

import jwt
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa


class UserNotFoundException(Exception):
    """boto3의 ``cognito-idp.Client.exceptions.UserNotFoundException`` 흉내."""


class UsernameExistsException(Exception):
    """boto3의 ``cognito-idp.Client.exceptions.UsernameExistsException`` 흉내."""


class NotAuthorizedException(Exception):
    """boto3의 ``cognito-idp.Client.exceptions.NotAuthorizedException`` 흉내(비번 불일치 등)."""


class TooManyRequestsException(Exception):
    """boto3의 ``cognito-idp.Client.exceptions.TooManyRequestsException`` 흉내(throttling)."""


class InvalidPasswordException(Exception):
    """boto3의 ``cognito-idp.Client.exceptions.InvalidPasswordException`` 흉내(비번 정책 위반)."""


class _Exceptions:
    UserNotFoundException = UserNotFoundException
    UsernameExistsException = UsernameExistsException
    NotAuthorizedException = NotAuthorizedException
    TooManyRequestsException = TooManyRequestsException
    InvalidPasswordException = InvalidPasswordException


def jwks_for(signing_key: rsa.RSAPrivateKey, *, kid: str) -> dict[str, Any]:
    """RSA 공개키 → Cognito 형태의 JWKS(``{"keys": [...]}``). ``test_jwt_verify.py``와 동일 패턴."""
    jwk = jwt.algorithms.RSAAlgorithm.to_jwk(signing_key.public_key(), as_dict=True)
    jwk.update({"kid": kid, "alg": "RS256", "use": "sig"})
    return {"keys": [jwk]}


class FakeCognitoIdp:
    """boto3 ``cognito-idp`` 클라이언트 더블 — ``AwsCognitoUserPool``이 쓰는 표면만 흉내낸다.

    ``admin_get_user`` / ``admin_create_user`` / ``admin_set_user_password`` / ``admin_initiate_auth``.
    발급 토큰은 ``issuer``/``client_id``/``signing_key``로 실제 RS256 서명한다 — ``jwks_for()``로
    만든 JWKS를 ``CognitoJwks(static_override=...)``에 물리면 검증까지 실 계약을 닫을 수 있다.
    """

    exceptions = _Exceptions()

    def __init__(
        self,
        *,
        issuer: str,
        client_id: str,
        signing_key: rsa.RSAPrivateKey,
        kid: str = "test-kid",
    ) -> None:
        self._issuer = issuer
        self._client_id = client_id
        self._signing_key = signing_key
        self._kid = kid
        # username -> {"sub": ..., "password": ... | None}
        self._users: dict[str, dict[str, Any]] = {}
        # method 이름 -> 다음 호출 시(1회) 던질 예외. force_error()로 채운다(테스트 시뮬레이션 훅).
        self._force_error: dict[str, Exception] = {}

    def force_error(self, method: str, exc: Exception) -> None:
        """다음 ``method`` 호출에서(1회만) ``exc``를 강제로 던지게 한다.

        ``AwsCognitoUserPool``의 boto3 예외 처리 경로(throttling·NotAuthorized·InvalidPassword·
        기타 ``ClientError``/``BotoCoreError``)를 실 AWS 없이 검증하기 위한 훅이다. 소진되면(1회
        발동 후) 자동으로 정상 동작으로 되돌아간다.
        """
        self._force_error[method] = exc

    def _maybe_raise(self, method: str) -> None:
        exc = self._force_error.pop(method, None)
        if exc is not None:
            raise exc

    def jwks(self) -> dict[str, Any]:
        return jwks_for(self._signing_key, kid=self._kid)

    def admin_get_user(self, *, UserPoolId: str, Username: str) -> dict[str, Any]:
        self._maybe_raise("admin_get_user")
        user = self._users.get(Username)
        if user is None:
            raise UserNotFoundException(f"{Username} not found")
        return {"Username": Username, "UserAttributes": [{"Name": "sub", "Value": user["sub"]}]}

    def admin_create_user(
        self, *, UserPoolId: str, Username: str, MessageAction: str = "SUPPRESS"
    ) -> dict[str, Any]:
        self._maybe_raise("admin_create_user")
        if Username in self._users:
            raise UsernameExistsException(f"{Username} exists")
        sub = str(uuid.uuid4())
        self._users[Username] = {"sub": sub, "password": None}
        return {"User": {"Username": Username, "Attributes": [{"Name": "sub", "Value": sub}]}}

    def admin_set_user_password(
        self, *, UserPoolId: str, Username: str, Password: str, Permanent: bool
    ) -> dict[str, Any]:
        self._maybe_raise("admin_set_user_password")
        user = self._users.get(Username)
        if user is None:
            raise UserNotFoundException(f"{Username} not found")
        user["password"] = Password
        return {}

    def admin_initiate_auth(
        self,
        *,
        UserPoolId: str,
        ClientId: str,
        AuthFlow: str,
        AuthParameters: dict[str, str],
    ) -> dict[str, Any]:
        self._maybe_raise("admin_initiate_auth")
        username = AuthParameters["USERNAME"]
        password = AuthParameters.get("PASSWORD")
        user = self._users.get(username)
        if user is None or user.get("password") != password:
            raise NotAuthorizedException("Incorrect username or password")

        id_token = self._sign(username=username, sub=user["sub"], token_use="id")
        access_token = self._sign(
            username=username, sub=user["sub"], token_use="access", client_id=ClientId
        )
        return {
            "AuthenticationResult": {
                "IdToken": id_token,
                "AccessToken": access_token,
                "RefreshToken": f"refresh-{username}",
            }
        }

    def _sign(
        self, *, username: str, sub: str, token_use: str, client_id: str | None = None
    ) -> str:
        now = datetime.now(timezone.utc)
        claims: dict[str, Any] = {
            "sub": sub,
            "cognito:username": username,
            "iss": self._issuer,
            "token_use": token_use,
            "iat": now,
            "exp": now + timedelta(hours=1),
        }
        if token_use == "id":
            claims["aud"] = self._client_id
        else:
            claims["client_id"] = client_id or self._client_id
        pem = self._signing_key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.PKCS8,
            encryption_algorithm=serialization.NoEncryption(),
        )
        return jwt.encode(claims, pem, algorithm="RS256", headers={"kid": self._kid})
