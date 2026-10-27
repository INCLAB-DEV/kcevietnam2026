"""role-branch 단위 테스트 — 역할별 최종 라우트 분기(F-AU-001 AC).

구현 세부가 아니라 **관찰 가능한 결과**(어떤 역할이면 어떤 라우트로 가고, 겸직은 두 역할이
보존되는지)를 본다. 운영사/참가사/바이어/겸직 4케이스를 모두 덮는다.
"""

from app.auth.role_branch import (
    ROUTE_HOME,
    ROUTE_INTRO,
    ROUTE_ORGANIZER,
    decide_route,
)


# --- AC: 운영사 → /organizer -------------------------------------------------
def test_operator_routes_to_organizer():
    decision = decide_route(is_exhibitor=False, is_buyer=False, is_operator=True)
    assert decision.route == ROUTE_ORGANIZER
    assert decision.roles == ("operator",)


def test_operator_flag_wins_even_with_roles_present():
    # 운영사 내부계정이면 역할 불리언과 무관하게 운영 화면으로 간다.
    decision = decide_route(is_exhibitor=True, is_buyer=True, is_operator=True)
    assert decision.route == ROUTE_ORGANIZER
    assert decision.roles == ("operator",)


# --- AC: 참가사 → /home ------------------------------------------------------
def test_exhibitor_routes_to_home():
    decision = decide_route(is_exhibitor=True, is_buyer=False)
    assert decision.route == ROUTE_HOME
    assert decision.roles == ("exhibitor",)


# --- AC: 바이어 → /home ------------------------------------------------------
def test_buyer_routes_to_home():
    decision = decide_route(is_exhibitor=False, is_buyer=True)
    assert decision.route == ROUTE_HOME
    assert decision.roles == ("buyer",)


# --- 방어: 둘 다 참(비정상 데이터) → /home, 임의로 한쪽으로 접지 않음 -------
# 한 행사 안 역할은 단일이라 정상 경로에선 안 나오지만, malformed 입력을 방어적으로 처리한다.
def test_both_true_defensively_routes_to_home_without_collapsing():
    decision = decide_route(is_exhibitor=True, is_buyer=True)
    assert decision.route == ROUTE_HOME
    assert decision.roles == ("exhibitor", "buyer")


# --- 역할 없음(아직 행사 미신청) → /welcome 인트로, roles=() (거부 아님) ------
def test_no_role_routes_to_intro_for_pre_application_user():
    # 역할은 행사별 속성 — 아직 어느 행사에도 신청 안 한 기업은 거부가 아니라 서비스 인트로로.
    decision = decide_route(is_exhibitor=False, is_buyer=False, is_operator=False)
    assert decision.route == ROUTE_INTRO
    assert decision.roles == ()
