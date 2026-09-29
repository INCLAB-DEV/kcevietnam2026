"""session-issue — NABI 계정(Cognito) 발급/조회 → 세션/JWT 발급(ADR-0007/0008).

검증·매핑이 끝난 회원ID에 대해:
- **최초 진입**이면 게이트된 NABI 계정(Cognito 유저풀)을 **발급**하고 세션을 낸다.
- **재방문**이면 **기존 계정을 조회**해 세션만 낸다 — 새 계정을 또 만들지 않는다(멱등).

NABI 계정 ↔ 회원ID ↔ registrants를 **동일 회원ID 키**로 잇는다. Cognito는 OTP 발송자가
아니라 **유저풀 + 세션/JWT 토큰 발급·검증(JWKS/RS256)** 역할만 맡는다(F-AU-001 경계 B).

⚠ 약관 동의 게이트: "게이트된 계정"은 **필수 약관 동의 후** 발급된다(D3/D4). 동의 수집은
형제 모듈 ``consent_capture``(별도 슬라이스) 소관이라 이 모듈은 **동의 완료 여부를 입력으로
받아** 게이트를 강제하기만 한다 — 동의 수집 로직은 품지 않는다.

Cognito 유저풀·키 정책은 인프라/보안 결정(HITL)이라 ``CognitoUserPool`` 포트 뒤에 격리한다.
실구현은 AWS Cognito(admin_create_user / 토큰 발급), 테스트는 인메모리 더블.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol, runtime_checkable


class ConsentNotSatisfiedError(RuntimeError):
    """최초 진입인데 필수 약관 동의가 끝나지 않음 — 게이트 계정을 발급하지 않는다(D4).

    방산=민감정보라 처리 근거(동의) 없이는 계정이 나오면 안 된다.
    """

    def __init__(self, member_id: str) -> None:
        super().__init__(f"회원ID {member_id!r}: 필수 약관 미동의 — 게이트 계정 발급 불가")
        self.member_id = member_id


@dataclass(frozen=True, slots=True)
class SessionTokens:
    """Cognito가 발급한 세션 토큰 묶음 — FastAPI가 소유하고 검증한다(JWKS/RS256).

    토큰 자체는 Cognito가 서명한다(NABI가 직접 RS256 서명하지 않음). FastAPI는 발급받아
    돌려주고, 이후 요청에서 ``jwt_verify``로 JWKS 검증한다.
    """

    id_token: str
    access_token: str
    refresh_token: str | None = None


@dataclass(frozen=True, slots=True)
class CognitoAccount:
    """Cognito 유저풀의 NABI 계정 — 회원ID를 동일 키로 들고 있다."""

    cognito_sub: str  # Cognito user pool의 subject(고유 ID)
    member_id: str  # 동일 키 — registrants·검증 회원ID와 일치


@dataclass(frozen=True, slots=True)
class SessionResult:
    """세션 발급 결과 — 최초/재방문 분기를 관찰 가능하게 노출한다.

    ``is_new_account``로 호출자가 "방금 발급됨(최초)"과 "기존 계정(재방문)"을 구분한다.
    재방문에서 새 계정이 생기지 않았음을 계약 테스트가 이 플래그로 검증한다(AC3).
    """

    account: CognitoAccount
    tokens: SessionTokens
    is_new_account: bool


@runtime_checkable
class CognitoUserPool(Protocol):
    """Cognito 유저풀 포트 — 계정 발급/조회·세션 토큰 발급을 격리한다.

    실구현은 AWS Cognito(admin API + 토큰 발급). 호출자는 이 인터페이스에만 의존한다.
    """

    def find_account(self, member_id: str) -> CognitoAccount | None:
        """회원ID로 기존 NABI 계정을 조회한다. 없으면 None(= 최초 진입)."""
        ...

    def get_or_create_account(self, member_id: str) -> tuple[CognitoAccount, bool]:
        """회원ID로 게이트된 NABI 계정을 **원자적으로** 발급하거나 기존 것을 돌려준다.

        동시 첫로그인 레이스에서 두 요청이 모두 ``find_account``가 None을 보고 발급으로
        들어올 수 있다. 실 Cognito는 ``admin_create_user``가 한쪽을 ``UsernameExistsException``
        으로 거부하므로, 어댑터는 그 충돌을 흡수해 **(계정, 방금_생성했는지)** 를 돌려준다.
        진 쪽은 ``created=False``로 기존 계정 취급 — 절대 두 계정이 생기지 않는다.

        Returns:
            (계정, created) — created=True면 이 호출이 새로 발급, False면 이미 있던 것.
        """
        ...

    def issue_tokens(self, account: CognitoAccount) -> SessionTokens:
        """계정에 대한 세션 토큰(JWKS/RS256 검증 가능)을 발급한다."""
        ...


def issue_session(
    member_id: str,
    pool: CognitoUserPool,
    *,
    consent_satisfied: bool,
) -> SessionResult:
    """회원ID에 대한 NABI 계정 세션을 발급한다 — 최초=발급+세션, 재방문=기존+세션.

    재방문(기존 계정 존재)이면 약관을 다시 요구하지 않고(User Story 9) 곧장 세션을 낸다.
    최초이면 필수 약관 동의가 끝났을 때만 게이트 계정을 발급한다.

    Args:
        member_id: 검증·매핑된 회원ID(NABI 계정 동일 키).
        pool: Cognito 유저풀 포트.
        consent_satisfied: 최초 진입 시 필수 약관 동의 완료 여부(consent_capture 결과).
            재방문이면 무시된다(이미 동의 이력 보유).

    Returns:
        ``SessionResult`` — 계정·토큰·최초여부.

    Raises:
        ConsentNotSatisfiedError: 최초 진입인데 필수 약관 미동의일 때.
    """
    existing = pool.find_account(member_id)
    if existing is not None:
        # 재방문 — 기존 계정으로 세션만. 새 계정을 만들지 않는다(멱등).
        return SessionResult(
            account=existing,
            tokens=pool.issue_tokens(existing),
            is_new_account=False,
        )

    # 최초 진입 — 필수 약관 동의 게이트를 통과해야 계정을 발급한다.
    if not consent_satisfied:
        raise ConsentNotSatisfiedError(member_id)

    # 원자적 발급 — 동시 첫로그인 레이스의 진 쪽은 created=False로 기존 계정 취급.
    account, created = pool.get_or_create_account(member_id)
    return SessionResult(
        account=account,
        tokens=pool.issue_tokens(account),
        is_new_account=created,
    )


class InMemoryCognitoUserPool:
    """계약 테스트용 인메모리 유저풀 — 발급/조회 멱등성을 재현한다.

    ``create_account`` 호출 횟수를 ``created_count``로 노출해 "재방문 시 신규 발급 안 함"을
    계약 테스트가 검증할 수 있게 한다.
    """

    def __init__(self) -> None:
        self._accounts: dict[str, CognitoAccount] = {}
        self.created_count = 0
        self._token_seq = 0

    def find_account(self, member_id: str) -> CognitoAccount | None:
        return self._accounts.get(member_id)

    def get_or_create_account(self, member_id: str) -> tuple[CognitoAccount, bool]:
        existing = self._accounts.get(member_id)
        if existing is not None:
            # 이미 있으면 새로 만들지 않는다 — created=False(레이스의 진 쪽도 이 경로).
            return existing, False
        account = CognitoAccount(cognito_sub=f"sub-{member_id}", member_id=member_id)
        self._accounts[member_id] = account
        self.created_count += 1
        return account, True

    def issue_tokens(self, account: CognitoAccount) -> SessionTokens:
        # 매 발급마다 다른 토큰 문자열 — 세션이 새로 났음을 구분 가능하게(스텁 단순화).
        self._token_seq += 1
        n = self._token_seq
        return SessionTokens(
            id_token=f"id-{account.member_id}-{n}",
            access_token=f"access-{account.member_id}-{n}",
            refresh_token=f"refresh-{account.member_id}-{n}",
        )
