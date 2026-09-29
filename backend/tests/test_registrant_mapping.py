"""registrant-mapping 계약 테스트 — 회원ID → 적재 레코드, 없으면 not-found(F-AU-001 AC1).

read-only 매핑만 검증한다(로그인은 새 레코드를 만들지 않는다 — ADR-0009 eager 생성 전제).
"""

import pytest

from app.auth.registrant_mapping import (
    InMemoryRegistrantDirectory,
    RegistrantDirectory,
    RegistrantNotFoundError,
    RegistrantRef,
    map_member_to_registrant,
)

_REF = RegistrantRef(
    registrant_id="R-1", member_id="M-1001", is_exhibitor=False, is_buyer=True, role_hint="buyer"
)


def _directory() -> InMemoryRegistrantDirectory:
    return InMemoryRegistrantDirectory({"M-1001": _REF})


def test_directory_satisfies_port_interface():
    assert isinstance(_directory(), RegistrantDirectory)


def test_known_member_id_maps_to_registrant():
    assert map_member_to_registrant("M-1001", _directory()) is _REF


def test_unknown_member_id_raises_not_found():
    with pytest.raises(RegistrantNotFoundError) as exc:
        map_member_to_registrant("M-9999", _directory())
    assert exc.value.member_id == "M-9999"


def test_mapping_preserves_role_booleans_for_branching():
    # 역할 분기(role-branch)가 읽을 organization_event_roles 불리언을 손실 없이 실어 넘긴다.
    ref = map_member_to_registrant("M-1001", _directory())
    assert (ref.is_exhibitor, ref.is_buyer) == (False, True)
    assert ref.role_hint == "buyer"  # prefill 힌트도 함께 보존
    assert ref.member_id == "M-1001"
