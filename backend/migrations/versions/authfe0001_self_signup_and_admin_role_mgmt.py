"""자체 회원가입 + 어드민 역할관리 + 행사 영문명 — members.password_hash/phone, events.name_en

Revision ID: authfe0001
Revises: adminnt0001
Create Date: 2026-08-28

개발계획서 §7.3(홈페이지 자체 회원가입) 요구 확정에 따라 ADR-0007 "공개 자체 회원가입은 열지
않는다"를 발주자 지시로 부분 supersede한다: **회원가입으로는 참가사(exhibitor)/바이어(buyer)만
될 수 있다.** 슈퍼어드민(event master)은 어떤 API로도 생성되지 않는다 — 오직 DB 직접 부여
(backend/README.md "슈퍼어드민 부여" 절 참고). 이 리비전은 그 자체가입 계정을 담을 컬럼과, FE
어드민 콘솔이 요구한 행사 영문명 컬럼을 함께 얹는다(같은 슬라이스로 묶여 들어온 변경 — adminvn0001
선례처럼 서로 겹치는 테이블·컬럼이 없는 독립 컬럼 추가라 한 리비전으로 번들).

1. **members.password_hash**(nullable, Text) — bcrypt 해시. 명단 임포트로 생긴 담당자(로그인은
   여전히 DX Korea 검증)는 NULL로 남는다. members.email은 이미 초기 스키마(416bbb825e07)부터
   NOT NULL UNIQUE라 이메일 쪽엔 추가 제약이 필요 없다(부분 유니크 인덱스 불필요 — 이미 전
   레코드 유일값 강제됨, 기존 데이터와 충돌 없음).
2. **members.phone**(nullable, Text) — 회원가입 폼의 선택 연락처.
3. **events.name_en**(nullable, Text) — 행사명 영문. FE 어드민 콘솔이 한/영 다국어를 긴급 요건으로
   확정했다(기존 ``name``은 국문 전용으로 계속 쓰고, 영문은 이 컬럼에 별도 저장).
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "authfe0001"
down_revision: Union[str, None] = "adminnt0001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("members", sa.Column("phone", sa.Text(), nullable=True))
    op.add_column("members", sa.Column("password_hash", sa.Text(), nullable=True))
    op.add_column("events", sa.Column("name_en", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("events", "name_en")
    op.drop_column("members", "password_hash")
    op.drop_column("members", "phone")
