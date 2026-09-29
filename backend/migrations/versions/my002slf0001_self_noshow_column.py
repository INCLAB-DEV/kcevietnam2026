"""MY-002 "내가 불참" 기록 — post_meeting_reviews.self_noshow(boolean) 추가

Revision ID: my002slf0001
Revises: proxyapp0001
Create Date: 2026-09-16

기존 스키마는 counterpart_noshow(상대방 불참)만 저장했다. Q1에서 "내가 불참"(SELF_NOSHOW)을
고르면 review_capture.build_review는 is_noshow=True/counterpart_noshow=False인 정규형을 만드는데,
저장 시 counterpart_noshow 컬럼만 쓰다 보니 어느 쪽이 불참인지 구분할 방법이 없어 읽어올 때
"불참 아님"으로 되돌아가는 버그가 있었다(리포지토리 round-trip 손실). 이 컬럼으로 "본인 불참"을
그 자체로 저장한다 — 두 불참 플래그는 상호 배타적이다(review_capture.build_review가 보장).

기존 행은 전부 counterpart_noshow만 있었던 시기 데이터라 self_noshow=false로 백필한다(무손실 —
당시엔 self_noshow를 구분해 저장할 방법 자체가 없었으니 false가 유일하게 정직한 기본값).

CHECK 제약(post_meeting_reviews_noshow_exclusive): 두 불참 플래그가 동시에 true가 되면 안 된다
(review_capture.build_review는 proceeded 값 하나로만 결정하므로 저장 경로에서 이미 상호 배타적이지만,
그 불변식을 애플리케이션 코드에만 맡기지 않고 DB 레벨에서도 강제한다 — 회귀 방지). 컬럼이
새로 생기고 기본값이 false라 기존 행에서 이 제약에 걸릴 데이터는 없다.
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "my002slf0001"
down_revision: Union[str, None] = "proxyapp0001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "post_meeting_reviews",
        sa.Column("self_noshow", sa.Boolean(), nullable=False, server_default=sa.text("false")),
    )
    op.create_check_constraint(
        "post_meeting_reviews_noshow_exclusive",
        "post_meeting_reviews",
        "NOT (counterpart_noshow AND self_noshow)",
    )


def downgrade() -> None:
    op.drop_constraint("post_meeting_reviews_noshow_exclusive", "post_meeting_reviews", type_="check")
    op.drop_column("post_meeting_reviews", "self_noshow")
