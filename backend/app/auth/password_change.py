"""참가자 셀프 비밀번호 변경 — 도메인 규칙 한 가지(발주자 요구사항 2026-09-30).

명단 업로드(``app.roster``)가 공통 비밀번호를 일괄로 심어놓은 상태라, 참가사 담당자가 자기 로그인
비밀번호를 스스로 바꿀 경로가 없었다. 이 모듈이 그 규칙 하나를 소유한다 — **현재 비밀번호를 아는
사람만** 자기 ``members.password_hash``를 새 해시로 갈아끼운다.

이 코드를 ``app.auth`` 슬라이스에 둔 이유: 비밀번호 정책·해시의 정본(``credentials``)과 로컬 로그인
검증(``local_verify``)이 여기 있고, 셀프 변경은 그 둘의 조합일 뿐이라 새 규칙을 만들지 않는다.
HTTP 경로는 ``POST /api/me/change-password``지만 ``GET /api/me``를 소유한 ``app.discover``에는 넣지
않았다 — 그쪽은 "기업 탐색 + 뷰어 참가 컨텍스트" 슬라이스라 자격증명 변경을 끼워 넣으면 슬라이스
책임이 흐려진다(URL prefix가 같다는 사실이 슬라이스 소유권을 결정하지는 않는다). 라우터는
``app.auth.password_router``가 같은 ``/api/me`` prefix로 따로 붙인다.

⚠ 세션 자체는 Cognito가 발급하지만 **로그인에 쓰는 비밀번호는 ``members.password_hash``**다
(``LocalCredentialVerifier``가 email+bcrypt로 검증한다) — 그래서 이 해시만 갈아끼우면 다음 로그인에
곧바로 반영된다. Cognito 쪽 비밀번호는 **의도적으로 건드리지 않는다**: 유저풀 계정은 세션 발급용
컨테이너일 뿐 로그인 자격증명이 아니라, 거기까지 동기화하면 두 개의 진실이 생긴다
(2026-09-30, 발주자 요구사항).

⚠ 평문은 이 모듈 밖으로 새지 않는다 — 예외 메시지·로그·반환값에 입력값을 싣지 않는다.
"""

from __future__ import annotations

import uuid

from sqlalchemy.orm import Session

from app.auth.credentials import check_password, check_password_policy, hash_password
from app.db import release_connection
from app.models import Member


class PasswordChangeError(Exception):
    """셀프 비밀번호 변경 실패의 공통 조상 — HTTP 환산은 ``password_router`` 한 곳에서만 한다."""


class NoLocalPasswordError(PasswordChangeError):
    """회원 행이 없거나 ``password_hash``가 NULL — 로컬 비밀번호로 로그인하는 계정이 아니다.

    입력값 오류가 아니라 **계정 상태와의 충돌**이라 라우터가 422가 아니라 409로 환산한다
    (DX Korea 검증 대상 계정·데모 토큰 주체가 여기로 떨어진다).
    """


class InvalidCurrentPasswordError(PasswordChangeError):
    """현재 비밀번호 불일치. 메시지는 어느 필드가 왜 틀렸는지 이상을 알려주지 않는다."""


class PasswordPolicyViolationError(PasswordChangeError):
    """새 비밀번호가 정책(``app.auth.credentials``) 위반. 메시지는 정책 문구 그대로(입력값 없음)."""


class SamePasswordError(PasswordChangeError):
    """새 비밀번호가 지금 쓰는 것과 같다 — 바꾸지 않았으므로 성공으로 취급하지 않는다."""


def _member_or_none(db: Session, member_id: str) -> Member | None:
    """``members.id``로 회원을 읽는다. UUID가 아닌 주체면 조회 자체를 하지 않고 None.

    ⚠ UUID 여부를 **조회 전에** 판별해야 한다. ``members.id``는 uuid 컬럼이라 비-UUID 문자열을
    비교에 넣으면 Postgres가 22P02로 트랜잭션을 깨고 500이 난다. 주체 키가 비-UUID인 경우는
    실제로 있다 — 데모 로그인은 ``registrants.organizer_member_id``(``mbr-buyer-01`` 등)를 싣는다
    (``app.auth.principal._demo_principal`` 참고). 그 주체는 애초에 로컬 비밀번호가 없으므로
    호출부에서 ``NoLocalPasswordError``(409)로 흐르는 것이 맞다.
    """
    try:
        uuid.UUID(member_id)
    except (ValueError, AttributeError, TypeError):
        return None
    return db.get(Member, member_id)


