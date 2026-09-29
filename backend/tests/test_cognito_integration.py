"""실 AWS Cognito 통합테스트 — 게이트됨(F-AU-001, 2단계 실행 준비 완료).

``RUN_COGNITO_IT=1`` 환경변수가 없으면 전부 skip된다 — 로컬/CI에서 실수로 실 AWS를 때리지
않는다. 실행하려면 다음이 필요하다:

- ``RUN_COGNITO_IT=1``
- ``COGNITO_USER_POOL_ID``, ``COGNITO_CLIENT_ID``, ``AWS_REGION=ap-northeast-2``,
  ``COGNITO_SESSION_PASSWORD_SECRET``(아무 문자열이나 — 파생 비밀번호 시크릿), boto3 기본
  자격증명 체인(IAM 역할/``AWS_*`` env)으로 이 유저풀에 admin API를 부를 수 있는 권한.
  ⚠ ``COGNITO_USER_POOL_ID``는 손입력하지 말 것 — 마지막 문자가 숫자 ``0``인지 대문자 ``O``인지
  혼동되기 쉽다. 실행 시 ``boto3 list_user_pools``(``Name == "nabi-dev-users"``)로 실측해서
  env로 주입한다.

preflight(``describe_user_pool_client``)로 앱 클라이언트가 ``ALLOW_ADMIN_USER_PASSWORD_AUTH``를
지원하는지 먼저 확인한다 — AWS 실측으로 이미 확정됐지만(``ExplicitAuthFlows``), 유저풀이 바뀌거나
설정이 드리프트했을 때 엉뚱한 실패로 시간 낭비하지 않기 위한 안전장치다.

⚠ **username 구성 리스크(미확인)**: 이 통합테스트가 실 유저풀에서 최초로 검증해야 할 것 중 하나가
"``admin_create_user(Username=member_id)``가 실제로 먹히는가"다. 유저풀이 email-alias 전용이면
``InvalidParameterException`` 류로 거부될 수 있다 — 그 경우 로컬 구현 문서(``cognito_pool.py``
모듈 docstring)에 적어둔 fallback(합성 이메일 username)이 필요해진다. 실제 실행 전까지는 이
리스크가 확정되지 않는다.

⚠ 테스트 계정 정리: ``test_issue_session_against_real_user_pool``은 이제 ``finally`` 블록에서
``admin_delete_user``로 생성한 테스트 계정을 자동 정리한다(단 ``cognito-idp:AdminDeleteUser``
권한이 필요하다 — 권한이 없으면 정리 자체는 경고 로그만 남기고 조용히 실패한다). 그럼에도
preflight 테스트(``test_preflight_app_client_supports_admin_user_password_auth``)가 만드는 계정은
없다(``describe_user_pool_client``만 호출한다) — 정리 대상 자체가 없다.

⚠ 2단계 실행 시 확인할 것(TODO): ``admin_initiate_auth``가 ``AuthenticationResult``에
``IdToken``·``AccessToken``을 **둘 다** 담아 오는지는 이제 어써션으로 확인한다. 다만 여기서
발급된 ID 토큰으로 참가자 보호 라우트가 **실제로 통과**하는지(login → 세션 토큰 → 보호 라우트
200)까지의 왕복 검증은 실 RDS 도달 경로(bastion/배포)가 필요해 이번 범위 밖이다 — 테스트 함수
끝의 TODO 주석 참고.
"""

from __future__ import annotations

import os

import pytest

RUN_COGNITO_IT = os.environ.get("RUN_COGNITO_IT") == "1"

pytestmark = pytest.mark.skipif(
    not RUN_COGNITO_IT,
    reason="RUN_COGNITO_IT=1 없이는 실 AWS Cognito를 부르지 않는다(로컬/CI 오발동 방지)",
)


@pytest.fixture(scope="module")
def cognito_settings():
    """실 유저풀 접속 정보 — env에서 읽는다. 미설정이면 이 모듈의 모든 테스트를 skip한다."""
    from app.config import settings

    required = {
        "cognito_user_pool_id": settings.cognito_user_pool_id,
        "cognito_client_id": settings.cognito_client_id,
        "cognito_session_password_secret": settings.cognito_session_password_secret,
    }
    missing = [k for k, v in required.items() if not v]
    if missing:
        pytest.skip(f"실 Cognito 통합테스트 설정 누락: {missing}")
    return settings


