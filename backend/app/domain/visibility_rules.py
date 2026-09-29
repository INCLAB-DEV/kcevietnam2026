"""참가기업 열람 범위 제한 — 개발계획서 §8 "참가기업 열람 범위 제한".

참가사는 참가사를, 바이어는 바이어를 열람할 수 없다 — 상대 역할(참가사↔바이어)만 서로 열람 가능.
탐색 API가 아직 없어(현재는 admin organizations 목록만 존재) 규칙 모듈 + 테스트만 먼저 둔다.
**admin organizations 목록에는 적용하지 않는다** — 운영자는 이 규칙 밖(전부 열람).

행사별 정책(#OP 슈퍼어드민 콘솔, 개발계획서 §8 확장): 같은 역할끼리(참가사↔참가사·바이어↔바이어)
상호 열람을 허용할지는 이제 **행사 설정값**(``events.allow_same_role_discovery``)이다 — 베트남
전시는 기본 false(교차 역할만 허용)지만, 다음 행사에서 뒤집을 수 있다. 반대 역할(참가사↔바이어)
열람은 정책과 무관하게 항상 허용되는 구조적 규칙이라 파라미터로 흔들리지 않는다.
"""

from __future__ import annotations

from typing import Literal

Role = Literal["exhibitor", "buyer"]


def can_view_organization(
    viewer_role: Role, target_role: Role, *, allow_same_role_discovery: bool = False
) -> bool:
    """열람 주체(viewer_role)가 대상(target_role)을 볼 수 있는가.

    - 참가사↔바이어(교차 역할): 항상 True — 정책으로도 막지 않는 구조적 규칙.
    - 참가사↔참가사·바이어↔바이어(동일 역할): ``allow_same_role_discovery``(행사별 설정)를 따른다.
      기본 False(§8 원 규칙 — 동종 경쟁사/동종 바이어 열람 차단).
    """
    if viewer_role != target_role:
        return True
    return allow_same_role_discovery
