"""seed v1 consent documents (F-AU-001 / ADR-0009)

v1 약관 5종을 consent_documents에 시드한다 — 항목별 분리 동의(한국 개인정보보호법).
필수: 서비스 이용·개인정보 수집이용·민감정보(방산) 처리·제3자 제공(매칭은 상대 기업에
정보 제공이 핵심 기능이라 필수). 선택: 마케팅 수신.
UNIQUE(type, version) 가 멱등 보장 — 같은 v1을 중복 시드하지 않는다.

Revision ID: a1c0n5ent0001
Revises: e93488b8bc96
Create Date: 2026-06-23
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "a1c0n5ent0001"
# main 최신 head(BM-001 e93488b8bc96) 뒤에 선형으로 잇는다 — 멀티 head 방지.
down_revision: Union[str, None] = "e93488b8bc96"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

# v1 약관 정의(프리즈된 스냅샷). 본문(content_url)은 약관 원문 확정 후 별도 개정으로 채운다.
_VERSION = "v1"
_EFFECTIVE = "2026-06-01"
_DOCS = [
    ("tos", "서비스 이용약관", True),
    ("privacy", "개인정보 수집·이용 동의", True),
    ("sensitive", "민감정보(방산) 처리 동의", True),
    ("third_party", "개인정보 제3자 제공 동의", True),
    ("marketing", "마케팅 정보 수신 동의", False),
]

_consent_documents = sa.table(
    "consent_documents",
    sa.column("type", sa.Text),
    sa.column("title", sa.Text),
    sa.column("version", sa.Text),
    sa.column("is_required", sa.Boolean),
    sa.column("effective_date", sa.Date),
)


def upgrade() -> None:
    op.bulk_insert(
        _consent_documents,
        [
            {
                "type": t,
                "title": title,
                "version": _VERSION,
                "is_required": required,
                "effective_date": _EFFECTIVE,
            }
            for (t, title, required) in _DOCS
        ],
    )


def downgrade() -> None:
    types = ", ".join(f"'{t}'" for (t, _, _) in _DOCS)
    op.execute(
        sa.text(
            f"DELETE FROM consent_documents WHERE version = '{_VERSION}' AND type IN ({types})"
        )
    )
