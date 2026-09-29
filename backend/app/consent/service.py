"""약관 동의 수집 — 순수 규칙(rules)을 DB(3테이블)에 묶는 얇은 계층.

DB 접근은 여기로 모은다(FastAPI가 DB 소유 — ADR-0008). 규칙 판단은 rules에 위임하고,
이 모듈은 활성 약관 로드 / 마스터 upsert / 이력 append만 책임진다.
"""

from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Session

from app.consent import rules
from app.models import ConsentDocument, Member, UserConsentHistory, UserConsentState


@dataclass(frozen=True)
class GateStatus:
    satisfied: bool
    missing_required: list[str]
    agreed_types: set[str]


def member_exists(db: Session, member_id: str) -> bool:
    """member.id 존재 여부 — 동의 기록 전 미존재 member를 명시적으로 거부(FK 500 방지)."""
    return db.execute(
        select(func.count()).select_from(Member.__table__).where(Member.id == member_id)
    ).scalar_one() > 0


def load_active_documents(db: Session) -> list[ConsentDocument]:
    """현행 약관(type별 최신 버전 1개). 시행일이 미래인 개정본은 아직 유효하지 않으므로 제외한다."""
    today = db.execute(select(func.current_date())).scalar_one()
    all_docs = db.execute(
        # effective_date가 NULL(상시)이거나 오늘 이하인 문서만 후보로 본다.
        select(ConsentDocument).where(
            (ConsentDocument.effective_date.is_(None))
            | (ConsentDocument.effective_date <= today)
        )
    ).scalars().all()
    proj = [
        rules.ConsentDoc(
            type=d.type,
            version=d.version,
            is_required=d.is_required,
            id=d.id,
            effective_date=str(d.effective_date) if d.effective_date else None,
        )
        for d in all_docs
    ]
    active_ids = {d.id for d in rules.active_documents(proj)}
    by_id = {d.id: d for d in all_docs}
    return [by_id[i] for i in active_ids]


def _agreed_types_for_member(db: Session, member_id: str, active: list[ConsentDocument]) -> set[str]:
    """이 회원이 **현행 약관 버전**에 현재 동의 중인 type 집합.

    마스터(user_consent_states)의 agreed=True이고, 동의한 문서가 현행 버전과 일치할 때만 인정한다.
    약관이 개정되면(consent_document_id 불일치) 재동의가 필요하므로 게이트에서 빠진다.
    """
    active_doc_ids = {d.id for d in active}
    states = (
        db.execute(select(UserConsentState).where(UserConsentState.member_id == member_id))
        .scalars()
        .all()
    )
    return {
        s.type
        for s in states
        if s.agreed and s.consent_document_id in active_doc_ids
    }


def gate_status(db: Session, member_id: str) -> GateStatus:
    """회원의 진행 게이트 상태 — 재방문자가 약관 재요구 없이 통과하는지 판정한다."""
    active = load_active_documents(db)
    proj = [_to_proj(d) for d in active]
    agreed = _agreed_types_for_member(db, member_id, active)
    result = rules.evaluate_gate(proj, agreed)
    return GateStatus(
        satisfied=result.satisfied,
        missing_required=list(result.missing_required),
        agreed_types=agreed,
    )


def record_agreements(
    db: Session, member_id: str, agreed_types: set[str], ip: str | None
) -> rules.GateResult:
    """동의를 수집한다 — 게이트 통과 시 마스터 갱신 + 이력 append를 한 트랜잭션으로 커밋.

    필수 약관 미동의면 아무것도 쓰지 않고 차단 결과만 돌려준다(반쪽 동의 방지). 미지 type은 거부.
    """
    active = load_active_documents(db)
    proj = [_to_proj(d) for d in active]

    rules.validate_agreement(proj, agreed_types)  # 미지·비활성 type → UnknownConsentTypeError

    gate = rules.evaluate_gate(proj, agreed_types)
    if not gate.satisfied:
        return gate  # 필수 미동의 — 진행 차단, 기록하지 않음.

    plan = rules.plan_capture(proj, agreed_types)
    for entry in plan:
        _upsert_master(db, member_id, entry)
        db.add(
            UserConsentHistory(
                member_id=member_id,
                consent_document_id=entry.consent_document_id,
                action="agreed",
                ip=ip,
                method="login_consent",
            )
        )
    db.commit()
    return gate


def _upsert_master(db: Session, member_id: str, entry: rules.CaptureEntry) -> None:
    """(member, type) 마스터 1행을 **원자적으로** 동의 상태로 만든다.

    동시 첫 제출 2건이 겹쳐도 UNIQUE(member_id, type) 충돌 없이 멱등하도록 PostgreSQL
    INSERT ... ON CONFLICT DO UPDATE를 쓴다. agreed_at/updated_at은 서버 시각(now()) 스냅샷.
    """
    stmt = pg_insert(UserConsentState.__table__).values(
        member_id=member_id,
        type=entry.type,
        consent_document_id=entry.consent_document_id,
        agreed=True,
        agreed_at=func.now(),
    )
    stmt = stmt.on_conflict_do_update(
        constraint="user_consent_states_member_id_type_key",
        set_={
            "consent_document_id": entry.consent_document_id,
            "agreed": True,
            "agreed_at": func.now(),
            "withdrawn_at": None,
            "updated_at": func.now(),
        },
    )
    db.execute(stmt)


def _to_proj(d: ConsentDocument) -> rules.ConsentDoc:
    return rules.ConsentDoc(
        type=d.type,
        version=d.version,
        is_required=d.is_required,
        id=d.id,
        effective_date=str(d.effective_date) if d.effective_date else None,
    )
