"""role-branch — 적재 레코드의 역할을 읽어 최종 라우트를 결정하는 순수 분기(F-AU-001).

로그인 슬라이스의 마지막 합류 지점. ``organization_event_roles``의 두 불리언
(``is_exhibitor`` / ``is_buyer``)과 **운영사 내부계정 여부**를 read-only로 판독해
진입 라우트를 정한다(ADR-0007/0008/0009):

- 운영사(roster 밖 내부계정) → ``/organizer``(OP-001).
- 참가 역할 보유(전시자/바이어) → ``/home``(HM-001).
- 아직 역할 없음(행사 미신청) → ``/welcome``(서비스 인트로 — **신규 페이지**, 미정의).

**인증 ≠ 역할.** 역할은 로그인의 전제조건이 아니라 **행사별 속성**이다. NABI는 기업을
먼저 모으고 원하는 행사에 신청하게 하는 구조라, 아직 어느 행사에도 신청하지 않은 기업은
**역할이 없는 정상 상태**다. 따라서 역할 없음은 거부 사유가 아니라 서비스 인트로
페이지(``/welcome``)로 보낸다 — 거기서 행사를 탐색·신청한다. 참가자 화면(``/home``)이나
운영 화면(``/organizer``)에 떨구지 않는다. ⚠ ``/welcome``은 page-list.csv·PRD에 아직
정의되지 않은 신규 페이지다(정의·구현은 별도 작업).

**한 행사 안에서 한 등록자의 역할은 단일이다** — ``organization_event_roles``는
(organization, event) 단위라 한 행에서 ``is_exhibitor``/``is_buyer`` 중 최대 하나만 참이다
(다른 컨퍼런스의 다른 역할은 event_id가 다른 별개 행). 둘 다 참인 상태는 정상 경로에서
나오지 않지만, 나오면 방어적으로 ``/home`` + 두 역할 모두 실어 보낸다(임의로 한쪽으로 안 접음).

**순수 함수다** — DB·세션·요청 객체를 모른다. 입력은 이미 읽힌 역할 불리언뿐이고,
로그인 시 행을 새로 만들지 않는다(read-only, F-AU-001 Further Notes). DB 조회·세션
발급은 호출자(오케스트레이터)가 하고, 여기서는 "어떤 역할이면 어떤 라우트"만 결정한다.
"""

from __future__ import annotations

from dataclasses import dataclass

# 최종 진입 라우트. 라우트 문자열을 한 곳에 고정해 분기 분산을 막는다.
ROUTE_ORGANIZER = "/organizer"  # 운영사 → OP-001
ROUTE_HOME = "/home"  # 참가사/바이어 → HM-001
ROUTE_INTRO = "/welcome"  # 역할 없음(행사 미신청) → 서비스 인트로(신규 페이지, 미정의)

# 역할 식별자 — RouteDecision.roles에 보존되는 활성 역할.
ROLE_OPERATOR = "operator"
ROLE_EXHIBITOR = "exhibitor"
ROLE_BUYER = "buyer"


@dataclass(frozen=True, slots=True)
class RouteDecision:
    """역할 분기 결과 — 최종 라우트 + 활성 역할.

    ``route``는 진입 화면을 정한다. ``roles``는 활성 역할이며, 역할이 없으면 빈 튜플(``()``)
    이다 — 아직 행사에 신청하지 않은 기업의 정상 상태(이 경우 route는 ``/welcome``).
    """

    route: str
    roles: tuple[str, ...]


def decide_route(
    *,
    is_exhibitor: bool,
    is_buyer: bool,
    is_operator: bool = False,
) -> RouteDecision:
    """역할 불리언을 읽어 최종 라우트를 결정한다(순수 함수).

    Args:
        is_exhibitor: ``organization_event_roles.is_exhibitor``.
        is_buyer: ``organization_event_roles.is_buyer``.
        is_operator: 운영사 내부계정 여부(roster 밖). 참이면 역할 불리언과 무관하게
            ``/organizer``로 분기한다.

    Returns:
        ``RouteDecision`` — 라우트와 활성 역할(역할 없으면 ``roles=()``).
    """
    if is_operator:
        # 운영사는 roster 밖 내부계정 — 역할 명단과 독립적으로 운영 화면으로 간다(D5).
        return RouteDecision(route=ROUTE_ORGANIZER, roles=(ROLE_OPERATOR,))

    roles: list[str] = []
    if is_exhibitor:
        roles.append(ROLE_EXHIBITOR)
    if is_buyer:
        roles.append(ROLE_BUYER)

    if not roles:
        # 역할 없음은 거부가 아니라 정상 — 아직 행사에 신청 안 한 기업을 서비스 인트로로 보낸다.
        # 역할은 행사별 속성이라 로그인 전제조건이 아니다(인증 ≠ 역할).
        return RouteDecision(route=ROUTE_INTRO, roles=())

    # 참가 역할 보유 → 참가자 화면. 한 행사 안 역할은 단일이라 roles는 보통 1개이고, 둘 다 참인
    # 비정상 데이터면 방어적으로 둘 다 실어 보낸다(임의로 한쪽으로 접지 않음).
    return RouteDecision(route=ROUTE_HOME, roles=tuple(roles))
