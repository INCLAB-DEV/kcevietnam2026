"""계정 자격증명 규칙 단일 정본 — 이메일 형식·비밀번호 정책·비밀번호 해시·해시 대조.

자체 회원가입(app.auth.signup_schemas/signup_service)과 명단 업로드의 공통 비밀번호
(app.roster — 운영자가 올린 명단 계정에 일괄 적용)가 **같은 규칙**을 쓴다. 두 경로가 규칙을 따로
들면 "가입으론 안 되는 비밀번호가 명단으론 들어가는" 드리프트가 생기므로 여기 한 곳에만 둔다.

bcrypt는 이 모듈을 거쳐서만 부른다(``hash_password``/``check_password``) — 둘 다 프로세스 전체의 동시 실행
자리(``password_hash_slot``)를 잡고 돈다. bcrypt 1회는 0.2~0.3초짜리 CPU 작업이라, 로그인이 몰리면 상한
없이는 해시들이 CPU 2개를 나눠 쓰며 전부 함께 느려졌다(설정 ``password_hash_max_concurrency`` 주석).
⚠ 자리를 기다리는 시간까지 생각해, 호출부는 **해시 전에 DB 커넥션을 놓는다**(app.db.release_connection) —
대기·해시 동안 커넥션을 쥐고 있으면 풀이 고갈돼 DB를 잠깐만 쓰는 다른 API까지 멈춘다. 로그인·자체가입·셀프
비밀번호 변경이 그렇게 한다. 운영자 경로(명단 공통 비밀번호·담당자 비밀번호)만 예외다 — 가드가 flush만 해 둔
쓰기를 롤백하지 않으려고 커넥션을 쥔 채 요청당 1번 해시한다(app.admin.router._hash_or_422 주석).

⚠ 평문 비밀번호는 이 모듈 밖으로 새지 않게 다룬다 — 검증 실패 메시지에 입력값을 싣지 않고,
해시만 돌려준다(로그·응답·원본 보관 어디에도 평문을 남기지 않는 것은 호출부 책임).
"""

from __future__ import annotations

import logging
import re
import threading
from collections.abc import Iterator
from contextlib import contextmanager

import bcrypt

from app.config import settings

logger = logging.getLogger(__name__)

# EmailStr(email-validator 의존성 추가)까지는 과하다고 판단 — 형식만 가볍게 검사한다.
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")

# 최소 8자 + 영문·숫자 혼합(요구사항 §7.3). 특수문자는 요구하지 않는다(과설계 방지).
PASSWORD_MIN_LENGTH = 8
# bcrypt(설치된 5.0.0으로 실측)는 72바이트를 넘는 입력에 ValueError를 던진다("password cannot be
# longer than 72 bytes") — 자르지 않고 아예 거부한다. UTF-8에서 한글·이모지는 문자당 여러 바이트라
# len(password)(문자 수)로는 못 잡으므로 여기서 바이트 길이로 직접 검사한다. 이 정책을 통과하는
# 어떤 비밀번호로 해시를 걸어도(hash_password) bcrypt가 500을 던질 일이 없다는 게 이 상수의 존재
# 이유다 — 자체가입·명단 업로드·비밀번호 재설정 전부 여기 하나만 통과하면 안전하다.
PASSWORD_MAX_BYTES = 72
PASSWORD_POLICY_MESSAGE = f"비밀번호는 최소 {PASSWORD_MIN_LENGTH}자, 영문+숫자를 포함해야 합니다"
PASSWORD_TOO_LONG_MESSAGE = f"비밀번호는 최대 {PASSWORD_MAX_BYTES}바이트(UTF-8 기준)까지 가능합니다"

#: 정책 위반 422 응답의 ``detail.code`` — 화면이 문구가 아니라 코드로 갈라 쓴다(프론트 번역 키와
#: 동일 문자열). 비밀번호를 받는 모든 경로(명단 업로드·단건 등록·비밀번호 재설정)가 공유한다.
PASSWORD_POLICY_ERROR = "PASSWORD_POLICY"


def is_valid_email(value: str) -> bool:
    """이메일 형식 검사(정규화 전 값도 받는다 — 앞뒤 공백은 무시)."""
    return bool(EMAIL_RE.match(value.strip()))


def check_password_policy(password: str) -> str:
    """비밀번호 정책 위반이면 ValueError(메시지에 입력값을 담지 않는다), 통과하면 그대로 반환."""
    if (
        len(password) < PASSWORD_MIN_LENGTH
        or not re.search(r"[A-Za-z]", password)
        or not re.search(r"[0-9]", password)
    ):
        raise ValueError(PASSWORD_POLICY_MESSAGE)
    if len(password.encode("utf-8")) > PASSWORD_MAX_BYTES:
        raise ValueError(PASSWORD_TOO_LONG_MESSAGE)
    return password


class PasswordHashBusyError(RuntimeError):
    """bcrypt 자리를 얻지 못했다 — 대기열이 이미 꽉 찼거나(즉시) 제한 시간 안에 차례가 오지 않았다. 지금 몰려 있으니
    잠시 후 다시 시도할 일이다.

    로그인은 503 ``login_busy``로(app.auth.login_router), 그 밖의 경로는 앱 전역 핸들러가 503 ``server_busy``로
    바꾼다(app.main) — 어느 쪽이든 500으로 새지 않는다.
    """


_slots_lock = threading.Lock()
_hash_semaphore: threading.BoundedSemaphore | None = None
# 지금 자리를 **기다리는** 요청 수(자리를 잡고 해시 중인 요청은 세지 않는다). ``_slots_lock`` 아래에서만 바꾼다.
# ``reset_password_hash_slots``가 비우지 않는다 — 기다리던 요청이 끝날 때 각자 돌려준다(ai_concurrency 대기열 셈과 같은 규약).
_waiting = 0


