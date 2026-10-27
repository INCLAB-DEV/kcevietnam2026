"""참가기업 삭제 규칙 테스트(F-OP-002) — 닫힌 미팅만 있는 기업은 지우고, 예정·완료 미팅이 있으면 막는다.

이 파일이 지키는 것은 하나다: **지워져야 할 것만 지워진다.** 운영 데이터를 지우는 기능이라 "지워졌는가"
보다 "다른 것이 안 지워졌는가"가 더 중요하다. 그래서 핵심 테스트는 삭제 전후로 **DB 전체**(모든 테이블의
모든 행)를 찍어 비교한다 — 사라진 행·바뀐 칸·새로 생긴 행이 기대한 목록과 정확히 같아야 한다. 상대 기업,
상대 기업의 다른 미팅, 무관한 미팅·기업은 한 행도 바뀌지 않는다는 것을 목록에 없다는 사실로 증명한다.

실제 Postgres(``migrated_db``)에서 돈다 — FK 삭제 규칙(CASCADE·SET NULL·규칙 없음)이 이 기능의 절반이라
제약이 없는 DB로는 검증할 수 없다. 가드는 ``test_admin_api.py``와 같은 방식으로 override하고, 권한 배선
(sub 403·미인증 401)만 실 가드로 태운다.
"""

from __future__ import annotations

import dataclasses
import itertools
import logging
import threading
import time
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select, text
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import sessionmaker

from app.admin import service as admin_service
from app.admin.guard import EventOperatorPrincipal, require_event_operator
from app.auth.organizer_guard import (
    EventMasterPrincipal,
    InMemoryEventOperatorDirectory,
    StubSessionAuthenticator,
    get_authenticator,
    get_operator_directory,
    require_event_master,
)
from app.db import Base, get_session
from app.main import app
from app.models import (
    AiMatchSuggestion,
    BuyerAttendee,
    BuyerInterestKeyword,
    BuyerProfile,
    BuyerRecommendedBuyer,
    ConversationChannel,
    Event,
    EventScheduleSettings,
    ExhibitorAttendee,
    ExhibitorKeyword,
    ExhibitorProduct,
    ExhibitorProfile,
    File,
    InterestedOrganization,
    Interpreter,
    InterpreterAssignment,
    Keyword,
    LoveCall,
    Meeting,
    MeetingParticipant,
    Member,
    Notification,
    NotificationDispatch,
    OrgEventRoleOrgType,
    Organization,
    OrganizationEventRole,
    PostMeetingReview,
    Registrant,
    SaturationBatchRun,
    SaturationDraftItem,
    TranscriptionJob,
    UserConsentState,
)
from app.notifications.bulk_dispatch import shutdown_bulk_email
from app.roster import import_service
from app.roster.parser import RosterRecord

_seq = itertools.count(1)


# =============================================================================
# 픽스처 / 가드 override
# =============================================================================
@pytest.fixture()
def db_factory(migrated_db: str):
    engine = create_engine(migrated_db, future=True)
    TestSession = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)
    yield TestSession
    engine.dispose()


@pytest.fixture()
def client(db_factory):
    def _override_session():
        db = db_factory()
        try:
            yield db
        except Exception:
            db.rollback()
            raise
        finally:
            db.close()

    app.dependency_overrides[get_session] = _override_session
    yield TestClient(app, raise_server_exceptions=False)
    app.dependency_overrides.clear()


def _as_master(event_id: str) -> None:
    app.dependency_overrides[require_event_master] = lambda: EventMasterPrincipal(
        member_id="mbr-master", event_id=event_id
    )
    app.dependency_overrides[require_event_operator] = lambda: EventOperatorPrincipal(
        member_id="mbr-master",
        event_id=event_id,
        permission_level="master",
        organizer_id=str(uuid.uuid4()),
    )


@pytest.fixture()
def wired_event() -> str:
    return str(uuid.uuid4())


@pytest.fixture()
def wired_client(db_factory, wired_event):
    """가드 override 없이 실 배선(스텁 인증 + 인메모리 운영자 디렉터리) — 권한 판정만 본다."""

    def _override_session():
        db = db_factory()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_session] = _override_session
    app.dependency_overrides[get_authenticator] = StubSessionAuthenticator
    app.dependency_overrides[get_operator_directory] = lambda: InMemoryEventOperatorDirectory(
        {("mbr-master", wired_event): "master", ("mbr-sub", wired_event): "sub"}
    )
    yield TestClient(app, raise_server_exceptions=False)
    app.dependency_overrides.clear()


MASTER = {"Authorization": "Bearer access-mbr-master-1"}
SUB = {"Authorization": "Bearer access-mbr-sub-1"}


def _delete_url(event_id: str, org_id: str) -> str:
    return f"/api/admin/events/{event_id}/organizations/{org_id}"


def _impact_url(event_id: str, org_id: str) -> str:
    return f"/api/admin/events/{event_id}/organizations/{org_id}/deletion-impact"


#: 삭제·미리보기의 "이 행사에 그 기업이 없다" — 화면(BFF)은 이 구조화된 코드가 실린 404만 "기업 없음"으로 본다.
ORG_NOT_FOUND_DETAIL = {"code": "ORG_NOT_FOUND", "message": "기업을 찾을 수 없습니다"}


# =============================================================================
# DB 전체 스냅샷 · 비교
# =============================================================================
def _key(table_name: str, **pk) -> tuple[str, ...]:
    """그 테이블의 PK 컬럼 순서대로 만든 행 키 — 스냅샷의 키와 같은 모양."""
    table = Base.metadata.tables[table_name]
    return tuple(str(pk[col.name]) for col in table.primary_key.columns)


def _snapshot(db_factory) -> dict[str, dict[tuple[str, ...], dict]]:
    """모든 테이블의 모든 행 — {테이블: {PK: 행}}. 삭제 전후를 통째로 견주는 재료다."""
    # 일괄 메일 스레드가 발송 기록을 쓰는 중이면 스냅샷 사이에 행이 생긴다 — 끝까지 기다린 뒤 찍는다.
    shutdown_bulk_email(wait=True)
    db = db_factory()
    try:
        return {
            table.name: {
                tuple(str(row[col.name]) for col in table.primary_key.columns): dict(row)
                for row in db.execute(select(table)).mappings()
            }
            for table in Base.metadata.sorted_tables
        }
    finally:
        db.close()


@dataclasses.dataclass
class Diff:
    deleted: dict[str, set[tuple[str, ...]]]
    added: dict[str, set[tuple[str, ...]]]
    #: {테이블: {PK: {컬럼: (이전 값, 지금 값)}}}
    changed: dict[str, dict[tuple[str, ...], dict[str, tuple]]]

    @property
    def empty(self) -> bool:
        return not (self.deleted or self.added or self.changed)


def _diff(before: dict, after: dict) -> Diff:
    deleted: dict = {}
    added: dict = {}
    changed: dict = {}
    for table, rows in before.items():
        now = after[table]
        gone = set(rows) - set(now)
        new = set(now) - set(rows)
        if gone:
            deleted[table] = gone
        if new:
            added[table] = new
        for key in set(rows) & set(now):
            if rows[key] != now[key]:
                changed.setdefault(table, {})[key] = {
                    col: (rows[key][col], now[key][col])
                    for col in rows[key]
                    if rows[key][col] != now[key][col]
                }
    return Diff(deleted=deleted, added=added, changed=changed)


def _assert_nothing_changed(before: dict, after: dict) -> None:
    diff = _diff(before, after)
    assert diff.empty, f"아무것도 바뀌면 안 되는데 바뀌었다: {diff}"


#: 미리보기 칸 → 그 칸이 세는, 실제로 지워지는 행의 테이블. 연결 기록은 다섯 테이블의 합이다.
_PREVIEW_COUNT_TABLES: dict[str, tuple[str, ...]] = {
    "closed_meeting_count": ("meetings",),
    "review_count": ("post_meeting_reviews",),
    "transcription_job_count": ("transcription_jobs",),
    "notification_count": ("notifications",),
    "draft_item_count": ("saturation_draft_items",),
    "linked_record_count": (
        "interested_organizations",
        "love_calls",
        "ai_match_suggestions",
        "conversation_channels",
        "interpreter_assignments",
    ),
    "member_count": ("members",),
}


def _assert_preview_matches_deleted(impact: dict, diff: Diff, organization_id: str) -> None:
    """미리보기(삭제 전에 읽은 값)의 건수 = 삭제 전후 스냅샷 차이로 센, 실제로 지워진 행 수."""
    actual = {
        field: sum(len(diff.deleted.get(table, ())) for table in tables)
        for field, tables in _PREVIEW_COUNT_TABLES.items()
    }
    assert {field: impact[field] for field in _PREVIEW_COUNT_TABLES} == actual
    org_gone = _key("organizations", id=organization_id) in diff.deleted.get("organizations", set())
    assert impact["organization_deleted"] is org_gone


def _participation_rows(org: dict) -> dict[str, set]:
    """``_seed_org``가 만든 이 행사 참가(role)와 그 아래 행 — 참가를 지우면 함께 사라지는 행의 키."""
    rows: dict[str, set] = {
        "organization_event_roles": {_key("organization_event_roles", id=org["role_id"])},
        "org_event_role_org_types": {
            _key(
                "org_event_role_org_types",
                org_event_role_id=org["role_id"],
                keyword_id=org["org_type_keyword_id"],
            )
        },
    }
    if "exhibitor_profile_id" in org:
        rows["exhibitor_profiles"] = {_key("exhibitor_profiles", id=org["exhibitor_profile_id"])}
        rows["exhibitor_products"] = {_key("exhibitor_products", id=p) for p in org["product_ids"]}
        rows["exhibitor_attendees"] = {_key("exhibitor_attendees", id=org["exhibitor_attendee_id"])}
        rows["exhibitor_keywords"] = {
            _key(
                "exhibitor_keywords",
                exhibitor_profile_id=org["exhibitor_profile_id"],
                keyword_id=org["field_keyword_id"],
            )
        }
    if "buyer_profile_id" in org:
        rows["buyer_profiles"] = {_key("buyer_profiles", id=org["buyer_profile_id"])}
        rows["buyer_attendees"] = {_key("buyer_attendees", id=org["buyer_attendee_id"])}
        rows["buyer_recommended_buyers"] = {
            _key("buyer_recommended_buyers", id=org["recommended_buyer_id"])
        }
        rows["buyer_interest_keywords"] = {
            _key(
                "buyer_interest_keywords",
                buyer_profile_id=org["buyer_profile_id"],
                keyword_id=org["field_keyword_id"],
            )
        }
    return rows


def _merge_rows(*parts: dict[str, set]) -> dict[str, set]:
    merged: dict[str, set] = {}
    for part in parts:
        for table, keys in part.items():
            merged.setdefault(table, set()).update(keys)
    return merged


# =============================================================================
# 시드 헬퍼
# =============================================================================
def _seed_event(db_factory, **overrides) -> str:
    n = next(_seq)
    db = db_factory()
    try:
        slug = overrides.pop("slug", f"orgdel-{n}-{uuid.uuid4().hex[:8]}")
        ev = Event(name=overrides.pop("name", "삭제 규칙 검증 행사"), slug=slug, **overrides)
        db.add(ev)
        db.commit()
        return str(ev.id)
    finally:
        db.close()


def _keyword_id(db, category: str) -> str:
    return db.execute(
        select(Keyword.id).where(Keyword.category == category).order_by(Keyword.code).limit(1)
    ).scalar_one()


