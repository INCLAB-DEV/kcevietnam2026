"""러브콜 메일 발송 이력 컬럼 — love_calls 에 email_* 4개 추가 (#13)

Revision ID: lc001mail01
Revises: mt002pair01
Create Date: 2026-09-15

러브콜이 "DB 플래그"에서 **실제로 나가는 메일**이 되면서(#13), 무엇을 언제 누구에게 보냈는지
남길 자리가 필요해졌다. 새 테이블을 만들지 않고 기존 ``love_calls`` 행을 확장한다 — 러브콜
신호와 러브콜 메일은 같은 (미팅, 보낸기업, 받은기업) 축을 공유하는 한 사건이고, 이미 그 축에
UNIQUE 제약이 걸려 있어 중복 발송 방지에 그대로 쓸 수 있기 때문이다.

- ``email_subject`` / ``email_body``: **사용자가 검수·수정해 실제로 보낸** 텍스트. AI 초안이
  아니라 발송본이다(미리보기=발송본). 보낸 쪽이 나중에 "내가 뭐라고 보냈지"를 다시 볼 수 있다.
- ``email_recipient_count``: 그 시점에 실제로 수신한 담당자 수. 나중에 멤버가 늘거나 줄어도
  발송 당시 사실이 보존된다.
- ``email_sent_at``: **중복 발송 판정의 기준.** Step1 의 Love Call 토글은 신호 행만 만들고
  email_* 를 전부 NULL 로 남기므로, "행이 있다"로 판정하면 메일을 한 번도 안 보낸 미팅이
  발송됨으로 잘못 잠긴다.

전부 nullable — 기존 행(메일 없이 만들어진 신호)은 그대로 유효하다. 백필 없음.
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "lc001mail01"
down_revision: Union[str, None] = "mt002pair01"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("love_calls", sa.Column("email_subject", sa.Text(), nullable=True))
    op.add_column("love_calls", sa.Column("email_body", sa.Text(), nullable=True))
    op.add_column("love_calls", sa.Column("email_recipient_count", sa.Integer(), nullable=True))
    op.add_column(
        "love_calls", sa.Column("email_sent_at", sa.DateTime(timezone=True), nullable=True)
    )


def downgrade() -> None:
    # ⚠ 발송 이력이 사라진다 — 되돌리면 "이미 보냈다"를 판정할 수 없어 중복 발송이 가능해진다.
    op.drop_column("love_calls", "email_sent_at")
    op.drop_column("love_calls", "email_recipient_count")
    op.drop_column("love_calls", "email_body")
    op.drop_column("love_calls", "email_subject")
