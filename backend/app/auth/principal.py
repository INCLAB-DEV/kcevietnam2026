"""principal — 보호 라우트의 현재 주체(member/organization)를 Cognito JWT에서 도출(ADR-0008).

권한검사는 FastAPI 한 곳에 집중한다(ADR-0008). 신원은 **Cognito가 서명한 세션 JWT**에서
나온다 — Next.js는 토큰만 싣고, 검증·org 도출은 여기서 한다. RS256/JWKS 검증 세부는 deep
module ``jwt_verify``가 소유하고, 이 모듈은 그 위에 **DB 매핑(member → organization)** 과
**FastAPI 의존성/HTTP 거부(401)** 를 얇게 얹는다.

신원 키 규약: NABI는 ``member_id``를 Cognito·registrants에 걸쳐 동일 키로 잇는다
(session_issue 도큐 참고). 매핑 키는 ``cognito_pool.resolve_member_key``가 뽑는다 — **ID 토큰의
``cognito:username`` 클레임**을 우선 본다(``AwsCognitoUserPool``이 ``admin_create_user
(Username=member_id)``로 계정을 만들어 이 클레임이 곧 member_id다), 없으면 ``sub``로 폴백한다.
그 값으로 ``members`` 행을 못 찾으면(미지 주체) 401.

JWKS·issuer·client_id는 설정에서 주입한다(config). issuer/client_id가 미설정이면 **인증
미구성**이라 보호 라우트를 열지 않고 401로 닫는다(조용한 통과 금지). JWKS는 ``get_jwks_provider``
(``jwks_cache.CognitoJwks``)가 issuer의 ``.well-known/jwks.json``에서 동적으로 가져와 TTL 캐시한다
(키 회전 대응) — 오프라인 테스트/고정 JWKS는 ``cognito_jwks_json`` 정적 오버라이드로 그대로 쓴다.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from functools import lru_cache
from typing import Any
from uuid import UUID

from fastapi import Depends, Header, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth.cognito_pool import resolve_member_key, verify_session_token
from app.auth.jwks_cache import CognitoJwks
from app.auth.jwt_verify import JwtVerificationError
from app.auth.organizer_guard import StubSessionAuthenticator, UnauthenticatedError
from app.config import settings
from app.db import get_session
from app.models import Member, Registrant

#: 데모 토큰 해석기 — 운영자 가드가 쓰는 것과 **같은 객체 규약**을 재사용한다(토큰 형식 정규식을
#: 두 번 쓰지 않는다). 참가자 라우트와 운영자 라우트가 같은 데모 토큰을 이해해야 하므로 형식
#: 해석은 한 곳(organizer_guard)에만 있어야 한다.
_demo_authenticator = StubSessionAuthenticator()


@dataclass(frozen=True, slots=True)
class Principal:
    """인증된 요청 주체 — 검증된 회원과 그 소속 Organization.

    소유권 검사(본인/소속 org 자원만 접근)는 ``organization_id``로 한다. 자원의 소유 org가
    이 값과 다르면 403.
    """

    member_id: str
    organization_id: str


@lru_cache
def get_jwks_provider() -> CognitoJwks:
    """유저풀 JWKS 제공자(TTL 캐시) — 프로세스 단일 인스턴스로 캐시를 공유한다.

    ``organizer_guard.get_authenticator``의 ``CognitoSessionAuthenticator``도 이 인스턴스를 받아
    같은 캐시를 나눠 쓴다. 인스턴스 생성 자체는 네트워크를 타지 않는다(``CognitoJwks.keys()`` 호출
    시점까지 지연) — 예전 ``get_jwks()``가 미구성 시 즉시 401을 던져 데모 분기에 도달 못 하던 문제가
    구조적으로 사라진다. "인증 미구성" 401 판정은 ``get_current_principal`` 본문의 issuer/client_id
    명시 체크가 맡는다. 정적 오버라이드(``cognito_jwks_json``)가 있으면 그걸 그대로 쓴다(오프라인
    테스트/데모 고정 JWKS 경로 보존). 테스트는 override로 주입하거나 ``.cache_clear()``로 재구성한다.
    """
    return CognitoJwks(
        settings.cognito_issuer,
        ttl_seconds=settings.cognito_jwks_ttl_seconds,
        static_override=_static_jwks_override(),
    )


def _static_jwks_override() -> dict[str, Any] | None:
    """``cognito_jwks_json``(.well-known/jwks.json 본문)을 파싱한다. 미설정/깨짐이면 None(동적 fetch로)."""
    raw = settings.cognito_jwks_json
    if not raw:
        return None
    try:
        return json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return None


def _unauthorized(detail: str) -> HTTPException:
    # 401은 항상 같은 형태로 — 어떤 토큰 결함인지 외부에 흘리지 않는다(거부 사유 비노출).
    return HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=detail)


def get_current_principal(
    authorization: str | None = Header(default=None),
    jwks_provider: CognitoJwks = Depends(get_jwks_provider),
    db: Session = Depends(get_session),
) -> Principal:
    """``Authorization: Bearer <jwt>``를 검증해 현재 주체(member+org)를 도출한다.

    검증 실패(헤더 없음·형식 오류·서명/만료/iss/aud/token_use 불일치)는 모두 401로 닫는다.
    토큰은 유효하나 ``resolve_member_key``로 회원을 못 찾으면(미지 주체) 401. 성공 시 회원의 소속 org를
    실어 ``Principal``을 돌려준다 — 소유권 403 판정은 호출 라우트가 한다.

    ``AUTH_BACKEND=demo``면 **데모 토큰을 먼저** 해석하고, 데모 형식이 아니면 그대로 실 Cognito
    검증으로 흘려보낸다. 새 의존성을 만들지 않는 건 의도적이다 — 인증 진입점이 이미 세 개
    (participant/organizer/admin)라 네 번째를 더하면 "어느 가드가 이 라우트를 지키는가"가
    라우트마다 달라진다. 폴백 구조 덕에 데모 모드에서도 실 JWT 경로 테스트가 그대로 돈다.

    기본값(cognito)에서는 이 분기가 아예 없다 — 서명검증 없는 스텁이 prod로 새지 않는다.
    """
    if settings.auth_backend == "demo":
        demo = _demo_principal(authorization, db)
        if demo is not None:
            return demo

    if settings.cognito_issuer is None or settings.cognito_client_id is None:
        # 인증 미구성 — 보호 라우트를 열지 않는다(조용한 통과 금지).
        raise _unauthorized("인증 미구성")

    token = _bearer_token(authorization)
    try:
        claims = verify_session_token(
            token,
            jwks_provider,
            issuer=settings.cognito_issuer,
            client_id=settings.cognito_client_id,
        )
    except JwtVerificationError as exc:
        raise _unauthorized("유효하지 않은 토큰") from exc

    member_id = resolve_member_key(claims)
    if not member_id:
        raise _unauthorized("유효하지 않은 토큰")

    org_id = db.execute(
        select(Member.organization_id).where(Member.id == member_id)
    ).scalar_one_or_none()
    if org_id is None:
        # 서명은 유효하나 명단에 없는 주체 — 자원 접근의 닻이 없으므로 거부.
        raise _unauthorized("알 수 없는 주체")

    return Principal(member_id=str(member_id), organization_id=str(org_id))


def _demo_principal(authorization: str | None, db: Session) -> Principal | None:
    """데모 토큰(``access-{subject}-{seq}``) → Principal. 데모 형식이 아니면 None(폴백).

    데모 로그인이 내는 subject는 두 종류다:

    - **UUID** — 자체 회원가입(§7.3)으로 만들어진 ``members.id``.
    - **비-UUID**(``mbr-buyer-01`` 등) — 명단 적재층의 ``registrants.organizer_member_id``.

    ⚠ **UUID 여부를 조회 전에 판별해야 한다.** ``members.id``는 uuid 컬럼이라 비-UUID 문자열을
    비교에 넣으면 Postgres가 22P02(invalid input syntax)로 트랜잭션 자체를 깨고 500이 난다 —
    "없는 회원"이라는 정상적인 401이 아니라 서버 에러가 된다.

    Returns:
        해석된 Principal, 또는 토큰이 데모 형식이 아니면 None(호출부가 Cognito 경로로 폴백).

    Raises:
        HTTPException(401): 데모 형식은 맞지만 그 subject에 대응하는 org를 못 찾을 때.
    """
    try:
        subject = _demo_authenticator.identify(authorization)
    except UnauthenticatedError:
        return None  # 데모 토큰이 아니다 — 실 JWT 경로가 판단하게 넘긴다.

    org_id = _demo_org_id(db, subject)
    if org_id is None:
        raise _unauthorized("알 수 없는 주체")
    return Principal(member_id=subject, organization_id=str(org_id))


def _demo_org_id(db: Session, subject: str) -> str | None:
    """데모 subject → 소속 org. UUID면 members, 아니면 registrants 경로."""
    if _is_uuid(subject):
        return db.execute(
            select(Member.organization_id).where(Member.id == subject)
        ).scalar_one_or_none()
    # 명단 적재층 — 같은 회원이 여러 행사에 있을 수 있으므로 최신 적재분 하나를 쓴다.
    return db.execute(
        select(Registrant.organization_id)
        .where(
            Registrant.organizer_member_id == subject,
            Registrant.organization_id.isnot(None),
        )
        .order_by(Registrant.created_at.desc())
        .limit(1)
    ).scalar_one_or_none()


def _is_uuid(value: str) -> bool:
    try:
        UUID(value)
        return True
    except (ValueError, AttributeError, TypeError):
        return False


def _bearer_token(authorization: str | None) -> str:
    """``Authorization`` 헤더에서 Bearer 토큰을 꺼낸다. 없거나 형식이 틀리면 401."""
    if not authorization:
        raise _unauthorized("인증 정보 없음")
    scheme, _, token = authorization.partition(" ")
    if scheme.lower() != "bearer" or not token.strip():
        raise _unauthorized("인증 정보 없음")
    return token.strip()