def _seed_org(
    db_factory,
    event_id: str,
    name: str,
    *,
    exhibitor: bool = False,
    buyer: bool = False,
    members: int = 1,
    status: str = "approved",
    buyer_subtype: str | None = None,
) -> dict:
    """기업 하나를 통째로 — 조직·참가(role)·프로필과 그 아래(제품·담당자·분야)·회원.

    돌려주는 dict에 만든 행의 id를 전부 담는다 — 테스트가 "무엇이 지워져야 하는가"를 직접 적을 수 있게.
    """
    n = next(_seq)
    # migrated_db는 세션 스코프라 여기서 커밋한 행이 뒤 테스트에 남는다 — 기업명으로 전역 조회하는 테스트
    # (예: test_roster_import.py의 name_ko == "참가사")와 겹치지 않게 이름에 고유 접미사를 붙인다.
    name = f"{name}-{uuid.uuid4().hex[:8]}"
    db = db_factory()
    try:
        org = Organization(name_ko=name, name_en=f"Org {n}")
        db.add(org)
        db.flush()
        role = OrganizationEventRole(
            organization_id=org.id,
            event_id=event_id,
            is_exhibitor=exhibitor,
            is_buyer=buyer,
            application_status=status,
            buyer_subtype=buyer_subtype,
        )
        db.add(role)
        member_rows = [
            Member(organization_id=org.id, name=f"담당자{n}-{i}", email=f"m{n}-{i}-{uuid.uuid4().hex[:6]}@example.com")
            for i in range(members)
        ]
        db.add_all(member_rows)
        db.flush()
        out: dict = {
            "org_id": str(org.id),
            "role_id": str(role.id),
            "member_ids": [str(m.id) for m in member_rows],
            "name": name,
            "emails": [m.email for m in member_rows],
        }
        org_type = _keyword_id(db, "org_type")
        db.add(OrgEventRoleOrgType(org_event_role_id=role.id, keyword_id=org_type))
        out["org_type_keyword_id"] = str(org_type)
        field = _keyword_id(db, "business_field")
        out["field_keyword_id"] = str(field)
        if exhibitor:
            profile = ExhibitorProfile(org_event_role_id=role.id, intro_ko=f"{name} 소개")
            db.add(profile)
            db.flush()
            products = [
                ExhibitorProduct(exhibitor_profile_id=profile.id, name_ko=f"제품{i}", sort_order=i)
                for i in range(2)
            ]
            attendee = ExhibitorAttendee(
                exhibitor_profile_id=profile.id,
                member_id=member_rows[0].id if member_rows else None,
                first_name_ko="담당",
                email=f"att{n}@example.com",
            )
            db.add_all([*products, attendee])
            db.add(ExhibitorKeyword(exhibitor_profile_id=profile.id, keyword_id=field))
            db.flush()
            out["exhibitor_profile_id"] = str(profile.id)
            out["product_ids"] = [str(p.id) for p in products]
            out["exhibitor_attendee_id"] = str(attendee.id)
        if buyer:
            profile = BuyerProfile(org_event_role_id=role.id, company_intro_en=f"{name} intro")
            db.add(profile)
            db.flush()
            attendee = BuyerAttendee(
                buyer_profile_id=profile.id,
                member_id=member_rows[0].id if member_rows else None,
                first_name="Buyer",
                email=f"batt{n}@example.com",
            )
            recommended = BuyerRecommendedBuyer(buyer_profile_id=profile.id, organization="Other Buyer")
            db.add_all([attendee, recommended])
            db.add(BuyerInterestKeyword(buyer_profile_id=profile.id, keyword_id=field))
            db.flush()
            out["buyer_profile_id"] = str(profile.id)
            out["buyer_attendee_id"] = str(attendee.id)
            out["recommended_buyer_id"] = str(recommended.id)
        db.commit()
        return out
    finally:
        db.close()


def _add_role(db_factory, event_id: str, org: dict, *, exhibitor: bool = False, buyer: bool = False) -> dict:
    """같은 조직에 다른 행사의 참가(role)를 하나 더 — 여러 행사에 걸친 기업."""
    db = db_factory()
    try:
        role = OrganizationEventRole(
            organization_id=org["org_id"],
            event_id=event_id,
            is_exhibitor=exhibitor,
            is_buyer=buyer,
            application_status="approved",
        )
        db.add(role)
        db.flush()
        out = {"role_id": str(role.id)}
        if exhibitor:
            profile = ExhibitorProfile(org_event_role_id=role.id, intro_ko="다른 행사 소개")
            db.add(profile)
            db.flush()
            out["exhibitor_profile_id"] = str(profile.id)
        db.commit()
        return out
    finally:
        db.close()


def _seed_meeting(db_factory, event_id: str, exhibitor: dict, buyer: dict, status: str, **overrides) -> str:
    """미팅 한 건 — 상태마다 DB CHECK가 요구하는 칸을 맞춘다(확정은 시간 필수, 사유는 그 상태에서만)."""
    # 미팅마다 다른 시각 — 같은 기업의 확정 미팅 여러 건이 슬롯 EXCLUDE에 걸리지 않게.
    start = datetime(2027, 3, 10, 0, 0, tzinfo=timezone.utc) + timedelta(minutes=30 * next(_seq))
    fields: dict = dict(
        event_id=event_id,
        exhibitor_org_id=exhibitor["org_id"],
        buyer_org_id=buyer["org_id"],
        matching_type="open",
        status=status,
        requested_by="buyer",
        scheduled_start=start,
        scheduled_end=start + timedelta(minutes=30),
    )
    if status == "proposed":
        fields["awaiting_org_id"] = exhibitor["org_id"]  # 바이어가 신청 → 참가사가 응답할 차례
    if status == "cancelled":
        fields.update(
            cancelled_at=start,
            cancelled_by="buyer",
            cancelled_by_org_id=buyer["org_id"],
            cancelled_reason_code="schedule_conflict",
        )
    if status == "rejected":
        fields.update(
            rejected_at=start,
            rejected_by_org_id=exhibitor["org_id"],
            rejected_reason_code="schedule_unavailable",
        )
    fields.update(overrides)
    db = db_factory()
    try:
        meeting = Meeting(**fields)
        db.add(meeting)
        db.commit()
        return str(meeting.id)
    finally:
        db.close()


def _seed_meeting_children(db_factory, event_id: str, meeting_id: str, *parties: dict) -> dict:
    """미팅에 딸린 행 — 양쪽 기업 각각의 참석자·회의록·전사 작업·알림(+발송 기록)."""
    db = db_factory()
    try:
        out: dict = {
            "participant_ids": [],
            "review_ids": [],
            "job_ids": [],
            "notification_ids": [],
            "dispatch_ids": [],
        }
        for party in parties:
            member_id = party["member_ids"][0]
            participant = MeetingParticipant(meeting_id=meeting_id, member_id=member_id)
            review = PostMeetingReview(
                meeting_id=meeting_id, reviewer_org_id=party["org_id"], satisfaction_rating=4
            )
            job = TranscriptionJob(meeting_id=meeting_id, org_id=party["org_id"], status="done")
            notification = Notification(
                event_id=event_id,
                recipient_org_id=party["org_id"],
                type="meeting_cancelled",
                meeting_id=meeting_id,
            )
            db.add_all([participant, review, job, notification])
            db.flush()
            dispatch = NotificationDispatch(
                notification_id=notification.id, member_id=member_id, channel="in_app", status="sent"
            )
            db.add(dispatch)
            db.flush()
            out["participant_ids"].append(str(participant.id))
            out["review_ids"].append(str(review.id))
            out["job_ids"].append(str(job.id))
            out["notification_ids"].append(str(notification.id))
            out["dispatch_ids"].append(str(dispatch.id))
        db.commit()
        return out
    finally:
        db.close()


def _seed_inbox_notification(db_factory, event_id: str, org: dict) -> dict:
    """미팅과 무관한 알림(신청 승인) — 그 기업 인박스에만 있는 행."""
    db = db_factory()
    try:
        notification = Notification(
            event_id=event_id, recipient_org_id=org["org_id"], type="application_approved"
        )
        db.add(notification)
        db.flush()
        dispatch = NotificationDispatch(
            notification_id=notification.id,
            member_id=org["member_ids"][0],
            channel="email",
            status="sent",
        )
        db.add(dispatch)
        db.commit()
        return {"notification_id": str(notification.id), "dispatch_id": str(dispatch.id)}
    finally:
        db.close()


def _seed_run(db_factory, event_id: str, status: str, items: list[tuple]) -> dict:
    """일괄 배정 run + 초안 항목. items = [(참가사, 바이어, 항목 상태, 물질화된 미팅 id 또는 None)]."""
    db = db_factory()
    try:
        number = (
            db.execute(
                select(SaturationBatchRun.run_number)
                .where(SaturationBatchRun.event_id == event_id)
                .order_by(SaturationBatchRun.run_number.desc())
                .limit(1)
            ).scalar_one_or_none()
            or 0
        ) + 1
        run = SaturationBatchRun(
            event_id=event_id, run_number=number, min_guaranteed_slots=1, status=status
        )
        db.add(run)
        db.flush()
        item_ids = []
        for seq, (exhibitor, buyer, item_status, meeting_id) in enumerate(items, start=1):
            start = datetime(2027, 3, 12, 0, 0, tzinfo=timezone.utc) + timedelta(minutes=30 * next(_seq))
            item = SaturationDraftItem(
                saturation_run_id=run.id,
                exhibitor_org_id=exhibitor["org_id"],
                buyer_org_id=buyer["org_id"],
                scheduled_start=start,
                scheduled_end=start + timedelta(minutes=30),
                status=item_status,
                materialized_meeting_id=meeting_id,
                seq_no=seq,
            )
            db.add(item)
            db.flush()
            item_ids.append(str(item.id))
        db.commit()
        return {"run_id": str(run.id), "item_ids": item_ids}
    finally:
        db.close()


def _exists(db_factory, model, row_id: str) -> bool:
    db = db_factory()
    try:
        return db.get(model, row_id) is not None
    finally:
        db.close()


# =============================================================================
# 핵심 — 닫힌 미팅만 있는 기업: 지워져야 할 것만 지워진다
# =============================================================================
def _build_world(db_factory) -> dict:
    """삭제 대상(T)과 그 주변 — 상대 기업, 상대의 다른 미팅, 무관한 미팅까지 한 행사에 깐다.

    T는 참가사 겸 바이어다(미팅이 두 축에 다 걸린다):
      · T(참가사) – C(바이어)   취소됨   ← 지워진다(딸린 회의록·전사 작업·알림·참석자 포함)
      · E3(참가사) – T(바이어)  거절됨   ← 지워진다
    그대로 남아야 하는 것:
      · E2 – C    확정     (상대 C의 다른 미팅)
      · E2 – C    완료     (상대 C의 다른 미팅 — 회의록 포함)
      · E3 – C2   수락대기 (상대 E3의 다른 미팅)
      · E2 – C2   취소됨   (T와 무관한 닫힌 미팅 — 닫혔다는 이유로 지워지면 안 된다)
    """
    event_id = _seed_event(db_factory)
    target = _seed_org(db_factory, event_id, "삭제대상", exhibitor=True, buyer=True, members=2)
    c = _seed_org(db_factory, event_id, "상대바이어C", buyer=True)
    c2 = _seed_org(db_factory, event_id, "무관바이어C2", buyer=True)
    e2 = _seed_org(db_factory, event_id, "무관참가사E2", exhibitor=True)
    e3 = _seed_org(db_factory, event_id, "상대참가사E3", exhibitor=True)

    m_cancelled = _seed_meeting(db_factory, event_id, target, c, "cancelled")
    m_rejected = _seed_meeting(db_factory, event_id, e3, target, "rejected")
    m_c_accepted = _seed_meeting(db_factory, event_id, e2, c, "accepted")
    m_c_completed = _seed_meeting(db_factory, event_id, e2, c, "completed")
    m_e3_proposed = _seed_meeting(db_factory, event_id, e3, c2, "proposed")
    m_unrelated_cancelled = _seed_meeting(db_factory, event_id, e2, c2, "cancelled")

    children_cancelled = _seed_meeting_children(db_factory, event_id, m_cancelled, target, c)
    children_rejected = _seed_meeting_children(db_factory, event_id, m_rejected, e3, target)
    # 남아야 하는 미팅에도 같은 종류의 행을 깐다 — 이것들이 한 행도 안 사라져야 한다.
    _seed_meeting_children(db_factory, event_id, m_c_accepted, e2, c)
    _seed_meeting_children(db_factory, event_id, m_c_completed, e2, c)
    _seed_meeting_children(db_factory, event_id, m_e3_proposed, e3, c2)
    _seed_meeting_children(db_factory, event_id, m_unrelated_cancelled, e2, c2)

    inbox_target = _seed_inbox_notification(db_factory, event_id, target)
    _seed_inbox_notification(db_factory, event_id, c)  # 상대의 인박스 — 남아야 한다

    # 일괄 배정: 확정된 run(항목이 미팅을 가리킨다)과 아직 초안인 run.
    confirmed_run = _seed_run(
        db_factory,
        event_id,
        "confirmed",
        [
            (target, c, "confirmed", m_cancelled),  # 지워진다
            (e2, c2, "confirmed", m_unrelated_cancelled),  # 남는다(미팅 참조도 그대로)
        ],
    )
    draft_run = _seed_run(
        db_factory,
        event_id,
        "draft",
        [
            (target, c2, "draft", None),  # 지워진다(T가 참가사 축)
            (e3, target, "draft", None),  # 지워진다(T가 바이어 축)
            (e2, c, "draft", None),  # 남는다
        ],
    )

    db = db_factory()
    try:
        # T에만 걸린 부속 행 — 조직과 함께 지워지는 것(CASCADE)과 참조만 끊기는 것(SET NULL).
        love_call = LoveCall(
            meeting_id=m_cancelled, event_id=event_id, from_org_id=c["org_id"], to_org_id=target["org_id"]
        )
        bookmark_in = InterestedOrganization(
            event_id=event_id, owner_org_id=c["org_id"], target_org_id=target["org_id"], source="all"
        )
        bookmark_out = InterestedOrganization(
            event_id=event_id, owner_org_id=target["org_id"], target_org_id=c["org_id"], source="all"
        )
        bookmark_unrelated = InterestedOrganization(
            event_id=event_id, owner_org_id=c["org_id"], target_org_id=e2["org_id"], source="all"
        )
        suggestion = AiMatchSuggestion(
            event_id=event_id, for_org_id=c["org_id"], target_org_id=target["org_id"]
        )
        channel = ConversationChannel(
            event_id=event_id, org_a_id=target["org_id"], org_b_id=c["org_id"]
        )
        interpreter = Interpreter(event_id=event_id, name="통역사")
        db.add_all(
            [love_call, bookmark_in, bookmark_out, bookmark_unrelated, suggestion, channel, interpreter]
        )
        db.flush()
        assignment = InterpreterAssignment(
            interpreter_id=interpreter.id, organization_id=target["org_id"], event_id=event_id
        )
        consent = UserConsentState(member_id=target["member_ids"][0], type="tos", agreed=True)
        registrant = Registrant(
            event_id=event_id,
            organizer_member_id=f"roster-{uuid.uuid4().hex[:8]}",
            organization_id=target["org_id"],
            raw={},
        )
        file = File(
            s3_key=f"logos/{uuid.uuid4().hex}",
            purpose="company_logo",
            owner_org_id=target["org_id"],
            uploaded_by_member_id=target["member_ids"][0],
        )
        db.add_all([assignment, consent, registrant, file])
        db.commit()
        extras = {
            "love_call_id": str(love_call.id),
            "bookmark_in_id": str(bookmark_in.id),
            "bookmark_out_id": str(bookmark_out.id),
            "bookmark_unrelated_id": str(bookmark_unrelated.id),
            "suggestion_id": str(suggestion.id),
            "channel_id": str(channel.id),
            "interpreter_id": str(interpreter.id),
            "assignment_id": str(assignment.id),
            "consent_id": str(consent.id),
            "registrant_id": str(registrant.id),
            "file_id": str(file.id),
        }
    finally:
        db.close()

    return {
        "event_id": event_id,
        "target": target,
        "c": c,
        "c2": c2,
        "e2": e2,
        "e3": e3,
        "m_cancelled": m_cancelled,
        "m_rejected": m_rejected,
        "kept_meetings": [m_c_accepted, m_c_completed, m_e3_proposed, m_unrelated_cancelled],
        "children_cancelled": children_cancelled,
        "children_rejected": children_rejected,
        "inbox_target": inbox_target,
        "confirmed_run": confirmed_run,
        "draft_run": draft_run,
        **extras,
    }


