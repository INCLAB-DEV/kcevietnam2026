"""계정 자격증명 규칙 단일 정본 — 이메일 형식·비밀번호 정책·비밀번호 해시.

자체 회원가입(app.auth.signup_schemas/signup_service)과 명단 업로드의 공통 비밀번호
(app.roster — 운영자가 올린 명단 계정에 일괄 적용)가 **같은 규칙**을 쓴다. 두 경로가 규칙을 따로
들면 "가입으론 안 되는 비밀번호가 명단으론 들어가는" 드리프트가 생기므로 여기 한 곳에만 둔다.

⚠ 평문 비밀번호는 이 모듈 밖으로 새지 않게 다룬다 — 검증 실패 메시지에 입력값을 싣지 않고,
해시만 돌려준다(로그·응답·원본 보관 어디에도 평문을 남기지 않는 것은 호출부 책임).
"""

from __future__ import annotations

import re

import bcrypt

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


# 패스워드 해시 라이브러리 선택: argon2-cffi 대비 bcrypt가 가볍다 — cffi 빌드체인이 따로 필요 없는
# 단일 순수 C 확장이고(argon2-cffi는 이름 그대로 cffi 의존), 이미 psycopg[binary]로 네이티브 의존성을
# 최소화하는 이 프로젝트 기조와 맞는다. cost factor는 bcrypt 기본값(gensalt() 기본 12 rounds)을 쓴다.
def hash_password(password: str) -> str:
    """bcrypt 해시(alg-cost-salt-hash 인코딩 문자열). 검증은 app.auth.local_verify가 checkpw로 한다."""
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")
