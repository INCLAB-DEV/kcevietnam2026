"""cognito-pool — 실 Amazon Cognito 유저풀 어댑터(ADR-0007/0008, F-AU-001 1단계 — 로컬 구현).

Cognito를 "외부에서 이미 신원확인된 사용자(DX Korea 검증 통과)에게 실 JWT를 발급하는 토큰 민터"로
쓴다. ``admin_create_user``(``MessageAction=SUPPRESS`` — 이메일 미발송, 멤버 미러) +
``admin_set_user_password``(``Permanent=True``, 서버 시크릿에서 HMAC 파생한 무상태 비밀번호) +
``admin_initiate_auth``(``ADMIN_USER_PASSWORD_AUTH``)로 실 세션 토큰(ID/access/refresh)을 발급한다.
비밀번호는 저장하지 않고 매번 같은 값으로 재현하므로(파생 함수가 무상태) 별도 컬럼이 필요 없다.
앱 클라이언트의 ``ExplicitAuthFlows``가 ``ADMIN_USER_PASSWORD_AUTH``만 확정돼(AWS 실측) Lambda
CUSTOM_AUTH 대안은 구현하지 않는다.

sub↔member 매핑: 컬럼 신설 없이 ``admin_create_user(Username=member_id)``로 계정을 만들어 ID 토큰의
``cognito:username`` == member_id로 회원ID를 그대로 복원한다(``resolve_member_key``). DB 마이그레이션
불필요.

⚠ 실 유저풀의 username 구성(아이디 기반 vs email alias)은 **미확인**이다 — 이 어댑터는 member_id를
Username으로 직접 쓰는 것으로 가정한다(로컬 구현 범위의 리스크로 남겨둔다). 실 유저풀이 email-alias
전용이라 ``admin_create_user``가 거부하면(예: ``InvalidParameterException``), member_id를 합성
이메일(예: ``{member_id}@members.nabi.local``)로 우회하는 fallback이 필요할 수 있다 — 실AWS 없이는
확정할 수 없어 구현하지 않았다. 실 통합테스트(게이트됨)의 preflight가 이 가정을 미리 검증한다.

앱 클라이언트는 secret 없음(null)으로 확인됐다 — ``SECRET_HASH``는 기본 생략한다. ``app_client_secret``
이 주어졌을 때만 계산하도록 방어적으로 남겨둔다(미래 클라이언트 교체 대비).
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import logging
from typing import Any

from botocore.exceptions import BotoCoreError, ClientError

from app.auth.jwks_cache import CognitoJwks
from app.auth.jwt_verify import JwtVerificationError, SigningKeyNotFoundError, verify_jwt
from app.auth.session_issue import CognitoAccount, SessionTokens

logger = logging.getLogger(__name__)


class CognitoPoolError(Exception):
    """``AwsCognitoUserPool``이 boto3 예외를 서비스 전용 예외로 래핑할 때 쓰는 베이스.

    항상 ``raise ... from exc``로 원인(boto3 ``ClientError``/``BotoCoreError``)을 보존한다 —
    로그·트레이스백에서 원인까지 추적 가능하다. 호출부는 의미 불명확한 500 대신 이 타입(또는
    서브타입)으로 "무엇이 왜 실패했는지" 구분 가능한 실패를 받는다.
    """


class CognitoAuthError(CognitoPoolError):
    """Cognito가 인증을 명시적으로 거부했다(``NotAuthorizedException``) — 비번 불일치 등.

    ⚠ 정상 흐름에서는 나지 않아야 하는 경로다: ``issue_tokens``가 넘기는 비밀번호는
    ``get_or_create_account``가 ``admin_set_user_password``로 직접 심어둔 파생 비밀번호이므로
    같은 member_id면 항상 일치해야 한다. 그럼에도 나면 비번 로테이션 드리프트·유저풀 정책/자격증명
    변경 같은 방어적 신호다 — 500이 아니라 "로그인 거부"로 이어질 수 있는 인증 실패로 명시적으로
    구분한다.
    """


class CognitoThrottledError(CognitoPoolError):
    """Cognito admin API가 throttling(``TooManyRequestsException``)으로 일시 거부했다."""


class CognitoServiceError(CognitoPoolError):
    """throttling 이외의 boto3 ``ClientError``/``BotoCoreError`` — 네트워크·서비스 장애 등."""


class CognitoConfigurationError(CognitoPoolError):
    """파생 비밀번호가 유저풀 비밀번호 정책을 위반했다(``InvalidPasswordException``).

    ``_derived_password``는 Cognito 기본 비밀번호 정책(대/소문자·숫자·특수문자·8자 이상)을 항상
    충족하도록 고정 prefix를 붙여 만들어졌으므로, 정상 흐름에서 이 예외가 나면 그 자체가 구현
    버그이거나(파생 로직 변경) 유저풀 정책이 더 엄격해졌다는 신호다.
    """


def resolve_member_key(claims: dict[str, Any]) -> str | None:
    """ID 토큰 클레임 → member_id.

    ``cognito:username``을 우선한다 — ``AwsCognitoUserPool``이 ``admin_create_user(Username=member_id)``
    로 계정을 만들어 이 클레임이 곧 member_id이기 때문이다(주 경로). ``sub``는 그 매핑이 없거나 깨진
    경우의 폴백이다(예: ``cognito:username`` 클레임을 담지 않는 토큰) — 데모/기존 JWT 테스트 호환용
    경로이기도 하다. 이 폴백으로 넘어가도 안전하다: ``sub``가 실제 member_id와 다르면 이후
    ``members.id`` 조회가 miss돼 401로 fail-closed되지, 엉뚱한 회원으로 잘못 통과하지 않는다.
    """
    return claims.get("cognito:username") or claims.get("sub")


def verify_session_token(
    token: str,
    provider: CognitoJwks,
    *,
    issuer: str,
    client_id: str,
) -> dict[str, Any]:
    """세션(ID) 토큰을 JWKS로 검증한다 — 로그인은 항상 ID 토큰을 세션으로 내보내므로 token_use 고정.

    kid-miss(``SigningKeyNotFoundError`` — 키 회전 직후 캐시가 옛 키만 들고 있을 때)는 캐시를 강제
    재fetch해 1회만 재시도한다. 그래도 실패하면 그대로 던진다(무한 재시도 금지).
    """
    jwks = provider.keys()
    try:
        return verify_jwt(token, jwks, issuer=issuer, client_id=client_id, token_use="id")
    except SigningKeyNotFoundError:
        jwks = provider.keys(force_refresh=True)
        return verify_jwt(token, jwks, issuer=issuer, client_id=client_id, token_use="id")


class CognitoSessionAuthenticator:
    """``organizer_guard.SessionAuthenticator`` 구현 — Cognito ID 토큰(JWKS/RS256)으로 회원ID를 도출한다.

    로그인이 세션 토큰으로 ID 토큰을 내보내므로(``login_router._session_token``) 여기서도 ID 토큰
    검증 경로(``verify_session_token``)를 그대로 쓴다. 실패는 전부 ``UnauthenticatedError``로 통일해
    ``organizer_guard.require_event_master``가 401로 닫을 수 있게 한다.
    """

    def __init__(self, *, provider: CognitoJwks, issuer: str | None, client_id: str | None) -> None:
        self._provider = provider
        self._issuer = issuer
        self._client_id = client_id

    def identify(self, authorization: str | None) -> str:
        # 지연 import — organizer_guard가 이 모듈을(get_authenticator에서) 지연 import하므로,
        # 모듈 최상단에서 맞물아 임포트하면 순환 임포트가 난다.
        from app.auth.organizer_guard import UnauthenticatedError

        if not authorization:
            raise UnauthenticatedError("Authorization 헤더가 없다")
        scheme, _, token = authorization.partition(" ")
        token = token.strip()
        if scheme.lower() != "bearer" or not token:
            raise UnauthenticatedError("Bearer 토큰 형식이 아니다")

        try:
            claims = verify_session_token(
                token, self._provider, issuer=self._issuer, client_id=self._client_id
            )
        except JwtVerificationError as exc:
            raise UnauthenticatedError(f"유효하지 않은 토큰: {exc}") from exc

        member_id = resolve_member_key(claims)
        if not member_id:
            raise UnauthenticatedError("클레임에서 회원ID를 찾을 수 없다")
        return member_id


class AwsCognitoUserPool:
    """``session_issue.CognitoUserPool`` 프로토콜 구현 — boto3 ``cognito-idp`` admin API.

    ``client``를 주지 않으면(운영 경로) ``boto3.client("cognito-idp", region_name=region)``을 지연
    import해 만든다(``app/services/storage.py``의 S3Storage 관례와 동일). 테스트는 ``client=FakeCognitoIdp(...)``
    로 boto3 없이 주입한다.
    """

    def __init__(
        self,
        *,
        user_pool_id: str,
        app_client_id: str,
        region: str,
        password_secret: str,
        app_client_secret: str | None = None,
        client: Any = None,
        email_resolver: Any = None,
    ) -> None:
        if client is None:
            import boto3  # 지연 import — boto3는 실 어댑터에서만 필요하다.

            client = boto3.client("cognito-idp", region_name=region)
        self._client = client
        self._user_pool_id = user_pool_id
        self._app_client_id = app_client_id
        self._password_secret = password_secret
        self._app_client_secret = app_client_secret
        # 미래 대비 — 실 유저풀이 email-alias 전용으로 밝혀지면 member_id→합성 이메일 변환에 쓴다.
        # 현재는 username=member_id 가정이라 미사용(위 모듈 docstring의 리스크 참고).
        self._email_resolver = email_resolver

    def find_account(self, member_id: str) -> CognitoAccount | None:
        try:
            resp = self._client.admin_get_user(UserPoolId=self._user_pool_id, Username=member_id)
        except self._client.exceptions.UserNotFoundException:
            return None
        except Exception as exc:  # noqa: BLE001 - _wrap_boto_error가 대상 예외만 골라 재던진다
            # 네트워크/throttle 등 그 외 실패는 삼키지 말고(None 반환 금지) 래핑해 전파한다.
            # get_or_create_account가 UsernameExistsException 흡수 경로에서 이 메서드를 다시 부를
            # 때도 여기서 래핑되므로, 그 경로에서 다른 예외가 나도 그대로 500이 아니라 이 타입이 된다.
            raise self._wrap_boto_error(exc, action="admin_get_user") from exc
        sub = _sub_from_attributes(resp.get("UserAttributes", []))
        return CognitoAccount(cognito_sub=sub or member_id, member_id=member_id)

    def get_or_create_account(self, member_id: str) -> tuple[CognitoAccount, bool]:
        try:
            resp = self._client.admin_create_user(
                UserPoolId=self._user_pool_id,
                Username=member_id,
                MessageAction="SUPPRESS",
            )
        except self._client.exceptions.UsernameExistsException:
            # 동시 첫로그인 레이스의 진 쪽 — 이긴 쪽이 이미 만든 계정을 조회해 기존 계정 취급한다.
            # find_account가 그 외 예외(throttle 등)를 던지면 여기서 래핑된 채로 그대로 전파된다.
            existing = self.find_account(member_id)
            if existing is None:  # pragma: no cover - 생성 직후 조회 실패라는 극단적 레이스
                raise
            return existing, False
        except Exception as exc:  # noqa: BLE001 - _wrap_boto_error가 대상 예외만 골라 재던진다
            # admin_create_user는 Password를 넘기지 않아 InvalidPasswordException은 여기서 나지
            # 않는다(그 경로는 아래 admin_set_user_password) — throttle/기타 ClientError만 해당.
            raise self._wrap_boto_error(exc, action="admin_create_user") from exc

        try:
            self._client.admin_set_user_password(
                UserPoolId=self._user_pool_id,
                Username=member_id,
                Password=self._derived_password(member_id),
                Permanent=True,
            )
        except self._client.exceptions.InvalidPasswordException as exc:
            # 파생 비번이 유저풀 비밀번호 정책을 위반 — 정상 흐름에선 안 나야 하는 구현 버그 신호.
            logger.exception(
                "Cognito admin_set_user_password: 파생 비밀번호가 정책 위반 — member_id=%s",
                member_id,
            )
            raise CognitoConfigurationError(
                f"파생 비밀번호가 유저풀 비밀번호 정책 위반: member_id={member_id!r}"
            ) from exc
        except Exception as exc:  # noqa: BLE001 - _wrap_boto_error가 대상 예외만 골라 재던진다
            raise self._wrap_boto_error(exc, action="admin_set_user_password") from exc

        sub = _sub_from_attributes(resp.get("User", {}).get("Attributes", []))
        return CognitoAccount(cognito_sub=sub or member_id, member_id=member_id), True

    def issue_tokens(self, account: CognitoAccount) -> SessionTokens:
        auth_params: dict[str, str] = {
            "USERNAME": account.member_id,
            "PASSWORD": self._derived_password(account.member_id),
        }
        secret_hash = self._secret_hash(account.member_id)
        if secret_hash is not None:
            auth_params["SECRET_HASH"] = secret_hash

        try:
            resp = self._client.admin_initiate_auth(
                UserPoolId=self._user_pool_id,
                ClientId=self._app_client_id,
                AuthFlow="ADMIN_USER_PASSWORD_AUTH",
                AuthParameters=auth_params,
            )
        except self._client.exceptions.NotAuthorizedException as exc:
            # ⚠ 정상 흐름에선 안 나는 경로 — 위 PASSWORD는 get_or_create_account가
            # admin_set_user_password로 직접 심어둔 파생 비밀번호라 같은 member_id면 항상 일치해야
            # 한다. 그래도 나면 비번 로테이션 드리프트 등의 방어적 신호이므로, 500이 아니라 "로그인
            # 거부"로 이어질 수 있는 명시적 인증 실패로 구분해 던진다.
            logger.warning(
                "Cognito admin_initiate_auth 인증 거부(NotAuthorized) — member_id=%s",
                account.member_id,
            )
            raise CognitoAuthError(
                f"Cognito 인증 거부(NotAuthorized): member_id={account.member_id!r}"
            ) from exc
        except Exception as exc:  # noqa: BLE001 - _wrap_boto_error가 대상 예외만 골라 재던진다
            raise self._wrap_boto_error(exc, action="admin_initiate_auth") from exc

        result = resp["AuthenticationResult"]
        return SessionTokens(
            id_token=result["IdToken"],
            access_token=result["AccessToken"],
            refresh_token=result.get("RefreshToken"),
        )

    def _wrap_boto_error(self, exc: Exception, *, action: str) -> CognitoPoolError:
        """throttling·기타 ``ClientError``/``BotoCoreError``를 로깅 후 서비스 전용 예외로 래핑한다.

        호출부가 이미 처리한 특정 예외(``UserNotFoundException``/``UsernameExistsException``/
        ``NotAuthorizedException``/``InvalidPasswordException``)는 각자의 ``except`` 절에서
        먼저 걸러지므로 여기까지 오지 않는다 — 이 헬퍼는 그 나머지(throttle·네트워크·그 외
        서비스 에러)만 받는다. 반환값을 ``raise ... from exc``로 던지는 건 호출부 책임이다(원인
        보존).
        """
        if isinstance(exc, self._client.exceptions.TooManyRequestsException):
            logger.warning("Cognito %s throttled(TooManyRequests)", action)
            return CognitoThrottledError(f"Cognito {action} throttled")
        if isinstance(exc, (ClientError, BotoCoreError)):
            logger.exception("Cognito %s 실패(boto3)", action)
            return CognitoServiceError(f"Cognito {action} 실패: {exc}")
        # boto3/botocore가 아닌 예외(버그 등)는 서비스 예외로 감싸지 않고 그대로 다시 던진다 —
        # 호출부가 `raise self._wrap_boto_error(...) from exc`로 감싸므로 원본 타입을 보존한다.
        raise exc

    def _derived_password(self, member_id: str) -> str:
        """서버 시크릿에서 HMAC 파생 — 별도 저장 없이 무상태로 재현 가능한 고정 비밀번호.

        Cognito 기본 비밀번호 정책(대/소문자·숫자·특수문자 포함, 8자 이상)을 항상 충족하도록 고정
        prefix(``Nx1!`` — 대문자·소문자·숫자·특수문자 포함)를 앞에 붙이고, 뒤에
        HMAC-SHA256(password_secret, member_id) 다이제스트를 URL-safe base64(패딩 제거)로 붙인다.
        같은 member_id는 항상 같은 비밀번호(멱등 재로그인), 다른 member_id는 전혀 다른 값이다.

        ⚠ 이 비밀번호는 서버가 Cognito admin 흐름(``admin_set_user_password``/
        ``admin_initiate_auth``) 내부용으로만 쓴다 — 사용자가 직접 입력하거나 알 필요가 없고
        FE로 노출되지 않는다. 앱클라이언트가 ``USER_PASSWORD_AUTH``를 허용하지 않고
        ``ADMIN_USER_PASSWORD_AUTH``(admin 전용, IAM 자격증명 필요)만 지원하므로,
        ``password_secret``(→ 이 파생값) 단독이 유출돼도 그것만으로 로그인할 수 없다 —
        별도로 AWS admin 자격증명(IAM)까지 있어야 한다(blast radius 제한). 실배포는 Secrets
        Manager로 ``password_secret``을 보관한다(2단계).

        ⚠ 로테이션 주의: ``password_secret``을 교체하면 이 함수의 출력이 통째로 바뀌어, **이미
        Cognito에 생성된 기존 계정들의 저장된 비밀번호와 불일치**하게 된다(``admin_set_user_password``
        는 계정 생성 시 1회만 호출됨). 로테이션 시엔 기존 계정들에 대해 새 시크릿으로 파생한 비밀번호를
        ``admin_set_user_password``로 재동기화하는 운영 절차가 필요하다(운영 노트 — 이 로직 자체는
        무상태 재현만 보장하고 재동기화는 별도 배치/스크립트 몫).
        """
        digest = hmac.new(
            self._password_secret.encode("utf-8"), member_id.encode("utf-8"), hashlib.sha256
        ).digest()
        body = base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")
        return f"Nx1!{body}"

    def _secret_hash(self, username: str) -> str | None:
        """앱 클라이언트 secret이 있을 때만 계산한다 — 실 클라이언트는 secret 없음(null)이 확인돼
        기본은 None(SECRET_HASH 생략). 미래 클라이언트 교체 대비로만 남겨둔다.
        """
        if not self._app_client_secret:
            return None
        digest = hmac.new(
            self._app_client_secret.encode("utf-8"),
            (username + self._app_client_id).encode("utf-8"),
            hashlib.sha256,
        ).digest()
        return base64.b64encode(digest).decode("ascii")


def _sub_from_attributes(attributes: list[dict[str, str]]) -> str | None:
    for attr in attributes:
        if attr.get("Name") == "sub":
            return attr.get("Value")
    return None