def test_delete_with_only_closed_meetings_removes_exactly_what_it_should(client, db_factory):
    w = _build_world(db_factory)
    event_id, t = w["event_id"], w["target"]
    _as_master(event_id)

    before = _snapshot(db_factory)
    preview = client.get(_impact_url(event_id, t["org_id"]))
    assert preview.status_code == 200, preview.text
    impact = preview.json()
    _assert_nothing_changed(before, _snapshot(db_factory))  # 미리보기는 읽기만 한다

    resp = client.delete(_delete_url(event_id, t["org_id"]))
    assert resp.status_code == 204, resp.text
    diff = _diff(before, _snapshot(db_factory))

    closed = [w["m_cancelled"], w["m_rejected"]]
    children = [w["children_cancelled"], w["children_rejected"]]
    meeting_notifications = [n for ch in children for n in ch["notification_ids"]]
    meeting_dispatches = [d for ch in children for d in ch["dispatch_ids"]]
    confirmed_item_of_target = w["confirmed_run"]["item_ids"][0]
    draft_items_of_target = w["draft_run"]["item_ids"][:2]

    def ids(table: str, *values: str) -> set:
        return {_key(table, id=v) for v in values}

    expected_deleted = {
        # 이 행사의 참가와 그 아래
        "organization_event_roles": ids("organization_event_roles", t["role_id"]),
        "exhibitor_profiles": ids("exhibitor_profiles", t["exhibitor_profile_id"]),
        "exhibitor_products": ids("exhibitor_products", *t["product_ids"]),
        "exhibitor_attendees": ids("exhibitor_attendees", t["exhibitor_attendee_id"]),
        "exhibitor_keywords": {
            _key(
                "exhibitor_keywords",
                exhibitor_profile_id=t["exhibitor_profile_id"],
                keyword_id=t["field_keyword_id"],
            )
        },
        "buyer_profiles": ids("buyer_profiles", t["buyer_profile_id"]),
        "buyer_attendees": ids("buyer_attendees", t["buyer_attendee_id"]),
        "buyer_recommended_buyers": ids("buyer_recommended_buyers", t["recommended_buyer_id"]),
        "buyer_interest_keywords": {
            _key(
                "buyer_interest_keywords",
                buyer_profile_id=t["buyer_profile_id"],
                keyword_id=t["field_keyword_id"],
            )
        },
        "org_event_role_org_types": {
            _key(
                "org_event_role_org_types",
                org_event_role_id=t["role_id"],
                keyword_id=t["org_type_keyword_id"],
            )
        },
        # 닫힌 미팅과 그 미팅에 딸린 행(양쪽 기업 것 모두)
        "meetings": ids("meetings", *closed),
        "meeting_participants": ids(
            "meeting_participants", *[p for ch in children for p in ch["participant_ids"]]
        ),
        "post_meeting_reviews": ids(
            "post_meeting_reviews", *[r for ch in children for r in ch["review_ids"]]
        ),
        "transcription_jobs": ids("transcription_jobs", *[j for ch in children for j in ch["job_ids"]]),
        "notifications": ids(
            "notifications", *meeting_notifications, w["inbox_target"]["notification_id"]
        ),
        "notification_dispatches": ids(
            "notification_dispatches", *meeting_dispatches, w["inbox_target"]["dispatch_id"]
        ),
        # 이 기업을 가리키는 일괄 배정 초안 항목(run 행은 남는다)
        "saturation_draft_items": ids(
            "saturation_draft_items", confirmed_item_of_target, *draft_items_of_target
        ),
        # 조직과 회원, 조직에만 걸린 부속 행
        "organizations": ids("organizations", t["org_id"]),
        "members": ids("members", *t["member_ids"]),
        "user_consent_states": ids("user_consent_states", w["consent_id"]),
        "love_calls": ids("love_calls", w["love_call_id"]),
        "interested_organizations": ids(
            "interested_organizations", w["bookmark_in_id"], w["bookmark_out_id"]
        ),
        "ai_match_suggestions": ids("ai_match_suggestions", w["suggestion_id"]),
        "conversation_channels": ids("conversation_channels", w["channel_id"]),
        "interpreter_assignments": ids("interpreter_assignments", w["assignment_id"]),
    }
    assert diff.deleted == expected_deleted
    assert diff.added == {}
    # 바뀐 칸은 "지워진 조직·회원을 가리키던 포인터가 NULL이 된 것"뿐이다(행은 남는다).
    assert diff.changed == {
        "registrants": {
            _key("registrants", id=w["registrant_id"]): {"organization_id": (t["org_id"], None)}
        },
        "files": {
            _key("files", id=w["file_id"]): {
                "owner_org_id": (t["org_id"], None),
                "uploaded_by_member_id": (t["member_ids"][0], None),
            }
        },
    }

    # 위 비교가 이미 증명하지만, 요구사항을 문장 그대로 한 번 더 확인한다.
    for other in (w["c"], w["c2"], w["e2"], w["e3"]):  # 상대 기업·무관한 기업
        assert _exists(db_factory, Organization, other["org_id"])
        assert _exists(db_factory, OrganizationEventRole, other["role_id"])
        assert all(_exists(db_factory, Member, m) for m in other["member_ids"])
    for meeting_id in w["kept_meetings"]:  # 상대의 다른 미팅·무관한 미팅(닫힌 것 포함)
        assert _exists(db_factory, Meeting, meeting_id)
    assert _exists(db_factory, SaturationBatchRun, w["confirmed_run"]["run_id"])
    assert _exists(db_factory, SaturationBatchRun, w["draft_run"]["run_id"])
    assert _exists(db_factory, InterestedOrganization, w["bookmark_unrelated_id"])

    # 미리보기가 말한 것 = 실제로 지워진 것. 알림은 닫힌 미팅의 것(양쪽 인박스 4건)에 이 기업 인박스의 미팅
    # 무관 알림 1건을 더한 5건이다 — 이 기업이 받은 미팅 알림 2건은 양쪽에 다 걸리지만 한 번만 센다.
    _assert_preview_matches_deleted(impact, diff, t["org_id"])
    assert impact == {
        "organization_id": t["org_id"],
        "deletable": True,
        "scheduled_count": 0,
        "completed_count": 0,
        "closed_meeting_count": 2,
        "review_count": 4,
        "transcription_job_count": 4,
        "notification_count": len(meeting_notifications) + 1,
        "draft_item_count": 3,
        "linked_record_count": 6,  # 러브콜 1·관심 표시 2·AI 추천 1·대화 채널 1·통역 배정 1
        "member_count": 2,
        "organization_deleted": True,
        "other_event_count": 0,
    }

    # 목록에서도 사라졌고, 다시 지우면 구조화된 404다(500이 아니다).
    listed = client.get(f"/api/admin/events/{event_id}/organizations?limit=100").json()
    assert t["org_id"] not in {i["id"] for i in listed["items"]}
    again = [client.delete(_delete_url(event_id, t["org_id"])), client.get(_impact_url(event_id, t["org_id"]))]
    for resp in again:
        assert resp.status_code == 404
        assert resp.json() == {"detail": ORG_NOT_FOUND_DETAIL}


def test_delete_without_meetings_removes_role_org_and_members_only(client, db_factory):
    """미팅이 없는 기업은 기존대로 — 참가·프로필·조직·회원만 사라지고 그 밖은 그대로다."""
    event_id = _seed_event(db_factory)
    t = _seed_org(db_factory, event_id, "미팅없는기업", exhibitor=True)
    other = _seed_org(db_factory, event_id, "다른기업", buyer=True)
    _seed_meeting(db_factory, event_id, _seed_org(db_factory, event_id, "E", exhibitor=True), other, "accepted")
    _as_master(event_id)

    before = _snapshot(db_factory)
    impact = client.get(_impact_url(event_id, t["org_id"])).json()
    assert impact["deletable"] is True
    assert impact["closed_meeting_count"] == 0
    assert impact["organization_deleted"] is True
    assert impact["member_count"] == 1

    assert client.delete(_delete_url(event_id, t["org_id"])).status_code == 204
    diff = _diff(before, _snapshot(db_factory))
    assert set(diff.deleted) == {
        "organizations",
        "organization_event_roles",
        "members",
        "exhibitor_profiles",
        "exhibitor_products",
        "exhibitor_attendees",
        "exhibitor_keywords",
        "org_event_role_org_types",
    }
    assert diff.deleted["organizations"] == {_key("organizations", id=t["org_id"])}
    assert diff.deleted["members"] == {_key("members", id=m) for m in t["member_ids"]}
    assert diff.added == {} and diff.changed == {}
    _assert_preview_matches_deleted(impact, diff, t["org_id"])


# =============================================================================
# 막는 경우 — 예정·완료 미팅. 아무것도 지워지지 않는다.
# =============================================================================
def test_scheduled_meetings_block_with_counts(client, db_factory):
    """예정(proposed·accepted) 미팅이 있으면 409 + 건수 — 닫힌 미팅이 섞여 있어도 하나도 안 지운다."""
    event_id = _seed_event(db_factory)
    t = _seed_org(db_factory, event_id, "예정미팅기업", exhibitor=True)
    buyer = _seed_org(db_factory, event_id, "바이어", buyer=True)
    _seed_meeting(db_factory, event_id, t, buyer, "proposed")
    _seed_meeting(db_factory, event_id, t, buyer, "accepted")
    cancelled = _seed_meeting(db_factory, event_id, t, buyer, "cancelled")
    _seed_meeting_children(db_factory, event_id, cancelled, t, buyer)
    _as_master(event_id)

    before = _snapshot(db_factory)
    impact = client.get(_impact_url(event_id, t["org_id"])).json()
    assert impact["deletable"] is False
    assert (impact["scheduled_count"], impact["completed_count"]) == (2, 0)

    resp = client.delete(_delete_url(event_id, t["org_id"]))
    assert resp.status_code == 409
    detail = resp.json()["detail"]
    assert detail["code"] == "ORG_HAS_MEETINGS"
    assert detail["scheduled_count"] == 2
    assert detail["completed_count"] == 0
    assert detail["meeting_count"] == 2  # 막는 미팅 수(취소된 1건은 세지 않는다)
    assert "예정된 미팅이 2건" in detail["message"]
    _assert_nothing_changed(before, _snapshot(db_factory))


def test_completed_meetings_block_with_counts(client, db_factory):
    """완료 미팅이 있으면 409 + 건수 — 상대 기업의 회의록·미팅 이력을 지키기 위해 삭제 자체를 막는다."""
    event_id = _seed_event(db_factory)
    t = _seed_org(db_factory, event_id, "완료미팅기업", buyer=True)
    exhibitor = _seed_org(db_factory, event_id, "참가사", exhibitor=True)
    completed = _seed_meeting(db_factory, event_id, exhibitor, t, "completed")
    children = _seed_meeting_children(db_factory, event_id, completed, exhibitor, t)
    _as_master(event_id)

    before = _snapshot(db_factory)
    impact = client.get(_impact_url(event_id, t["org_id"])).json()
    assert impact["deletable"] is False
    assert (impact["scheduled_count"], impact["completed_count"]) == (0, 1)

    resp = client.delete(_delete_url(event_id, t["org_id"]))
    assert resp.status_code == 409
    detail = resp.json()["detail"]
    assert detail["code"] == "ORG_HAS_MEETINGS"
    assert (detail["scheduled_count"], detail["completed_count"]) == (0, 1)
    assert "완료된 미팅이 1건" in detail["message"]
    _assert_nothing_changed(before, _snapshot(db_factory))
    assert all(_exists(db_factory, PostMeetingReview, r) for r in children["review_ids"])


