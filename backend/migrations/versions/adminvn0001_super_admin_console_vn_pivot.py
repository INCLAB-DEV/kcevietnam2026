"""슈퍼어드민 콘솔 + 베트남 피벗 — 행사 CRUD/정책 컬럼·통역사 배정·대리작성 감사·운영자 신원 브릿지

Revision ID: adminvn0001
Revises: c71c40959ae7
Create Date: 2026-08-28

베트남 전시 버전 피벗(#OP 슈퍼어드민 콘솔)에서 확정된 요구를 스키마로 반영한다:

1. **events 정책 컬럼(행사마다 다시 정할 수 있게, 하드코딩 금지)**:
   - ``slot_minutes``(미팅 슬롯 길이, 10/20/30/60 중 선택 — 기본 30)
   - ``venue_name``·``exhibition_start``/``exhibition_end``(전시장·전시 기간 — 슈퍼어드민이 행사 생성 시 입력)
   - ``enabled_venue_types``(이 행사에서 쓰는 미팅 장소 유형 부분집합 — meeting_venues.venue_type과 동일
     값집합. 베트남 행사는 booth만 켤 수 있게 3종 전부를 기본으로 깔고 운영자가 좁힌다)
   - ``allow_same_role_discovery``(참가사↔참가사·바이어↔바이어 상호 열람 허용 여부 — 개발계획서 §8,
     기본 false. app.domain.visibility_rules가 소비)

2. **organizers.member_id** — 운영자 가드(app.auth.organizer_guard)가 인증하는 "회원ID"와 이 행 사이의
   브릿지. 실 Cognito 운영자 어댑터가 아직 없어(organizer_guard 자체 문서화된 갭) 어드민 서비스가 최초
   접근 시 get-or-create로 채운다. nullable·unique — 기존 행에는 값 없음(문제 없음, 지연 백필).

3. **organization_event_roles.proxy_written_by_organizer_id** — 신청서 대리작성(엑셀 임포트만 되고
   회원가입 안 한 기업을 슈퍼어드민이 대신 작성) 감사. 채워져도 application_status는 그대로
   'registered'(=미신청) — 이 컬럼 자체는 상태를 바꾸지 않는다(앱 로직이 게이트).

4. **interpreters / interpreter_assignments** — 참가기업별 통역사 배정(회의록 작성은 통역사 몫이나
   통역사 로그인 계정 체계는 추후). 한 기업은 행사당 통역사 하나(unique(event, organization) — 재배정은
   기존 배정을 갈아끼움), 한 통역사는 여러 기업을 맡을 수 있다.
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "adminvn0001"
down_revision: Union[str, None] = "c71c40959ae7"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # --- 1. events 정책/일정 컬럼 --------------------------------------------
    op.add_column("events", sa.Column("venue_name", sa.Text(), nullable=True))
    op.add_column("events", sa.Column("exhibition_start", sa.Date(), nullable=True))
    op.add_column("events", sa.Column("exhibition_end", sa.Date(), nullable=True))
    op.add_column(
        "events",
        sa.Column("slot_minutes", sa.Integer(), nullable=False, server_default=sa.text("30")),
    )
    op.create_check_constraint(
        "events_slot_minutes_check", "events", "slot_minutes IN (10, 20, 30, 60)"
    )
    op.add_column(
        "events",
        sa.Column(
            "enabled_venue_types",
            postgresql.ARRAY(sa.Text()),
            nullable=False,
            server_default=sa.text("'{booth,zone_table,business_room}'"),
        ),
    )
    op.create_check_constraint(
        "events_enabled_venue_types_check",
        "events",
        "enabled_venue_types <@ ARRAY['booth', 'zone_table', 'business_room']::text[]",
    )
    op.add_column(
        "events",
        sa.Column(
            "allow_same_role_discovery", sa.Boolean(), nullable=False, server_default=sa.text("false")
        ),
    )

    # --- 2. organizers 운영자 신원 브릿지 ------------------------------------
    op.add_column("organizers", sa.Column("member_id", sa.Text(), nullable=True))
    op.create_unique_constraint("organizers_member_id_key", "organizers", ["member_id"])

    # --- 3. 대리작성 감사 -----------------------------------------------------
    op.add_column(
        "organization_event_roles",
        sa.Column(
            "proxy_written_by_organizer_id",
            postgresql.UUID(as_uuid=False),
            sa.ForeignKey("organizers.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )

    # --- 4. 통역사 배정 ---------------------------------------------------------
    op.create_table(
        "interpreters",
        sa.Column("id", postgresql.UUID(as_uuid=False), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("event_id", postgresql.UUID(as_uuid=False), sa.ForeignKey("events.id", ondelete="CASCADE"), nullable=False),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("languages", postgresql.ARRAY(sa.Text()), nullable=True),
        sa.Column("phone", sa.Text(), nullable=True),
        sa.Column("email", sa.Text(), nullable=True),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.CheckConstraint(
            "languages <@ ARRAY['ko', 'en', 'zh', 'ja', 'ru', 'other']::text[]",
            name="interpreters_languages_check",
        ),
    )
    op.create_table(
        "interpreter_assignments",
        sa.Column("id", postgresql.UUID(as_uuid=False), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("interpreter_id", postgresql.UUID(as_uuid=False), sa.ForeignKey("interpreters.id", ondelete="CASCADE"), nullable=False),
        sa.Column("organization_id", postgresql.UUID(as_uuid=False), sa.ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False),
        sa.Column("event_id", postgresql.UUID(as_uuid=False), sa.ForeignKey("events.id", ondelete="CASCADE"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.UniqueConstraint("event_id", "organization_id", name="interpreter_assignments_event_id_organization_id_key"),
    )


def downgrade() -> None:
    op.drop_table("interpreter_assignments")
    op.drop_table("interpreters")

    op.drop_column("organization_event_roles", "proxy_written_by_organizer_id")

    op.drop_constraint("organizers_member_id_key", "organizers", type_="unique")
    op.drop_column("organizers", "member_id")

    op.drop_column("events", "allow_same_role_discovery")
    op.drop_constraint("events_enabled_venue_types_check", "events", type_="check")
    op.drop_column("events", "enabled_venue_types")
    op.drop_constraint("events_slot_minutes_check", "events", type_="check")
    op.drop_column("events", "slot_minutes")
    op.drop_column("events", "exhibition_end")
    op.drop_column("events", "exhibition_start")
    op.drop_column("events", "venue_name")
