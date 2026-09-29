"""registrant-mapping — 검증된 회원ID → 적재 레코드(registrants) 매핑(ADR-0007/0009).

DX Korea 검증이 돌려준 **회원ID**(= 주관사 명단 멱등 upsert 주키)로 미리 적재된 내
``registrants`` 레코드를 찾는다. 명단 import(OP-002)가 회원ID 키로 레코드를 **eager 생성**
해 두었다는 전제(ADR-0009) — 로그인은 **read-only**, 새 행을 만들지 않는다(동시 첫로그인
레이스 방지, F-AU-001 Further Notes).

매핑이 없으면(검증은 통과했지만 명단에 그 회원ID가 없음) **not-found**로 분기한다. 이건
인증 실패가 아니라 "적재 레코드 부재" — 호출자가 별도로 안내한다.

DB 세부는 ``RegistrantDirectory`` 포트 뒤에 둔다. 실구현은 SQLAlchemy 조회, 테스트는
인메모리 더블. 이 모듈 자체는 조회 메커니즘을 모른다.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol, runtime_checkable


@dataclass(frozen=True, slots=True)
class RegistrantRef:
    """적재 레코드 매핑 결과 — 세션 발급·역할 분기가 필요로 하는 최소 식별자.

    레코드 전체가 아니라 후속 단계(계정 연결·역할 분기)에 필요한 키만 노출한다. 회원ID는
    NABI 계정 ↔ 회원ID ↔ registrants를 잇는 동일 키이므로 함께 보존한다.

    역할 분기(role-branch)는 ``role_hint``(개별 명단 행의 요약값)가 아니라 **소속 기업의
    ``organization_event_roles`` 불리언**(``is_exhibitor`` / ``is_buyer``)을 권위 있는 역할로
    읽는다 — 이슈 #22가 명시한 입력 소스다. ``organization_event_roles``는 (organization,
    event) 단위라 한 행사 안에서는 둘 중 하나만 참이다(겸직 없음). ``role_hint``는 prefill용.
    """

    registrant_id: str  # registrants.id (PK)
    member_id: str  # registrants.organizer_member_id — 동일 키(검증이 돌려준 회원ID)
    is_exhibitor: bool  # organization_event_roles.is_exhibitor — 역할 분기 입력(role-branch)
    is_buyer: bool  # organization_event_roles.is_buyer — 역할 분기 입력(role-branch)
    role_hint: str | None = None  # 'exhibitor' | 'buyer' | 'both' — 개별 행 요약(prefill용)
    # 접힌 로그인 트랜잭션이 노출하는 진행 게이트 입력(F-AU-001 #23 slice A). 기본값을 둬
    # 기존 #22 매핑 테스트는 손대지 않고 통과한다(역할 분기 입력과 독립).
    application_status: str = "registered"  # 'registered' | 'submitted' — 행사 신청 진행 단계
    has_profile: bool = False  # 기업 프로필 작성 여부 — 진입 후 안내 분기에 쓰임


class RegistrantNotFoundError(LookupError):
    """검증은 통과했으나 그 회원ID로 적재된 레코드가 없음.

    인증 실패와 구분되는 분기 — 명단에 없는(혹은 아직 import 안 된) 회원이다.
    """

    def __init__(self, member_id: str) -> None:
        super().__init__(f"회원ID {member_id!r}에 해당하는 적재 레코드(registrant)가 없다")
        self.member_id = member_id


@runtime_checkable
class RegistrantDirectory(Protocol):
    """회원ID로 적재 레코드를 조회하는 포트 — DB 접근을 격리한다.

    실구현은 ``registrants``를 (event_id, organizer_member_id) 유니크 키로 조회한다.
    여기서는 단일 이벤트 컨텍스트를 가정하고 회원ID만 받는다(이벤트 스코프는 실구현이 바인딩).
    """

    def find_by_member_id(self, member_id: str) -> RegistrantRef | None:
        """회원ID로 적재 레코드를 찾는다. 없으면 None."""
        ...


def map_member_to_registrant(member_id: str, directory: RegistrantDirectory) -> RegistrantRef:
    """검증된 회원ID를 적재 레코드로 매핑한다.

    Args:
        member_id: DX Korea 검증이 돌려준 회원ID.
        directory: 적재 레코드 조회 포트.

    Returns:
        매핑된 ``RegistrantRef``.

    Raises:
        RegistrantNotFoundError: 그 회원ID로 적재된 레코드가 없을 때.
    """
    ref = directory.find_by_member_id(member_id)
    if ref is None:
        raise RegistrantNotFoundError(member_id)
    return ref


class InMemoryRegistrantDirectory:
    """계약 테스트용 인메모리 디렉토리 — 실 DB 없이 매핑/not-found 분기를 재현한다."""

    def __init__(self, registrants: dict[str, RegistrantRef] | None = None) -> None:
        """Args: registrants: 회원ID → RegistrantRef 매핑."""
        self._by_member_id = dict(registrants or {})

    def find_by_member_id(self, member_id: str) -> RegistrantRef | None:
        return self._by_member_id.get(member_id)