def test_scheduled_and_completed_are_both_reported(client, db_factory):
    event_id = _seed_event(db_factory)
    t = _seed_org(db_factory, event_id, "둘다있는기업", exhibitor=True, buyer=True)
    buyer = _seed_org(db_factory, event_id, "바이어", buyer=True)
    exhibitor = _seed_org(db_factory, event_id, "참가사", exhibitor=True)
    _seed_meeting(db_factory, event_id, t, buyer, "accepted")  # T가 참가사 축
    _seed_meeting(db_factory, event_id, exhibitor, t, "completed")  # T가 바이어 축
    _seed_meeting(db_factory, event_id, exhibitor, t, "completed")
    _seed_meeting(db_factory, event_id, t, buyer, "rejected")
    _as_master(event_id)

    before = _snapshot(db_factory)
    impact = client.get(_impact_url(event_id, t["org_id"])).json()
    assert impact["deletable"] is False
    assert (impact["scheduled_count"], impact["completed_count"]) == (1, 2)
    assert impact["closed_meeting_count"] == 1

    resp = client.delete(_delete_url(event_id, t["org_id"]))
    assert resp.status_code == 409
    detail = resp.json()["detail"]
    assert (detail["scheduled_count"], detail["completed_count"], detail["meeting_count"]) == (1, 2, 3)
    assert "예정된 미팅 1건" in detail["message"] and "완료된 미팅 2건" in detail["message"]
    _assert_nothing_changed(before, _snapshot(db_factory))


def test_blocked_until_scheduled_meeting_is_cancelled_then_deletable(client, db_factory):
    """고객이 막혔던 흐름 — 미팅을 취소하고 나면 삭제된다(예전엔 취소해도 영영 409였다)."""
    event_id = _seed_event(db_factory)
    t = _seed_org(db_factory, event_id, "테스트로만든기업", exhibitor=True)
    buyer = _seed_org(db_factory, event_id, "바이어", buyer=True)
    meeting_id = _seed_meeting(db_factory, event_id, t, buyer, "accepted")
    _as_master(event_id)

    assert client.delete(_delete_url(event_id, t["org_id"])).status_code == 409

    cancelled = client.post(f"/api/admin/events/{event_id}/meetings/{meeting_id}/cancel", json={})
    assert cancelled.status_code == 200, cancelled.text

    impact = client.get(_impact_url(event_id, t["org_id"])).json()
    assert impact["deletable"] is True
    assert impact["closed_meeting_count"] == 1
    assert client.delete(_delete_url(event_id, t["org_id"])).status_code == 204
    assert not _exists(db_factory, Meeting, meeting_id)
    assert not _exists(db_factory, Organization, t["org_id"])
    assert _exists(db_factory, Organization, buyer["org_id"])


def test_state_change_after_preview_is_caught_by_delete(client, db_factory):
    """미리보기를 읽은 뒤 미팅이 확정으로 바뀌면 — 삭제가 다시 판정해 409로 답하고 아무것도 안 지운다."""
    event_id = _seed_event(db_factory)
    t = _seed_org(db_factory, event_id, "그사이바뀐기업", exhibitor=True)
    buyer = _seed_org(db_factory, event_id, "바이어", buyer=True)
    meeting_id = _seed_meeting(db_factory, event_id, t, buyer, "cancelled")
    _as_master(event_id)

    assert client.get(_impact_url(event_id, t["org_id"])).json()["deletable"] is True

    db = db_factory()
    try:
        meeting = db.get(Meeting, meeting_id)
        meeting.cancelled_reason_code = None
        meeting.status = "accepted"
        db.commit()
    finally:
        db.close()

    before = _snapshot(db_factory)
    resp = client.delete(_delete_url(event_id, t["org_id"]))
    assert resp.status_code == 409
    assert resp.json()["detail"]["scheduled_count"] == 1
    _assert_nothing_changed(before, _snapshot(db_factory))


# =============================================================================
# 일괄 배정 초안이 가리키는 기업
# =============================================================================
def test_org_referenced_by_saturation_draft_is_deleted_and_run_still_confirms(client, db_factory):
    """초안 항목이 조직을 ondelete 없는 FK로 가리켜 예전엔 삭제가 500이었다. 이제 그 항목을 지우고,
    남은 초안은 그대로 확정된다(지운 기업으로 미팅을 만들려 들지 않는다)."""
    today = datetime.now(timezone.utc).date()
    event_id = _seed_event(
        db_factory,
        exhibition_start=today,
        exhibition_end=today + timedelta(days=5),
        timezone="Asia/Seoul",
        enabled_venue_types=["booth", "zone_table", "business_room"],
    )
    db = db_factory()
    try:
        db.add(EventScheduleSettings(event_id=event_id, min_guaranteed_slots=1))
        db.commit()
    finally:
        db.close()
    ex1 = _seed_org(db_factory, event_id, "초안참가사1", exhibitor=True)
    ex2 = _seed_org(db_factory, event_id, "초안참가사2", exhibitor=True)
    _seed_org(db_factory, event_id, "초안바이어1", buyer=True, buyer_subtype="hosted")
    _seed_org(db_factory, event_id, "초안바이어2", buyer=True, buyer_subtype="hosted")
    _as_master(event_id)

    run = client.post(f"/api/admin/events/{event_id}/saturation-runs").json()
    assert len(run["items"]) == 2
    item_ex1 = next(i for i in run["items"] if i["exhibitor_org_id"] == ex1["org_id"])
    item_ex2 = next(i for i in run["items"] if i["exhibitor_org_id"] == ex2["org_id"])

    before = _snapshot(db_factory)
    impact = client.get(_impact_url(event_id, ex1["org_id"])).json()
    assert impact["deletable"] is True
    assert impact["draft_item_count"] == 1

    assert client.delete(_delete_url(event_id, ex1["org_id"])).status_code == 204
    diff = _diff(before, _snapshot(db_factory))
    assert diff.deleted["saturation_draft_items"] == {_key("saturation_draft_items", id=item_ex1["id"])}
    assert "saturation_batch_runs" not in diff.deleted  # 실행 이력(run 행)은 남는다
    assert diff.added == {} and diff.changed == {}

    confirmed = client.post(f"/api/admin/events/{event_id}/saturation-runs/{run['id']}/confirm")
    assert confirmed.status_code == 200, confirmed.text
    body = confirmed.json()
    assert (body["confirmed_count"], body["skipped_count"]) == (1, 0)
    assert [i["id"] for i in body["items"]] == [item_ex2["id"]]


def test_mismatched_draft_item_pointing_at_closed_meeting_is_unlinked_not_deleted(client, db_factory):
    """닫힌 미팅을 가리키는 초안 항목이 이 기업의 것이 아니어도(쌍이 어긋난 데이터) FK 위반 없이
    지워진다 — 그 항목은 남기고 미팅 참조만 끊는다(``materialized_meeting_id``는 삭제 규칙이 없는 FK다)."""
    event_id = _seed_event(db_factory)
    t = _seed_org(db_factory, event_id, "삭제대상", exhibitor=True)
    buyer = _seed_org(db_factory, event_id, "바이어", buyer=True)
    e2 = _seed_org(db_factory, event_id, "다른참가사", exhibitor=True)
    meeting_id = _seed_meeting(db_factory, event_id, t, buyer, "cancelled")
    run = _seed_run(db_factory, event_id, "confirmed", [(e2, buyer, "confirmed", meeting_id)])
    _as_master(event_id)

    before = _snapshot(db_factory)
    assert client.delete(_delete_url(event_id, t["org_id"])).status_code == 204
    diff = _diff(before, _snapshot(db_factory))
    assert "saturation_draft_items" not in diff.deleted
    assert diff.changed == {
        "saturation_draft_items": {
            _key("saturation_draft_items", id=run["item_ids"][0]): {
                "materialized_meeting_id": (meeting_id, None)
            }
        }
    }


def test_draft_items_of_other_events_keep_the_organization(client, db_factory):
    """다른 행사의 일괄 배정 기록이 이 기업을 가리키면(그 행사 참가가 이미 빠졌어도) 조직은 남는다 — 그 항목은
    다른 행사의 기록이라 지우지 않고, 조직 FK가 NOT NULL·삭제 규칙 없음이라 남긴 채 조직을 지울 수도 없다.
    이 행사 참가만 빠지고, 다른 행사의 항목·실행(run)은 한 줄도 바뀌지 않는다. (예전 구현은 조직을 지우면서
    다른 행사의 항목까지 지웠다 — 교차 리뷰 지적.)"""
    event_a = _seed_event(db_factory, name="행사A")
    event_b = _seed_event(db_factory, name="행사B")
    t = _seed_org(db_factory, event_a, "다른행사에초안이남은기업", exhibitor=True)
    buyer_b = _seed_org(db_factory, event_b, "B바이어", buyer=True)
    exhibitor_b = _seed_org(db_factory, event_b, "B참가사", exhibitor=True)
    run_b = _seed_run(
        db_factory,
        event_b,
        "discarded",
        [(t, buyer_b, "draft", None), (exhibitor_b, buyer_b, "draft", None)],
    )
    _as_master(event_a)

    before = _snapshot(db_factory)
    impact = client.get(_impact_url(event_a, t["org_id"])).json()
    assert impact["organization_deleted"] is False
    assert impact["draft_item_count"] == 0  # 지우는 일괄 배정 기록은 이 행사 것뿐이다
    assert (impact["member_count"], impact["linked_record_count"]) == (0, 0)

    assert client.delete(_delete_url(event_a, t["org_id"])).status_code == 204
    diff = _diff(before, _snapshot(db_factory))
    assert diff.deleted == _participation_rows(t)
    assert diff.added == {} and diff.changed == {}
    _assert_preview_matches_deleted(impact, diff, t["org_id"])
    assert _exists(db_factory, Organization, t["org_id"])
    assert all(_exists(db_factory, Member, m) for m in t["member_ids"])
    assert all(_exists(db_factory, SaturationDraftItem, item) for item in run_b["item_ids"])
    assert _exists(db_factory, SaturationBatchRun, run_b["run_id"])


# =============================================================================
# 다른 행사에도 참가 중인 기업 — 이 행사 것만 빠지고 조직은 남는다
# =============================================================================
def test_multi_event_org_keeps_org_and_other_event_data(client, db_factory):
    event_a = _seed_event(db_factory, name="행사A")
    event_b = _seed_event(db_factory, name="행사B")
    t = _seed_org(db_factory, event_a, "두행사기업", exhibitor=True, members=2)
    role_b = _add_role(db_factory, event_b, t, exhibitor=True)
    buyer_a = _seed_org(db_factory, event_a, "A바이어", buyer=True)
    buyer_b = _seed_org(db_factory, event_b, "B바이어", buyer=True)

    closed_a = _seed_meeting(db_factory, event_a, t, buyer_a, "cancelled")
    children_a = _seed_meeting_children(db_factory, event_a, closed_a, t, buyer_a)
    # 행사 B의 것 — 확정 미팅, 닫힌 미팅, 초안 항목. 행사 A에서 지워도 전부 남아야 한다.
    accepted_b = _seed_meeting(db_factory, event_b, t, buyer_b, "accepted")
    cancelled_b = _seed_meeting(db_factory, event_b, t, buyer_b, "cancelled")
    _seed_meeting_children(db_factory, event_b, accepted_b, t, buyer_b)
    _seed_meeting_children(db_factory, event_b, cancelled_b, t, buyer_b)
    run_a = _seed_run(db_factory, event_a, "draft", [(t, buyer_a, "draft", None)])
    run_b = _seed_run(db_factory, event_b, "draft", [(t, buyer_b, "draft", None)])
    inbox = _seed_inbox_notification(db_factory, event_a, t)
    db = db_factory()
    try:
        love_call = LoveCall(
            meeting_id=closed_a, event_id=event_a, from_org_id=t["org_id"], to_org_id=buyer_a["org_id"]
        )
        db.add(love_call)
        db.commit()
        love_call_id = str(love_call.id)
    finally:
        db.close()
    _as_master(event_a)

    before = _snapshot(db_factory)
    impact = client.get(_impact_url(event_a, t["org_id"])).json()
    assert client.delete(_delete_url(event_a, t["org_id"])).status_code == 204
    diff = _diff(before, _snapshot(db_factory))

    def ids(table: str, *values: str) -> set:
        return {_key(table, id=v) for v in values}

    assert diff.deleted == {
        "organization_event_roles": ids("organization_event_roles", t["role_id"]),
        "exhibitor_profiles": ids("exhibitor_profiles", t["exhibitor_profile_id"]),
        "exhibitor_products": ids("exhibitor_products", *t["product_ids"]),
        "exhibitor_attendees": ids("exhibitor_attendees", t["exhibitor_attendee_id"]),
        "exhibitor_keywords": {
            _key(
                "exhibitor_keywords",
                exhibitor_profile_id=t["exhibitor_profile_id"],
                keyword_id=t["field_keyword_id"],
            )
        },
        "org_event_role_org_types": {
            _key(
                "org_event_role_org_types",
                org_event_role_id=t["role_id"],
                keyword_id=t["org_type_keyword_id"],
            )
        },
        "meetings": ids("meetings", closed_a),
        "meeting_participants": ids("meeting_participants", *children_a["participant_ids"]),
        "post_meeting_reviews": ids("post_meeting_reviews", *children_a["review_ids"]),
        "transcription_jobs": ids("transcription_jobs", *children_a["job_ids"]),
        "notifications": ids("notifications", *children_a["notification_ids"]),
        "notification_dispatches": ids("notification_dispatches", *children_a["dispatch_ids"]),
        "saturation_draft_items": ids("saturation_draft_items", *run_a["item_ids"]),
    }
    assert diff.added == {}
    # 조직이 남으므로 러브콜 행도 남는다 — 지워진 미팅을 가리키던 참조만 DB 규칙(SET NULL)대로 끊긴다.
    assert diff.changed == {
        "love_calls": {_key("love_calls", id=love_call_id): {"meeting_id": (closed_a, None)}}
    }

    # 조직·회원·다른 행사의 참가와 미팅·초안, 미팅과 무관한 알림은 그대로다.
    assert _exists(db_factory, Organization, t["org_id"])
    assert all(_exists(db_factory, Member, m) for m in t["member_ids"])
    assert _exists(db_factory, OrganizationEventRole, role_b["role_id"])
    assert _exists(db_factory, ExhibitorProfile, role_b["exhibitor_profile_id"])
    assert _exists(db_factory, Meeting, accepted_b) and _exists(db_factory, Meeting, cancelled_b)
    assert _exists(db_factory, SaturationDraftItem, run_b["item_ids"][0])
    assert _exists(db_factory, Notification, inbox["notification_id"])

    _assert_preview_matches_deleted(impact, diff, t["org_id"])
    assert impact == {
        "organization_id": t["org_id"],
        "deletable": True,
        "scheduled_count": 0,
        "completed_count": 0,
        "closed_meeting_count": 1,
        "review_count": 2,
        "transcription_job_count": 2,
        "notification_count": 2,  # 조직이 남으니 이 기업 인박스의 미팅 무관 알림은 남는다
        "draft_item_count": 1,
        "linked_record_count": 0,  # 조직이 남으니 러브콜도 남는다(지워진 미팅 참조만 끊긴다)
        "member_count": 0,  # 조직이 남으니 로그인 계정도 남는다
        "organization_deleted": False,
        "other_event_count": 1,
    }

    # 행사 B에서는 여전히 참가 중이고, 거기 예정 미팅이 있어 B에서의 삭제는 막힌다.
    _as_master(event_b)
    assert client.delete(_delete_url(event_b, t["org_id"])).status_code == 409


