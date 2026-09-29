"""login — 인증 슬라이스 오케스트레이터(검증 → 매핑 → 세션). ADR-0007/0008.

deep module들을 **얇게 엮기만** 한다 — 규칙·DB·외부호출은 각 모듈/포트가 소유하고, 여기서는
순서(검증 → 회원ID → 적재 레코드 매핑 → 게이트 계정/세션)와 분기 결과만 조립한다.

이 함수가 F-AU-001의 관찰 가능한 로그인 계약을 한 자리에서 드러낸다:
- 아이디/비번 성공 → 회원ID → 적재 레코드 매핑 → 세션(최초=발급, 재방문=기존).
- 매핑 없음 → not-found 결과(인증 실패와 구분).
- 검증 실패 → 거부 사유.

역할 분기(``/organizer`` vs ``/home``)의 **규칙**은 형제 모듈 ``role_branch``(순수 함수)가
소유한다. 오케스트레이터는 그 함수를 호출해 결정된 라우트를 로그인 성공 결과에 실어
넘길 뿐, 분기 로직을 직접 들고 있지 않는다(F-AU-001 role-branch 슬라이스).
"""

from __future__ import annotations

from dataclasses import dataclass

from app.auth.dx_korea_verify import (
    DxKoreaVerifier,
    RejectionReason,
    VerifyOk,
)
from app.auth.registrant_mapping import (
    RegistrantDirectory,
    RegistrantNotFoundError,
    RegistrantRef,
    map_member_to_registrant,
)
from app.auth.role_branch import RouteDecision, decide_route
from app.auth.session_issue import (
    CognitoUserPool,
    SessionResult,
    issue_session,
)


@dataclass(frozen=True, slots=True)
class LoginSucceeded:
    """로그인 성공 — 적재 레코드 + 세션 + 역할로 결정된 진입 라우트.

    ``route``는 ``role_branch``가 적재 레코드의 역할에서 결정한 최종 진입 화면
    (``/organizer`` | ``/home``)이고, ``roles``는 겸직을 잃지 않도록 활성 역할을 보존한다.
    """

    registrant: RegistrantRef
    session: SessionResult
    route: str
    roles: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class LoginRejected:
    """검증 실패 — 거부 사유(아이디/비번 불일치·잠김·업스트림 장애)."""

    reason: RejectionReason


@dataclass(frozen=True, slots=True)
class LoginRegistrantNotFound:
    """검증은 통과했으나 그 회원ID로 적재된 레코드가 없음 — 인증 실패와 구분되는 분기."""

    member_id: str


# 로그인 결과 = 성공 | 거부(사유) | 적재레코드 없음. 호출자는 isinstance로 분기한다.
LoginOutcome = LoginSucceeded | LoginRejected | LoginRegistrantNotFound


def authenticate_and_issue_session(
    username: str,
    password: str,
    *,
    verifier: DxKoreaVerifier,
    directory: RegistrantDirectory,
    pool: CognitoUserPool,
    consent_satisfied: bool,
) -> LoginOutcome:
    """아이디/비번을 검증해 적재 레코드를 매핑하고 NABI 계정 세션을 발급한다.

    Args:
        username: DX Korea 아이디.
        password: DX Korea 비밀번호.
        verifier: DX Korea 인증 어댑터 포트.
        directory: 적재 레코드 조회 포트.
        pool: Cognito 유저풀 포트.
        consent_satisfied: 최초 진입 시 필수 약관 동의 완료 여부(재방문이면 무시).

    Returns:
        ``LoginSucceeded`` | ``LoginRejected`` | ``LoginRegistrantNotFound``.

    Raises:
        ConsentNotSatisfiedError: 최초 진입인데 필수 약관 미동의일 때(session_issue가 던짐).
    """
    result = verifier.verify(username, password)
    if not isinstance(result, VerifyOk):
        # 검증 실패 — 거부 사유를 그대로 노출(무엇을 고칠지 안내).
        return LoginRejected(reason=result.reason)

    try:
        registrant = map_member_to_registrant(result.member_id, directory)
    except RegistrantNotFoundError:
        # 검증은 통과했으나 명단에 그 회원ID가 없음.
        return LoginRegistrantNotFound(member_id=result.member_id)

    # 적재 레코드의 역할로 라우트를 정한다(규칙은 role_branch가 소유). 역할은 로그인 전제가
    # 아니라 행사별 속성이라, 아직 역할이 없어도 거부하지 않고 서비스 인트로(/welcome)로 보낸다.
    # DX Korea 로그인 경로는 항상 roster 참가자라 운영사가 아니다(운영사는 내부계정 별도 경로).
    decision: RouteDecision = decide_route(
        is_exhibitor=registrant.is_exhibitor,
        is_buyer=registrant.is_buyer,
        is_operator=False,
    )

    session = issue_session(result.member_id, pool, consent_satisfied=consent_satisfied)
    return LoginSucceeded(
        registrant=registrant,
        session=session,
        route=decision.route,
        roles=decision.roles,
    )
