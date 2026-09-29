"""비밀번호 정책 단위 테스트 — bcrypt 72바이트 상한(P1, 발주자 지시 2026-09-21).

배경: 설치된 bcrypt(5.0.0, 실측)는 72바이트를 넘는 입력에 ValueError를 던진다. 이 정책 검사가
그 경계를 앞단에서 막아야 hash_password 호출이 500으로 죽지 않는다. DB/HTTP 없이 순수 함수만
검증한다 — 자체가입·명단 업로드·단건 등록·비밀번호 재설정이 전부 이 함수 하나를 거친다.
"""

from __future__ import annotations

import bcrypt
import pytest

from app.auth.credentials import (
    PASSWORD_MAX_BYTES,
    check_password_policy,
    hash_password,
)


def test_installed_bcrypt_rejects_over_72_bytes():
    """정책 상수(72)가 실제 설치된 bcrypt 동작과 맞는지 스스로 재확인한다 — 라이브러리가 올라가
    한도가 바뀌면 이 테스트가 먼저 깨진다."""
    with pytest.raises(ValueError, match="72 bytes"):
        bcrypt.hashpw(("a" * 73).encode("utf-8"), bcrypt.gensalt())


def test_72_byte_password_passes_policy_and_hashes_without_error():
    password = "Ab1" + "a" * (PASSWORD_MAX_BYTES - 3)  # 영문+숫자 포함, 정확히 72바이트
    assert len(password.encode("utf-8")) == PASSWORD_MAX_BYTES
    assert check_password_policy(password) == password
    # 정책을 통과했으면 실제 해시도 500 없이 끝나야 한다(이 상수의 존재 이유).
    hashed = hash_password(password)
    assert bcrypt.checkpw(password.encode("utf-8"), hashed.encode("utf-8"))


def test_73_byte_password_is_rejected_by_policy_not_bcrypt():
    password = "Ab1" + "a" * (PASSWORD_MAX_BYTES - 2)  # 73바이트
    assert len(password.encode("utf-8")) == PASSWORD_MAX_BYTES + 1
    with pytest.raises(ValueError, match="바이트"):
        check_password_policy(password)


def test_korean_and_emoji_are_counted_as_bytes_not_characters():
    # "가"는 UTF-8에서 3바이트, 이모지는 4바이트 — 문자 수로는 짧아 보여도 바이트로는 넘을 수 있다.
    password = "Ab1" + "가" * 24  # 3 + 24*3 = 75바이트, 문자 수로는 27자뿐
    assert len(password) < PASSWORD_MAX_BYTES  # 문자 수 기준이면 통과했을 값
    assert len(password.encode("utf-8")) > PASSWORD_MAX_BYTES
    with pytest.raises(ValueError, match="바이트"):
        check_password_policy(password)

    emoji_password = "Ab1" + "🔒" * 18  # 3 + 18*4 = 75바이트
    assert len(emoji_password) < PASSWORD_MAX_BYTES
    assert len(emoji_password.encode("utf-8")) > PASSWORD_MAX_BYTES
    with pytest.raises(ValueError, match="바이트"):
        check_password_policy(emoji_password)