def test_meeting_left_in_another_event_keeps_org_instead_of_cascading(client, db_factory):
    """``meetings.awaiting_org_id``는 ON DELETE CASCADE다 — 조직을 지우면 그 조직의 응답을 기다리던 미팅이
    말없이 함께 지워진다. 참가가 없는 다른 행사에 미팅이 남은 조직은(정상 흐름에선 생기지 않는 데이터)
    지우지 않고 이 행사 참가만 뺀다 — 다른 행사의 미팅은 한 행도 건드리지 않는다."""
    event_a = _seed_event(db_factory, name="행사A")
    event_b = _seed_event(db_factory, name="행사B")
    t = _seed_org(db_factory, event_a, "다른행사에미팅이남은기업", buyer=True)
    exhibitor_b = _seed_org(db_factory, event_b, "B참가사", exhibitor=True)
    # T는 행사 B에 참가(role)가 없는데 미팅만 남아 있다.
    waiting_on_t = _seed_meeting(
        db_factory, event_b, exhibitor_b, t, "proposed", awaiting_org_id=t["org_id"], requested_by="exhibitor"
    )
    accepted_b = _seed_meeting(db_factory, event_b, exhibitor_b, t, "accepted")
    _as_master(event_a)

    before = _snapshot(db_factory)
    impact = client.get(_impact_url(event_a, t["org_id"])).json()
    assert impact["deletable"] is True
    assert impact["organization_deleted"] is False
    assert impact["member_count"] == 0
    assert impact["other_event_count"] == 0

    assert client.delete(_delete_url(event_a, t["org_id"])).status_code == 204
    diff = _diff(before, _snapshot(db_factory))
    assert set(diff.deleted) == {
        "organization_event_roles",
        "buyer_profiles",
        "buyer_attendees",
        "buyer_recommended_buyers",
        "buyer_interest_keywords",
        "org_event_role_org_types",
    }
    assert diff.added == {} and diff.changed == {}
    _assert_preview_matches_deleted(impact, diff, t["org_id"])
    assert _exists(db_factory, Meeting, waiting_on_t) and _exists(db_factory, Meeting, accepted_b)
    assert _exists(db_factory, Organization, t["org_id"])


# =============================================================================
# 다른 행사의 흔적 — 하나라도 있으면 조직·회원은 남고, 다른 행사의 행은 한 줄도 바뀌지 않는다
# =============================================================================
def _add(db_factory, *rows) -> None:
    db = db_factory()
    try:
        db.add_all(list(rows))
        db.commit()
    finally:
        db.close()


def _kept_org_base(db_factory) -> dict:
    """흔적 테스트의 무대. 흔적이 하나도 없으면 X는 조직·회원까지 지워질 상태다 — 테스트가 흔적을 하나씩 더한다.

    행사 A: 삭제 대상 X(참가사), 상대 Y(바이어), 무관한 E2(참가사)·Y2(바이어). X–Y의 취소된 미팅과 거기 딸린
    행(양쪽의 참석자·회의록·전사 작업·알림·발송 기록), 그 미팅을 만든 확정 일괄 배정 기록, X 인박스의 미팅 무관 알림.
    행사 B: Z(참가사)·W(바이어) — X는 B에 참가하지 않는다.
    """
    event_a = _seed_event(db_factory, name="흔적A")
    event_b = _seed_event(db_factory, name="흔적B")
    x = _seed_org(db_factory, event_a, "삭제대상X", exhibitor=True)
    y = _seed_org(db_factory, event_a, "상대Y", buyer=True)
    y2 = _seed_org(db_factory, event_a, "무관Y2", buyer=True)
    e2 = _seed_org(db_factory, event_a, "무관E2", exhibitor=True)
    z = _seed_org(db_factory, event_b, "B참가사Z", exhibitor=True)
    w = _seed_org(db_factory, event_b, "B바이어W", buyer=True)
    closed = _seed_meeting(db_factory, event_a, x, y, "cancelled")
    children = _seed_meeting_children(db_factory, event_a, closed, x, y)
    run_a = _seed_run(db_factory, event_a, "confirmed", [(x, y, "confirmed", closed)])
    inbox = _seed_inbox_notification(db_factory, event_a, x)

    def ids(table: str, values) -> set:
        return {_key(table, id=v) for v in values}

    # 조직이 남을 때 지워지는 것 — 이 행사 참가와 그 아래, 닫힌 미팅과 거기 딸린 행, 이 행사의 일괄 배정 기록.
    deleted_when_kept = _merge_rows(
        _participation_rows(x),
        {
            "meetings": ids("meetings", [closed]),
            "meeting_participants": ids("meeting_participants", children["participant_ids"]),
            "post_meeting_reviews": ids("post_meeting_reviews", children["review_ids"]),
            "transcription_jobs": ids("transcription_jobs", children["job_ids"]),
            "notifications": ids("notifications", children["notification_ids"]),
            "notification_dispatches": ids("notification_dispatches", children["dispatch_ids"]),
            "saturation_draft_items": ids("saturation_draft_items", run_a["item_ids"]),
        },
    )
    return {
        "event_a": event_a,
        "event_b": event_b,
        "x": x,
        "y": y,
        "y2": y2,
        "e2": e2,
        "z": z,
        "w": w,
        "inbox": inbox,
        "deleted_when_kept": deleted_when_kept,
    }


def _x(base: dict) -> str:
    return base["x"]["org_id"]


def _trace_role_in_other_event(f, b) -> None:
    _add_role(f, b["event_b"], b["x"], buyer=True)


def _trace_meeting_as_exhibitor(f, b) -> None:
    _seed_meeting(f, b["event_b"], b["x"], b["w"], "accepted")


def _trace_meeting_as_buyer(f, b) -> None:
    _seed_meeting(f, b["event_b"], b["z"], b["x"], "accepted")


def _trace_meeting_awaiting_in_other_event(f, b) -> None:
    _seed_meeting(f, b["event_b"], b["z"], b["w"], "proposed", awaiting_org_id=_x(b))


def _trace_meeting_awaiting_here_without_being_a_party(f, b) -> None:
    # 이 행사 미팅이지만 X는 당사자가 아니다 — awaiting_org_id는 CASCADE라 조직을 지우면 무관한 미팅이 사라진다.
    _seed_meeting(f, b["event_a"], b["e2"], b["y2"], "proposed", awaiting_org_id=_x(b))


def _trace_draft_item_as_exhibitor(f, b) -> None:
    _seed_run(f, b["event_b"], "draft", [(b["x"], b["w"], "draft", None)])


def _trace_draft_item_as_buyer(f, b) -> None:
    _seed_run(f, b["event_b"], "confirmed", [(b["z"], b["x"], "skipped", None)])


def _trace_notification(f, b) -> None:
    # 발송 기록 없이 — 회원 발송 기록 검사와 섞이지 않게 알림 칸 하나만 건다.
    _add(f, Notification(event_id=b["event_b"], recipient_org_id=_x(b), type="review_ready"))


def _trace_review_on_other_event_meeting(f, b) -> None:
    meeting = _seed_meeting(f, b["event_b"], b["z"], b["w"], "completed")
    _add(f, PostMeetingReview(meeting_id=meeting, reviewer_org_id=_x(b), satisfaction_rating=3))


def _trace_review_on_unrelated_meeting_here(f, b) -> None:
    # 같은 행사지만 X가 당사자가 아닌 미팅(E2–Y2)에 X가 쓴 회의록 — 조직 CASCADE가 무관한 미팅의 기록을 지운다.
    meeting = _seed_meeting(f, b["event_a"], b["e2"], b["y2"], "completed")
    _add(f, PostMeetingReview(meeting_id=meeting, reviewer_org_id=_x(b), satisfaction_rating=3))


def _trace_transcription_job_on_other_event_meeting(f, b) -> None:
    meeting = _seed_meeting(f, b["event_b"], b["z"], b["w"], "completed")
    _add(f, TranscriptionJob(meeting_id=meeting, org_id=_x(b), status="done"))


def _trace_transcription_job_on_unrelated_meeting_here(f, b) -> None:
    meeting = _seed_meeting(f, b["event_a"], b["e2"], b["y2"], "completed")
    _add(f, TranscriptionJob(meeting_id=meeting, org_id=_x(b), status="done"))


def _trace_love_call_sent(f, b) -> None:
    _add(f, LoveCall(event_id=b["event_b"], from_org_id=_x(b), to_org_id=b["z"]["org_id"]))


def _trace_love_call_received(f, b) -> None:
    _add(f, LoveCall(event_id=b["event_b"], from_org_id=b["z"]["org_id"], to_org_id=_x(b)))


def _trace_bookmark_owned(f, b) -> None:
    _add(
        f,
        InterestedOrganization(
            event_id=b["event_b"], owner_org_id=_x(b), target_org_id=b["z"]["org_id"], source="all"
        ),
    )


def _trace_bookmark_targeted(f, b) -> None:
    _add(
        f,
        InterestedOrganization(
            event_id=b["event_b"], owner_org_id=b["z"]["org_id"], target_org_id=_x(b), source="ai"
        ),
    )


def _trace_ai_suggestion_for(f, b) -> None:
    _add(f, AiMatchSuggestion(event_id=b["event_b"], for_org_id=_x(b), target_org_id=b["z"]["org_id"]))


def _trace_ai_suggestion_of(f, b) -> None:
    _add(f, AiMatchSuggestion(event_id=b["event_b"], for_org_id=b["z"]["org_id"], target_org_id=_x(b)))


def _trace_channel_as_a(f, b) -> None:
    _add(f, ConversationChannel(event_id=b["event_b"], org_a_id=_x(b), org_b_id=b["z"]["org_id"]))


def _trace_channel_as_b(f, b) -> None:
    _add(f, ConversationChannel(event_id=b["event_b"], org_a_id=b["z"]["org_id"], org_b_id=_x(b)))


def _trace_interpreter_assignment(f, b) -> None:
    db = f()
    try:
        interpreter = Interpreter(event_id=b["event_b"], name="B통역사")
        db.add(interpreter)
        db.flush()
        db.add(
            InterpreterAssignment(
                interpreter_id=interpreter.id, organization_id=_x(b), event_id=b["event_b"]
            )
        )
        db.commit()
    finally:
        db.close()


def _trace_member_attends_other_event_meeting(f, b) -> None:
    meeting = _seed_meeting(f, b["event_b"], b["z"], b["w"], "accepted")
    _add(f, MeetingParticipant(meeting_id=meeting, member_id=b["x"]["member_ids"][0]))


def _trace_member_attends_unrelated_meeting_here(f, b) -> None:
    # 명단 재업로드로 회원이 X로 옮겨 오기 전, 예전 소속 기업으로 들어간 미팅(이 행사, X는 당사자 아님).
    meeting = _seed_meeting(f, b["event_a"], b["e2"], b["y2"], "accepted")
    _add(f, MeetingParticipant(meeting_id=meeting, member_id=b["x"]["member_ids"][0]))