def _hash_slots() -> threading.BoundedSemaphore:
    """첫 사용 시점의 설정으로 만든다(app.services.ai_concurrency의 자리 장치와 같은 지연 생성 규약)."""
    global _hash_semaphore
    with _slots_lock:
        if _hash_semaphore is None:
            _hash_semaphore = threading.BoundedSemaphore(settings.password_hash_max_concurrency)
        return _hash_semaphore


def reset_password_hash_slots() -> None:
    """자리 장치를 비운다 — 다음 사용 때 현재 설정으로 다시 만든다(설정을 바꿔 가며 검증하는 테스트용).

    지금 자리를 쥔 해시는 옛 세마포어에 반납하므로 새 장치의 셈에 섞이지 않는다. 대기 수는 그대로 둔다(위 주석).
    """
    global _hash_semaphore
    with _slots_lock:
        _hash_semaphore = None


def password_hash_waiters() -> int:
    """지금 해시 자리를 기다리는 요청 수 — 로그·테스트용."""
    with _slots_lock:
        return _waiting


@contextmanager
def password_hash_slot(timeout: float | None = None) -> Iterator[None]:
    """bcrypt 1회의 자리를 잡는다. 못 잡으면 ``PasswordHashBusyError``.

    - 빈 자리가 있으면 기다리지 않고 바로 잡는다(대기 수에 들어가지 않는다).
    - 없으면 대기열에 선다 — 단 이미 ``password_hash_max_waiters``명이 기다리는 중이면 서지 않고 **즉시** 거절한다.
      기다리는 요청도 AnyIO 스레드 토큰(프로세스 전체 40개)을 쥐고 있어서, 대기를 무한정 받으면 로그인이 몰린
      순간 스레드가 바닥나 해시와 무관한 다른 동기 API까지 멈춘다. 상한이면 해시에 묶이는 스레드는 최대
      자리 수 + 대기 상한(기본 2 + 12 = 14)이고, 나머지(≥26)는 다른 API 몫으로 남는다.
    - 대기는 ``timeout``(기본 설정값)까지 — 넘으면 거절한다.
    대기 수는 잠금 아래에서 세고, 대기를 마치는 모든 경로(자리 얻음·시간 초과·예외)에서 되돌린다.

    bcrypt(5.x)는 해시하는 동안 GIL을 놓아 스레드마다 CPU 코어를 하나씩 쓴다 — 그래서 동시에 도는 개수를 묶는
    것이 곧 CPU 점유를 묶는 것이다. ⚠ 자리를 기다리는 동안 요청 스레드는 묶여 있으므로, 호출부는 DB 커넥션을
    먼저 놓고 이걸 부른다(모듈 독스트링 — 예외 경로 포함).
    """
    global _waiting
    semaphore = _hash_slots()
    if not semaphore.acquire(blocking=False):
        with _slots_lock:
            if _waiting >= settings.password_hash_max_waiters:
                raise PasswordHashBusyError("비밀번호 해시 대기열이 꽉 찼다")
            _waiting += 1
        try:
            wait = settings.password_hash_acquire_timeout_seconds if timeout is None else timeout
            acquired = semaphore.acquire(timeout=wait)
        finally:
            with _slots_lock:
                _waiting -= 1
        if not acquired:
            raise PasswordHashBusyError("비밀번호 해시 자리 대기 시간 초과")
    try:
        yield
    finally:
        semaphore.release()


# 패스워드 해시 라이브러리 선택: argon2-cffi 대비 bcrypt가 가볍다 — cffi 빌드체인이 따로 필요 없는
# 단일 순수 C 확장이고(argon2-cffi는 이름 그대로 cffi 의존), 이미 psycopg[binary]로 네이티브 의존성을
# 최소화하는 이 프로젝트 기조와 맞는다. cost factor는 bcrypt 기본값(gensalt() 기본 12 rounds)을 쓴다.
def hash_password(password: str) -> str:
    """bcrypt 해시(alg-cost-salt-hash 인코딩 문자열). 대조는 ``check_password``로 한다.

    자리(``password_hash_slot``)를 잡고 돈다 — 못 잡으면 ``PasswordHashBusyError``. 되도록 DB 커넥션을 놓고 부른다.
    """
    with password_hash_slot():
        return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def check_password(password: str, password_hash: str) -> bool:
    """평문이 저장된 bcrypt 해시와 맞는지 — 로그인 검증(app.auth.local_verify)·셀프 비밀번호 변경이 쓴다.

    ``hash_password``와 같은 자리를 잡고 돈다 — 못 잡으면 ``PasswordHashBusyError``. DB 커넥션을 쥔 채 부르지 않는다.

    - 72바이트(``PASSWORD_MAX_BYTES``)를 넘는 입력은 대조 없이 False다 — 정책상 그런 비밀번호는 저장될 수 없고
      (``check_password_policy``), bcrypt는 이 길이에 ValueError를 던져 로그인이 500으로 끝났다. 자리도 쓰지 않는다.
    - 저장된 해시가 bcrypt 형식이 아니면(데이터 손상) 불일치로 덮지 않고 로그를 남긴 채 예외를 올린다(→ 500).
      로그에 해시·평문은 싣지 않는다.
    """
    candidate = password.encode("utf-8")
    if len(candidate) > PASSWORD_MAX_BYTES:
        return False
    with password_hash_slot():
        try:
            return bcrypt.checkpw(candidate, password_hash.encode("utf-8"))
        except ValueError:
            # 길이는 위에서 걸렀으니 여기 오는 ValueError는 저장된 해시 쪽 문제(예: "Invalid salt")다.
            logger.error("저장된 비밀번호 해시가 bcrypt 형식이 아니다 — 계정 데이터 확인 필요")
            raise
