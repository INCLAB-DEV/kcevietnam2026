"""참가자용 미팅 도메인 — 상태 전이 감사 컬럼 + 슬롯/장소 점유 제약 (F-MT-001)

Revision ID: mt001meet01
Revises: orggrant0001
Create Date: 2026-09-01

``meetings``/``meeting_venues`` 테이블 자체는 초기 스키마(416bbb825e07)에 이미 있었지만,
참가자가 직접 신청·수락·거절·취소하는 흐름을 지탱할 **감사 컬럼과 동시성 제약**이 없었다. 이
마이그레이션이 그 둘을 채운다.

핵심 결정:

1. **슬롯 길이 진실원천 단일화** — ``events.slot_minutes``와 ``event_schedule_settings.slot_minutes``가
   같은 사실을 두 곳에 들고 있었다. 두 값이 갈라지면 "그리드가 만든 슬롯"과 "예약이 검증하는 슬롯"이
   달라져 조용히 어긋난다. 유효한 설정값(10/20/30/60)을 events로 흡수한 뒤 settings 쪽 컬럼을 **제거**한다.

2. **점유는 accepted만** — proposed는 슬롯을 점유하지 않는다. 같은 시간대에 여러 신청이 공존하고,
   **첫 수락이 이긴다**. 이걸 EXCLUDE 제약의 WHERE 절로 DB에 새긴다(앱 로직이 잊어도 DB가 막는다).
   구간은 ``[)`` 반열림 — 09:00~09:30과 09:30~10:00은 겹치지 않는다.

3. **D9(활성 쌍 유일성)** 은 부분 unique 인덱스로. 종료 상태(rejected/cancelled/completed)는 빠져
   재신청을 막지 않는다.

4. **사유 어휘는 CHECK로 묶지 않는다** — 취소/거절 사유 코드 어휘가 아직 확정 전이라, 어휘 변경이
   마이그레이션을 강요하지 않게 둔다. 대신 "사유는 그 상태에서만 존재한다"는 구조적 불변식은 CHECK로
   건다(``cancelled_reason_code IS NULL OR status='cancelled'``). 어휘 강제는 API 경계(Pydantic Literal).

5. **fail loud** — 새 제약을 어기는 기존 행이 있으면 데이터를 자동으로 고치지 않고 명확한 메시지로
   멈춘다. 운영 데이터의 의미를 마이그레이션이 임의로 판단해선 안 된다.

6. **updated_at은 DB 트리거가 아니라 앱이 갱신한다** — 이 레포에는 트리거 전례가 없다. ORM
   ``onupdate=func.now()`` + 명시 UPDATE의 ``values(updated_at=...)`` 로 채운다.
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "mt001meet01"
down_revision: Union[str, None] = "orggrant0001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


class MeetingDataConflictError(RuntimeError):
    """새 제약을 어기는 기존 행 — 사람이 판단해 정리해야 한다(자동 변조 금지)."""


def _preflight(bind) -> None:
    """새 제약과 충돌하는 기존 데이터를 먼저 훑어 명확한 메시지로 멈춘다."""
    # D9 — 활성 상태(proposed/accepted)의 (행사, 참가사, 바이어) 중복 쌍.
    dup_pairs = bind.execute(
        sa.text(
            """
            SELECT event_id, exhibitor_org_id, buyer_org_id, count(*) AS n
            FROM meetings
            WHERE status IN ('proposed', 'accepted')
            GROUP BY event_id, exhibitor_org_id, buyer_org_id
            HAVING count(*) > 1
            ORDER BY n DESC
            LIMIT 20
            """
        )
    ).all()
    if dup_pairs:
        detail = "; ".join(
            f"event={r.event_id} exhibitor={r.exhibitor_org_id} buyer={r.buyer_org_id} ({r.n}건)"
            for r in dup_pairs
        )
        raise MeetingDataConflictError(
            "D9(활성 미팅 쌍 유일성) 위반 데이터가 있어 부분 unique 인덱스를 만들 수 없다. "
            "같은 행사·같은 (참가사, 바이어) 쌍에 proposed/accepted 미팅이 2건 이상 존재한다 — "
            "어느 쪽을 남길지는 운영 판단이라 마이그레이션이 자동 정리하지 않는다. "
            f"중복 쌍: {detail}"
        )

    # 구간 역전/빈 구간.
    bad_range = bind.execute(
        sa.text(
            """
            SELECT id, scheduled_start, scheduled_end FROM meetings
            WHERE scheduled_start IS NOT NULL AND scheduled_end IS NOT NULL
              AND scheduled_end <= scheduled_start
            LIMIT 20
            """
        )
    ).all()
    if bad_range:
        detail = "; ".join(f"{r.id}({r.scheduled_start} ~ {r.scheduled_end})" for r in bad_range)
        raise MeetingDataConflictError(
            "meetings_schedule_order_check 위반 데이터가 있다 — scheduled_end가 scheduled_start보다 "
            f"뒤가 아니다. 시간 보정은 운영 판단이라 자동 수정하지 않는다. 해당 미팅: {detail}"
        )

    # 확정인데 일정이 비어 있는 행.
    bad_accepted = bind.execute(
        sa.text(
            """
            SELECT id FROM meetings
            WHERE status = 'accepted' AND (scheduled_start IS NULL OR scheduled_end IS NULL)
            LIMIT 20
            """
        )
    ).scalars().all()
    if bad_accepted:
        raise MeetingDataConflictError(
            "meetings_accepted_requires_schedule_check 위반 데이터가 있다 — status='accepted'인데 "
            "scheduled_start/end가 비었다. 확정 미팅에 시간을 넣을지 상태를 내릴지는 운영 판단이라 "
            f"자동 수정하지 않는다. 해당 미팅: {', '.join(str(i) for i in bad_accepted)}"
        )

    # EXCLUDE 3종 — 이미 겹쳐 있는 accepted 미팅.
    for label, column in (
        ("참가사", "exhibitor_org_id"),
        ("바이어", "buyer_org_id"),
    ):
        overlaps = bind.execute(
            sa.text(
                f"""
                SELECT a.id AS a_id, b.id AS b_id, a.{column} AS org_id
                FROM meetings a JOIN meetings b
                  ON a.{column} = b.{column} AND a.id < b.id
                WHERE a.status = 'accepted' AND b.status = 'accepted'
                  AND a.scheduled_start IS NOT NULL AND a.scheduled_end IS NOT NULL
                  AND b.scheduled_start IS NOT NULL AND b.scheduled_end IS NOT NULL
                  AND tstzrange(a.scheduled_start, a.scheduled_end, '[)')
                      && tstzrange(b.scheduled_start, b.scheduled_end, '[)')
                LIMIT 20
                """
            )
        ).all()
        if overlaps:
            detail = "; ".join(f"{r.a_id} ↔ {r.b_id} ({label} {r.org_id})" for r in overlaps)
            raise MeetingDataConflictError(
                f"{label} 슬롯 점유 EXCLUDE 제약을 만들 수 없다 — 이미 시간이 겹치는 accepted 미팅 "
                f"쌍이 있다. 어느 쪽을 취소할지는 운영 판단이다. 겹치는 쌍: {detail}"
            )

    venue_overlaps = bind.execute(
        sa.text(
            """
            SELECT a.id AS a_id, b.id AS b_id, a.venue_id AS venue_id
            FROM meetings a JOIN meetings b ON a.venue_id = b.venue_id AND a.id < b.id
            WHERE a.status = 'accepted' AND b.status = 'accepted'
              AND a.venue_id IS NOT NULL
              AND a.scheduled_start IS NOT NULL AND a.scheduled_end IS NOT NULL
              AND b.scheduled_start IS NOT NULL AND b.scheduled_end IS NOT NULL
              AND tstzrange(a.scheduled_start, a.scheduled_end, '[)')
                  && tstzrange(b.scheduled_start, b.scheduled_end, '[)')
            LIMIT 20
            """
        )
    ).all()
    if venue_overlaps:
        detail = "; ".join(f"{r.a_id} ↔ {r.b_id} (venue {r.venue_id})" for r in venue_overlaps)
        raise MeetingDataConflictError(
            "장소 점유 EXCLUDE 제약을 만들 수 없다 — 같은 장소에 시간이 겹치는 accepted 미팅 쌍이 "
            f"있다. 어느 쪽을 옮길지는 운영 판단이다. 겹치는 쌍: {detail}"
        )

    # meeting_venues get-or-create 멱등키 — 이미 (행사, 유형, 라벨) 중복이 있으면 만들 수 없다.
    dup_venues = bind.execute(
        sa.text(
            """
            SELECT event_id, venue_type, label, count(*) AS n
            FROM meeting_venues
            GROUP BY event_id, venue_type, label
            HAVING count(*) > 1
            LIMIT 20
            """
        )
    ).all()
    if dup_venues:
        detail = "; ".join(f"event={r.event_id} {r.venue_type}/{r.label} ({r.n}건)" for r in dup_venues)
        raise MeetingDataConflictError(
            "meeting_venues (event_id, venue_type, label) 유니크를 만들 수 없다 — 같은 라벨의 장소 "
            f"행이 이미 중복돼 있다. 통합 대상은 운영 판단이다. 중복: {detail}"
        )


def upgrade() -> None:
    bind = op.get_bind()

    # EXCLUDE USING gist에서 uuid를 '=' 로 비교하려면 btree_gist가 필요하다(gist는 기본적으로
    # 스칼라 동등비교 연산자 클래스를 모른다).
    op.execute("CREATE EXTENSION IF NOT EXISTS btree_gist")

    _preflight(bind)

    # --- 1. 슬롯 길이 진실원천 단일화 ---------------------------------------
    # settings 쪽에 유효한 값(10/20/30/60)이 있고 events와 다르면 그 값을 events로 올린다.
    # 유효하지 않은 값(체크 밖)은 events의 CHECK를 깨뜨리므로 옮기지 않고 버린다.
    op.execute(
        """
        UPDATE events e
        SET slot_minutes = s.slot_minutes
        FROM event_schedule_settings s
        WHERE s.event_id = e.id
          AND s.slot_minutes IN (10, 20, 30, 60)
          AND e.slot_minutes <> s.slot_minutes
        """
    )
    op.drop_column("event_schedule_settings", "slot_minutes")

    # --- 2. 행사 타임존 -------------------------------------------------------
    op.add_column(
        "events",
        sa.Column(
            "timezone", sa.Text(), nullable=False, server_default=sa.text("'Asia/Seoul'")
        ),
    )

    # --- 3. meetings 감사/상태 컬럼 ------------------------------------------
    op.add_column(
        "meetings",
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")
        ),
    )
    # 기존 행의 "마지막 변경 시각"은 알 길이 없다 — 생성 시각이 가장 정직한 근사치다.
    op.execute("UPDATE meetings SET updated_at = created_at")

    op.add_column("meetings", sa.Column("awaiting_org_id", sa.dialects.postgresql.UUID(as_uuid=False), nullable=True))
    op.create_foreign_key(
        "meetings_awaiting_org_id_fkey", "meetings", "organizations",
        ["awaiting_org_id"], ["id"], ondelete="CASCADE",
    )
    # 응답 대기 주체 백필 — proposed 행만. 신청자의 반대편이 공을 쥔다.
    # 운영자 생성(requested_by='organizer')은 수신측이 특정되지 않아 NULL 유지.
    op.execute(
        """
        UPDATE meetings SET awaiting_org_id = CASE requested_by
            WHEN 'exhibitor' THEN buyer_org_id
            WHEN 'buyer' THEN exhibitor_org_id
        END
        WHERE status = 'proposed'
        """
    )

    op.add_column("meetings", sa.Column("request_reason", sa.Text(), nullable=True))

    op.add_column("meetings", sa.Column("cancelled_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("meetings", sa.Column("cancelled_by", sa.Text(), nullable=True))
    op.add_column(
        "meetings", sa.Column("cancelled_by_org_id", sa.dialects.postgresql.UUID(as_uuid=False), nullable=True)
    )
    op.create_foreign_key(
        "meetings_cancelled_by_org_id_fkey", "meetings", "organizations",
        ["cancelled_by_org_id"], ["id"], ondelete="SET NULL",
    )
    op.add_column("meetings", sa.Column("cancelled_reason_code", sa.Text(), nullable=True))
    op.add_column("meetings", sa.Column("cancelled_reason_text", sa.Text(), nullable=True))

    op.add_column("meetings", sa.Column("rejected_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column(
        "meetings", sa.Column("rejected_by_org_id", sa.dialects.postgresql.UUID(as_uuid=False), nullable=True)
    )
    op.create_foreign_key(
        "meetings_rejected_by_org_id_fkey", "meetings", "organizations",
        ["rejected_by_org_id"], ["id"], ondelete="SET NULL",
    )
    op.add_column("meetings", sa.Column("rejected_reason_code", sa.Text(), nullable=True))
    op.add_column("meetings", sa.Column("rejected_reason_text", sa.Text(), nullable=True))

    # ADR-0013 확정 필드 — 운영자 대리신청 감사. 이번 슬라이스에는 writer가 없다(placeholder).
    op.add_column(
        "meetings",
        sa.Column("proxy_applied_by_organizer_id", sa.dialects.postgresql.UUID(as_uuid=False), nullable=True),
    )
    op.create_foreign_key(
        "meetings_proxy_applied_by_organizer_id_fkey", "meetings", "organizers",
        ["proxy_applied_by_organizer_id"], ["id"], ondelete="SET NULL",
    )

    # --- 4. CHECK 제약 --------------------------------------------------------
    op.create_check_constraint(
        "meetings_cancelled_by_check", "meetings",
        "cancelled_by IN ('exhibitor', 'buyer', 'organizer')",
    )
    op.create_check_constraint(
        "meetings_cancelled_reason_status_check", "meetings",
        "cancelled_reason_code IS NULL OR status = 'cancelled'",
    )
    op.create_check_constraint(
        "meetings_rejected_reason_status_check", "meetings",
        "rejected_reason_code IS NULL OR status = 'rejected'",
    )
    op.create_check_constraint(
        "meetings_schedule_order_check", "meetings",
        "scheduled_end IS NULL OR scheduled_start IS NULL OR scheduled_end > scheduled_start",
    )
    op.create_check_constraint(
        "meetings_accepted_requires_schedule_check", "meetings",
        "status <> 'accepted' OR (scheduled_start IS NOT NULL AND scheduled_end IS NOT NULL)",
    )

    # --- 5. D9 활성 쌍 유일성 -------------------------------------------------
    op.execute(
        """
        CREATE UNIQUE INDEX meetings_active_pair_uniq
        ON meetings (event_id, exhibitor_org_id, buyer_org_id)
        WHERE status IN ('proposed', 'accepted')
        """
    )

    # --- 6. 점유 EXCLUDE 3종 (accepted만) -------------------------------------
    for name, column, extra in (
        ("meetings_exhibitor_slot_excl", "exhibitor_org_id", ""),
        ("meetings_buyer_slot_excl", "buyer_org_id", ""),
        ("meetings_venue_slot_excl", "venue_id", " AND venue_id IS NOT NULL"),
    ):
        op.execute(
            f"""
            ALTER TABLE meetings ADD CONSTRAINT {name}
            EXCLUDE USING gist (
                {column} WITH =,
                tstzrange(scheduled_start, scheduled_end, '[)') WITH &&
            )
            WHERE (status = 'accepted'{extra}
                   AND scheduled_start IS NOT NULL AND scheduled_end IS NOT NULL)
            """
        )

    # --- 7. meeting_venues get-or-create 멱등키 -------------------------------
    op.create_unique_constraint(
        "meeting_venues_event_type_label_key", "meeting_venues", ["event_id", "venue_type", "label"]
    )

    # --- 8. 조회 인덱스 -------------------------------------------------------
    op.create_index("meetings_event_status_idx", "meetings", ["event_id", "status"])
    op.execute(
        "CREATE INDEX meetings_exhibitor_schedule_idx ON meetings (exhibitor_org_id, scheduled_start)"
        " WHERE status = 'accepted'"
    )
    op.execute(
        "CREATE INDEX meetings_buyer_schedule_idx ON meetings (buyer_org_id, scheduled_start)"
        " WHERE status = 'accepted'"
    )
    # completion tick 스캔 전용 — scheduled_end <= now 인 accepted 만 훑는다.
    op.execute(
        "CREATE INDEX meetings_completion_scan_idx ON meetings (scheduled_end) WHERE status = 'accepted'"
    )
    op.execute("CREATE INDEX meetings_event_created_idx ON meetings (event_id, created_at DESC)")


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS meetings_event_created_idx")
    op.execute("DROP INDEX IF EXISTS meetings_completion_scan_idx")
    op.execute("DROP INDEX IF EXISTS meetings_buyer_schedule_idx")
    op.execute("DROP INDEX IF EXISTS meetings_exhibitor_schedule_idx")
    op.drop_index("meetings_event_status_idx", table_name="meetings")

    op.drop_constraint("meeting_venues_event_type_label_key", "meeting_venues", type_="unique")

    for name in (
        "meetings_venue_slot_excl",
        "meetings_buyer_slot_excl",
        "meetings_exhibitor_slot_excl",
    ):
        op.execute(f"ALTER TABLE meetings DROP CONSTRAINT IF EXISTS {name}")

    op.execute("DROP INDEX IF EXISTS meetings_active_pair_uniq")

    for name in (
        "meetings_accepted_requires_schedule_check",
        "meetings_schedule_order_check",
        "meetings_rejected_reason_status_check",
        "meetings_cancelled_reason_status_check",
        "meetings_cancelled_by_check",
    ):
        op.drop_constraint(name, "meetings", type_="check")

    op.drop_constraint("meetings_proxy_applied_by_organizer_id_fkey", "meetings", type_="foreignkey")
    op.drop_column("meetings", "proxy_applied_by_organizer_id")

    op.drop_constraint("meetings_rejected_by_org_id_fkey", "meetings", type_="foreignkey")
    for column in ("rejected_reason_text", "rejected_reason_code", "rejected_by_org_id", "rejected_at"):
        op.drop_column("meetings", column)

    op.drop_constraint("meetings_cancelled_by_org_id_fkey", "meetings", type_="foreignkey")
    for column in (
        "cancelled_reason_text", "cancelled_reason_code", "cancelled_by_org_id",
        "cancelled_by", "cancelled_at",
    ):
        op.drop_column("meetings", column)

    op.drop_column("meetings", "request_reason")
    op.drop_constraint("meetings_awaiting_org_id_fkey", "meetings", type_="foreignkey")
    op.drop_column("meetings", "awaiting_org_id")
    op.drop_column("meetings", "updated_at")

    op.drop_column("events", "timezone")

    # 슬롯 길이를 settings로 되돌린다. 값은 events에서 복원(단일화 이전 상태의 최선 근사) —
    # 기본값 30은 events 행이 없을 수 없으므로 사실상 안전망이다.
    op.add_column(
        "event_schedule_settings",
        sa.Column("slot_minutes", sa.Integer(), nullable=False, server_default=sa.text("30")),
    )
    op.execute(
        """
        UPDATE event_schedule_settings s SET slot_minutes = e.slot_minutes
        FROM events e WHERE e.id = s.event_id
        """
    )
    # btree_gist 확장은 남긴다 — 다른 객체가 의존할 수 있고, 확장 제거는 이 마이그레이션의
    # 되돌림 범위(스키마 변경)를 넘어선 클러스터 수준 변경이다.