def change_member_password(
    db: Session, *, member_id: str, current_password: str, new_password: str
) -> None:
    """현재 비밀번호를 확인하고 ``members.password_hash``를 새 해시로 바꾼다(성공 시 commit).

    검사 순서는 고정이다 — 계정 상태(로컬 비밀번호 있음) → 현재 비밀번호 일치 → 새 비밀번호 정책
    → 기존과 동일 여부. 현재 비밀번호 검증을 정책 판정보다 **앞에** 두는 게 중요하다: 뒤로 미루면
    남의 계정에 대고 정책 문구를 떠볼 수 있다. 동일 여부를 정책 뒤에 두는 것도 의도적이다 —
    정책 위반인 값은 "같다"가 아니라 정책 문구로 안내해야 화면이 엉뚱한 말을 하지 않는다.

    Raises:
        NoLocalPasswordError: 회원 행 없음 또는 ``password_hash`` NULL(409).
        InvalidCurrentPasswordError: 현재 비밀번호 불일치(403). 대조하는 사이 비밀번호가 바뀐 경우도 여기다.
        PasswordPolicyViolationError: 새 비밀번호 정책 위반(422).
        SamePasswordError: 새 비밀번호가 기존과 동일(422).
        PasswordHashBusyError: 해시 자리를 못 얻음 — 대기열 가득·대기 시간 초과(앱 전역 핸들러가 503 server_busy로 바꾼다).

    커넥션: bcrypt 두 번(대조·새 해시, 각 0.2~0.3초 CPU + 자리 대기) 동안 요청 세션의 커넥션을 쥐지 않는다 —
    해시 값만 읽어 두고 놓았다가(``release_connection`` — 여기까지 인증 조회와 이 조회, 읽기뿐이다) 쓸 때 다시
    읽는다. 다시 읽은 해시가 대조한 해시와 다르면 그 사이 비밀번호가 바뀐 것이라(다른 탭·운영자 재설정) 방금
    확인한 "현재 비밀번호"가 더 이상 현재 값이 아니다 — 덮어쓰지 않고 불일치로 돌려보낸다.
    """
    member = _member_or_none(db, member_id)
    if member is None or member.password_hash is None:
        # 회원 없음/해시 없음을 구분하지 않는다(열거 공격 완화, local_verify와 동일 관례).
        raise NoLocalPasswordError("이 계정은 비밀번호로 로그인하지 않습니다")
    verified_hash = member.password_hash
    release_connection(db)

    # 검증 방식은 LocalCredentialVerifier와 같은 check_password(bcrypt)다. 그 클래스를 그대로 재사용하지
    # 않은 건 조회 키가 달라서다 — 그쪽은 email로 찾는데, 여기선 이미 인증된 주체(principal.member_id)
    # 로 찾아야 "남의 이메일로 비밀번호를 바꾸는" 경로가 아예 생기지 않는다.
    if not check_password(current_password, verified_hash):
        raise InvalidCurrentPasswordError("현재 비밀번호가 일치하지 않습니다")

    try:
        check_password_policy(new_password)
    except ValueError as exc:
        # ⚠ 원인 체인을 끊는다(``from None``) — 평문이 traceback으로도 새지 않게(admin.router._hash_or_422 미러).
        raise PasswordPolicyViolationError(str(exc)) from None

    # 현재 비밀번호가 이미 "지금 쓰는 값"으로 증명됐으므로 평문 비교로 충분하다(bcrypt 한 번 더 돌릴 이유 없음).
    if new_password == current_password:
        raise SamePasswordError("새 비밀번호가 기존 비밀번호와 같습니다")

    new_hash = hash_password(new_password)
    # 닫힌 세션이 새 커넥션으로 다시 읽는다(close가 식별 맵을 비워 db.get도 DB에 묻는다). FOR UPDATE로 행을 잠가
    # 비교와 쓰기 사이에 다른 변경이 끼지 못하게 한다 — 잠금은 아래 commit까지 수 ms뿐이다.
    member = db.get(Member, member_id, with_for_update=True)
    if member is None or member.password_hash is None:
        raise NoLocalPasswordError("이 계정은 비밀번호로 로그인하지 않습니다")
    if member.password_hash != verified_hash:
        raise InvalidCurrentPasswordError("현재 비밀번호가 일치하지 않습니다")
    member.password_hash = new_hash
    db.commit()
