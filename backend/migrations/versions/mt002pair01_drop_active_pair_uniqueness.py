"""D9(활성 쌍 유일성) 제거 — 같은 두 기업이 여러 번 미팅할 수 있게 한다 (#11)

Revision ID: mt002pair01
Revises: ev001code0001
Create Date: 2026-09-15

발주자 결정(2026-09-15, GitHub #11): 같은 두 기업(참가사-바이어 쌍)도 행사 중 여러 번 미팅할 수
있어야 한다. 기존 ``meetings_active_pair_uniq`` 부분 unique 인덱스(mt001meet01)는 이 쌍에 살아있는
(proposed/accepted) 미팅을 하나로 제한했는데, 이게 "거절/취소된 시간이 비어 있어도 그 쌍이 다른
시간에 미팅 하나만 갖고 있으면 재신청이 막힌다"는 형태로 N:M 요구와 정면으로 어긋났다.

**푸는 것**: 쌍(두 기업) 단위 중복 제한 — 이 인덱스 하나.

**유지하는 것**: 시각 단위 이중예약 방지는 이 마이그레이션이 손대지 않는 별도 제약이다 —
``meetings_exhibitor_slot_excl``/``meetings_buyer_slot_excl``/``meetings_venue_slot_excl``
(전부 accepted만 대상인 EXCLUDE 제약, mt001meet01). 한 기업이 같은 시각에 미팅을 두 건 확정하는
건 여전히 막힌다.

애플리케이션 레벨에서는 (쌍, 시각) 단위로 같은 상대에게 같은 시각 proposed를 중복 신청하는 실수만
막는다(``app.matching.meeting_booking.find_duplicate_proposed`` — ``DUPLICATE_APPLICATION``). 이건
사용자 실수 방지용 소프트 가드라 DB 제약으로 올리지 않았다 — 이미 advisory lock(정렬된 org id
쌍) 안에서 검사하므로 레이스 없이 안전하고, exhibitor_org_id/buyer_org_id가 역할에 따라 두 미팅
사이에서 뒤바뀔 수 있어 대칭적인 부분 unique 인덱스로 표현하기 애매하다(LEAST/GREATEST로 우회
가능하지만 이 정도 사용자 실수 방지에는 과하다).

downgrade()는 인덱스를 되살린다 — 단, **이 마이그레이션이 내려간 동안 같은 쌍에 활성 미팅이
여러 건 쌓였다면 CREATE UNIQUE INDEX가 기존 데이터 위반으로 실패한다.** 그 경우 운영자가 먼저
중복 쌍을 정리(취소/거절 처리)한 뒤 다시 downgrade해야 한다 — mt001meet01의 ``_preflight``와
같은 이유로 여기서는 자동 정리하지 않는다(운영 데이터를 마이그레이션이 임의로 판단하지 않는다).
"""

from typing import Sequence, Union

from alembic import op

revision: str = "mt002pair01"
down_revision: Union[str, None] = "ev001code0001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("DROP INDEX IF EXISTS meetings_active_pair_uniq")


def downgrade() -> None:
    # ⚠ downgrade 시점에 같은 (event_id, exhibitor_org_id, buyer_org_id) 쌍에 활성(proposed/
    # accepted) 미팅이 이미 2건 이상 쌓여 있으면 이 CREATE UNIQUE INDEX가 실패한다. 운영자가
    # 먼저 중복 쌍을 정리한 뒤 재시도해야 한다 — 자동 정리는 하지 않는다.
    op.execute(
        """
        CREATE UNIQUE INDEX meetings_active_pair_uniq
        ON meetings (event_id, exhibitor_org_id, buyer_org_id)
        WHERE status IN ('proposed', 'accepted')
        """
    )
