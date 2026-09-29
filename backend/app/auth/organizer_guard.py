"""organizer-guard — /organizer/* 의 운영자(master) 권한 단일 지점(이슈 #47, ADR-0008 경계 B, ADR-0012).

**FastAPI가 권한검사를 소유한다.** Next.js는 RDS에 직접 붙지 않고 이 API들만 호출하며, "이 호출자가
이 행사의 운영자 master인가"의 판정은 여기 한 곳으로 수렴한다(경계 B). 프론트의 라우트 가드는 UX
리다이렉트일 뿐, **권위 있는 거부는 이 의존성이 내린다** — 토큰을 위조/우회해 organizer API를 때려도
여기서 401/403으로 막힌다.

권한 모델은 ADR-0012다: 권한등급(master/sub)은 **계정 전역이 아니라 계정×행사(event) 단위**다. 그래서
가드는 "운영자임"이 아니라 **master-for-this-event** 를 검사한다(맨 "운영자임"으로는 admin을 절대 안
연다 — 권한상승 차단). 판정은 두 포트 뒤에 격리한다:

1. **인증** — ``SessionAuthenticator``가 ``Authorization: Bearer`` 토큰을 검증해 **회원ID**를 돌려준다.
   실구현은 Cognito JWT(JWKS/RS256, ``jwt_verify``)를 검증하는 어댑터, 데모/테스트는 인메모리 스텁.
2. **인가** — ``EventOperatorDirectory``가 (회원ID, 행사ID)의 권한등급을 돌려주고, 순수 함수
   ``authorize_event_master``가 master만 통과시킨다. sub는 자기 관할 콘솔(별도 슬라이스)에서 scope
   가드로 다뤄지며, 이 master 가드는 통과시키지 않는다.

포트는 FastAPI 의존성으로 주입해 테스트가 ``dependency_overrides``로 더블을 꽂을 수 있다. 기본(cognito)
분기는 실 Cognito 인증자(``cognito_pool.CognitoSessionAuthenticator``) + ``event_organizers`` DB 조회로
배선돼 있다(``get_authenticator``/``get_operator_directory``). AUTH_BACKEND=demo만 인메모리 스텁을 쓴다.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Protocol, runtime_checkable

from fastapi import Depends, Header, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import settings
from app.db import get_session
from app.models import EventOrganizer, Organizer

# 권한 등급 — event_organizers.permission_level 과 동일(ADR-0012). master만 admin 가드를 통과.
PERMISSION_MASTER = "master"


@dataclass(frozen=True, slots=True)
class EventMasterPrincipal:
    """인증·인가가 끝난, 이 행사의 master 운영자. 라우트 핸들러가 받는 신원 묶음."""

    member_id: str  # 검증된 회원ID(Cognito 계정과 동일 키)
    event_id: str  # 이 권한이 유효한 행사 — 권한등급은 행사별이므로 함께 들고 다닌다


class GuardError(Exception):
    """가드 거부의 베이스 — 의존성이 이 타입들을 HTTP 상태로 환산한다."""


class UnauthenticatedError(GuardError):
    """토큰이 없거나 검증 실패 — 누구인지 모른다(→ 401)."""


class NotEventMasterError(GuardError):
    """인증은 됐으나 이 행사의 master가 아니다(sub·미배정·참가자 등 → 403)."""

    def __init__(self, member_id: str, event_id: str, permission_level: str | None) -> None:
        super().__init__(
            f"회원ID {member_id!r}은 행사 {event_id!r}의 master가 아니다(등급 {permission_level!r})"
        )
        self.member_id = member_id
        self.event_id = event_id
        self.permission_level = permission_level


@runtime_checkable
class SessionAuthenticator(Protocol):
    """세션 토큰 → 회원ID. Cognito JWT 검증을 포트 뒤에 격리한다(경계 B).

    실구현(``cognito_pool.CognitoSessionAuthenticator``)은 ``Authorization`` 헤더의 **id 토큰**을
    ``jwt_verify``로 JWKS/RS256 검증하고 회원ID 클레임을 뽑는 어댑터 — 로그인이 세션 토큰으로
    id 토큰을 내보내므로(``login_router._session_token``) 여기서도 id 토큰을 검증한다. 테스트/데모는
    인메모리 스텁(아래).
    """

    def identify(self, authorization: str | None) -> str:
        """``Authorization`` 헤더값을 검증해 회원ID를 돌려준다. 없거나 무효면 UnauthenticatedError."""
        ...


@runtime_checkable
class EventOperatorDirectory(Protocol):
    """(회원ID, 행사ID) → 권한등급. event_organizers 조회를 포트 뒤에 격리한다(경계 B, ADR-0012).

    실구현은 회원ID로 운영자 계정을 찾아 event_organizers에서 그 행사의 permission_level을 돌려주는
    DB 어댑터. 그 행사에 배정이 없으면 None(= 이 행사 운영자 아님).
    """

    def permission_level(self, member_id: str, event_id: str) -> str | None:
        """(회원ID, 행사ID)의 권한등급('master'/'sub'), 그 행사에 배정 없으면 None."""
        ...


def authorize_event_master(
    member_id: str, event_id: str, directory: EventOperatorDirectory
) -> EventMasterPrincipal:
    """(회원ID, 행사ID)가 master면 principal, 아니면 NotEventMasterError(순수 인가 코어).

    sub·미배정은 모두 거부한다 — admin은 master-for-this-event로만 연다(ADR-0012). 이 함수가
    가드의 테스트 가능한 deep module이다(HTTP·토큰과 분리).
    """
    level = directory.permission_level(member_id, event_id)
    if level != PERMISSION_MASTER:
        raise NotEventMasterError(member_id, event_id, level)
    return EventMasterPrincipal(member_id=member_id, event_id=event_id)


# --- 데모/테스트 더블 ---------------------------------------------------------
# 토큰 형식·운영자 시드는 dev/test 전용. 실 Cognito·event_organizers 배선으로 교체될 자리다.

# InMemoryCognitoUserPool이 발급하는 데모 토큰 형식: "access-{member_id}-{seq}" / "id-{member_id}-{seq}".
# 회원ID에 하이픈이 있어(mbr-org-01) 종류·말미 seq만 벗겨 가운데를 회원ID로 본다(데모 한정).
_DEMO_TOKEN_RE = re.compile(r"^(?:access|id)-(?P<member_id>.+)-\d+$")


class StubSessionAuthenticator:
    """데모/테스트용 인증자 — InMemoryCognitoUserPool 토큰 형식을 회원ID로 환산한다.

    "Bearer access-mbr-org-01-1" → "mbr-org-01". 형식 불일치·헤더 없음은 UnauthenticatedError.
    실 Cognito 어댑터(JWKS 검증)로 교체될 자리다. 토큰 위조 방지는 실구현의 서명검증 몫이고,
    이 스텁은 형식만 본다(데모 시연·계약 테스트 용도).
    """

    def identify(self, authorization: str | None) -> str:
        if not authorization:
            raise UnauthenticatedError("Authorization 헤더가 없다")
        scheme, _, token = authorization.partition(" ")
        if scheme.lower() != "bearer" or not token:
            raise UnauthenticatedError("Bearer 토큰 형식이 아니다")
        match = _DEMO_TOKEN_RE.match(token.strip())
        if match is None:
            raise UnauthenticatedError("토큰을 해석할 수 없다")
        return match.group("member_id")


class InMemoryEventOperatorDirectory:
    """데모/테스트용 운영자 디렉터리 — {(회원ID, 행사ID): 권한등급}. 그 외는 미배정(None).

    권한등급이 행사별임을 그대로 모델링한다(ADR-0012): 같은 회원ID가 행사마다 다른 등급을 가질 수 있다.

    ``db``를 주지 않으면(기존 관례 — 대부분의 테스트가 그렇다) 하드코딩 dict만 본다(순수 인메모리,
    DB 불필요). ``db``를 주면 dict에 없는 (회원ID, 행사ID)는 ``organizers``/``event_organizers``로
    폴백 조회한다(이슈: demo 모드가 DB로 부여한 권한을 무시해 멀티 행사에서 어드민이 붕괴하던 결함
    수정 — 행사가 2개 이상이고 그중 하나가 DB로만 권한을 받았으면, dict 미스는 곧 실제로 배정이
    없다는 뜻이 아니라 "이 하드코딩 시드 밖의 배정"일 수 있다). dict도 폴백도 못 찾으면 그대로
    None(fail-closed 유지 — 조용한 전체 허용 아님).
    """

    def __init__(self, assignments: dict[tuple[str, str], str], db: Session | None = None) -> None:
        self._assignments = dict(assignments)
        self._db = db

    def permission_level(self, member_id: str, event_id: str) -> str | None:
        level = self._assignments.get((member_id, event_id))
        if level is not None:
            return level
        if self._db is None:
            return None
        return self._db.execute(
            select(EventOrganizer.permission_level)
            .join(Organizer, Organizer.id == EventOrganizer.organizer_id)
            .where(Organizer.member_id == member_id, EventOrganizer.event_id == event_id)
        ).scalar_one_or_none()


# 데모 시드(dev/test/6·17 데모 전용) — AUTH_BACKEND=demo 일 때만 활성. login_router의
# _DEMO_OPERATOR_MEMBER_IDS와 동일 회원을 **데모 행사 하나(DEMO_EVENT_ID)** 에 배정한다.
# ⚠ 행사별 모델(ADR-0012)을 그대로 지킨다 — 모든 행사 권한이 아니라 DEMO_EVENT_ID 한정.
#   mbr-org-01  = master(주최사)  → master 전용 API 통과
#   mbr-trade-01 = sub(무역관)    → master 전용 API 403 (sub 전용 콘솔은 후속 슬라이스)
DEMO_EVENT_ID = "00000000-0000-0000-0000-0000000000de"
PERMISSION_SUB = "sub"
_demo_authenticator: SessionAuthenticator = StubSessionAuthenticator()
_DEMO_ASSIGNMENTS: dict[tuple[str, str], str] = {
    ("mbr-org-01", DEMO_EVENT_ID): PERMISSION_MASTER,
    ("mbr-trade-01", DEMO_EVENT_ID): PERMISSION_SUB,
}


def get_authenticator() -> SessionAuthenticator:
    """FastAPI 의존성 — 세션 인증자. 기본(cognito)은 실 Cognito 인증자, AUTH_BACKEND=demo만 데모 스텁.

    cognito 분기는 ``cognito_pool.CognitoSessionAuthenticator``를 ``principal.get_jwks_provider()``
    (프로세스 공유 JWKS 캐시)와 함께 배선한다 — participant 라우트(``principal``)와 organizer 라우트가
    같은 JWKS 캐시를 나눠 쓴다. issuer/client_id가 미설정이어도 여기서 죽지 않는다 — JWKS가 빈
    키셋이라 실제 토큰 검증이 자연히 실패해(kid 못 찾음) fail-closed가 유지된다(조용한 통과 아님).
    """
    if settings.auth_backend == "demo":
        return _demo_authenticator
    # 지연 import — cognito_pool이 이 모듈의 UnauthenticatedError를 쓰므로(순환 임포트 방지),
    # principal도 이 모듈을 임포트하므로(순환 임포트 방지) 둘 다 호출 시점에 들여온다.
    from app.auth.cognito_pool import CognitoSessionAuthenticator
    from app.auth.principal import get_jwks_provider

    return CognitoSessionAuthenticator(
        provider=get_jwks_provider(),
        issuer=settings.cognito_issuer,
        client_id=settings.cognito_client_id,
    )


def get_operator_directory(db: Session = Depends(get_session)) -> EventOperatorDirectory:
    """FastAPI 의존성 — 운영자 디렉터리. AUTH_BACKEND=demo는 데모 시드 우선, 기본(cognito)은 DB만.

    demo 모드는 하드코딩 데모 시드(_DEMO_ASSIGNMENTS)를 우선 보되, 거기 없는 (회원ID, 행사ID)는
    실 ``organizers``/``event_organizers`` 테이블로 폴백한다(위 InMemoryEventOperatorDirectory
    docstring 참고) — DB로 grant한 권한이 demo 가드에서 통째로 무시돼 멀티 행사 어드민이 403/500로
    무너지던 결함 수정. 기본(cognito)은 데모 시드 없이 곧장 DB 조회만 한다(``{}`` + db) — 배정이
    없으면 그대로 None(fail-closed 유지, 무차별 허용 아님). ``db``는 매 요청 세션(``get_session``)
    이라 요청마다 새 디렉터리를 만든다(모듈 싱글턴을 재사용하면 세션이 요청 간 공유돼 버린다).
    """
    if settings.auth_backend == "demo":
        return InMemoryEventOperatorDirectory(_DEMO_ASSIGNMENTS, db=db)
    return InMemoryEventOperatorDirectory({}, db=db)


def require_event_master(
    event_id: str,
    authorization: str | None = Header(default=None),
    authenticator: SessionAuthenticator = Depends(get_authenticator),
    directory: EventOperatorDirectory = Depends(get_operator_directory),
) -> EventMasterPrincipal:
    """organizer 라우트 가드 — 이 행사의 master만 통과(ADR-0012). 단일 권한검사 지점(경계 B).

    ``event_id``는 라우트 경로(예: /organizer/events/{event_id}/...)에서 읽는다. 토큰 없음·무효 → 401,
    인증됐으나 이 행사 master 아님 → 403. 통과하면 핸들러가 principal을 받는다.
    """
    try:
        member_id = authenticator.identify(authorization)
        return authorize_event_master(member_id, event_id, directory)
    except UnauthenticatedError as exc:
        raise HTTPException(status_code=401, detail="인증이 필요합니다.") from exc
    except NotEventMasterError as exc:
        raise HTTPException(status_code=403, detail="이 행사의 운영자(master) 권한이 필요합니다.") from exc
