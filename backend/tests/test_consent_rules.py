"""consent-capture 순수 규칙 단위 테스트 (F-AU-001 / ADR-0009).

DB·HTTP 없이 **관찰 가능한 동작**만 본다: 필수 미동의면 차단, 동의되면 통과,
재방문자(필수 전부 보유)는 통과, 개정 버전이 활성으로 선택됨, 미지 항목은 거부(PRD Testing Decisions).
"""

import pytest

from app.consent.rules import (
    ConsentDoc,
    UnknownConsentTypeError,
    active_documents,
    evaluate_gate,
    plan_capture,
    validate_agreement,
)

# v1 활성 약관 픽스처 — 필수 4 + 선택 1(seed와 동일 구성).
REQUIRED = ["tos", "privacy", "sensitive", "third_party"]
OPTIONAL = ["marketing"]
ACTIVE = [
    ConsentDoc(type="tos", version="v1", is_required=True, id="doc-tos"),
    ConsentDoc(type="privacy", version="v1", is_required=True, id="doc-privacy"),
    ConsentDoc(type="sensitive", version="v1", is_required=True, id="doc-sensitive"),
    ConsentDoc(type="third_party", version="v1", is_required=True, id="doc-third"),
    ConsentDoc(type="marketing", version="v1", is_required=False, id="doc-mkt"),
]


# --- 게이트: 필수 전부 동의해야 통과 ----------------------------------------
def test_gate_satisfied_when_all_required_agreed():
    result = evaluate_gate(ACTIVE, set(REQUIRED))
    assert result.satisfied is True
    assert result.missing_required == ()


def test_gate_satisfied_ignores_optional():
    # 선택(마케팅)을 빼도 필수만 다 있으면 통과.
    result = evaluate_gate(ACTIVE, set(REQUIRED))
    assert result.satisfied is True


def test_gate_blocks_when_required_missing():
    result = evaluate_gate(ACTIVE, {"tos", "privacy"})
    assert result.satisfied is False
    assert set(result.missing_required) == {"sensitive", "third_party"}


def test_gate_blocks_when_only_optional_agreed():
    result = evaluate_gate(ACTIVE, set(OPTIONAL))
    assert result.satisfied is False
    assert set(result.missing_required) == set(REQUIRED)


def test_gate_passes_for_revisitor_with_all_required():
    # 재방문자: 이미 필수 전부 보유 → 약관 재요구 없이 통과.
    revisitor_agreed = set(REQUIRED) | set(OPTIONAL)
    assert evaluate_gate(ACTIVE, revisitor_agreed).satisfied is True


# --- 활성 약관 선택: type별 최신 버전 1개 ------------------------------------
def test_active_documents_picks_latest_version_per_type():
    docs = [
        ConsentDoc(type="tos", version="v1", is_required=True, id="tos-v1", effective_date="2026-06-01"),
        ConsentDoc(type="tos", version="v2", is_required=True, id="tos-v2", effective_date="2026-07-01"),
        ConsentDoc(type="privacy", version="v1", is_required=True, id="pr-v1", effective_date="2026-06-01"),
    ]
    active = active_documents(docs)
    by_type = {d.type: d for d in active}
    assert by_type["tos"].id == "tos-v2"  # 최신 시행일
    assert by_type["privacy"].id == "pr-v1"
    assert len(active) == 2  # type당 1개


def test_active_documents_deterministic_order():
    # 입력에 처음 등장한 type 순서를 보존(결정적 출력).
    docs = [
        ConsentDoc(type="marketing", version="v1", is_required=False, id="m"),
        ConsentDoc(type="tos", version="v1", is_required=True, id="t"),
    ]
    assert [d.type for d in active_documents(docs)] == ["marketing", "tos"]


# --- 동의 항목 검증: 미지·비활성 type 거부 ----------------------------------
def test_validate_rejects_unknown_type():
    with pytest.raises(UnknownConsentTypeError):
        validate_agreement(ACTIVE, {"tos", "not_a_real_type"})


def test_validate_passes_for_known_subset():
    # 미지 항목이 없으면(부분 집합이어도) 검증 통과 — 필수 충족 여부는 게이트가 본다.
    validate_agreement(ACTIVE, {"tos"})


# --- 수집 계획: 동의 항목 → 현행 문서 버전 매핑 ------------------------------
def test_plan_capture_maps_to_active_doc_version():
    plan = plan_capture(ACTIVE, {"tos", "marketing"})
    by_type = {e.type: e for e in plan}
    assert by_type["tos"].consent_document_id == "doc-tos"
    assert by_type["tos"].version == "v1"
    assert by_type["marketing"].consent_document_id == "doc-mkt"


def test_plan_capture_skips_doc_without_id():
    docs = [ConsentDoc(type="tos", version="v1", is_required=True, id=None)]
    assert plan_capture(docs, {"tos"}) == []


def test_plan_capture_skips_type_not_in_active():
    assert plan_capture(ACTIVE, {"ghost"}) == []