def _dispatch_to_x_member(f, b, *, event_id: str, recipient: dict) -> None:
    db = f()
    try:
        notification = Notification(
            event_id=event_id, recipient_org_id=recipient["org_id"], type="application_approved"
        )
        db.add(notification)
        db.flush()
        db.add(
            NotificationDispatch(
                notification_id=notification.id,
                member_id=b["x"]["member_ids"][0],
                channel="email",
                status="sent",
            )
        )
        db.commit()
    finally:
        db.close()


def _trace_member_received_other_event_notification(f, b) -> None:
    _dispatch_to_x_member(f, b, event_id=b["event_b"], recipient=b["z"])


def _trace_member_received_other_company_notification_here(f, b) -> None:
    _dispatch_to_x_member(f, b, event_id=b["event_a"], recipient=b["y"])


#: 흔적 종류 → (조직을 남기게 해야 하는 검사 "테이블.칸", 흔적을 만드는 함수). 종류마다 그 검사 하나만 걸리게
#: 만든다 — 검사 하나가 빠지면 그 종류의 테스트가 실패한다.
_TRACE_KINDS = {
    "role_in_other_event": ("organization_event_roles.organization_id", _trace_role_in_other_event),
    "meeting_as_exhibitor": ("meetings.exhibitor_org_id", _trace_meeting_as_exhibitor),
    "meeting_as_buyer": ("meetings.buyer_org_id", _trace_meeting_as_buyer),
    "meeting_awaiting_in_other_event": ("meetings.awaiting_org_id", _trace_meeting_awaiting_in_other_event),
    "meeting_awaiting_here_not_party": (
        "meetings.awaiting_org_id",
        _trace_meeting_awaiting_here_without_being_a_party,
    ),
    "draft_item_as_exhibitor": ("saturation_draft_items.exhibitor_org_id", _trace_draft_item_as_exhibitor),
    "draft_item_as_buyer": ("saturation_draft_items.buyer_org_id", _trace_draft_item_as_buyer),
    "notification": ("notifications.recipient_org_id", _trace_notification),
    "review_on_other_event_meeting": (
        "post_meeting_reviews.reviewer_org_id",
        _trace_review_on_other_event_meeting,
    ),
    "review_on_unrelated_meeting_here": (
        "post_meeting_reviews.reviewer_org_id",
        _trace_review_on_unrelated_meeting_here,
    ),
    "transcription_job_on_other_event_meeting": (
        "transcription_jobs.org_id",
        _trace_transcription_job_on_other_event_meeting,
    ),
    "transcription_job_on_unrelated_meeting_here": (
        "transcription_jobs.org_id",
        _trace_transcription_job_on_unrelated_meeting_here,
    ),
    "love_call_sent": ("love_calls.from_org_id", _trace_love_call_sent),
    "love_call_received": ("love_calls.to_org_id", _trace_love_call_received),
    "bookmark_owned": ("interested_organizations.owner_org_id", _trace_bookmark_owned),
    "bookmark_targeted": ("interested_organizations.target_org_id", _trace_bookmark_targeted),
    "ai_suggestion_for": ("ai_match_suggestions.for_org_id", _trace_ai_suggestion_for),
    "ai_suggestion_of": ("ai_match_suggestions.target_org_id", _trace_ai_suggestion_of),
    "channel_as_a": ("conversation_channels.org_a_id", _trace_channel_as_a),
    "channel_as_b": ("conversation_channels.org_b_id", _trace_channel_as_b),
    "interpreter_assignment": ("interpreter_assignments.organization_id", _trace_interpreter_assignment),
    "member_attends_other_event_meeting": (
        "meeting_participants.member_id",
        _trace_member_attends_other_event_meeting,
    ),
    "member_attends_unrelated_meeting_here": (
        "meeting_participants.member_id",
        _trace_member_attends_unrelated_meeting_here,
    ),
    "member_received_other_event_notification": (
        "notification_dispatches.member_id",
        _trace_member_received_other_event_notification,
    ),
    "member_received_other_company_notification_here": (
        "notification_dispatches.member_id",
        _trace_member_received_other_company_notification_here,
    ),
}


def test_without_traces_the_organization_and_its_accounts_go_too(client, db_factory):
    """흔적 테스트의 무대 그대로(흔적 없음)면 조직·회원과 이 기업 인박스까지 지워진다 — 아래 흔적 종류별
    테스트에서 조직이 남는 것은 그 흔적 때문이라는 기준선."""
    base = _kept_org_base(db_factory)
    event_a, x = base["event_a"], base["x"]
    _as_master(event_a)

    before = _snapshot(db_factory)
    impact = client.get(_impact_url(event_a, x["org_id"])).json()
    assert impact["organization_deleted"] is True
    assert client.delete(_delete_url(event_a, x["org_id"])).status_code == 204
    diff = _diff(before, _snapshot(db_factory))

    assert diff.deleted == _merge_rows(
        base["deleted_when_kept"],
        {
            "organizations": {_key("organizations", id=x["org_id"])},
            "members": {_key("members", id=m) for m in x["member_ids"]},
            "notifications": {_key("notifications", id=base["inbox"]["notification_id"])},
            "notification_dispatches": {
                _key("notification_dispatches", id=base["inbox"]["dispatch_id"])
            },
        },
    )
    assert diff.added == {} and diff.changed == {}
    _assert_preview_matches_deleted(impact, diff, x["org_id"])


@pytest.mark.parametrize("kind", list(_TRACE_KINDS))
def test_organization_is_kept_while_anything_outside_this_participation_points_to_it(
    client, db_factory, kind
):
    """흔적이 하나라도 있으면 조직·회원은 남고, 이 행사 참가와 이 행사의 닫힌 미팅·일괄 배정 기록만 지워진다.
    흔적 행을 비롯해 다른 행사의 행·이 기업 인박스는 한 줄도 바뀌지 않는다(삭제 전후 DB 전체 비교)."""
    base = _kept_org_base(db_factory)
    expected_key, make_trace = _TRACE_KINDS[kind]
    make_trace(db_factory, base)
    event_a, x = base["event_a"], base["x"]
    _as_master(event_a)

    db = db_factory()
    try:
        role = admin_service.get_role_for_org(db, event_a, x["org_id"])
        retained_by = admin_service.assess_organization_deletion(db, role).retained_by
    finally:
        db.close()
    assert [key for key, _count in retained_by] == [expected_key]

    before = _snapshot(db_factory)
    impact = client.get(_impact_url(event_a, x["org_id"])).json()
    assert impact["organization_deleted"] is False
    assert (impact["member_count"], impact["linked_record_count"]) == (0, 0)
    assert client.delete(_delete_url(event_a, x["org_id"])).status_code == 204
    diff = _diff(before, _snapshot(db_factory))

    assert diff.deleted == base["deleted_when_kept"]
    assert diff.added == {} and diff.changed == {}
    _assert_preview_matches_deleted(impact, diff, x["org_id"])


def test_trace_kinds_exercise_every_trace_check():
    """흔적 검사 목록의 칸마다 그 칸 하나만으로 조직을 남기는지 확인하는 종류가 위에 있다."""
    checks = {
        f"{table}.{column}"
        for table, column in (
            *admin_service.ORGANIZATION_TRACE_CHECKS,
            *admin_service.MEMBER_TRACE_CHECKS,
        )
    }
    assert {key for key, _make in _TRACE_KINDS.values()} == checks


# --- 분류 완결성 — 조직·회원을 가리키는 FK는 모두 검사 목록이나 제외 목록(이유) 중 한 곳에 있다 -------------
_REFERENCE_LISTS = [
    pytest.param(
        "organizations",
        admin_service.ORGANIZATION_TRACE_CHECKS,
        admin_service.ORGANIZATION_REFERENCES_NOT_CHECKED,
        id="organizations",
    ),
    pytest.param(
        "members",
        admin_service.MEMBER_TRACE_CHECKS,
        admin_service.MEMBER_REFERENCES_NOT_CHECKED,
        id="members",
    ),
]


def _referencing_columns(target_table: str) -> set[tuple[str, str]]:
    """모델 메타데이터에서 ``target_table``을 가리키는 모든 FK 칸 — (테이블, 칸)."""
    return {
        (fk.parent.table.name, fk.parent.name)
        for table in Base.metadata.tables.values()
        for fk in table.foreign_keys
        if fk.column.table.name == target_table
    }


@pytest.mark.parametrize(("target", "checked", "not_checked"), _REFERENCE_LISTS)
def test_every_reference_is_trace_checked_or_excluded_with_a_reason(target, checked, not_checked):
    """테이블이 늘어 이 기업을 가리키는 칸이 생기면 여기서 실패한다 — 흔적 검사 목록이나 제외 목록(이유)에
    넣기 전에는 조용히 빠지지 않는다."""
    referencing = _referencing_columns(target)
    assert not set(checked) & set(not_checked), "같은 칸이 검사 목록과 제외 목록 양쪽에 있다"
    unclassified = referencing - set(checked) - set(not_checked)
    assert not unclassified, f"분류되지 않은 FK — 검사 목록이나 제외 목록(이유)에 넣는다: {sorted(unclassified)}"
    unknown = (set(checked) | set(not_checked)) - referencing
    assert not unknown, f"모델에 없는 칸이 목록에 있다: {sorted(unknown)}"
    assert all(" — " in reason for reason in not_checked.values()), "제외 이유는 '규칙 — 이유' 형식"


_DELETE_RULE_NAMES = {"a": "NO ACTION", "r": "RESTRICT", "c": "CASCADE", "n": "SET NULL", "d": "SET DEFAULT"}


@pytest.mark.parametrize(("target", "checked", "not_checked"), _REFERENCE_LISTS)
def test_declared_delete_rules_match_the_database(db_factory, target, checked, not_checked):
    """목록이 기대는 삭제 규칙이 실 DB(pg_constraint)와 같다 — 검사하는 칸은 지워지거나(CASCADE) 삭제를 막는
    (NO ACTION) 칸이고, 제외 이유 앞머리에 적은 규칙(SET NULL 등)은 실제 규칙이다. 모델과 DB의 FK 목록도 같다."""
    db = db_factory()
    try:
        rows = db.execute(
            text(
                """
                select child.relname, att.attname, con.confdeltype
                from pg_constraint con
                join pg_class child on child.oid = con.conrelid
                join pg_class parent on parent.oid = con.confrelid
                join pg_namespace ns on ns.oid = child.relnamespace
                join pg_attribute att on att.attrelid = con.conrelid and att.attnum = con.conkey[1]
                where con.contype = 'f' and ns.nspname = 'public' and parent.relname = :target
                """
            ),
            {"target": target},
        ).all()
    finally:
        db.close()
    rules = {(table, column): _DELETE_RULE_NAMES[rule] for table, column, rule in rows}

    assert set(rules) == _referencing_columns(target)
    for key in checked:
        assert rules[key] in ("CASCADE", "NO ACTION"), (key, rules[key])
    for key, reason in not_checked.items():
        assert reason.split(" — ", 1)[0] == rules[key], (key, rules[key], reason)


# =============================================================================
# 권한 — 삭제도 미리보기도 master 전용
# =============================================================================
def test_delete_and_preview_are_master_only(wired_client, db_factory, wired_event):
    _seed_event(db_factory, id=wired_event)
    t = _seed_org(db_factory, wired_event, "권한확인기업", buyer=True)

    before = _snapshot(db_factory)
    assert wired_client.get(_impact_url(wired_event, t["org_id"]), headers=SUB).status_code == 403
    assert wired_client.delete(_delete_url(wired_event, t["org_id"]), headers=SUB).status_code == 403
    assert wired_client.get(_impact_url(wired_event, t["org_id"])).status_code == 401
    assert wired_client.delete(_delete_url(wired_event, t["org_id"])).status_code == 401
    _assert_nothing_changed(before, _snapshot(db_factory))

    preview = wired_client.get(_impact_url(wired_event, t["org_id"]), headers=MASTER)
    assert preview.status_code == 200
    assert preview.json()["deletable"] is True
    assert wired_client.delete(_delete_url(wired_event, t["org_id"]), headers=MASTER).status_code == 204


def test_preview_404_for_org_outside_this_event(client, db_factory):
    """없는 기업·다른 행사의 기업 — 미리보기와 삭제 모두 구조화된 404(code ORG_NOT_FOUND)이고 아무것도 안 지운다."""
    event_id = _seed_event(db_factory)
    other_event = _seed_event(db_factory)
    elsewhere = _seed_org(db_factory, other_event, "다른행사기업", buyer=True)
    _as_master(event_id)

    before = _snapshot(db_factory)
    responses = [
        client.get(_impact_url(event_id, str(uuid.uuid4()))),
        client.delete(_delete_url(event_id, str(uuid.uuid4()))),
        client.get(_impact_url(event_id, elsewhere["org_id"])),
        client.delete(_delete_url(event_id, elsewhere["org_id"])),
    ]
    for resp in responses:
        assert resp.status_code == 404, resp.text
        assert resp.json() == {"detail": ORG_NOT_FOUND_DETAIL}
    _assert_nothing_changed(before, _snapshot(db_factory))
    assert _exists(db_factory, Organization, elsewhere["org_id"])


