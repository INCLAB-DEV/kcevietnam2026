"""consent-gate — 접힌 로그인 트랜잭션이 약관 동의를 묻고 기록하는 포트(F-AU-001, #23 slice A).

접힌 트랜잭션은 DB·세션을 모르고 **포트에만** 의존해야 한다. 동의 수집의 실제 DB 로직은
형제 슬라이스 ``app.consent``(rules + service)가 소유하지만, 그건 SQLAlchemy ``Session``에
강하게 묶여 있다. 그래서 로그인 트랜잭션을 DB에 결합하지 않도록 **얇은 포트**를 따로 둔다 —
실구현은 추후 ``app.consent.service``를 어댑팅하고, 데모·테스트는 인메모리 더블을 쓴다.

**관찰 가능한 계약**:
- ``active_documents()`` — 지금 동의를 받아야 할 현행 약관 목록(화면에 그릴 카드).
- ``record(member_id, accepted_ids)`` — 동의를 기록하고 게이트 통과 여부를 돌려준다.
  필수 문서 id가 모두 accepted_ids에 들어 있어야 satisfied(없으면 missing_required로 보고).

데모에서 약관 문서의 ``id``는 곧 그 **type**(tos/privacy/sensitive/marketing)이라, accepted_ids가
그대로 동의 type 집합이 된다(계약 문서의 id == type 규약).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol, runtime_checkable


@dataclass(frozen=True, slots=True)
class ConsentDoc:
    """동의 화면에 그릴 약관 문서 한 건 — 카드 표시·필수 여부 판정에 필요한 최소 필드.

    ``id``는 동의 제출(accepted_ids)의 앵커다. 데모에서는 id == type(tos/privacy/...)으로
    두어 제출 id 집합이 곧 동의 type 집합이 되게 한다.
    """

    id: str
    title: str
    summary: str
    version: str
    required: bool
    content: str = ""  # 약관 전문(바텀시트 노출). 미설정이면 빈 문자열.


@dataclass(frozen=True, slots=True)
class GateOutcome:
    """동의 기록 결과 — 게이트 통과 여부 + 미동의 필수 문서.

    ``satisfied``가 False면 ``missing_required``에 아직 동의가 안 된 필수 문서 id가 담긴다 —
    호출자(트랜잭션)는 이걸 ``consent_incomplete`` 결과로 그대로 노출한다.
    """

    satisfied: bool
    missing_required: list[str]


@runtime_checkable
class ConsentGate(Protocol):
    """약관 동의 게이트 포트 — 현행 약관 노출 + 동의 기록을 격리한다.

    실구현은 ``app.consent``(DB)를 어댑팅하고, 데모·테스트는 ``InMemoryConsentGate``를 쓴다.
    트랜잭션은 이 인터페이스에만 의존하므로 DB에 결합되지 않는다.
    """

    def active_documents(self) -> list[ConsentDoc]:
        """지금 동의를 받아야 할 현행 약관 목록."""
        ...

    def record(self, member_id: str, accepted_ids: list[str]) -> GateOutcome:
        """동의를 기록하고 게이트 통과 여부를 돌려준다.

        필수 문서 id가 모두 accepted_ids에 있으면 satisfied=True. 하나라도 빠지면
        satisfied=False + 빠진 필수 id(missing_required).
        """
        ...


class InMemoryConsentGate:
    """계약 테스트·데모용 인메모리 게이트 — DB 없이 노출/기록/게이트 판정을 재현한다.

    회원별 누적 동의 id를 들고 있어, 같은 회원이 여러 번 record해도 합집합으로 평가한다
    (재제출에 관대). 필수 문서가 모두 동의되면 satisfied.
    """

    def __init__(self, documents: list[ConsentDoc]) -> None:
        """Args: documents: 노출할 현행 약관 목록(데모 시드는 deps 팩토리가 준다)."""
        self._documents = list(documents)
        self._agreed_by_member: dict[str, set[str]] = {}

    def active_documents(self) -> list[ConsentDoc]:
        # 방어적 복사 — 호출자가 내부 목록을 변형하지 못하게.
        return list(self._documents)

    def record(self, member_id: str, accepted_ids: list[str]) -> GateOutcome:
        agreed = self._agreed_by_member.setdefault(member_id, set())
        agreed.update(accepted_ids)

        required = {d.id for d in self._documents if d.required}
        missing = sorted(required - agreed)
        return GateOutcome(satisfied=not missing, missing_required=missing)
