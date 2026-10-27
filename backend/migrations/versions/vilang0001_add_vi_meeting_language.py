"""add 'vi' (Vietnamese) to MEETING_LANGUAGES check constraints

Revision ID: vilang0001
Revises: op005sat0001
Create Date: 2026-09-09

2026 베트남 K-콘텐츠 엑스포 대응 — 상담·참가자·통역 언어 허용집합에 'vi'(베트남어) 추가.
``MEETING_LANGUAGES``가 (ko,en,zh,ja,ru,other) → (+vi)로 바뀌면서, 그 집합을 강제하는
``col <@ ARRAY[...]::text[]`` CHECK 제약 5개(interpreters/exhibitor_profiles/buyer_attendees×2/
exhibitor_attendees)를 재생성한다. 없으면 pydantic이 통과시켜도 DB INSERT가 IntegrityError로 막힌다.

drop은 이름 기준 ``IF EXISTS``라 기존 표현식 포맷과 무관하게 안전하다(멱등).
"""

from alembic import op

revision = "vilang0001"
down_revision = "op005sat0001"
branch_labels = None
depends_on = None

# (constraint_name, table, column)
_CONSTRAINTS = [
    ("interpreters_languages_check", "interpreters", "languages"),
    ("exhibitor_profiles_available_languages_check", "exhibitor_profiles", "available_languages"),
    ("buyer_attendees_languages_check", "buyer_attendees", "languages"),
    ("buyer_attendees_interpreter_languages_check", "buyer_attendees", "interpreter_languages"),
    ("exhibitor_attendees_languages_check", "exhibitor_attendees", "languages"),
]

_NEW = "ARRAY['ko', 'en', 'zh', 'ja', 'ru', 'vi', 'other']::text[]"
_OLD = "ARRAY['ko', 'en', 'zh', 'ja', 'ru', 'other']::text[]"


def _rebuild(allowed: str) -> None:
    for name, table, col in _CONSTRAINTS:
        op.execute(f"ALTER TABLE {table} DROP CONSTRAINT IF EXISTS {name}")
        op.execute(f"ALTER TABLE {table} ADD CONSTRAINT {name} CHECK ({col} <@ {allowed})")


def upgrade() -> None:
    _rebuild(_NEW)


def downgrade() -> None:
    _rebuild(_OLD)
