"""F-NT-001 참가자 알림 메일 — 행사가 자동 알림의 이메일 발송을 켜고 끈다(기본: 꺼짐)

Revision ID: nt004mail0001
Revises: nv001menu0001
Create Date: 2026-10-16

발주사 요청(2026-10-16): 베트남 바이어 명단을 받아 운영 담당자가 직접 비즈매칭 신청 절차를 대신 밟는다.
그동안 신청 완료·매칭 확정 같은 알림이 참가기업·바이어 이메일로 나가지 않게 막아 달라. 담당자는 운영
콘솔(대리작성·승인·강제 배정·포화 배정 확정)로도, 공통 비밀번호로 참가자 계정에 직접 로그인해서도
조작한다 — 백엔드는 후자를 참가자 본인과 구분할 수 없으므로(``Principal`` 에 운영자 표식이 없다) "누가
했는가"가 아니라 **행사 단위 스위치**로 막는다. 이 플랫폼은 행사마다 재사용하므로(ADR-0012) 행사 설정값이다.

``event_schedule_settings.participant_email_enabled`` (boolean, NOT NULL, default ``false``):

- ``false`` — **기본**. 자동 알림(``app.notifications.service`` 를 거치는 8종)의 인앱 알림은 그대로 남기고,
  이메일 등 외부 채널은 보내지 않는다. 보냈을 수신자마다 dispatch 를 ``status='skipped'``,
  ``error='event_email_disabled'`` 로 남겨 알림 콘솔에서 "보내지 않음"으로 보인다.
- ``true`` — 이 설정이 생기기 전과 같다. 자동 알림이 인앱 + 이메일로 나간다. 마스터가 행사 설정에서 켠다.

**기본값이 ``false`` 인 건 발주사 결정이다(2026-10-16)**: 배포하는 순간 모든 행사의 자동 알림 메일이
멈춰야 하고, 누가 설정을 따로 끌 필요가 없어야 한다. 그래서 ``server_default`` 가 **기존 행도 전부
``false`` 로 백필**하고, 설정 행이 아직 없는 행사도 읽는 쪽이 ``false`` 로 취급한다
(``app.models.DEFAULT_PARTICIPANT_EMAIL_ENABLED`` — 폴백은 전부 그 상수 하나를 본다).

⚠ **이 리비전은 무동작 변화가 아니다.** 컬럼만으로는 아무 일도 없지만(구 코드는 이 컬럼을 읽지 않는다),
이 컬럼을 읽는 코드가 올라오는 순간 모든 행사의 자동 알림 메일이 멈춘다. 메일을 보낼 행사는 배포 후 행사
설정에서 켠다. 다시 켜도 꺼져 있던 동안의 메일을 몰아서 보내지 않는다(백필 없음 — 필요하면 알림 콘솔에서
개별 재발송).

**대상이 아닌 메일**: 회원가입 이메일 인증 코드, 러브콜 메일(참가자가 직접 써서 '보내기'를 누르는 명시적
발송). 둘 다 알림 서비스를 거치지 않고 이 값을 읽지 않는다.
(이 리비전 시점의 범위다. 같은 날 발주사 요구 "어떠한 메일도"로 러브콜 메일도 이 값을 따르게 됐다 — 스키마
변화 없이 app/api/love_call.py가 읽는다. 지금 범위는 F-NT-001 "행사별 참가자 알림 메일 스위치" 절.)

**``events`` 가 아닌 ``event_schedule_settings`` 에 두는 이유**: ``events`` 는 레포 밖 읽기 전용 계정이
직접 읽는 테이블이라 스키마를 건드리지 않는다(``nv001menu0001`` 과 같은 자리).

boolean 이라 CHECK 는 필요 없다. 기본값은 이 리비전 시점의 스냅샷으로 여기 적는다(``nv001menu0001`` 과 같은
방식) — 나중에 기본값이 바뀌면 그 리비전이 고친다.
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "nt004mail0001"
down_revision: Union[str, None] = "nv001menu0001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

# ALTER TABLE은 ACCESS EXCLUSIVE 잠금을 기다린다. 운영 중인 앱이 이 테이블을 읽는 트랜잭션을 오래 쥐고 있으면
# 무한정 기다리고, 그 사이 이 테이블을 읽으려는 모든 요청이 그 뒤에 줄을 선다(행사 설정·알림 발송이 멈춘다).
# 3초 안에 잠금을 못 얻으면 이 마이그레이션이 실패하고 끝나게 한다 — 다시 돌리면 된다. env.py가 마이그레이션을
# 한 트랜잭션 안에서 돌리므로(PostgreSQL transactional DDL) SET LOCAL은 그 트랜잭션이 끝나면 풀린다(같은 실행에서
# 이 뒤에 도는 리비전에도 남는다 — 그 리비전도 같은 상한을 받는다). 실패하면 트랜잭션 전체가 되돌아가고, 배포
# 스크립트(standalone-deploy: set -e)는 새 컨테이너를 올리기 전에 멈춘다 — 옛 코드는 이 컬럼 없이도 돈다.
_LOCK_TIMEOUT = "SET LOCAL lock_timeout = '3s'"


def upgrade() -> None:
    op.execute(_LOCK_TIMEOUT)
    op.add_column(
        "event_schedule_settings",
        sa.Column(
            "participant_email_enabled",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("false"),
        ),
    )


def downgrade() -> None:
    # 켜 둔 행사가 있어도 그대로 내려간다 — 그 선택은 컬럼과 함께 사라지고(다시 올리면 전부 기본값 false 다),
    # 이 컬럼을 모르는 구 코드는 모든 행사에 메일을 보낸다. 이 컬럼을 읽는 코드를 먼저 내린 뒤에 실행한다:
    # 컬럼이 없으면 알림 발송·행사 설정 조회가 실패한다.
    op.execute(_LOCK_TIMEOUT)
    op.drop_column("event_schedule_settings", "participant_email_enabled")