def test_delete_finding_the_org_gone_after_locking_is_the_same_structured_404(client, db_factory, monkeypatch):
    """확인 뒤 잠그는 사이에 다른 요청이 먼저 지웠다(서비스의 OrganizationNotFoundError) — 같은 구조화된 404."""
    event_id = _seed_event(db_factory)
    t = _seed_org(db_factory, event_id, "먼저지워진기업", buyer=True)
    _as_master(event_id)

    def _already_gone(_db, _role):
        raise admin_service.OrganizationNotFoundError("기업을 찾을 수 없습니다")

    monkeypatch.setattr(admin_service, "delete_organization_participation", _already_gone)

    resp = client.delete(_delete_url(event_id, t["org_id"]))
    assert resp.status_code == 404, resp.text
    assert resp.json() == {"detail": ORG_NOT_FOUND_DETAIL}


def test_other_endpoints_keep_the_plain_not_found_detail(client, db_factory):
    """구조화된 404는 삭제·미리보기 두 엔드포인트만이다 — 공용 404(기업 상세 등)의 문자열 detail은 그대로다
    (그 문장을 읽는 다른 화면·BFF가 있다)."""
    event_id = _seed_event(db_factory)
    _as_master(event_id)

    resp = client.get(f"/api/admin/events/{event_id}/organizations/{uuid.uuid4()}")
    assert resp.status_code == 404
    assert resp.json() == {"detail": "기업을 찾을 수 없습니다"}


# =============================================================================
# 경합·실패 — 판정과 삭제 사이. 어떤 경우에도 500이 아니다.
# =============================================================================
def _racing_world(db_factory) -> dict:
    """경합 테스트의 공통 무대 — 취소된 미팅 하나만 있어 "그냥 두면 삭제되는" 기업.

    조직은 다른 행사에도 참가 중이다: 조직 행이 남는 쪽이라 FK가 뒤늦게라도 막아 주지 않는다 — 잠금이
    없으면 참가가 지워진 기업을 가리키는 확정 미팅이 그대로 남는다.
    """
    event_a = _seed_event(db_factory, name="행사A")
    event_b = _seed_event(db_factory, name="행사B")
    t = _seed_org(db_factory, event_a, "경합대상기업", exhibitor=True)
    _add_role(db_factory, event_b, t, exhibitor=True)
    buyer = _seed_org(db_factory, event_a, "바이어", buyer=True)
    cancelled = _seed_meeting(db_factory, event_a, t, buyer, "cancelled")
    return {"event_id": event_a, "t": t, "buyer": buyer, "cancelled": cancelled}


def _new_accepted_meeting(w: dict) -> Meeting:
    start = datetime(2027, 4, 1, 1, 0, tzinfo=timezone.utc)
    return Meeting(
        event_id=w["event_id"],
        exhibitor_org_id=w["t"]["org_id"],
        buyer_org_id=w["buyer"]["org_id"],
        matching_type="forced",
        status="accepted",
        requested_by="organizer",
        scheduled_start=start,
        scheduled_end=start + timedelta(minutes=30),
    )


def _delete_in_background(client, url: str) -> tuple[threading.Thread, dict]:
    result: dict = {}
    thread = threading.Thread(
        target=lambda: result.update(resp=client.delete(url)), daemon=True
    )
    thread.start()
    return thread, result


def _wait_until_delete_waits_for_a_lock(db_factory, *, timeout: float = 10.0) -> None:
    """이 테스트 DB의 다른 세션 하나가 잠금을 기다리기 시작할 때까지(= 삭제가 막힐 때까지) 기다린다.

    삭제는 잠금을 교착 판정 시간의 절반까지만 기다린다(서비스 ``_YIELD_BEFORE_DEADLOCK_CHECK``). 그래서 고정
    시간을 재우지 않고 막힌 것을 확인하자마자 상대 트랜잭션을 끝낸다 — 그래야 "기다렸다가 그 결과로 판정"을
    대기 상한 안에서 본다. ``pg_stat_activity``는 트랜잭션마다 스냅숏이라 매번 새 트랜잭션으로 읽는다.
    """
    deadline = time.monotonic() + timeout
    db = db_factory()
    try:
        while time.monotonic() < deadline:
            waiting = db.execute(
                text(
                    "select count(*) from pg_stat_activity where datname = current_database() "
                    "and wait_event_type = 'Lock' and pid <> pg_backend_pid()"
                )
            ).scalar_one()
            db.rollback()
            if waiting:
                return
            time.sleep(0.01)
    finally:
        db.close()
    raise AssertionError("삭제가 잠금을 기다리지 않았다")


def _deadlock_timeout_seconds(db_factory) -> float:
    db = db_factory()
    try:
        return (
            db.execute(text("select setting::int from pg_settings where name = 'deadlock_timeout'")).scalar_one()
            / 1000
        )
    finally:
        db.close()


def _assert_blocked_by_one_scheduled_meeting(thread: threading.Thread, result: dict) -> None:
    thread.join(timeout=15)
    assert not thread.is_alive()
    resp = result["resp"]
    assert resp.status_code == 409, resp.text
    detail = resp.json()["detail"]
    assert detail["code"] == "ORG_HAS_MEETINGS"
    assert detail["scheduled_count"] == 1


def test_delete_waits_for_in_flight_meeting_insert_then_blocks(client, db_factory):
    """다른 트랜잭션이 이 기업의 새 미팅을 넣는 중(아직 커밋 전)이면 삭제는 판정하지 않고 기다린다.

    기다리지 않으면 그 미팅을 못 본 채 "닫힌 미팅뿐"이라고 판정해 참가를 지운다. **조직 행 잠금**이 그
    INSERT의 FK 확인과 맞물려 삭제를 세운다.
    """
    w = _racing_world(db_factory)
    _as_master(w["event_id"])
    before = _snapshot(db_factory)

    writer = db_factory()
    try:
        writer.add(_new_accepted_meeting(w))
        writer.flush()  # INSERT는 나갔고 커밋은 아직 — 이 트랜잭션 밖에서는 보이지 않는다

        thread, result = _delete_in_background(client, _delete_url(w["event_id"], w["t"]["org_id"]))
        _wait_until_delete_waits_for_a_lock(db_factory)
        assert thread.is_alive(), "삭제가 진행 중인 미팅 INSERT를 기다리지 않고 끝났다"
        writer.commit()
    finally:
        writer.close()

    _assert_blocked_by_one_scheduled_meeting(thread, result)
    # 그 사이 커밋된 새 미팅 한 건 말고는 아무것도 달라지지 않았다(참가도, 취소된 미팅도 그대로).
    diff = _diff(before, _snapshot(db_factory))
    assert diff.deleted == {} and diff.changed == {}
    assert set(diff.added) == {"meetings"} and len(diff.added["meetings"]) == 1


def test_delete_waits_for_booking_that_holds_the_org_lock(client, db_factory):
    """예약 임계구역에 먼저 들어간 요청(미팅 예약 락을 쥐고 겹침 검사 중 — 아직 INSERT 전)이 있으면 삭제는
    그 예약이 끝날 때까지 기다린다. 신청·수락·운영자 배정이 잡는 것과 **같은 락**을 삭제도 잡기 때문이다."""
    w = _racing_world(db_factory)
    _as_master(w["event_id"])
    before = _snapshot(db_factory)

    booking = db_factory()
    try:
        admin_service.slot_booking.meeting_write_lock(
            booking, event_id=w["event_id"], org_ids=[w["t"]["org_id"], w["buyer"]["org_id"]]
        )
        thread, result = _delete_in_background(client, _delete_url(w["event_id"], w["t"]["org_id"]))
        _wait_until_delete_waits_for_a_lock(db_factory)
        assert thread.is_alive(), "삭제가 진행 중인 예약을 기다리지 않고 끝났다"
        booking.add(_new_accepted_meeting(w))
        booking.commit()
    finally:
        booking.close()

    _assert_blocked_by_one_scheduled_meeting(thread, result)
    diff = _diff(before, _snapshot(db_factory))
    assert diff.deleted == {} and diff.changed == {}
    assert set(diff.added) == {"meetings"}


def test_delete_waits_for_in_flight_status_change_of_a_counted_meeting(client, db_factory):
    """센 미팅의 상태가 바뀌는 중(커밋 전)이면 삭제는 그 결과를 보고 판정한다 — **미팅 행 잠금**.

    잠그지 않고 세면 "취소됨"으로 본 미팅을 지우려다 그 행의 잠금을 기다리게 되고, 상대 트랜잭션이
    확정으로 바꿔 커밋한 뒤 **확정된 미팅을 지워 버린다**(판정과 삭제 사이의 경합).
    """
    w = _racing_world(db_factory)
    _as_master(w["event_id"])
    before = _snapshot(db_factory)

    writer = db_factory()
    try:
        meeting = writer.get(Meeting, w["cancelled"])
        meeting.cancelled_reason_code = None
        meeting.status = "accepted"
        writer.flush()  # UPDATE는 나갔고 커밋은 아직

        thread, result = _delete_in_background(client, _delete_url(w["event_id"], w["t"]["org_id"]))
        _wait_until_delete_waits_for_a_lock(db_factory)
        assert thread.is_alive(), "삭제가 진행 중인 상태 변경을 기다리지 않고 끝났다"
        writer.commit()
    finally:
        writer.close()

    _assert_blocked_by_one_scheduled_meeting(thread, result)
    diff = _diff(before, _snapshot(db_factory))
    assert diff.deleted == {} and diff.added == {}
    assert set(diff.changed) == {"meetings"}  # 상대 트랜잭션이 바꾼 그 미팅뿐
    assert _exists(db_factory, Meeting, w["cancelled"])
    assert _exists(db_factory, OrganizationEventRole, w["t"]["role_id"])


def test_delete_waits_for_in_flight_reference_to_a_member_then_keeps_the_organization(
    client, db_factory
):
    """이 기업 회원을 가리키는 행(다른 행사 미팅의 참석자)이 들어오는 중(커밋 전)이면 삭제는 판정하지 않고
    기다렸다가, 그 행을 흔적으로 보고 조직·회원을 남긴다 — **회원 행 잠금**.

    잠그지 않고 판정하면 그 행을 못 본 채 "흔적 없음"으로 조직을 지우고, 회원 삭제의 CASCADE가 막 커밋된
    다른 행사의 참석자 행까지 지운다.
    """
    base = _kept_org_base(db_factory)
    event_a, x = base["event_a"], base["x"]
    other_event_meeting = _seed_meeting(db_factory, base["event_b"], base["z"], base["w"], "accepted")
    _as_master(event_a)
    before = _snapshot(db_factory)

    writer = db_factory()
    try:
        participant = MeetingParticipant(
            meeting_id=other_event_meeting, member_id=x["member_ids"][0]
        )
        writer.add(participant)
        writer.flush()  # INSERT는 나갔고 커밋은 아직
        participant_id = str(participant.id)

        thread, result = _delete_in_background(client, _delete_url(event_a, x["org_id"]))
        _wait_until_delete_waits_for_a_lock(db_factory)
        assert thread.is_alive(), "삭제가 회원을 가리키는 진행 중인 INSERT를 기다리지 않고 끝났다"
        writer.commit()
    finally:
        writer.close()
    thread.join(timeout=15)
    assert not thread.is_alive()

    assert result["resp"].status_code == 204, result["resp"].text
    diff = _diff(before, _snapshot(db_factory))
    # 이 행사 참가·닫힌 미팅·일괄 배정 기록만 지워졌고, 그 사이 커밋된 참석자 행은 그대로 남았다.
    assert diff.deleted == base["deleted_when_kept"]
    assert diff.added == {"meeting_participants": {_key("meeting_participants", id=participant_id)}}
    assert diff.changed == {}
    assert _exists(db_factory, Organization, x["org_id"])


def test_delete_gives_up_before_the_deadlock_check_instead_of_waiting_on_a_long_transaction(
    client, db_factory
):
    """긴 트랜잭션(큰 명단 업로드 등)이 이 기업 회원을 잠근 채 있으면, 삭제는 교착 판정 시간이 되기 전에 먼저
    물러난다 — 409 ORG_DELETE_CONFLICT, 아무것도 지우지 않는다. 상대 트랜잭션은 그대로 끝까지 간다."""
    base = _kept_org_base(db_factory)
    event_a, x = base["event_a"], base["x"]
    deadlock_timeout = _deadlock_timeout_seconds(db_factory)
    _as_master(event_a)
    before = _snapshot(db_factory)

    writer = db_factory()
    try:
        writer.get(Member, x["member_ids"][0]).phone = "010-1234-0000"
        writer.flush()  # 회원 행을 잠근 채 커밋하지 않는다(긴 트랜잭션)

        thread, result = _delete_in_background(client, _delete_url(event_a, x["org_id"]))
        _wait_until_delete_waits_for_a_lock(db_factory)
        thread.join(timeout=deadlock_timeout)
        assert not thread.is_alive(), "삭제가 교착 판정 시간이 지나도록 잠금을 기다렸다"
        writer.commit()  # 상대 트랜잭션은 문제없이 끝난다
    finally:
        writer.close()

    resp = result["resp"]
    assert resp.status_code == 409, resp.text
    assert resp.json()["detail"]["code"] == "ORG_DELETE_CONFLICT"
    diff = _diff(before, _snapshot(db_factory))
    assert diff.deleted == {} and diff.added == {}
    assert diff.changed == {
        "members": {_key("members", id=x["member_ids"][0]): {"phone": (None, "010-1234-0000")}}
    }


