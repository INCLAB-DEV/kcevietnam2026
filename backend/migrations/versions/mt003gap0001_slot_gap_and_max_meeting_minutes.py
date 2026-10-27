"""F-MT-001 슬롯 격자 — 상담 길이와 슬롯 간격 분리(텀) + 연속예약 상한을 분 단위로

Revision ID: mt003gap0001
Revises: my002slf0001
Create Date: 2026-09-22

발주사(마인즈그라운드) 운영표가 요구하는 하루 미팅 격자는

    10:00~10:40 · 10:45~11:25 · 11:30~12:10 · [점심 12:10~13:00] · 13:00~13:40 · … · 17:30~18:10

즉 **40분 상담 + 5분 텀**, 하루 10칸이다. 기존 모델은 ``events.slot_minutes`` 하나가 "상담 길이"와
"슬롯 간격"을 겸해서(``slot_grid._day_slots`` 의 ``step = end - start = slot_minutes``) 이 격자를
표현할 수 없었다. 실측으로 확인한 것:

- ``slot_minutes=40`` (간격=길이=40) → 10칸이 나오긴 하나 ``10:00-10:40 / 10:40-11:20 / 11:20-12:00 /
  13:20-14:00 …`` 으로 **시각이 전부 어긋나고**, 점심 스킵이 12:00~13:20 구멍을 만든다.
- ``slot_minutes=45`` (간격=길이=45) → **8칸**밖에 안 나온다. 11:30칸은 12:15까지 이어져 점심과
  겹쳐 탈락하고, 17:30칸은 18:15까지 이어져 운영 마감(18:10)을 넘겨 탈락한다.
- **길이 40 / 간격 45 분리** → 운영표와 분 단위까지 완전 일치(10/10).

그래서 ``event_schedule_settings.slot_gap_minutes`` 를 더해 간격(stride) = ``slot_minutes + gap`` 로
만들고, ``slot_minutes`` 허용값에 40을 추가한다.

**하위호환**: ``slot_gap_minutes`` 는 ``server_default '0'`` 이라 기존 행이 전부 0으로 백필되고,
0이면 간격 = 길이로 **현행과 동일한 격자**가 나온다. 이 마이그레이션 alone으로는 동작 변화가 없다
(실제 40분/5분텀 적용은 배포 후 운영자가 설정값을 바꾸는 별도의 데이터 작업이다).

**연속예약 상한**: ``slot_grid.MAX_RUN_SLOTS = 3`` (칸 수)를 ``event_schedule_settings
.max_meeting_minutes`` (분, 기본 90)로 옮긴다. 슬롯이 40분이 되면 3칸 스팬이 130분이 되어 원래
기준인 "최대 1시간 반"을 넘기 때문이다. 기본 90은 현행 ``30분 × 3칸 = 90분`` 을 그대로 허용하므로
역시 무동작 변화이고, 상한 조정이 필요하면 배포 없이 이 설정값만 바꾸면 된다.

**DB CHECK를 새 컬럼에 걸지 않는 이유**: 이 레포 관례상 값 **어휘**가 닫힌 집합일 때만 CHECK로
강제한다(``events_slot_minutes_check``, ``events_enabled_venue_types_check``). 반면 ``min_guaranteed_slots``
처럼 연속 범위는 DB CHECK 없이 API 경계(Pydantic ``Field(ge=…, le=…)``)에서만 막는다 — 범위 정책이
바뀔 때마다 마이그레이션을 요구하지 않게 하려는 의도다(``models.py`` 의 ``MEETING_CANCEL_REASONS``
주석이 같은 원칙을 명시한다). 두 새 컬럼은 후자를 따른다: 범위는 ``admin.schemas.EventSettingsIn``
에서 강제(``slot_gap_minutes`` 0~30, ``max_meeting_minutes`` 10~480).

``events_slot_minutes_check`` 는 이름 그대로 drop → create 한다(기존 행은 전부 30이라 새 집합
``(10,20,30,40,60)`` 을 위반하지 않는다 — recreate가 실패할 수 없다).
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "mt003gap0001"
down_revision: Union[str, None] = "my002slf0001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

# models.SLOT_MINUTES_CHOICES 의 이전 값 — downgrade 가 이 집합으로 CHECK 를 되돌린다.
_OLD_SLOT_MINUTES = (10, 20, 30, 60)


def _slot_minutes_check_sql(choices: Sequence[int]) -> str:
    return "slot_minutes IN (" + ", ".join(str(v) for v in choices) + ")"


def upgrade() -> None:
    op.add_column(
        "event_schedule_settings",
        sa.Column("slot_gap_minutes", sa.Integer(), nullable=False, server_default=sa.text("0")),
    )
    op.add_column(
        "event_schedule_settings",
        sa.Column("max_meeting_minutes", sa.Integer(), nullable=False, server_default=sa.text("90")),
    )
    # CHECK 는 모델(app.models.SLOT_MINUTES_CHOICES)이 단일 진실원천 — 여기서 값을 다시 쓰지 않고
    # import 해 쓴다(어휘가 두 곳에 적히면 반드시 갈라진다).
    from app.models import SLOT_MINUTES_CHOICES

    op.drop_constraint("events_slot_minutes_check", "events", type_="check")
    op.create_check_constraint(
        "events_slot_minutes_check", "events", _slot_minutes_check_sql(SLOT_MINUTES_CHOICES)
    )


def downgrade() -> None:
    op.drop_constraint("events_slot_minutes_check", "events", type_="check")
    op.create_check_constraint(
        "events_slot_minutes_check", "events", _slot_minutes_check_sql(_OLD_SLOT_MINUTES)
    )
    # 40분으로 바꿔둔 행사가 있으면 이전 CHECK 에 걸려 downgrade 가 실패한다 — 그건 올바른 실패다
    # (데이터를 30분으로 되돌리지 않고 스키마만 되돌리면 격자가 조용히 깨진다).
    op.drop_column("event_schedule_settings", "max_meeting_minutes")
    op.drop_column("event_schedule_settings", "slot_gap_minutes")
