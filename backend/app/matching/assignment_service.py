"""assignment-service — 운영자 강제배정·AI 전체 포화배정 (F-OP-005 Phase 3/4).

이 패키지(``app.matching``)의 다른 모듈은 대부분 순수 함수(DB 무관)지만, 이 모듈은 예외다 — 여기가
PRD가 말하는 ``forced-assignment``/``saturation-allocation`` **엔진** 그 자체이고, DB에서 대상을
찾고 :mod:`app.matching.meeting_booking` 을 호출해 실제로 미팅을 만드는 게 책임이다. "슈퍼관리자
자유도 최대" 원칙(발주자 지시) — fit score·매칭율 같은 정교한 판단은 없다. 대상을 찾는 규칙은
naive(결정적 정렬 + 순서대로 짝)하고, 자유도는 **운영자가 직접 대상·시간·장소를 고른다**는 데 있다.

**공용 프리미티브 재사용** — 강제·포화 둘 다 :func:`app.matching.meeting_booking.book_meeting`
하나로 수렴한다(락→겹침 재검증→(쌍,시각) 중복 검사→장소 확정→INSERT). 이 모듈은 그 앞뒤만 책임진다:

- **호출 전(front-matter)**: 이 모듈이 소유 — 행사/기업/장소 존재, 시간 창 해석(explicit
  start/end 또는 slot_ids), 수락 상태 결정(:func:`app.matching.acceptance_rule.resolve_entry_state`
  위임).
- **호출 후**: commit + ``IntegrityError`` → :class:`~app.matching.meeting_booking.MeetingError`
  환산은 **호출부 책임**(book_meeting의 계약 — flush까지만 하고 commit은 하지 않는다). 이 모듈의
  모든 쓰기 함수가 이 패턴을 따른다(``app.meetings.service.create_meeting``과 동일 구조).

**수락 상태는 운영자 개입 채널(FORCED·AI_SATURATION)에서 항상 accepted다(2026-09-15 정정,
ADR-0005, 발주자 QA B3).** 구버전 F-OP-005 D3 표(초청 바이어→accepted, 일반 바이어/Exhibitor→
proposed)는 참가자·AI 자율 채널(OPEN·AI_RETRIGGER·ON_SITE)에만 남아 있다 — 운영자가 단건(강제
배정 FORCED)이든 일괄(전체 포화배정 확정 AI_SATURATION)이든 직접 확정 버튼을 누르는 두 채널은
바이어 유형과 무관하게 항상 accepted다(:func:`~app.matching.acceptance_rule.resolve_entry_state`
가 이 두 채널을 최우선으로 분기 — ``_OPERATOR_OVERRIDE_CHANNELS``). 그래서 ``resolve_entry_state
(바이어 유형, 채널)`` 한 번으로 여전히 충분하고(호출부가 채널별로 분기할 필요 없음), 이 모듈이
만드는 미팅은 이제 전부 accepted로 들어간다 — ``awaiting_org_id``는 항상 None이 된다(강제·포화
둘 다 "응답 없이 확정된다"는 점에서 동일해졌다). ``entry``가 PROPOSED로 나올 여지는 두 채널
모두에서 없으므로 ``awaiting_org_id`` 분기는 방어적으로 남겨둔다(향후 채널 추가 대비).

**포화배정 draft의 장소는 draft 생성 시점에 정하지 않는다.** F-OP-005 PRD의 Out of Scope가 "Meeting
Venue 배정 연동"을 이후 과제로 명시한다 — 그래서 :func:`create_saturation_run`은 시간만 정하고,
장소는 confirm 시점에 book_meeting 임계구역 **안에서** 그 순간 비어 있는 곳을 고른다
(:func:`_saturation_venue_resolver`) — 다른 배치 흐름과 마찬가지로 availability 미리보기가 없으니
그 순간이 유일하게 "지금 진짜 비었는가"를 아는 지점이다. 우선순위는 zone_table(포화배정 표준
장소) → 참가사 booth(항상 확보 가능한 폴백)이고, business_room은 자동배정 대상에서 뺀다(룸
우선순위는 fit score 선행 과제, PRD Out of Scope).
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Sequence

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.admin import service as admin_service
from app.matching import slot_booking
from app.matching.acceptance_rule import (
    Channel,
    EntryState,
    RecipientType,
    recipient_type_from_buyer_subtype,
    resolve_entry_state,
)
from app.matching.meeting_booking import MeetingError, book_meeting, integrity_to_meeting_error
from app.matching.slot_grid import Slot, SlotError, build_grid, validate_slot_run
#: ``_booth_label``은 비공개(밑줄)지만, 부스 라벨 형식("{Hall명} {부스코드}")의 단일 진실원천이라
#: 여기서 새로 만들지 않고 그대로 재사용한다(book_meeting/get_or_create_booth_venue와 같은 재사용
#: 원칙 — meetings/service.py 파일 자체는 건드리지 않는다).
from app.meetings.service import (
    _booth_label,
    event_now,
    get_or_create_booth_venue,
    list_provisioned_venues,
    schedule_policy,
)
from app.models import (
    Event,
    EventScheduleSettings,
    Meeting,
    MeetingVenue,
    OrganizationEventRole,
    SaturationBatchRun,
    SaturationDraftItem,
)

#: 포화배정 자동 물질화가 시도하는 장소 유형 우선순위(모듈 docstring 참고).
_SATURATION_VENUE_PRIORITY: tuple[str, ...] = ("zone_table", "booth")

#: ``event_schedule_settings`` 행이 아직 없는 행사의 폴백 — 컬럼 server_default와 동일 값.
_DEFAULT_MIN_GUARANTEED_SLOTS = 10


# =============================================================================
# front-matter 검증 헬퍼 — 락과 무관한, 존재/형식 확인
# =============================================================================
def _require_event(db: Session, event_id: str) -> Event:
    event = db.get(Event, event_id)
    if event is None:
        raise MeetingError("EVENT_NOT_FOUND", "행사를 찾을 수 없습니다.", 404)
    return event


def _require_org_role(
    db: Session, event_id: str, org_id: str, *, need: str
) -> OrganizationEventRole:
    """need: ``'exhibitor'`` | ``'buyer'`` — 그 역할로 이 행사에 등록된 기업인지. 없으면 404."""
    role = db.execute(
        select(OrganizationEventRole).where(
            OrganizationEventRole.event_id == event_id,
            OrganizationEventRole.organization_id == org_id,
        )
    ).scalar_one_or_none()
    ok = role is not None and (role.is_exhibitor if need == "exhibitor" else role.is_buyer)
    if not ok:
        label = "참가사" if need == "exhibitor" else "바이어"
        raise MeetingError(
            f"{need.upper()}_NOT_FOUND", f"이 행사의 {label}로 등록된 기업이 아닙니다.", 404
        )
    return role


def _require_venue(db: Session, event_id: str, venue_id: str) -> MeetingVenue:
    venue = db.get(MeetingVenue, venue_id)
    if venue is None or str(venue.event_id) != str(event_id):
        raise MeetingError("VENUE_NOT_FOUND", "장소를 찾을 수 없습니다.", 404)
    return venue


def _buyer_recipient_type(role: OrganizationEventRole | None) -> RecipientType:
    """바이어 세부유형 → RecipientType. 미지정/역할없음은 보수적으로 일반 바이어로 본다
    (``app.meetings.service._recipient_type``과 동일 정책 — 동의 없는 즉시확정을 피한다)."""
    if role is None or not role.buyer_subtype:
        return RecipientType.GENERAL_BUYER
    return recipient_type_from_buyer_subtype(role.buyer_subtype)


def _resolve_window(
    db: Session,
    event: Event,
    *,
    scheduled_start: datetime | None,
    scheduled_end: datetime | None,
    slot_ids: Sequence[str] | None,
    now: datetime | None,
) -> tuple[datetime, datetime]:
    """explicit start/end 또는 slot_ids 중 주어진 쪽으로 시간 구간을 해석한다(라우터가 "정확히
    하나"를 이미 검증했다고 가정 — 여기는 slot_ids 해석 로직만 소유)."""
    if slot_ids:
        policy = schedule_policy(db, event)
        current = event_now(event, now)
        try:
            run = validate_slot_run(policy, slot_ids, now=current)
        except SlotError as exc:
            raise MeetingError("SLOT_INVALID", str(exc), 422)
        return run.start, run.end
    if scheduled_start is None or scheduled_end is None:
        raise MeetingError(
            "SLOT_INVALID", "scheduled_start/scheduled_end 또는 slot_ids를 지정해야 합니다.", 422
        )
    if scheduled_end <= scheduled_start:
        raise MeetingError("SLOT_INVALID", "종료 시각은 시작 시각보다 뒤여야 합니다.", 422)
    return scheduled_start, scheduled_end


# =============================================================================
# Phase 3 — 강제 배정
# =============================================================================
def _forced_venue_resolver(db: Session, event_id: str, venue_id: str, start: datetime, end: datetime):
    """운영자가 이미 고른 장소를 book_meeting 임계구역 **안에서** 잠그고 겹침을 재검증하는 콜백.

    front-matter 단계(:func:`_require_venue`)는 존재만 본다 — "그 순간 비어 있는가"는 락을 잡은
    뒤에만 참일 수 있는 사실이라 book_meeting이 이 콜백을 호출하는 시점((쌍,시각) 중복 검사 통과
    직후, INSERT 직전)에 재확인한다(``meeting_booking`` 모듈 계약).
    """

    def _resolve() -> MeetingVenue:
        venue = db.get(MeetingVenue, venue_id)
        if venue is None or str(venue.event_id) != str(event_id):
            raise MeetingError("VENUE_NOT_FOUND", "장소를 찾을 수 없습니다.", 404)
        slot_booking.meeting_write_lock(db, event_id=event_id, venue_id=str(venue.id))
        if slot_booking.has_venue_overlap(db, venue_id=str(venue.id), start=start, end=end):
            raise MeetingError("VENUE_TAKEN", "해당 시간에 장소가 이미 사용 중입니다.", 409)
        return venue

    return _resolve


def create_forced_meeting(
    db: Session,
    *,
    event_id: str,
    exhibitor_org_id: str,
    buyer_org_id: str,
    venue_id: str,
    scheduled_start: datetime | None = None,
    scheduled_end: datetime | None = None,
    slot_ids: Sequence[str] | None = None,
    reason: str | None = None,
    now: datetime | None = None,
) -> Meeting:
    """운영자 강제 배정 — front-matter 검증 → book_meeting(하드 제약만 강제) → commit.

    **참가사의 소프트 불가슬롯은 무시한다**(운영자 강제 — ``check_after_overlap`` 훅을 넘기지
    않는다). 하드 제약(슬롯 겹침·장소 충돌)은 book_meeting이 항상 강제하므로 여기서
    따로 검사하지 않는다. 수락 상태는 운영자가 고르지 않지만, FORCED 채널은 바이어 유형과
    무관하게 **항상 accepted**다(2026-09-15 정정 — ADR-0005, 발주자 QA 지적 B3: "강제 배정은
    무조건 확정"). 확정된 미팅은 양쪽 조직에 알림이 간다(``app.admin.router._emit_assignment_notifications``,
    기존 ``notify_meeting_accepted`` 재사용).
    """
    event = _require_event(db, event_id)
    if str(exhibitor_org_id) == str(buyer_org_id):
        raise MeetingError("ROLE_AMBIGUOUS", "같은 기업을 참가사·바이어 양쪽으로 지정할 수 없습니다.", 400)

    _require_org_role(db, event_id, exhibitor_org_id, need="exhibitor")
    buyer_role = _require_org_role(db, event_id, buyer_org_id, need="buyer")
    _require_venue(db, event_id, venue_id)

    start, end = _resolve_window(
        db, event,
        scheduled_start=scheduled_start, scheduled_end=scheduled_end,
        slot_ids=slot_ids, now=now,
    )

    entry = resolve_entry_state(_buyer_recipient_type(buyer_role), Channel.FORCED)

    meeting = book_meeting(
        db,
        event_id=str(event.id),
        exhibitor_org_id=str(exhibitor_org_id),
        buyer_org_id=str(buyer_org_id),
        start=start,
        end=end,
        resolve_venue=_forced_venue_resolver(db, str(event.id), venue_id, start, end),
        entry_state=entry,
        matching_type="forced",
        requested_by="organizer",
        # FORCED는 항상 accepted라 entry가 PROPOSED일 일이 없다(모듈 docstring 참고) — 그래도
        # 방어적으로 이 분기를 남겨둔다.
        awaiting_org_id=str(buyer_org_id) if entry is EntryState.PROPOSED else None,
        request_reason=reason,
    )
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise integrity_to_meeting_error(exc)
    db.refresh(meeting)
    return meeting


def create_retrigger_meeting(
    db: Session,
    *,
    event_id: str,
    exhibitor_org_id: str,
    buyer_org_id: str,
    venue_id: str,
    scheduled_start: datetime | None = None,
    scheduled_end: datetime | None = None,
    slot_ids: Sequence[str] | None = None,
    now: datetime | None = None,
) -> Meeting:
    """단일 기업 빈슬롯 보충 재트리거(⚡, F-OP-003 / Channel.AI_RETRIGGER) — front-matter 검증 →
    book_meeting(하드 제약만 강제, ``create_forced_meeting``과 동일하게 참가사 소프트 불가슬롯은
    보지 않는다 — FE ``proposeSingleOrgFill``가 드래프트 생성 시점에 이미 걸러준다) → commit.

    **FORCED/AI_SATURATION과 달리 운영자 개입 채널이 아니다** — 받는 쪽 바이어 유형이 진입
    상태를 그대로 결정한다(초청 바이어=accepted, 일반 바이어=수락대기). ``Meeting.matching_type``은
    CHECK 제약(``ai``/``open``/``forced``/``on_site``) 안에 머물러야 해서 AI_SATURATION과 똑같이
    ``"ai"``로 저장하지만(스키마 설계상 기존 모호함, 모듈 docstring 참고), 수락 상태 검증은
    ``book_meeting(channel=Channel.AI_RETRIGGER)``로 명시해 AI_SATURATION의 "항상 accepted" 규칙이
    잘못 적용되지 않게 한다 — 이 채널 구분이 없으면 일반 바이어 수신 건이 ``ENTRY_STATE_INVALID``로
    거부된다(2026-09-15 QA 지적 B: ⚡ 확정이 등록되지 않던 원인 중 하나).
    """
    event = _require_event(db, event_id)
    if str(exhibitor_org_id) == str(buyer_org_id):
        raise MeetingError("ROLE_AMBIGUOUS", "같은 기업을 참가사·바이어 양쪽으로 지정할 수 없습니다.", 400)

    _require_org_role(db, event_id, exhibitor_org_id, need="exhibitor")
    buyer_role = _require_org_role(db, event_id, buyer_org_id, need="buyer")
    _require_venue(db, event_id, venue_id)

    start, end = _resolve_window(
        db, event,
        scheduled_start=scheduled_start, scheduled_end=scheduled_end,
        slot_ids=slot_ids, now=now,
    )

    entry = resolve_entry_state(_buyer_recipient_type(buyer_role), Channel.AI_RETRIGGER)

    meeting = book_meeting(
        db,
        event_id=str(event.id),
        exhibitor_org_id=str(exhibitor_org_id),
        buyer_org_id=str(buyer_org_id),
        start=start,
        end=end,
        resolve_venue=_forced_venue_resolver(db, str(event.id), venue_id, start, end),
        entry_state=entry,
        matching_type="ai",
        channel=Channel.AI_RETRIGGER,
        requested_by="organizer",
        awaiting_org_id=str(buyer_org_id) if entry is EntryState.PROPOSED else None,
    )
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise integrity_to_meeting_error(exc)
    db.refresh(meeting)
    return meeting


# =============================================================================
# Phase 4 — AI 전체 포화배정
# =============================================================================
def _zero_meeting_org_ids(db: Session, event_id: str, *, role_flag: str) -> list[str]:
    """approved 상태이며 이 행사에서 활성 미팅(proposed/accepted)이 0건인 org id들.

    id 오름차순 정렬 — "공정성은 seq_no 순서 정도 결정론적이면 충분하다"는 설계 결정을 그대로
    따른다(fit score 없음, naive). 재실행해도 이미 미팅이 생긴 org는 자연히 빠진다(추가 전용
    반복 실행과 정합 — 취소분은 status가 활성 아니게 되므로 다음 run부터 다시 대상이 된다).
    """
    if role_flag == "exhibitor":
        role_col = OrganizationEventRole.is_exhibitor
        meeting_org_col = Meeting.exhibitor_org_id
    else:
        role_col = OrganizationEventRole.is_buyer
        meeting_org_col = Meeting.buyer_org_id

    busy = select(meeting_org_col).where(
        Meeting.event_id == event_id, Meeting.status.in_(["proposed", "accepted"])
    )
    rows = (
        db.execute(
            select(OrganizationEventRole.organization_id)
            .where(
                OrganizationEventRole.event_id == event_id,
                role_col.is_(True),
                OrganizationEventRole.application_status == "approved",
                OrganizationEventRole.organization_id.not_in(busy),
            )
            .order_by(OrganizationEventRole.organization_id)
        )
        .scalars()
        .all()
    )
    return [str(r) for r in rows]


def _future_grid_slots(db: Session, event: Event) -> list[Slot]:
    """행사 슬롯 그리드 중 지금보다 미래인 칸만 — naive 매칭이 고를 수 있는 시간 후보."""
    policy = schedule_policy(db, event)
    current = event_now(event)
    return [slot for day in build_grid(policy) for slot in day.slots if slot.start > current]


def _min_guaranteed_slots(db: Session, event_id: str) -> int:
    value = db.execute(
        select(EventScheduleSettings.min_guaranteed_slots).where(
            EventScheduleSettings.event_id == event_id
        )
    ).scalar_one_or_none()
    return _DEFAULT_MIN_GUARANTEED_SLOTS if value is None else value


@dataclass(frozen=True, slots=True)
class _DraftPair:
    exhibitor_org_id: str
    buyer_org_id: str
    slot: Slot


def _build_saturation_pairs(
    exhibitor_ids: Sequence[str],
    buyer_ids: Sequence[str],
    slots: Sequence[Slot],
    min_guaranteed_slots: int,
    unavailable: dict[str, set[str]],
) -> list[_DraftPair]:
    """참가사 우선 보장 라운드(ADR-0006 D8) — 각 참가사를 최소 ``min_guaranteed_slots``건까지,
    서로 다른 바이어·서로 다른 시간으로 채운다(naive, fit score 없음 — 결정적 정렬 + 라운드로빈).

    바이어는 참가사 index만큼 회전한 순서로 훑어 특정 바이어에게 쏠리지 않게 한다(공급 비대칭
    Exhibitor < Buyer 완화, ADR-0006 "참가사 우선 포화"). 같은 실행 안에서:

    - 참가사·바이어 모두 **한 슬롯에 한 미팅**만 가능(``occupied``로 추적) — draft 단계에서부터
      이중예약을 만들지 않는다(발주자 QA "이중예약 없어야" 체크).
    - 같은 참가사-바이어 쌍은 이 실행에서 한 번만 짝짓는다(``paired``).
    - 참가사가 신청 때 표시해둔 미팅 불가 슬롯(``unavailable``)은 후보에서 제외한다 — 강제배정
      (FORCED)과 달리 전체 포화배정은 운영자가 참가사 캘린더를 "대신" 채우는 자동 프로세스라
      참가사가 명시적으로 막아둔 시간까지 넘지 않는다.
    - 버퍼(참가사<바이어)가 없거나 슬롯이 없으면 그 참가사는 가능한 만큼만 채우고 다음으로
      넘어간다(품질 게이트 없이 빈 슬롯 최대한 채움, ADR-0006 "considered options" 기각안 참고).
    """
    pairs: list[_DraftPair] = []
    if not slots or not exhibitor_ids or not buyer_ids:
        return pairs

    n_buyers = len(buyer_ids)
    occupied: dict[str, set[str]] = {}
    paired: dict[str, set[str]] = {}

    for ex_idx, exhibitor_id in enumerate(exhibitor_ids):
        ex_unavailable = unavailable.get(exhibitor_id, set())
        ex_paired = paired.setdefault(exhibitor_id, set())
        filled = 0
        for offset in range(n_buyers):
            if filled >= min_guaranteed_slots:
                break
            buyer_id = buyer_ids[(ex_idx + offset) % n_buyers]
            if buyer_id in ex_paired:
                continue
            ex_busy = occupied.get(exhibitor_id, set())
            buyer_busy = occupied.get(buyer_id, set())
            chosen: Slot | None = None
            for slot in slots:
                if slot.id in ex_unavailable:
                    continue
                if slot.id in ex_busy or slot.id in buyer_busy:
                    continue
                chosen = slot
                break
            if chosen is None:
                continue  # 이 바이어와는 공통으로 비어있는(가능한) 슬롯이 없다 — 다음 바이어로.
            pairs.append(_DraftPair(exhibitor_id, buyer_id, chosen))
            occupied.setdefault(exhibitor_id, set()).add(chosen.id)
            occupied.setdefault(buyer_id, set()).add(chosen.id)
            ex_paired.add(buyer_id)
            filled += 1

    return pairs


def create_saturation_run(
    db: Session, event_id: str
) -> tuple[SaturationBatchRun, list[SaturationDraftItem]]:
    """draft run 생성 — 미팅 0건 참가사마다 최소 보장 슬롯 수(N)까지 서로 다른(0건) 바이어와
    빈 공통 슬롯으로 짝짓는다(naive, fit score 없음 — :func:`_build_saturation_pairs`).
    **아직 미팅을 만들지 않는다** — draft만 적재, 물질화는 :func:`confirm_saturation_run`.

    장소는 여기서 정하지 않는다(모듈 doc스트링 참고) — ``venue_id``는 NULL로 남는다.
    """
    event = _require_event(db, event_id)

    exhibitor_ids = _zero_meeting_org_ids(db, event_id, role_flag="exhibitor")
    buyer_ids = _zero_meeting_org_ids(db, event_id, role_flag="buyer")
    slots = _future_grid_slots(db, event)
    min_guaranteed_slots = _min_guaranteed_slots(db, event_id)
    unavailable = {
        org_id: set(slot_ids)
        for org_id, slot_ids in admin_service.list_exhibitor_unavailable_slots(db, event_id).items()
    }

    next_run_number = db.execute(
        select(func.coalesce(func.max(SaturationBatchRun.run_number), 0) + 1).where(
            SaturationBatchRun.event_id == event_id
        )
    ).scalar_one()

    run = SaturationBatchRun(
        event_id=event_id,
        run_number=next_run_number,
        min_guaranteed_slots=min_guaranteed_slots,
        status="draft",
    )
    db.add(run)
    db.flush()  # run.id 확보 — draft item이 FK로 물고 들어간다.

    items: list[SaturationDraftItem] = []
    draft_pairs = _build_saturation_pairs(
        exhibitor_ids, buyer_ids, slots, min_guaranteed_slots, unavailable
    )
    for i, pair in enumerate(draft_pairs):
        item = SaturationDraftItem(
            saturation_run_id=run.id,
            exhibitor_org_id=pair.exhibitor_org_id,
            buyer_org_id=pair.buyer_org_id,
            scheduled_start=pair.slot.start,
            scheduled_end=pair.slot.end,
            status="draft",
            seq_no=i + 1,
        )
        db.add(item)
        items.append(item)

    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise integrity_to_meeting_error(exc)
    db.refresh(run)
    for item in items:
        db.refresh(item)
    return run, items


def get_saturation_run(
    db: Session, event_id: str, run_id: str
) -> tuple[SaturationBatchRun, list[SaturationDraftItem]]:
    run = db.get(SaturationBatchRun, run_id)
    if run is None or str(run.event_id) != str(event_id):
        raise MeetingError("RUN_NOT_FOUND", "포화배정 run을 찾을 수 없습니다.", 404)
    items = list(
        db.execute(
            select(SaturationDraftItem)
            .where(SaturationDraftItem.saturation_run_id == run_id)
            .order_by(SaturationDraftItem.seq_no, SaturationDraftItem.id)
        ).scalars()
    )
    return run, items


def _saturation_venue_resolver(db: Session, event: Event, item: SaturationDraftItem):
    """물질화 전용 장소 자동선택 콜백 — zone_table 우선, 없으면 참가사 booth로 폴백(모듈
    docstring 참고). book_meeting 임계구역 안에서 호출되므로 "그 순간 비었는가"를 이 시점에야
    확정할 수 있다."""
    event_id = str(event.id)
    enabled = list(event.enabled_venue_types or [])
    exhibitor_org_id = str(item.exhibitor_org_id)
    start, end = item.scheduled_start, item.scheduled_end

    def _resolve() -> MeetingVenue:
        if "zone_table" in enabled:
            candidates = list_provisioned_venues(db, event_id=event_id, venue_type="zone_table")
            if candidates:
                for venue_id in sorted(str(v.id) for v in candidates):
                    slot_booking.meeting_write_lock(db, event_id=event_id, venue_id=venue_id)
                busy = slot_booking.busy_venue_ids(
                    db, venue_ids=[str(v.id) for v in candidates], start=start, end=end
                )
                for venue in candidates:
                    if str(venue.id) not in busy:
                        return venue

        if "booth" in enabled:
            label = _booth_label(db, event_id=event_id, exhibitor_org_id=exhibitor_org_id)
            venue = get_or_create_booth_venue(db, event_id=event_id, label=label)
            slot_booking.meeting_write_lock(db, event_id=event_id, venue_id=str(venue.id))
            if not slot_booking.has_venue_overlap(db, venue_id=str(venue.id), start=start, end=end):
                return venue

        raise MeetingError(
            "VENUE_TYPE_DISABLED",
            "이 시간에 배정할 수 있는 미팅 장소가 없습니다(zone_table/booth 모두 불가).",
            422,
        )

    return _resolve


@dataclass(frozen=True, slots=True)
class ConfirmItemResult:
    """confirm 루프 한 항목의 결과 — 라우터가 응답(성공/스킵 요약)을 조립하는 재료."""

    item: SaturationDraftItem
    error: MeetingError | None = None


def confirm_saturation_run(
    db: Session, event_id: str, run_id: str
) -> tuple[SaturationBatchRun, list[ConfirmItemResult]]:
    """draft 확정 — 항목마다 SAVEPOINT로 감싸 book_meeting으로 물질화한다.

    **항목별 원자성**: 한 항목이 슬롯/장소 충돌로 실패해도(``MeetingError``) 그 항목의 SAVEPOINT만
    롤백하고 ``status='skipped'``로 남긴 뒤 다음 항목을 계속한다 — 전체가 한 트랜잭션에 묶여
    한 항목의 실패가 이전 성공분까지 오염시키지 않는다. ``db.commit()``/``db.rollback()``은 항상
    "현재(가장 안쪽) 트랜잭션"에 적용되는 SQLAlchemy 세션 계약을 이용한다 — SAVEPOINT가 열려
    있으면 그 SAVEPOINT만 RELEASE/ROLLBACK TO SAVEPOINT되고 바깥 트랜잭션은 건드리지 않는다.

    ``book_meeting``은 flush 단계 ``IntegrityError``를 자기 안에서 ``db.rollback()``으로 이미
    처리하고 ``MeetingError``로 환산해 던진다 — 그 경우 SAVEPOINT는 이미 닫혀 있으므로
    ``db.in_nested_transaction()``으로 확인 후에만 우리가 추가로 롤백한다(안 그러면 이미 닫힌
    SAVEPOINT 대신 바깥 트랜잭션이 롤백되어 이전 확정분까지 사라진다).
    """
    run, items = get_saturation_run(db, event_id, run_id)
    if run.status != "draft":
        raise MeetingError(
            "RUN_NOT_DRAFT", f"이미 '{run.status}' 상태인 run입니다 — 확정할 수 없습니다.", 409
        )

    event = _require_event(db, event_id)

    draft_items = [item for item in items if item.status == "draft"]
    buyer_org_ids = {str(item.buyer_org_id) for item in draft_items}
    buyer_roles: dict[str, OrganizationEventRole] = {}
    if buyer_org_ids:
        for role in db.execute(
            select(OrganizationEventRole).where(
                OrganizationEventRole.event_id == event_id,
                OrganizationEventRole.organization_id.in_(buyer_org_ids),
            )
        ).scalars():
            buyer_roles[str(role.organization_id)] = role

    results: list[ConfirmItemResult] = []
    for item in draft_items:
        db.begin_nested()
        try:
            entry = resolve_entry_state(
                _buyer_recipient_type(buyer_roles.get(str(item.buyer_org_id))),
                Channel.AI_SATURATION,
            )
            meeting = book_meeting(
                db,
                event_id=str(event_id),
                exhibitor_org_id=str(item.exhibitor_org_id),
                buyer_org_id=str(item.buyer_org_id),
                start=item.scheduled_start,
                end=item.scheduled_end,
                resolve_venue=_saturation_venue_resolver(db, event, item),
                entry_state=entry,
                matching_type="ai",
                requested_by="organizer",
                awaiting_org_id=str(item.buyer_org_id) if entry is EntryState.PROPOSED else None,
                saturation_run_id=str(run.id),
            )
        except MeetingError as exc:
            # 이 항목의 SAVEPOINT만 되돌린다(``in_nested_transaction()``으로 book_meeting이
            # IntegrityError에서 이미 되돌린 경우와 구분 — 모듈 docstring 참고). ⚠ 상태 갱신은
            # 반드시 이 rollback **다음**에, 그리고 **즉시 flush**해야 한다 — 세션 rollback은
            # "아직 flush 안 된" 변경을 전부 되돌린다(어느 SAVEPOINT 소속인지 구분하지 않는다).
            # flush 없이 다음 항목으로 넘어가면, 다음 항목이 실패해 rollback할 때 **이번** 항목의
            # status="skipped" 갱신까지 함께 지워진다(SAVEPOINT 경계가 아니라 flush 여부가
            # 진짜 경계다).
            if db.in_nested_transaction():
                db.rollback()
            item.status = "skipped"
            db.flush()
            results.append(ConfirmItemResult(item=item, error=exc))
            continue
        # 성공 항목은 SAVEPOINT를 RELEASE하기 **전**에 상태를 갱신한다 — commit(release)이 그
        # 갱신까지 함께 flush해 이 SAVEPOINT의 일부로 확정시킨다(위 실패 분기와 같은 이유의
        # 대칭 처리 — "flush가 곧 되돌릴 수 없는 경계"라는 원칙을 성공 경로에도 그대로 적용).
        item.status = "confirmed"
        item.materialized_meeting_id = meeting.id
        db.commit()  # 이 항목의 SAVEPOINT만 RELEASE — 바깥 트랜잭션은 아직 열려 있다.
        results.append(ConfirmItemResult(item=item))

    run.status = "confirmed"
    run.confirmed_at = datetime.now(timezone.utc)
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise integrity_to_meeting_error(exc)

    db.refresh(run)
    for result in results:
        db.refresh(result.item)
    return run, results


def discard_saturation_run(db: Session, event_id: str, run_id: str) -> SaturationBatchRun:
    """draft run 폐기 — 물질화 없이 상태만 전이(비파괴, Meeting 생성 없음)."""
    run, _items = get_saturation_run(db, event_id, run_id)
    if run.status != "draft":
        raise MeetingError(
            "RUN_NOT_DRAFT", f"이미 '{run.status}' 상태인 run입니다 — discard할 수 없습니다.", 409
        )
    run.status = "discarded"
    db.commit()
    db.refresh(run)
    return run


__all__ = [
    "ConfirmItemResult",
    "MeetingError",
    "confirm_saturation_run",
    "create_forced_meeting",
    "create_retrigger_meeting",
    "create_saturation_run",
    "discard_saturation_run",
    "get_saturation_run",
]
