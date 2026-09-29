"""참가기업 열람 범위 제한 규칙(app.domain.visibility_rules) — 개발계획서 §8, 순수 함수.

DB 없이 항상 돈다. 표(4가지 조합) + 행사별 allow_same_role_discovery 정책 파라미터를 검증한다.
"""

from __future__ import annotations

from app.domain.visibility_rules import can_view_organization


def test_cross_role_always_visible_regardless_of_policy():
    # 참가사↔바이어는 구조적 규칙 — 정책(allow_same_role_discovery)과 무관하게 항상 True.
    assert can_view_organization("exhibitor", "buyer") is True
    assert can_view_organization("buyer", "exhibitor") is True
    assert can_view_organization("exhibitor", "buyer", allow_same_role_discovery=True) is True
    assert can_view_organization("buyer", "exhibitor", allow_same_role_discovery=False) is True


def test_same_role_blocked_by_default():
    # 베트남 전시 기본 정책(allow_same_role_discovery=False) — 참가사→참가사·바이어→바이어 불가.
    assert can_view_organization("exhibitor", "exhibitor") is False
    assert can_view_organization("buyer", "buyer") is False


def test_same_role_allowed_when_event_opts_in():
    # 다음 행사가 정책을 뒤집으면(allow_same_role_discovery=True) 동일 역할도 서로 열람 가능.
    assert can_view_organization("exhibitor", "exhibitor", allow_same_role_discovery=True) is True
    assert can_view_organization("buyer", "buyer", allow_same_role_discovery=True) is True


def test_visibility_matrix():
    # 표 형태로 4조합 전부 명시 검증(기본 정책 기준) — 회귀 방지.
    matrix = {
        ("exhibitor", "exhibitor"): False,
        ("exhibitor", "buyer"): True,
        ("buyer", "exhibitor"): True,
        ("buyer", "buyer"): False,
    }
    for (viewer, target), expected in matrix.items():
        assert can_view_organization(viewer, target) is expected, (viewer, target)
