"""매칭 도메인 규칙 — 순수 함수 모음 (DB·I/O 의존 없음).

여기 모듈들은 ADR-0005/0006 등 도메인 결정의 진실원천을 코드로 옮긴 순수 규칙이다.
forced-assignment·saturation-allocation 같은 상위 엔진이 이를 호출(위임)한다.
"""

from app.matching.acceptance_rule import (
    Channel,
    EntryState,
    ForcedConfirmationError,
    RecipientType,
    recipient_type_from_buyer_subtype,
    resolve_entry_state,
    validate_requested_state,
)

__all__ = [
    "Channel",
    "EntryState",
    "ForcedConfirmationError",
    "RecipientType",
    "recipient_type_from_buyer_subtype",
    "resolve_entry_state",
    "validate_requested_state",
]