@pytest.fixture(scope="module")
def boto3_client(cognito_settings):
    boto3 = pytest.importorskip("boto3")
    return boto3.client("cognito-idp", region_name=cognito_settings.aws_region or "ap-northeast-2")


def test_preflight_app_client_supports_admin_user_password_auth(cognito_settings, boto3_client):
    """AWS 실측으로 이미 확인된 사실(ADMIN_USER_PASSWORD_AUTH)을 매 실행 시 재확인한다 — 유저풀
    설정이 드리프트했으면 이후 테스트들이 엉뚱한 이유(SECRET_HASH 필요 등)로 실패하는 대신 여기서
    바로 알 수 있게 한다. 동시에 username 구성(아이디 기반 vs email alias) 힌트도 로그로 남긴다.
    """
    resp = boto3_client.describe_user_pool_client(
        UserPoolId=cognito_settings.cognito_user_pool_id,
        ClientId=cognito_settings.cognito_client_id,
    )
    client = resp["UserPoolClient"]
    assert "ALLOW_ADMIN_USER_PASSWORD_AUTH" in client.get("ExplicitAuthFlows", [])
    # secret 유무 확인 — 실측(secret 없음)과 다르면 app_client_secret 배선이 필요해졌다는 신호.
    assert "ClientSecret" not in client or not client["ClientSecret"]


def test_issue_session_against_real_user_pool(cognito_settings, boto3_client):
    """실 유저풀에 대해 get_or_create_account + issue_tokens 전체 왕복을 검증한다.

    이 테스트가 만드는 테스트 계정은 finally 블록에서 admin_delete_user로 자동 정리된다(모듈
    docstring 참고) — 공유 dev 유저풀(실 유저 6명 존재)에 계정이 영구히 남지 않도록 한다.
    """
    import logging
    import uuid

    from app.auth.cognito_pool import AwsCognitoUserPool, resolve_member_key, verify_session_token
    from app.auth.jwks_cache import CognitoJwks

    member_id = f"it-test-{uuid.uuid4().hex[:12]}"
    try:
        pool = AwsCognitoUserPool(
            user_pool_id=cognito_settings.cognito_user_pool_id,
            app_client_id=cognito_settings.cognito_client_id,
            region=cognito_settings.aws_region or "ap-northeast-2",
            password_secret=cognito_settings.cognito_session_password_secret,
            app_client_secret=cognito_settings.cognito_app_client_secret,
            client=boto3_client,
        )

        account, created = pool.get_or_create_account(member_id)
        assert created is True
        assert account.member_id == member_id

        tokens = pool.issue_tokens(account)
        assert tokens.id_token
        assert tokens.access_token

        issuer = f"https://cognito-idp.{cognito_settings.aws_region or 'ap-northeast-2'}.amazonaws.com/{cognito_settings.cognito_user_pool_id}"
        provider = CognitoJwks(issuer, ttl_seconds=cognito_settings.cognito_jwks_ttl_seconds)
        claims = verify_session_token(
            tokens.id_token, provider, issuer=issuer, client_id=cognito_settings.cognito_client_id
        )
        assert resolve_member_key(claims) == member_id

        # 재방문 — 새 계정이 또 생기지 않는다(멱등).
        again, created_again = pool.get_or_create_account(member_id)
        assert created_again is False
        assert again == account

        # TODO(2단계-후속): 발급 ID 토큰으로 보호 라우트 200 왕복 — 실 RDS 도달 경로(bastion/배포) 확보 후.
    finally:
        # ⚠ 정리 실패가 원래 테스트 실패 원인을 가리면 안 된다 — 이미 없는 계정(UserNotFoundException,
        # 예: get_or_create_account 자체가 실패한 경우)은 조용히 무시하고, 그 외 예외는 경고 로그만
        # 남기고 삼킨다. cognito-idp:AdminDeleteUser 권한이 필요하다.
        try:
            boto3_client.admin_delete_user(
                UserPoolId=cognito_settings.cognito_user_pool_id, Username=member_id
            )
        except boto3_client.exceptions.UserNotFoundException:
            pass
        except Exception:
            logging.getLogger(__name__).warning(
                "Cognito 테스트 계정 정리 실패(member_id=%s) — 수동 정리가 필요할 수 있음",
                member_id,
                exc_info=True,
            )
