"""F-NV-001 참가자 메뉴 — 행사가 참가사·바이어 화면의 왼쪽 메뉴 구성을 고른다(기본: 미팅만)

Revision ID: nv001menu0001
Revises: mt003gap0001
Create Date: 2026-10-08

발주사 요청(2026-10-08): 비즈매칭 진행 방식이 바뀌어 참가사·바이어 화면의 메뉴를 "미팅" 하나로
줄여 달라. 이 플랫폼은 행사마다 재사용하므로(ADR-0012) 특정 행사 전용 분기를 코드에 박지 않고
행사 설정값으로 둔다.

``event_schedule_settings.participant_menu`` (text, NOT NULL, default ``'meetings_only'``):

- ``meetings_only`` — 미팅만(**기본**)
- ``full`` — 대시보드·기업 탐색·미팅·알림·프로필(이 설정이 생기기 전의 메뉴)

**기본값이 ``meetings_only`` 인 건 발주사 결정이다**: 배포하는 순간 참가사·바이어 화면이 미팅 전용으로
보여야 하고, 누가 설정을 따로 켤 필요가 없어야 한다. 그래서 ``server_default`` 가 **기존 행도 전부
``meetings_only`` 로 백필**하고, 설정 행이 아직 없는 행사도 읽는 쪽(``/api/me``·알림 메일)이 같은 값으로
취급한다(``app.models.DEFAULT_PARTICIPANT_MENU`` — 폴백은 전부 그 상수 하나를 본다).

⚠ **이 리비전은 최근 설정 두 개(``mt003gap0001``)와 달리 무동작 변화가 아니다.** 컬럼만으로는 아무 일도
없지만(구 코드는 이 컬럼을 읽지 않는다), 이 컬럼을 읽는 코드가 올라오는 순간 모든 행사의 참가자 화면과
알림 메일 문구가 미팅 전용으로 바뀐다. 전체 메뉴가 필요한 행사는 배포 후 행사 설정에서 ``full`` 을 고른다
— 그렇게 고른 행사의 화면·메일은 이 변경 전과 완전히 같다.

**화면 구성용 값이다.** 이 값으로 API 권한을 바꾸지 않는다 — ``meetings_only`` 인 행사에서도 탐색·
알림·프로필·미팅 신청 API는 그대로 동작한다(ADR-0015).

**``events`` 가 아닌 ``event_schedule_settings`` 에 두는 이유**: ``events`` 는 레포 밖 읽기 전용 계정
(레포 밖 읽기 전용 계정)이 직접 읽는 테이블이라 스키마를 건드리지 않는다. 최근 설정 두 개
(``mt003gap0001``)와 같은 자리다.

**CHECK를 거는 이유**: 값 어휘가 닫힌 집합이다(``mt003gap0001`` docstring의 관례 — 어휘는 CHECK,
연속 범위는 API 경계). 어휘와 기본값은 이 리비전 시점의 스냅샷으로 여기 적는다(``nt003rej0001`` 과 같은
방식) — 나중에 값이 늘거나 기본값이 바뀌면 그 리비전이 고친다.
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "nv001menu0001"
down_revision: Union[str, None] = "mt003gap0001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_CHECK_NAME = "event_schedule_settings_participant_menu_check"
_CHECK = "participant_menu IN ('meetings_only', 'full')"


def upgrade() -> None:
    op.add_column(
        "event_schedule_settings",
        sa.Column(
            "participant_menu", sa.Text(), nullable=False, server_default=sa.text("'meetings_only'")
        ),
    )
    op.create_check_constraint(_CHECK_NAME, "event_schedule_settings", _CHECK)


def downgrade() -> None:
    # full 로 바꿔 둔 행사가 있어도 그대로 내려간다 — 그 선택은 컬럼과 함께 사라진다(다시 올리면 전부
    # 기본값 meetings_only 다). 이 컬럼을 읽는 코드를 먼저 내린 뒤에 실행한다: 컬럼이 없으면 /api/me 의
    # 조인이 실패한다.
    op.drop_constraint(_CHECK_NAME, "event_schedule_settings", type_="check")
    op.drop_column("event_schedule_settings", "participant_menu")
