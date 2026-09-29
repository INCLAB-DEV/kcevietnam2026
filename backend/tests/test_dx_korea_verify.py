"""dx-korea-verify 계약 테스트 — 어댑터의 성공/실패 분기(F-AU-001 AC1·AC2).

규격 미확정이라 실 HTTP 대신 스텁으로 **계약**만 검증한다: 맞는 자격증명이면 회원ID,
틀리면/잠기면/장애면 거부 사유. 구현 세부(HTTP·토큰 포맷)는 보지 않는다.
"""

from app.auth.dx_korea_verify import (
    DxKoreaVerifier,
    RejectionReason,
    StubDxKoreaVerifier,
    VerifyOk,
    VerifyRejected,
)


def _verifier() -> StubDxKoreaVerifier:
    return StubDxKoreaVerifier(
        credentials={
            ("buyer01", "pw-good"): "M-1001",
            ("locked-user", "pw-good"): "M-2002",
        },
        locked_usernames={"locked-user"},
    )


def test_stub_satisfies_port_interface():
    # 스텁이 포트(Protocol)를 만족 — 실구현과 교체 가능(AC2).
    assert isinstance(_verifier(), DxKoreaVerifier)


def test_valid_credentials_return_member_id():
    result = _verifier().verify("buyer01", "pw-good")
    assert result == VerifyOk(member_id="M-1001")


def test_wrong_password_rejected_invalid_credentials():
    result = _verifier().verify("buyer01", "pw-bad")
    assert result == VerifyRejected(RejectionReason.INVALID_CREDENTIALS)


def test_unknown_username_rejected_invalid_credentials():
    result = _verifier().verify("ghost", "whatever")
    assert result == VerifyRejected(RejectionReason.INVALID_CREDENTIALS)


def test_locked_account_rejected_even_with_correct_password():
    # 자격증명은 맞지만 잠긴 계정 — 진입 차단.
    result = _verifier().verify("locked-user", "pw-good")
    assert result == VerifyRejected(RejectionReason.ACCOUNT_LOCKED)


def test_upstream_unavailable_rejects_before_credential_check():
    down = StubDxKoreaVerifier(
        credentials={("buyer01", "pw-good"): "M-1001"},
        available=False,
    )
    # 장애면 맞는 자격증명이어도 거부 사유로 환산(예외를 던지지 않음).
    result = down.verify("buyer01", "pw-good")
    assert result == VerifyRejected(RejectionReason.UPSTREAM_UNAVAILABLE)


def test_verify_never_raises_returns_result():
    # 어댑터는 예외 누수 없이 결과로 분기를 표현한다.
    v = _verifier()
    for username, password in [("buyer01", "pw-good"), ("buyer01", "no"), ("x", "y")]:
        assert isinstance(v.verify(username, password), VerifyOk | VerifyRejected)
