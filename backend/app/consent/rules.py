"""consent-capture 순수 규칙 모듈 (F-AU-001 / ADR-0009).

약관 동의의 **관찰 가능한 동작**만 담는다 — DB·HTTP·시각 의존을 배제하고 평범한 데이터
구조 위에서만 판단한다. 그래서 DB 없이 단위 테스트로 박제할 수 있다(PRD Testing Decisions).

캡슐화 대상:
- 활성 약관 선택 — type별 최신 유효 버전 1개만 고른다(개정 누적 중 현행 약관 집합).
- 진행 게이트 — 필수 약관이 모두 동의됐는지. 미동의 필수가 하나라도 있으면 차단.
- 동의 검증 — 제출된 항목이 활성 약관 type에 속하는지(미지·비활성 type 거부).
- 수집 계획 — 동의된 항목을 어떤 약관 버전(문서)으로 기록할지 산출(마스터/이력은 service가 씀).
"""

from __future__ import annotations

from dataclasses import dataclass, field

# 약관 항목(한국 개인정보보호법: 항목별 분리 동의). schema.sql CHECK와 동일 집합. ADR-0009
CONSENT_TYPES: tuple[str, ...] = ("tos", "privacy", "sensitive", "third_party", "marketing")


class UnknownConsentTypeError(ValueError):
    """활성 약관에 없는 type으로 동의를 제출 — 거부."""


@dataclass(frozen=True)
class ConsentDoc:
    """약관 문서 한 버전의 규칙 판단용 투영(consent_documents 행의 일부)."""

    type: str
    version: str
    is_required: bool
    id: str | None = None  # consent_document_id (활성 선택·수집 계획에서 버전 스냅샷 앵커)
    effective_date: str | None = None  # 'YYYY-MM-DD' 문자열 비교로 최신 버전 선택


@dataclass(frozen=True)
class GateResult:
    satisfied: bool
    missing_required: tuple[str, ...] = field(default_factory=tuple)


@dataclass(frozen=True)
class CaptureEntry:
    """동의 1건을 어느 약관 버전으로 기록할지. service가 마스터 upsert + 이력 append에 쓴다."""

    type: str
    consent_document_id: str
    version: str


def active_documents(docs: list[ConsentDoc]) -> list[ConsentDoc]:
    """type별 **현행(활성) 약관 1개**만 골라 반환한다.

    같은 type의 개정본이 여러 행 쌓여도 화면·게이트는 최신 1개만 본다. 최신 기준은
    effective_date(없으면 가장 뒤로) → version 사전순. 안정 정렬로 결정적이다.
    """

    def freshness(d: ConsentDoc) -> tuple[str, str]:
        return (d.effective_date or "", d.version)

    latest: dict[str, ConsentDoc] = {}
    for d in docs:
        cur = latest.get(d.type)
        if cur is None or freshness(d) >= freshness(cur):
            latest[d.type] = d
    # 입력에 처음 등장한 type 순서를 보존(결정적 출력).
    seen: list[str] = []
    for d in docs:
        if d.type not in seen:
            seen.append(d.type)
    return [latest[t] for t in seen]


def evaluate_gate(active_docs: list[ConsentDoc], agreed_types: set[str]) -> GateResult:
    """필수 약관이 모두 동의됐는지. 미동의 필수가 있으면 차단(satisfied=False)."""
    required = {d.type for d in active_docs if d.is_required}
    missing = tuple(sorted(required - set(agreed_types)))
    return GateResult(satisfied=not missing, missing_required=missing)


def validate_agreement(active_docs: list[ConsentDoc], agreed_types: set[str]) -> None:
    """제출 동의 항목이 활성 약관 type 집합에 속하는지 검증. 미지·비활성 type이면 거부."""
    valid = {d.type for d in active_docs}
    unknown = sorted(set(agreed_types) - valid)
    if unknown:
        raise UnknownConsentTypeError(f"활성 약관에 없는 동의 항목: {', '.join(unknown)}")


def plan_capture(active_docs: list[ConsentDoc], agreed_types: set[str]) -> list[CaptureEntry]:
    """동의된 항목을 현행 약관 버전(문서)에 묶어 기록 계획을 만든다.

    consent_document_id가 버전 스냅샷 앵커 — 마스터/이력 모두 이 FK로 '어느 버전에 동의했나'를
    보존한다. id 없는 활성 문서(미저장)는 기록 대상이 아니므로 건너뛴다.
    """
    by_type = {d.type: d for d in active_docs}
    plan: list[CaptureEntry] = []
    for t in sorted(agreed_types):
        doc = by_type.get(t)
        if doc is None or doc.id is None:
            continue
        plan.append(CaptureEntry(type=t, consent_document_id=doc.id, version=doc.version))
    return plan