def _link_roster_registrant(db_factory, event_id: str, org: dict) -> str:
    """org의 첫 회원을 명단 행(registrant)에 잇는다 — 명단 업로드가 이 회원을 "기존 계정"으로 갱신하게.
    명단 행의 회원ID(organizer_member_id)를 돌려준다."""
    db = db_factory()
    try:
        registrant = Registrant(
            event_id=event_id,
            organizer_member_id=f"roster-{uuid.uuid4().hex[:8]}",
            organization_id=org["org_id"],
            name="담당자",
            org_name=org["name"],
            contact_email=org["emails"][0],
            role_hint="exhibitor",
            raw={"seed": "1"},
        )
        db.add(registrant)
        db.flush()
        db.get(Member, org["member_ids"][0]).registrant_id = registrant.id
        db.commit()
        return registrant.organizer_member_id
    finally:
        db.close()


@pytest.mark.parametrize("upload_joins", ["before_deadlock_check", "after_deadlock_check"])
def test_roster_upload_is_never_the_deadlock_victim_of_a_delete(
    client, db_factory, monkeypatch, upload_joins
):
    """명단 업로드(실제 import_roster)와 삭제가 잠금 순서로 엇갈려도 업로드는 끝까지 반영되고 삭제가 409로 물러난다.

    업로드는 이 기업 회원을 갱신(행 잠금)한 뒤 파일의 다음 행들을 처리하고, 끝에 카테고리 보강으로 이 기업 참가
    행을 FOR UPDATE로 잠근다. 그 사이 삭제가 참가 행을 쥔 채 회원을 기다리면 교착이다. 업로드가 교착 판정 시간이
    지난 뒤에 순환에 들어오면(큰 파일) 예전엔 업로드가 희생자였다 — 500, 적재 전체 롤백(2026-10-09 재현). 파일
    처리 시간은 두 번째 행에서만 늦춰 흉내 낸다(동작은 실제 그대로).
    """
    event_id = _seed_event(db_factory)
    x = _seed_org(db_factory, event_id, "업로드중삭제기업", exhibitor=True)
    member_key = _link_roster_registrant(db_factory, event_id, x)
    tag = uuid.uuid4().hex[:8]
    filler_name = f"업로드필러-{tag}"
    records = [
        RosterRecord(
            organizer_member_id=member_key,
            org_name=x["name"],
            name="담당자",
            contact_email=x["emails"][0],
            contact_phone="010-5555-0000",  # 바뀐 값 → 회원 행 UPDATE(잠금)
            role_hint="exhibitor",
            content_category="animation_character",  # 끝에서 이 기업 참가 행을 FOR UPDATE로 잠근다
            raw={"seed": "2"},
        ),
        RosterRecord(
            organizer_member_id=f"filler-{tag}",
            org_name=filler_name,
            contact_email=f"filler-{tag}@example.com",
            role_hint="buyer",
            raw={"filler": "1"},
        ),
    ]
    delay = (
        0.2 if upload_joins == "before_deadlock_check" else _deadlock_timeout_seconds(db_factory) + 0.5
    )
    first_member_locked = threading.Event()
    calls = {"n": 0}
    real_upsert_member = import_service._upsert_member

    def upsert_member_like_a_big_file(*args, **kwargs):
        calls["n"] += 1
        if calls["n"] == 2:
            time.sleep(delay)
        out = real_upsert_member(*args, **kwargs)
        if calls["n"] == 1:
            first_member_locked.set()
        return out

    monkeypatch.setattr(import_service, "_upsert_member", upsert_member_like_a_big_file)
    upload: dict = {}

    def run_upload():
        db = db_factory()
        try:
            upload["result"] = import_service.import_roster(db, event_id, records)
            db.commit()  # 라우터와 같다 — 요청 하나가 한 트랜잭션
        except Exception as exc:  # noqa: BLE001 — 실패 종류를 그대로 단언한다
            db.rollback()
            upload["error"] = exc
        finally:
            db.close()

    thread = threading.Thread(target=run_upload, daemon=True)
    thread.start()
    assert first_member_locked.wait(10)
    _as_master(event_id)
    resp = client.delete(_delete_url(event_id, x["org_id"]))
    thread.join(timeout=30)
    assert not thread.is_alive()

    assert "error" not in upload, f"업로드가 실패했다: {upload.get('error')!r}"
    assert (upload["result"].added, upload["result"].updated) == (1, 1)
    assert resp.status_code == 409, resp.text
    assert resp.json()["detail"]["code"] == "ORG_DELETE_CONFLICT"
    db = db_factory()
    try:
        # 삭제는 물러나 아무것도 지우지 않았고, 업로드는 끝까지 반영됐다.
        assert db.get(Organization, x["org_id"]) is not None
        assert db.get(OrganizationEventRole, x["role_id"]) is not None
        assert db.get(Member, x["member_ids"][0]).phone == "010-5555-0000"
        assert db.get(ExhibitorProfile, x["exhibitor_profile_id"]).content_category == "animation_character"
        assert db.execute(select(Organization.id).where(Organization.name_ko == filler_name)).first()
    finally:
        db.close()


def test_second_delete_of_same_org_finds_nothing(db_factory):
    """같은 기업을 두 요청이 동시에 지울 때 뒤쪽 — 잠금을 얻고 보니 이미 없다. 404로 답한다(500이 아니다)."""
    event_id = _seed_event(db_factory)
    t = _seed_org(db_factory, event_id, "두번지우는기업", buyer=True)

    late = db_factory()
    try:
        role = admin_service.get_role_for_org(late, event_id, t["org_id"])
        assert role is not None
        first = db_factory()
        try:
            admin_service.delete_organization_participation(
                first, admin_service.get_role_for_org(first, event_id, t["org_id"])
            )
        finally:
            first.close()
        with pytest.raises(admin_service.OrganizationNotFoundError):
            admin_service.delete_organization_participation(late, role)
    finally:
        late.close()


def test_leftover_reference_becomes_409_and_rolls_back(client, db_factory, monkeypatch):
    """판정을 통과한 뒤에도 DB가 막으면(여기선 판정이 못 본 확정 미팅) — 전부 롤백하고 409. 500이 아니다."""
    event_id = _seed_event(db_factory)
    t = _seed_org(db_factory, event_id, "참조가남은기업", exhibitor=True)
    buyer = _seed_org(db_factory, event_id, "바이어", buyer=True)
    cancelled = _seed_meeting(db_factory, event_id, t, buyer, "cancelled")
    accepted = _seed_meeting(db_factory, event_id, t, buyer, "accepted")
    _as_master(event_id)

    real = admin_service.assess_organization_deletion

    def _blind_to_scheduled(db, role, *, lock=False):
        return dataclasses.replace(real(db, role, lock=lock), scheduled_count=0)

    monkeypatch.setattr(admin_service, "assess_organization_deletion", _blind_to_scheduled)

    before = _snapshot(db_factory)
    resp = client.delete(_delete_url(event_id, t["org_id"]))
    assert resp.status_code == 409, resp.text
    detail = resp.json()["detail"]
    assert detail["code"] == "ORG_DELETE_CONFLICT"
    assert "아무것도 삭제되지 않았습니다" in detail["message"]
    # 이미 지운 것처럼 보이던 닫힌 미팅·참가까지 전부 되돌아왔다.
    _assert_nothing_changed(before, _snapshot(db_factory))
    assert _exists(db_factory, Meeting, cancelled) and _exists(db_factory, Meeting, accepted)


class _PgError(Exception):
    def __init__(self, sqlstate: str) -> None:
        super().__init__(sqlstate)
        self.sqlstate = sqlstate


def test_lock_conflict_becomes_409(client, db_factory, monkeypatch):
    """다른 요청과 잠금이 엇갈려 Postgres가 이 트랜잭션을 포기시키면(deadlock_detected) 409로 알린다."""
    event_id = _seed_event(db_factory)
    t = _seed_org(db_factory, event_id, "잠금충돌기업", buyer=True)
    _as_master(event_id)

    def _deadlock(*_args, **_kwargs):
        raise OperationalError("SELECT pg_advisory_xact_lock(...)", {}, _PgError("40P01"))

    monkeypatch.setattr(admin_service.slot_booking, "meeting_write_lock", _deadlock)

    before = _snapshot(db_factory)
    resp = client.delete(_delete_url(event_id, t["org_id"]))
    assert resp.status_code == 409
    assert resp.json()["detail"]["code"] == "ORG_DELETE_CONFLICT"
    _assert_nothing_changed(before, _snapshot(db_factory))


def test_unrelated_database_failure_is_not_disguised_as_conflict(db_factory, monkeypatch):
    """잠금 충돌이 아닌 DB 장애(연결 끊김 등)까지 "다른 작업과 겹쳤다"고 답하지 않는다 — 그대로 올린다."""
    event_id = _seed_event(db_factory)
    t = _seed_org(db_factory, event_id, "DB장애기업", buyer=True)

    def _connection_lost(*_args, **_kwargs):
        raise OperationalError("SELECT 1", {}, _PgError("08006"))

    monkeypatch.setattr(admin_service.slot_booking, "meeting_write_lock", _connection_lost)

    db = db_factory()
    try:
        role = admin_service.get_role_for_org(db, event_id, t["org_id"])
        with pytest.raises(OperationalError):
            admin_service.delete_organization_participation(db, role)
    finally:
        db.close()
    assert _exists(db_factory, Organization, t["org_id"])


# =============================================================================
# 서버 로그 — 건수 요약 한 줄, 개인정보 없이
# =============================================================================
def _capture_service_warnings(monkeypatch, caplog) -> None:
    # 같은 테스트 세션에서 앞선 마이그레이션(alembic fileConfig)이 app.* 로거를 꺼 둔다 — 이 테스트 동안만
    # 다시 켠다(test_notification_scheduler_lifespan.py와 같은 처리).
    monkeypatch.setattr(logging.getLogger("app.admin.service"), "disabled", False)
    caplog.set_level(logging.WARNING, logger="app.admin.service")


def test_delete_logs_counts_without_personal_data(client, db_factory, monkeypatch, caplog):
    event_id = _seed_event(db_factory)
    t = _seed_org(db_factory, event_id, "로그확인주식회사", exhibitor=True)
    buyer = _seed_org(db_factory, event_id, "바이어", buyer=True)
    meeting_id = _seed_meeting(db_factory, event_id, t, buyer, "cancelled")
    _seed_meeting_children(db_factory, event_id, meeting_id, t, buyer)
    _as_master(event_id)

    _capture_service_warnings(monkeypatch, caplog)
    assert client.delete(_delete_url(event_id, t["org_id"])).status_code == 204

    lines = [r.getMessage() for r in caplog.records if "참가기업 삭제" in r.getMessage()]
    assert len(lines) == 1
    line = lines[0]
    assert f"event_id={event_id}" in line and f"organization_id={t['org_id']}" in line
    assert "closed_meetings=1" in line and "reviews=2" in line and "notifications=2" in line
    assert "members=1" in line and "organization_deleted=True" in line
    assert "linked_records=0" in line and "retained_by=-" in line
    assert t["name"] not in line
    assert all(email not in line for email in t["emails"])


def test_blocked_delete_does_not_log_a_deletion(client, db_factory, monkeypatch, caplog):
    event_id = _seed_event(db_factory)
    t = _seed_org(db_factory, event_id, "막힌기업", exhibitor=True)
    buyer = _seed_org(db_factory, event_id, "바이어", buyer=True)
    _seed_meeting(db_factory, event_id, t, buyer, "proposed")
    _as_master(event_id)

    _capture_service_warnings(monkeypatch, caplog)
    assert client.delete(_delete_url(event_id, t["org_id"])).status_code == 409
    assert not [r for r in caplog.records if "참가기업 삭제" in r.getMessage()]


def test_service_and_preview_share_one_assessment(db_factory):
    """미리보기(잠금 없음)와 삭제(잠금)의 판정 함수는 하나다 — 같은 입력이면 같은 값을 낸다."""
    event_id = _seed_event(db_factory)
    t = _seed_org(db_factory, event_id, "판정확인기업", exhibitor=True, members=3)
    buyer = _seed_org(db_factory, event_id, "바이어", buyer=True)
    meeting_id = _seed_meeting(db_factory, event_id, t, buyer, "rejected")
    _seed_meeting_children(db_factory, event_id, meeting_id, t, buyer)
    _seed_run(db_factory, event_id, "discarded", [(t, buyer, "draft", None)])

    db = db_factory()
    try:
        role = admin_service.get_role_for_org(db, event_id, t["org_id"])
        preview = admin_service.assess_organization_deletion(db, role)
        locked = admin_service.assess_organization_deletion(db, role, lock=True)
        assert preview == locked
        deleted = admin_service.delete_organization_participation(db, role)
        assert deleted == preview
        assert deleted.closed_meeting_ids == (meeting_id,)
        assert (deleted.review_count, deleted.draft_item_count, deleted.member_count) == (2, 1, 3)
    finally:
        db.close()
    assert not _exists(db_factory, Organization, t["org_id"])
    assert not _exists(db_factory, Meeting, meeting_id)
