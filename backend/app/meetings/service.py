"""참가자용 미팅 서비스 — 검증 순서·트랜잭션 경계·알림 발화를 소유 (F-MT-001).

설계상 지켜야 하는 두 가지 순서가 있다.

**1. 검증 순서 = 락 보유 최소화.** 신원·권한·가시성·기간·형식처럼 **다른 트랜잭션과 무관한**
검사는 전부 락 바깥에서 끝낸다. advisory lock을 잡은 뒤에는 "다른 트랜잭션이 그 사이에 바꿀 수
있는 것"만 본다 — 슬롯 점유, 불가 슬롯 교차, (쌍,시각) 중복, 장소 점유. 임계구역이 짧을수록 동시
신청이 서로 덜 기다린다.

**2. 알림은 상태 전이가 커밋된 뒤에.** ``notifications.service._emit_notification``은 내부에서
``db.commit()``을 한다 — 상태 전이와 같은 트랜잭션에 두면 알림 실패가 이미 확정된 수락/취소를
되감는다. 그래서 전이를 먼저 커밋하고, 알림은 그 뒤에 ``notify_after_commit``로 감싸 실패를
삼킨다(로그만 남긴다). 알림이 안 갔다고 미팅이 취소되지 않은 척할 수는 없다.

동시성(락·겹침 술어)은 이 모듈이 직접 구현하지 않는다 — ``app.matching.slot_booking``이 유일한
소유자다. 가용성 계산과 쓰기 가드가 같은 함수를 쓰게 하려는 의도적 봉인이다.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import date, datetime
from typing import Iterable, Sequence

from sqlalchemy import func, or_, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.auth.principal import Principal
from app.config import settings
from app.display_locale import (
    DEFAULT_LOCALE,
    booth_title,
    localized_booth_venue_label,
    localized_hall_name,
    localized_org_name,
    normalize_locale,
    unassigned_booth_label,
)
from app.domain.visibility_rules import can_view_organization
from app.matching import slot_booking
from app.matching.acceptance_rule import (
    Channel,
    EntryState,
    RecipientType,
    recipient_type_from_buyer_subtype,
    resolve_entry_state,
)
#: MeetingError는 book_meeting이 던지는 예외라 정의를 app.matching.meeting_booking이 소유한다
#: (여기서 정의하면 그쪽이 이 모듈을 되돌아 임포트해야 해서 순환 임포트가 생긴다). 이 임포트로
#: ``service.MeetingError``·``discover/service.py``의 ``meetings_service.MeetingError`` 같은 기존
#: 호출부는 그대로 동작한다 — 재노출일 뿐 같은 클래스 객체다.
from app.matching.meeting_booking import (
    MeetingError,
    book_meeting,
    integrity_to_meeting_error,
)
from app.matching.meeting_state import IllegalTransitionError, assert_transition
from app.matching.slot_grid import (
    SchedulePolicy,
    Slot,
    SlotError,
    SlotRun,
    build_grid,
    validate_slot_run,
)
from app.models import (
    Booth,
    Event,
    EventScheduleSettings,
    ExhibitorProfile,
    Hall,
    Meeting,
    MeetingParticipant,
    MeetingVenue,
    Member,
    Organization,
    OrganizationEventRole,
    PostMeetingReview,
)
from app.notifications import service as notification_service

logger = logging.getLogger(__name__)

#: 이 슬라이스의 미팅은 전부 "직접 신청" 채널이다(AI 포화배정·강제배정은 별도 경로).
OPEN_CHANNEL = Channel.OPEN
MATCHING_TYPE_OPEN = "open"


class MeetingNotFoundError(Exception):
    """미팅/자원 부재 — 라우터가 404. 존재 자체를 숨기는 경로에도 쓴다."""


# =============================================================================
# 컨텍스트 해석 — 행사·역할·정책
# =============================================================================
@dataclass(frozen=True, slots=True)
class Party:
    """한쪽 당사자 — org와 그 행사에서의 역할 행."""

    org_id: str
    role: OrganizationEventRole

    @property
    def roles(self) -> frozenset[str]:
        found = set()
        if self.role.is_exhibitor:
            found.add("exhibitor")
        if self.role.is_buyer:
            found.add("buyer")
        return frozenset(found)


@dataclass(frozen=True, slots=True)
class PairContext:
    """신청/가용성 조회가 필요로 하는 해석 결과 묶음."""

    event: Event
    policy: SchedulePolicy
    me: Party
    counterpart: Party
    my_role: str  # 'exhibitor' | 'buyer'
    counterpart_role: str
    exhibitor_org_id: str
    buyer_org_id: str


def resolve_event_id(db: Session, org_id: str, event_id: str | None) -> str:
    """행사 특정 — 명시값 우선, 없으면 내 org의 참가 행사가 **정확히 하나**일 때만 자동 해석.

    자동 해석은 편의지 추측이 아니다. 두 개 이상이면 어느 행사의 미팅인지 서버가 고를 수 없고,
    잘못 고르면 다른 행사에 미팅이 생긴다 — 그래서 400으로 되묻는다(조용한 선택 금지).
    """
    if event_id:
        return event_id
    rows = db.execute(
        select(OrganizationEventRole.event_id).where(
            OrganizationEventRole.organization_id == org_id
        )
    ).scalars().all()
    unique = {str(value) for value in rows}
    if len(unique) == 1:
        return next(iter(unique))
    if not unique:
        raise MeetingError(
            "EVENT_AMBIGUOUS",
            "참가 중인 행사가 없어 행사를 특정할 수 없습니다. event_id를 지정해 주세요.",
            400,
        )
    raise MeetingError(
        "EVENT_AMBIGUOUS",
        f"참가 중인 행사가 {len(unique)}개라 자동으로 특정할 수 없습니다. event_id를 지정해 주세요.",
        400,
    )


def load_event(db: Session, event_id: str) -> Event:
    event = db.get(Event, event_id)
    if event is None:
        raise MeetingNotFoundError("행사를 찾을 수 없습니다")
    return event


def load_role(db: Session, event_id: str, org_id: str) -> OrganizationEventRole | None:
    return db.execute(
        select(OrganizationEventRole).where(
            OrganizationEventRole.event_id == event_id,
            OrganizationEventRole.organization_id == org_id,
        )
    ).scalar_one_or_none()


def schedule_policy(db: Session, event: Event) -> SchedulePolicy:
    """행사 슬롯 정책 조립. 운영시간/전시기간이 없으면 그리드를 만들 수 없다 → 409.

    슬롯 길이는 ``events.slot_minutes`` 단일 진실원천에서만 온다(mt001meet01). 칸 사이 텀과 미팅
    최대 길이는 행사별 운영 세부값이라 ``event_schedule_settings`` 에서 온다(mt003gap0001).
    """
    settings_row = db.execute(
        select(EventScheduleSettings).where(EventScheduleSettings.event_id == event.id)
    ).scalar_one_or_none()
    if settings_row is None:
        raise MeetingError(
            "EVENT_SCHEDULE_UNSET",
            "행사 운영시간이 설정되지 않아 미팅 슬롯을 만들 수 없습니다(운영자 설정 필요).",
            409,
        )
    if event.exhibition_start is None or event.exhibition_end is None:
        raise MeetingError(
            "EVENT_SCHEDULE_UNSET",
            "행사 전시 기간이 설정되지 않아 미팅 슬롯을 만들 수 없습니다(운영자 설정 필요).",
            409,
        )
    try:
        return SchedulePolicy(
            operating_start=settings_row.operating_start,
            operating_end=settings_row.operating_end,
            slot_minutes=event.slot_minutes,
            timezone=event.timezone,
            exhibition_start=event.exhibition_start,
            exhibition_end=event.exhibition_end,
            lunch_start=settings_row.lunch_start,
            lunch_end=settings_row.lunch_end,
            gap_minutes=settings_row.slot_gap_minutes,
            max_meeting_minutes=settings_row.max_meeting_minutes,
        )
    except SlotError as exc:
        raise MeetingError("EVENT_SCHEDULE_UNSET", f"행사 운영시간 설정이 올바르지 않습니다: {exc}", 409)


def event_now(event: Event, now: datetime | None = None) -> datetime:
    """행사 타임존 기준 '지금'. 주입된 now가 있으면 그걸 행사 타임존으로 환산해 쓴다."""
    from app.matching.slot_grid import resolve_zone

    zone = resolve_zone(event.timezone)
    moment = now or datetime.now(tz=zone)
    return moment.astimezone(zone)


def _resolve_direction(
    my_roles: frozenset[str], their_roles: frozenset[str], my_role: str | None
) -> tuple[str, str]:
    """(내 역할, 상대 역할) 확정 — 미팅은 참가사 1 : 바이어 1로만 성립한다.

    한쪽이라도 dual-role(참가사이자 바이어)이면 방향 후보가 여럿일 수 있다. 후보가 정확히 하나로
    좁혀질 때만 자동 결정하고, 아니면 되묻는다 — 서버가 방향을 임의로 고르면 미팅이 엉뚱한
    역할로 박제된다(``meetings.exhibitor_org_id``/``buyer_org_id``는 되돌리기 어렵다).
    """
    candidates = [
        (mine, theirs) for mine in sorted(my_roles) for theirs in sorted(their_roles) if mine != theirs
    ]
    if my_role is not None:
        candidates = [pair for pair in candidates if pair[0] == my_role]
    if len(candidates) == 1:
        return candidates[0]
    if not candidates:
        raise MeetingError(
            "ROLE_AMBIGUOUS",
            "미팅은 참가사와 바이어 사이에만 만들 수 있습니다 — 요청한 역할 조합으로는 "
            "방향을 정할 수 없습니다.",
            400,
        )
    raise MeetingError(
        "ROLE_AMBIGUOUS",
        "양측 모두 참가사·바이어 역할을 함께 가지고 있어 방향을 정할 수 없습니다. "
        "my_role을 지정해 주세요.",
        400,
    )


def resolve_pair(
    db: Session,
    *,
    principal: Principal,
    counterpart_org_id: str,
    event_id: str | None,
    my_role: str | None = None,
) -> PairContext:
    """행사·역할·가시성·방향까지 한 번에 해석한다(락 바깥에서 끝나는 검사들).

    순서에 의미가 있다: 존재(404) → 승인(403) → 가시성(403) → 방향(400). 승인 전인 사용자에게
    "그 기업은 볼 수 없습니다"라고 답하면 승인 상태를 숨기는 게 아니라 이유만 헷갈리게 한다.
    """
    resolved_event_id = resolve_event_id(db, principal.organization_id, event_id)
    event = load_event(db, resolved_event_id)

    my_role_row = load_role(db, resolved_event_id, principal.organization_id)
    if my_role_row is None:
        raise MeetingNotFoundError("이 행사의 참가 정보가 없습니다")
    counterpart_role_row = load_role(db, resolved_event_id, counterpart_org_id)
    if counterpart_role_row is None:
        raise MeetingNotFoundError("상대 기업을 찾을 수 없습니다")
    if str(counterpart_org_id) == str(principal.organization_id):
        raise MeetingError("ROLE_AMBIGUOUS", "자기 자신에게 미팅을 신청할 수 없습니다.", 400)

    if my_role_row.application_status != "approved":
        raise MeetingError(
            "PROFILE_NOT_APPROVED",
            "참가 신청이 승인된 뒤에 미팅을 신청할 수 있습니다.",
            403,
        )

    me = Party(org_id=str(principal.organization_id), role=my_role_row)
    counterpart = Party(org_id=str(counterpart_org_id), role=counterpart_role_row)

    # 열람 범위(개발계획서 §8) — 행사별 정책. 어느 역할 조합으로든 볼 수 있으면 통과.
    visible = any(
        can_view_organization(
            mine, theirs, allow_same_role_discovery=event.allow_same_role_discovery
        )
        for mine in me.roles
        for theirs in counterpart.roles
    )
    if not me.roles or not counterpart.roles or not visible:
        raise MeetingError("NOT_VISIBLE", "이 기업은 열람할 수 없습니다.", 403)

    my_side, counterpart_side = _resolve_direction(me.roles, counterpart.roles, my_role)
    exhibitor_org_id = me.org_id if my_side == "exhibitor" else counterpart.org_id
    buyer_org_id = me.org_id if my_side == "buyer" else counterpart.org_id

    return PairContext(
        event=event,
        policy=schedule_policy(db, event),
        me=me,
        counterpart=counterpart,
        my_role=my_side,
        counterpart_role=counterpart_side,
        exhibitor_org_id=exhibitor_org_id,
        buyer_org_id=buyer_org_id,
    )


def _assert_application_window(event: Event, now: datetime) -> None:
    """신청 기간(행사 타임존 기준 날짜) 밖이면 403. 미설정 경계는 열린 것으로 본다."""
    today: date = now.date()
    start = event.application_start
    end = event.application_end
    if start is not None and today < start:
        raise MeetingError(
            "APPLICATION_WINDOW_CLOSED", f"미팅 신청은 {start.isoformat()}부터 가능합니다.", 403
        )
    if end is not None and today > end:
        raise MeetingError(
            "APPLICATION_WINDOW_CLOSED", f"미팅 신청 기간이 {end.isoformat()}에 종료되었습니다.", 403
        )


def _recipient_type(counterpart: Party, counterpart_role: str) -> RecipientType:
    """수락 규칙(ADR-0005)의 '받는 쪽 유형' — 상대가 이 미팅에서 맡는 역할 기준."""
    if counterpart_role == "exhibitor":
        return RecipientType.EXHIBITOR
    subtype = counterpart.role.buyer_subtype
    if not subtype:
        # 바이어 세부유형 미지정 — 의무 미팅(hosted)으로 단정하지 않는다. 동의 없이 일정이
        # 잡히는 쪽이 더 나쁜 실패라 일반 바이어(수락대기)로 보수적으로 처리한다.
        return RecipientType.GENERAL_BUYER
    return recipient_type_from_buyer_subtype(subtype)


def exhibitor_unavailable_slots(db: Session, *, event_id: str, exhibitor_org_id: str) -> set[str]:
    """참가사가 저장해둔 미팅 불가 슬롯 키. **읽기 전용** — 이 컬럼 쓰기는 운영자 단일 경로다."""
    slots = db.execute(
        select(ExhibitorProfile.unavailable_meeting_slots)
        .join(
            OrganizationEventRole,
            OrganizationEventRole.id == ExhibitorProfile.org_event_role_id,
        )
        .where(
            OrganizationEventRole.event_id == event_id,
            OrganizationEventRole.organization_id == exhibitor_org_id,
        )
    ).scalar_one_or_none()
    return set(slots or ())


# =============================================================================
# 장소(venue) 해석
# =============================================================================
@dataclass(frozen=True, slots=True)
class BoothIdentity:
    """부스를 사람에게 보여줄 재료 — 기업명은 항상 있고, 번호는 없을 수 있다(미배정은 정상 상태)."""

    company_name: str
    #: 배정된 부스 ``"{Hall명} {부스코드}"``(정규화 halls/booths). 미배정이면 None.
    #: ⚠ ``meeting_venues`` 저장 라벨은 **이 값만** 쓴다 — 아래 신고값을 섞으면 같은 부스에 라벨이
    #: 다른 장소 행이 하나 더 생겨 부스 중복예약 가드(장소별 겹침 검사)가 갈라진다.
    assigned_number: str | None
    #: 참가신청 step1 신고값(``exhibitor_profiles.booth_location``) — 배정 전에도 참가자가 찾아갈 수
    #: 있는 부스번호이고, 운영자 콘솔의 "부스" 칸이 쓰는 것과 같은 출처다.
    declared_number: str | None

    @property
    def display_number(self) -> str | None:
        """화면에 보여줄 부스번호 — 배정값이 진실에 가깝고, 없으면 신고값으로 내려간다."""
        return self.assigned_number or self.declared_number


def _booth_identity(
    db: Session, *, event_id: str, exhibitor_org_id: str, locale: str = "ko"
) -> BoothIdentity:
    """참가사의 기업명 + 부스번호(배정값·신고값)를 한 번에 읽는다 — 저장 라벨과 화면 문구의 재료.

    배정(``booth_id`` → ``booths``/``halls``)과 신고(step1 ``booth_location``)는 별개 축이라 둘 다
    들고 온다 — 저장 라벨은 배정값만, 화면 문구는 배정값 → 신고값 순으로 쓴다. 부스 join은 outer다:
    미배정 참가사도 프로필 행은 있으므로 신고값을 잃지 않아야 한다.

    ``locale``은 **화면 문구용 값**만 바꾼다 — 기업명(영문명 우선)과 홀 이름("7홀" → "Hall 7").
    저장 라벨을 만드는 ``_booth_label``은 로케일을 넘기지 않아 항상 한국어 규칙이다.
    """
    row = db.execute(
        select(ExhibitorProfile.booth_location, Hall.hall_no, Hall.hall_name, Booth.code)
        .select_from(ExhibitorProfile)
        .join(
            OrganizationEventRole,
            OrganizationEventRole.id == ExhibitorProfile.org_event_role_id,
        )
        .outerjoin(Booth, Booth.id == ExhibitorProfile.booth_id)
        .outerjoin(Hall, Hall.id == Booth.hall_id)
        .where(
            OrganizationEventRole.event_id == event_id,
            OrganizationEventRole.organization_id == exhibitor_org_id,
        )
    ).first()
    declared, hall_no, hall_name, booth_code = row if row is not None else (None, None, None, None)
    return BoothIdentity(
        company_name=_localized_org_display_name(db, exhibitor_org_id, locale),
        assigned_number=(
            f"{localized_hall_name(hall_no, hall_name, locale)} {booth_code}"
            if hall_name and booth_code
            else None
        ),
        declared_number=(declared or "").strip() or None,
    )


def _booth_label(db: Session, *, event_id: str, exhibitor_org_id: str) -> str:
    """참가사 부스 장소의 **저장 라벨** — 표기 규칙 ``"{Hall명} {부스코드}"``(frontend boothLabel과 동일).

    ⚠ 이 값은 ``meeting_venues`` 멱등키((event_id, 'booth', label))의 일부고 확정 미팅 행이 이미
    가리키고 있다 — 화면 문구를 바꾸려고 여기를 건드리면 같은 부스에 장소 행이 하나 더 생긴다.
    참가자에게 보여줄 문구는 ``_booth_presentation``이 따로 만든다.
    부스가 아직 배정되지 않았으면(미배정은 정상 상태) 기업명을 써서 사람이 알아볼 라벨을 만든다.
    """
    identity = _booth_identity(db, event_id=event_id, exhibitor_org_id=exhibitor_org_id)
    if identity.assigned_number is not None:
        return identity.assigned_number
    return unassigned_booth_label(identity.company_name)


def get_or_create_booth_venue(db: Session, *, event_id: str, label: str) -> MeetingVenue:
    """부스 장소 행을 멱등하게 확보한다 — (event_id, 'booth', label) 유니크가 멱등 키.

    동시 신청 두 건이 같은 부스 장소를 동시에 만들려 해도 유니크 제약이 한쪽만 통과시키고,
    진 쪽은 ON CONFLICT DO NOTHING 후 재조회로 같은 행을 얻는다(예외 없이 수렴).
    """
    db.execute(
        pg_insert(MeetingVenue)
        .values(event_id=event_id, venue_type="booth", label=label)
        .on_conflict_do_nothing(
            index_elements=["event_id", "venue_type", "label"]
        )
    )
    venue = db.execute(
        select(MeetingVenue).where(
            MeetingVenue.event_id == event_id,
            MeetingVenue.venue_type == "booth",
            MeetingVenue.label == label,
        )
    ).scalar_one()
    return venue


def list_provisioned_venues(db: Session, *, event_id: str, venue_type: str) -> list[MeetingVenue]:
    """운영자가 프로비저닝해둔 장소 행들(zone_table/business_room). 라벨 순 — 배정도 이 순서."""
    return list(
        db.execute(
            select(MeetingVenue)
            .where(MeetingVenue.event_id == event_id, MeetingVenue.venue_type == venue_type)
            .order_by(MeetingVenue.label)
        ).scalars().all()
    )


def _resolve_venue(
    db: Session,
    ctx: PairContext,
    *,
    venue_type: str,
    run: SlotRun,
    venue_label: str | None = None,
) -> MeetingVenue:
    """장소 확정 — 임계구역 안에서 호출한다(장소 락을 여기서 잡는다).

    booth는 상대 참가사의 부스로 결정적이고, zone_table/business_room은 ``venue_label``이 왔으면
    그 자리를 고정으로 쓰고(H-02 — 사용자가 화면에서 고른 자리가 그대로 저장돼야 한다), 없으면
    운영자가 미리 깔아둔 풀에서 그 시간에 비어 있는 첫 자리를 자동 배정한다(기존 동작).
    후보 락은 **id 정렬 순서**로 잡는다 — org 락 키('mtslot:')가 장소 락 키('mtvenue:')보다
    항상 앞서므로 전역 획득 순서가 유지된다.
    """
    event_id = str(ctx.event.id)
    if venue_type == "booth":
        label = _booth_label(db, event_id=event_id, exhibitor_org_id=ctx.exhibitor_org_id)
        venue = get_or_create_booth_venue(db, event_id=event_id, label=label)
        slot_booking.meeting_write_lock(db, event_id=event_id, venue_id=str(venue.id))
        if slot_booking.has_venue_overlap(
            db, venue_id=str(venue.id), start=run.start, end=run.end
        ):
            raise MeetingError("VENUE_TAKEN", "해당 시간에 부스가 이미 사용 중입니다.", 409)
        return venue

    candidates = list_provisioned_venues(db, event_id=event_id, venue_type=venue_type)
    if not candidates:
        raise MeetingError(
            "VENUE_TYPE_DISABLED",
            "이 행사에는 해당 유형의 미팅 장소가 등록돼 있지 않습니다(운영자 등록 필요).",
            422,
        )

    if venue_label is not None:
        # 사용자가 특정 자리를 골랐다 — 그 후보 하나로 좁힌다. 없는 라벨이면 자동배정으로
        # 조용히 넘어가지 않고 거부한다(고른 자리와 다른 자리가 저장되는 게 이 버그의 본질).
        candidates = [v for v in candidates if v.label == venue_label]
        if not candidates:
            raise MeetingError(
                "VENUE_TAKEN", f"선택한 장소({venue_label})를 찾을 수 없습니다.", 409
            )

    for venue_id in sorted(str(v.id) for v in candidates):
        slot_booking.meeting_write_lock(db, event_id=event_id, venue_id=venue_id)
    busy = slot_booking.busy_venue_ids(
        db, venue_ids=[str(v.id) for v in candidates], start=run.start, end=run.end
    )
    for venue in candidates:
        if str(venue.id) not in busy:
            return venue
    raise MeetingError("VENUE_TAKEN", "해당 시간에 사용 가능한 장소가 없습니다.", 409)


# =============================================================================
# 직렬화
# =============================================================================
@dataclass(frozen=True, slots=True)
class MeetingView:
    """MeetingOut 조립에 필요한 뷰어 의존 값들 — 라우터가 그대로 dict로 편다."""

    meeting: Meeting
    counterpart_org_id: str
    counterpart_name: str
    venue_type: str | None
    venue_label: str | None
    has_review: bool
    attended: bool | None
    #: 행사 타임존 — 일정 시각을 이 존으로 환산해 내보낸다(아래 ``_in_event_zone`` 참고).
    timezone: str = "UTC"


def _in_event_zone(moment: datetime | None, timezone_name: str) -> datetime | None:
    """일정 시각을 **행사 로컬 오프셋**으로 환산한다.

    timestamptz를 그냥 읽으면 tzinfo가 **DB 세션 타임존**을 따른다 — 서버 설정에 따라 같은 미팅이
    ``+09:00``으로도 ``+00:00``으로도 직렬화된다. 그러면 호치민 행사의 09:00 미팅이 화면에
    02:00(UTC)으로 뜨거나, 클라이언트가 행사 타임존을 따로 알아내 다시 환산해야 한다.
    시각의 절대값은 같지만 **표시 오프셋**이 행사 기준이어야 한다는 게 응답 계약이다.
    """
    if moment is None:
        return None
    from app.matching.slot_grid import resolve_zone

    return moment.astimezone(resolve_zone(timezone_name))


def _requested_by_org_id(meeting: Meeting) -> str | None:
    if meeting.requested_by == "exhibitor":
        return str(meeting.exhibitor_org_id)
    if meeting.requested_by == "buyer":
        return str(meeting.buyer_org_id)
    return None  # organizer 생성/미기록 — 신청 org가 없다


def build_views(
    db: Session,
    meetings: Sequence[Meeting],
    viewer_org_id: str,
    *,
    locale: str = DEFAULT_LOCALE,
) -> list[MeetingView]:
    """뷰어 기준 파생값을 **배치로** 채운다(목록에서 N+1을 내지 않는다).

    ``locale``은 사람이 읽는 두 값만 바꾼다 — 상대 기업명(en이면 ``name_en`` 우선)과 부스 장소 라벨
    (en이면 ``"{기업명} Booth"``·``"Hall 7 A-12"``). 기본(ko)에서는 이전과 같은 쿼리·같은 값이다.
    """
    if not meetings:
        return []
    locale = normalize_locale(locale)
    meeting_ids = [str(m.id) for m in meetings]
    counterpart_ids = {
        str(m.buyer_org_id) if str(m.exhibitor_org_id) == str(viewer_org_id) else str(m.exhibitor_org_id)
        for m in meetings
    }
    # en은 부스 라벨에 참가사 영문명이 필요해 참가사 org까지 함께 읽는다(같은 쿼리 한 번).
    org_ids = set(counterpart_ids)
    if locale == "en":
        org_ids.update(str(m.exhibitor_org_id) for m in meetings)
    org_rows = {
        str(row.id): row
        for row in db.execute(
            select(Organization.id, Organization.name_ko, Organization.name_en).where(
                Organization.id.in_(org_ids)
            )
        ).all()
    }
    names = {oid: localized_org_name(row, locale, fallback=oid) for oid, row in org_rows.items()}
    zones = {
        str(eid): tz
        for eid, tz in db.execute(
            select(Event.id, Event.timezone).where(
                Event.id.in_({str(m.event_id) for m in meetings})
            )
        ).all()
    }
    venue_ids = {str(m.venue_id) for m in meetings if m.venue_id}
    venues = {
        str(vid): (vtype, label)
        for vid, vtype, label in db.execute(
            select(MeetingVenue.id, MeetingVenue.venue_type, MeetingVenue.label).where(
                MeetingVenue.id.in_(venue_ids)
            )
        ).all()
    } if venue_ids else {}
    # en 표시용 — 부스 장소의 저장 라벨("7홀 A-12"·"{기업명} 부스")을 옮기려면 그 행사의 홀 목록이
    # 필요하다. ko 응답은 저장 라벨을 그대로 내므로 이 조회 자체를 하지 않는다.
    halls_by_event: dict[str, list[tuple[str, str]]] = {}
    if locale == "en" and any(vtype == "booth" for vtype, _ in venues.values()):
        for hall_event_id, hall_no, hall_name in db.execute(
            select(Hall.event_id, Hall.hall_no, Hall.hall_name).where(
                Hall.event_id.in_({str(m.event_id) for m in meetings})
            )
        ).all():
            halls_by_event.setdefault(str(hall_event_id), []).append((hall_no, hall_name))

    review_rows = db.execute(
        select(
            PostMeetingReview.meeting_id,
            PostMeetingReview.reviewer_org_id,
            PostMeetingReview.counterpart_noshow,
            PostMeetingReview.self_noshow,
        ).where(PostMeetingReview.meeting_id.in_(meeting_ids))
    ).all()
    reviews: dict[tuple[str, str], tuple[bool, bool]] = {
        (str(mid), str(org)): (bool(counterpart_noshow), bool(self_noshow))
        for mid, org, counterpart_noshow, self_noshow in review_rows
    }

    views: list[MeetingView] = []
    for meeting in meetings:
        is_exhibitor_side = str(meeting.exhibitor_org_id) == str(viewer_org_id)
        counterpart_id = str(meeting.buyer_org_id) if is_exhibitor_side else str(meeting.exhibitor_org_id)
        venue_type, venue_label = venues.get(str(meeting.venue_id), (None, None))
        if venue_type == "booth" and venue_label is not None:
            # 부스 라벨은 시스템이 만든 한국어 문구라 로케일에 맞춰 옮긴다(ko는 그대로 돌아온다).
            # 매칭존·비즈니스룸 라벨("T-03"·"Room A")은 운영자가 붙인 이름이라 손대지 않는다.
            exhibitor_row = org_rows.get(str(meeting.exhibitor_org_id))
            venue_label = localized_booth_venue_label(
                venue_label,
                exhibitor_name_en=exhibitor_row.name_en if exhibitor_row is not None else None,
                halls=halls_by_event.get(str(meeting.event_id), ()),
                locale=locale,
            )
        # 뷰어의 참석 여부는 두 신고 중 하나로 판정한다: ① 뷰어 본인이 자기 리뷰에 self_noshow=True
        # ("내가 불참")를 남겼으면 그 자체로 확정 — 그게 가장 직접적인 신고다. ② 본인 신고가 없으면
        # **상대**가 남긴 리뷰를 본다 — 상대의 counterpart_noshow=True는 "상대가 본 상대방(=뷰어)이
        # 오지 않았다"는 신고다. 둘 다 없으면 알 수 없다(None) — 지어내지 않는다.
        own_review = reviews.get((str(meeting.id), str(viewer_org_id)))
        counterpart_review = reviews.get((str(meeting.id), counterpart_id))
        if own_review is not None and own_review[1]:  # 본인이 "내가 불참"을 신고
            attended: bool | None = False
        elif counterpart_review is not None:
            attended = not counterpart_review[0]
        else:
            attended = None
        views.append(
            MeetingView(
                meeting=meeting,
                counterpart_org_id=counterpart_id,
                counterpart_name=names.get(counterpart_id, counterpart_id),
                venue_type=venue_type,
                venue_label=venue_label,
                has_review=(str(meeting.id), str(viewer_org_id)) in reviews,
                attended=attended,
                timezone=zones.get(str(meeting.event_id), "UTC"),
            )
        )
    return views


def view_to_dict(view: MeetingView) -> dict:
    """MeetingOut 필드 사전 — Pydantic이 검증한다."""
    meeting = view.meeting
    duration = None
    if meeting.scheduled_start and meeting.scheduled_end:
        duration = int((meeting.scheduled_end - meeting.scheduled_start).total_seconds() // 60)
    return {
        "id": str(meeting.id),
        "event_id": str(meeting.event_id),
        "status": meeting.status,
        # 표시 오프셋은 **행사 기준**이다 — DB 세션 타임존이 새어 나가지 않게 명시 환산한다.
        "scheduled_start": _in_event_zone(meeting.scheduled_start, view.timezone),
        "scheduled_end": _in_event_zone(meeting.scheduled_end, view.timezone),
        "duration_minutes": duration,
        "event_timezone": view.timezone,
        "exhibitor_org_id": str(meeting.exhibitor_org_id),
        "buyer_org_id": str(meeting.buyer_org_id),
        "requested_by": meeting.requested_by,
        "requested_by_org_id": _requested_by_org_id(meeting),
        "awaiting_org_id": str(meeting.awaiting_org_id) if meeting.awaiting_org_id else None,
        "counterpart_org_id": view.counterpart_org_id,
        "counterpart_name": view.counterpart_name,
        "venue_id": str(meeting.venue_id) if meeting.venue_id else None,
        "venue_type": view.venue_type,
        "venue_label": view.venue_label,
        "has_review": view.has_review,
        "attended": view.attended,
        "request_reason": meeting.request_reason,
        "cancelled_at": meeting.cancelled_at,
        "cancelled_by": meeting.cancelled_by,
        "cancelled_by_org_id": str(meeting.cancelled_by_org_id) if meeting.cancelled_by_org_id else None,
        "cancelled_reason_code": meeting.cancelled_reason_code,
        "cancelled_reason_text": meeting.cancelled_reason_text,
        "rejected_at": meeting.rejected_at,
        "rejected_by_org_id": str(meeting.rejected_by_org_id) if meeting.rejected_by_org_id else None,
        "rejected_reason_code": meeting.rejected_reason_code,
        "rejected_reason_text": meeting.rejected_reason_text,
        "created_at": meeting.created_at,
        "updated_at": meeting.updated_at,
    }


def serialize(
    db: Session, meeting: Meeting, viewer_org_id: str, *, locale: str = DEFAULT_LOCALE
) -> dict:
    return view_to_dict(build_views(db, [meeting], viewer_org_id, locale=locale)[0])


# =============================================================================
# 목록 / 단건
# =============================================================================
def list_meetings(
    db: Session,
    *,
    principal: Principal,
    event_id: str | None,
    statuses: Sequence[str] | None = None,
    limit: int = 20,
    offset: int = 0,
) -> tuple[list[Meeting], int]:
    """내 org가 낀 미팅 목록(최신순). 권한의 닻은 org — 다른 org 미팅은 애초에 조회되지 않는다."""
    resolved_event_id = resolve_event_id(db, principal.organization_id, event_id)
    org_id = principal.organization_id
    stmt = select(Meeting).where(
        Meeting.event_id == resolved_event_id,
        or_(Meeting.exhibitor_org_id == org_id, Meeting.buyer_org_id == org_id),
    )
    if statuses:
        stmt = stmt.where(Meeting.status.in_(list(statuses)))
    total = db.execute(select(func.count()).select_from(stmt.subquery())).scalar_one()
    rows = db.execute(
        stmt.order_by(Meeting.created_at.desc(), Meeting.id).limit(limit).offset(offset)
    ).scalars().all()
    return list(rows), total


def get_participant_meeting(db: Session, meeting_id: str, org_id: str) -> Meeting:
    """단건 — 없으면 404, 있지만 내 org가 당사자가 아니면 403(bm/router의 소유권 패턴)."""
    meeting = db.get(Meeting, meeting_id)
    if meeting is None:
        raise MeetingNotFoundError("미팅을 찾을 수 없습니다")
    if str(org_id) not in {str(meeting.exhibitor_org_id), str(meeting.buyer_org_id)}:
        raise MeetingError("NOT_PARTICIPANT", "이 미팅의 참가 당사자가 아닙니다.", 403)
    return meeting


# =============================================================================
# 가용 슬롯 조회
# =============================================================================
_DRAFT_REASON_TEMPLATE = (
    "안녕하세요, {counterpart} 담당자님.\n\n"
    "저희는 귀사의 사업 분야에 큰 관심이 있어 미팅을 요청드립니다. "
    "귀사의 기술력과 협력 가능성을 자세히 알고 싶습니다.\n\n"
    "{event}에서 직접 뵙고 이야기 나눌 수 있기를 기대합니다."
)

_DRAFT_REASON_TEMPLATE_EN = (
    "Hello, {counterpart} representative.\n\n"
    "We are very interested in your business sector and would like to request a meeting. "
    "We would like to learn more about your technologies and potential collaboration opportunities.\n\n"
    "We hope to meet you in person and discuss this at {event}."
)

#: 장소 유형별 (제목, 설명). 부스 줄은 템플릿이다 — 제목에는 **부스 주인인 참가사** 기업명이
#: (``display_locale.booth_title``), 설명에는 실제 부스번호가 들어간다(상대 기업명을 두 번 쓰던 문구를
#: 대체 — 신청 방향이 반대여도 부스 주인은 언제나 참가사다). 조립은 ``_booth_presentation``.
_VENUE_PRESENTATION: dict[str, tuple[str, str]] = {
    "zone_table": ("비즈매칭존 테이블", "주최측 지정 비즈매칭존 테이블"),
    "business_room": ("비즈니스 룸", "프라이빗 회의실 · 사전 예약 필요"),
}

#: en 표기는 화면 용어집을 따른다(Booth / Matching zone / Business room, 문장형 대소문자).
_VENUE_PRESENTATION_EN: dict[str, tuple[str, str]] = {
    "zone_table": ("Matching zone table", "Organizer-assigned table in the matching zone"),
    "business_room": ("Business room", "Private meeting room · advance reservation required"),
}

#: 부스 줄의 설명 — 부스번호가 있을 때. en은 홀 이름까지 로케일로 옮긴 번호("Hall 7 A-12")가 들어온다.
_BOOTH_DESCRIPTION_WITH_NUMBER: dict[str, str] = {
    "ko": "참가기업 부스 {booth} 미팅",
    "en": "Meeting at the exhibitor's booth ({booth})",
}

#: 부스번호가 아직 배정되지 않았을 때의 설명 — 가짜 번호를 만들지 않고 문구만 바꾼다.
_BOOTH_DESCRIPTION_WITHOUT_NUMBER: dict[str, str] = {
    "ko": "참가기업 부스에서 미팅",
    "en": "Meeting at the exhibitor's booth",
}

_WEEKDAY_EN = ("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")


def _booth_presentation(
    db: Session, *, event_id: str, exhibitor_org_id: str, locale: str
) -> tuple[str, str]:
    """부스 줄의 (제목, 설명) — "{참가사} 부스" + 실제 부스번호.

    부스 주인은 신청 방향과 무관하게 참가사이므로 상대(counterpart)가 아니라 쌍의 참가사 org에서
    뽑는다(참가사 → 바이어 신청에서도 제목은 그 참가사 자기 부스다).
    """
    identity = _booth_identity(
        db, event_id=event_id, exhibitor_org_id=exhibitor_org_id, locale=locale
    )
    name = booth_title(identity.company_name, locale)
    number = identity.display_number
    if number is None:
        return name, _BOOTH_DESCRIPTION_WITHOUT_NUMBER[locale]
    return name, _BOOTH_DESCRIPTION_WITH_NUMBER[locale].format(booth=number)


def _get_venue_name(kind: str, locale: str) -> str:
    return (_VENUE_PRESENTATION_EN if locale == "en" else _VENUE_PRESENTATION)[kind][0]


def _get_venue_description(kind: str, locale: str) -> str:
    return (_VENUE_PRESENTATION_EN if locale == "en" else _VENUE_PRESENTATION)[kind][1]


def _get_badge_text(available_count: int, total: int, locale: str) -> str:
    # en 문구는 좁은 뱃지에 들어가야 한다 — "마감"은 그 시간에 자리가 다 찼다는 뜻이라 "Full",
    # "잔여 N석"은 "N left"로 줄인다(문장으로 풀면 375px 폭에서 장소 줄이 두 줄로 밀린다).
    if total == 0 or available_count == 0:
        return "Full" if locale == "en" else "마감"
    if total > 1 and available_count * 2 <= total:
        return f"{available_count} left" if locale == "en" else f"잔여 {available_count}석"
    return "Available" if locale == "en" else "가능"


def _unbookable_badge(locale: str) -> dict:
    """예약을 받지 않는 장소 유형의 뱃지 — 시간이 차서 "마감"인 것과 구분되는 정책 표시."""
    return {"text": "Unavailable" if locale == "en" else "불가능", "tone": "unavailable"}


def _bookable_venue_types(enabled: Sequence[str]) -> frozenset[str]:
    """지금 참가자가 **고를 수 있는** 장소 유형 = 운영 정책 ∩ 행사에서 켜진 유형.

    교집합이 비면 정책을 적용하지 않는다 — 부스 없이 매칭존만으로 운영하는 행사(행사별 재사용
    플랫폼이므로 실제로 생길 수 있다)에서 신청 자체가 불가능해지는 게 더 나쁜 결과다.

    운영자 배정(강제·⚡재보충·일괄배정 확정)의 장소 자동 결정도 이 함수를 그대로 쓴다
    (``app.matching.assignment_service._auto_venue_resolver``) — 두 경로의 장소 규칙이 갈라지지 않게.
    """
    policy = frozenset(settings.meeting_bookable_venue_types)
    usable = policy.intersection(enabled)
    return usable or frozenset(enabled)


def _badge(available_count: int, total: int, *, locale: str = "ko") -> dict:
    """장소 줄의 요약 뱃지 — 화면이 자리 수를 세지 않아도 되게 서버가 요약한다.

    ``total > 1`` 조건이 있는 건 자리가 하나뿐인 장소(부스) 때문이다 — 하나 남은 게 아니라
    원래 하나이므로 "잔여 1석"이 아니라 그냥 "가능"이다.
    """
    if total == 0 or available_count == 0:
        return {"text": _get_badge_text(available_count, total, locale), "tone": "unavailable"}
    if total > 1 and available_count * 2 <= total:
        return {"text": _get_badge_text(available_count, total, locale), "tone": "limited"}
    return {"text": _get_badge_text(available_count, total, locale), "tone": "available"}


def _localized_org_display_name(db: Session, org_id: str, locale: str) -> str:
    """영문 응답일 때만 영문 기업명을 우선한다. 한국어 기본 경로는 기존 helper를 그대로 쓴다."""
    if locale != "en":
        return notification_service.org_display_name(db, org_id)
    return localized_org_name(db.get(Organization, org_id), locale, fallback=org_id)


def _draft_reason(db: Session, ctx: PairContext, locale: str) -> str:
    counterpart_ko = notification_service.org_display_name(db, ctx.counterpart.org_id)
    if locale != "en":
        # 기존 문자열·이름 선택·format 순서를 보존해 locale 미지정 응답도 byte-identical하게 둔다.
        return _DRAFT_REASON_TEMPLATE.format(counterpart=counterpart_ko, event=ctx.event.name)

    counterpart_en = _localized_org_display_name(db, ctx.counterpart.org_id, locale)[:200]
    event_ko = ctx.event.name[:200]
    event_en = (ctx.event.name_en or ctx.event.name)[:200]
    korean = _DRAFT_REASON_TEMPLATE.format(
        counterpart=counterpart_ko[:200], event=event_ko
    )
    english = _DRAFT_REASON_TEMPLATE_EN.format(counterpart=counterpart_en, event=event_en)
    return f"{korean}\n\n---\n\n{english}"


def build_availability(
    db: Session,
    *,
    principal: Principal,
    counterpart_org_id: str,
    event_id: str | None,
    slot_ids: Sequence[str] | None = None,
    my_role: str | None = None,
    locale: str | None = None,
    now: datetime | None = None,
) -> dict:
    """신청 모달이 필요로 하는 날짜·슬롯·장소·초안·수락모드를 한 번에 만든다.

    슬롯 ``available`` 판정은 네 가지가 모두 참일 때다:

    1. 참가사가 불가로 표시하지 않았다(``unavailable_meeting_slots``, 읽기 전용)
    2. **양쪽 org 모두** 그 시간에 확정 미팅이 없다(``slot_booking`` 술어 재사용 — 쓰기 가드와 동일)
    3. 운영 종료 시각 안에서 끝난다(그리드 생성 단계에서 이미 보장)
    4. 행사 타임존 기준 미래다

    ``slot_ids``가 주어지면 장소 목록의 ``available``을 그 시간 기준으로 계산한다(시간 먼저 고르고
    장소를 고르는 화면 흐름).
    """
    # 모르는 값·None은 기존 한국어 응답으로 수렴한다(app.display_locale.normalize_locale).
    locale = normalize_locale(locale)
    ctx = resolve_pair(
        db,
        principal=principal,
        counterpart_org_id=counterpart_org_id,
        event_id=event_id,
        my_role=my_role,
    )
    event_id_str = str(ctx.event.id)
    current = event_now(ctx.event, now)
    grid = build_grid(ctx.policy)

    blocked = exhibitor_unavailable_slots(
        db, event_id=event_id_str, exhibitor_org_id=ctx.exhibitor_org_id
    )
    org_ids = [ctx.exhibitor_org_id, ctx.buyer_org_id]

    all_slots: list[Slot] = [slot for day in grid for slot in day.slots]
    busy: list[tuple[datetime, datetime]] = []
    if all_slots:
        busy = slot_booking.accepted_busy_slot_starts(
            db,
            event_id=event_id_str,
            org_ids=org_ids,
            start=min(slot.start for slot in all_slots),
            end=max(slot.end for slot in all_slots),
        )

    def _available(slot: Slot) -> bool:
        if slot.id in blocked:
            return False
        if slot.start <= current:
            return False
        return not any(slot_booking.overlaps(slot.start, slot.end, b0, b1) for b0, b1 in busy)

    dates = [
        {
            "id": day.id,
            "label": day.label,
            "weekday": _WEEKDAY_EN[date.fromisoformat(day.id).weekday()]
            if locale == "en"
            else day.weekday,
            "morning": [
                {"id": s.id, "time": s.time, "available": _available(s)} for s in day.morning
            ],
            "afternoon": [
                {"id": s.id, "time": s.time, "available": _available(s)} for s in day.afternoon
            ],
        }
        for day in grid
    ]

    # 장소 목록 — 요청 시간이 주어지면 그 구간 기준으로 점유를 반영한다.
    window: tuple[datetime, datetime] | None = None
    if slot_ids:
        try:
            run = validate_slot_run(ctx.policy, slot_ids, now=current)
            window = (run.start, run.end)
        except SlotError:
            # 잘못된 시간 조합이면 장소 필터를 적용할 근거가 없다 — 전체 목록을 그대로 낸다
            # (신청 시점에 SLOT_INVALID로 정확히 거부되므로 여기서 422를 낼 이유가 없다).
            window = None

    venues = _venue_options(db, ctx, window, locale=locale)
    entry = resolve_entry_state(
        _recipient_type(ctx.counterpart, ctx.counterpart_role), OPEN_CHANNEL
    )
    return {
        "dates": dates,
        "venues": venues,
        "draft_reason": _draft_reason(db, ctx, locale),
        "acceptance_mode": "immediate" if entry is EntryState.ACCEPTED else "pending",
        "slot_minutes": ctx.policy.slot_minutes,
        # 격자 모양의 나머지 두 축 — 프런트가 종료 시각·소요시간 라벨·연속 상한을 스스로 계산한다
        # (TimeSlotOut 은 시작 시각만 싣는다). policy 에서 읽으므로 진실원천은 여전히 DB 설정이다.
        "slot_gap_minutes": ctx.policy.gap_minutes,
        "max_meeting_minutes": ctx.policy.max_meeting_minutes,
        "timezone": ctx.event.timezone,
    }


def _venue_options(
    db: Session,
    ctx: PairContext,
    window: tuple[datetime, datetime] | None,
    *,
    locale: str = "ko",
) -> list[dict]:
    """행사에서 켜진 장소 유형만, 캐노니컬 어휘(booth/zone_table/business_room)로 낸다.

    ``selectable``은 "지금 이 장소로 신청할 수 있는가"(운영 정책, ``_bookable_venue_types``)다 —
    예약을 받지 않는 유형은 목록에서 지우지 않고 선택 불가로 내려보낸다(참가자가 "여긴 원래 없다"와
    "지금은 안 받는다"를 구분할 수 있게). 자리 가용(``numbers``)은 정책과 무관하게 그대로 계산한다 —
    정책이 열리는 순간 화면이 다시 정확해야 하고, 운영자 화면도 같은 계산을 본다.
    """
    event_id = str(ctx.event.id)
    enabled = list(ctx.event.enabled_venue_types or [])
    bookable = _bookable_venue_types(enabled)
    options: list[dict] = []

    for kind in ("booth", "zone_table", "business_room"):
        if kind not in enabled:
            continue
        selectable = kind in bookable
        if kind == "booth":
            name, description = _booth_presentation(
                db, event_id=event_id, exhibitor_org_id=ctx.exhibitor_org_id, locale=locale
            )
            # 점유 조회는 **저장 라벨**로 한다 — 화면 문구(locale 반영)와 달리 이 키는 항상 한국어
            # 규칙이어야 meeting_venues의 그 행을 찾는다(en 응답에서 라벨이 갈라지면 점유를 놓친다).
            label = _booth_label(db, event_id=event_id, exhibitor_org_id=ctx.exhibitor_org_id)
            available = True
            if window is not None:
                existing = db.execute(
                    select(MeetingVenue.id).where(
                        MeetingVenue.event_id == event_id,
                        MeetingVenue.venue_type == "booth",
                        MeetingVenue.label == label,
                    )
                ).scalar_one_or_none()
                if existing is not None:
                    available = not slot_booking.has_venue_overlap(
                        db, venue_id=str(existing), start=window[0], end=window[1]
                    )
            badge = _badge(1 if available else 0, 1, locale=locale)
            numbers = None
        else:
            name = _get_venue_name(kind, locale)
            description = _get_venue_description(kind, locale)
            rows = list_provisioned_venues(db, event_id=event_id, venue_type=kind)
            busy: set[str] = set()
            if window is not None and rows:
                busy = slot_booking.busy_venue_ids(
                    db, venue_ids=[str(r.id) for r in rows], start=window[0], end=window[1]
                )
            numbers = [
                {"value": row.label, "available": str(row.id) not in busy} for row in rows
            ]
            free = sum(1 for n in numbers if n["available"])
            badge = _badge(free, len(numbers), locale=locale)

        options.append(
            {
                "kind": kind,
                "name": name,
                "description": description,
                "badge": badge if selectable else _unbookable_badge(locale),
                "numbers": numbers,
                "selectable": selectable,
            }
        )
    return options


# =============================================================================
# 신청 생성
# =============================================================================
def create_meeting(
    db: Session,
    *,
    principal: Principal,
    counterpart_org_id: str,
    slot_ids: Sequence[str],
    venue_type: str,
    venue_label: str | None = None,
    event_id: str | None = None,
    my_role: str | None = None,
    request_reason: str | None = None,
    now: datetime | None = None,
    channels=None,
) -> Meeting:
    """미팅 신청 — 검증 → [임계구역] → INSERT → commit → 알림.

    임계구역 앞의 검사(권한·가시성·기간·형식)는 다른 트랜잭션이 바꿀 수 없는 사실이라 락 밖에서
    끝낸다. 락 안에서는 "그 사이에 바뀔 수 있는 것"만 본다.

    임계구역 자체(락 → 겹침 재검증 → (쌍,시각) 중복 → 장소 → INSERT)는 ``app.matching.meeting_booking.
    book_meeting``이 소유한다 — 강제/포화배정도 앞으로 같은 프리미티브를 호출한다(F-OP-005).
    이 함수는 OPEN 채널 고유의 것만 쥔다: 참가사 미팅-불가 슬롯 존중(``check_after_overlap``
    훅으로 주입) 그리고 상태 결정(``resolve_entry_state``)·알림 발화.
    """
    ctx = resolve_pair(
        db,
        principal=principal,
        counterpart_org_id=counterpart_org_id,
        event_id=event_id,
        my_role=my_role,
    )
    event_id_str = str(ctx.event.id)
    current = event_now(ctx.event, now)

    _assert_application_window(ctx.event, current)

    if venue_type not in (ctx.event.enabled_venue_types or []):
        raise MeetingError(
            "VENUE_TYPE_DISABLED", f"이 행사에서는 {venue_type} 장소를 사용할 수 없습니다.", 422
        )

    try:
        run = validate_slot_run(ctx.policy, slot_ids, now=current)
    except SlotError as exc:
        raise MeetingError("SLOT_INVALID", str(exc), 422)

    # resolve_entry_state는 순수 함수(DB·시간 무관)라 락 밖에서 계산해도 값이 같다 — 결과는
    # book_meeting에 entry_state로 넘기고, 알림 분기(_emit_creation_notifications)에도 재사용한다.
    entry = resolve_entry_state(
        _recipient_type(ctx.counterpart, ctx.counterpart_role), OPEN_CHANNEL
    )

    def _reject_if_exhibitor_marked_unavailable() -> None:
        """OPEN 전용 정책 — 참가사가 미팅-불가로 표시해둔 슬롯은 신청 자체를 막는다.

        book_meeting의 겹침 재검증 직후, (쌍,시각) 중복 검사 전에 호출된다(원래 create_meeting의 그 위치
        그대로) — 강제/포화배정은 이 훅을 넘기지 않는 방식으로 이 정책을 적용하지 않을 수 있다
        (§F-OP-005 설계 미결정 사항, Phase 2에서 결정).
        """
        blocked = exhibitor_unavailable_slots(
            db, event_id=event_id_str, exhibitor_org_id=ctx.exhibitor_org_id
        )
        if blocked & set(run.slot_ids):
            raise MeetingError("SLOT_TAKEN", "참가사가 해당 시간을 미팅 불가로 설정했습니다.", 409)

    meeting = book_meeting(
        db,
        event_id=event_id_str,
        exhibitor_org_id=ctx.exhibitor_org_id,
        buyer_org_id=ctx.buyer_org_id,
        start=run.start,
        end=run.end,
        resolve_venue=lambda: _resolve_venue(
            db, ctx, venue_type=venue_type, run=run, venue_label=venue_label
        ),
        entry_state=entry,
        matching_type=MATCHING_TYPE_OPEN,
        requested_by=ctx.my_role,
        # 수락대기면 상대가 공을 쥔다. 즉시 확정이면 응답을 기다릴 주체가 없다.
        awaiting_org_id=ctx.counterpart.org_id if entry is EntryState.PROPOSED else None,
        request_reason=request_reason,
        check_after_overlap=_reject_if_exhibitor_marked_unavailable,
    )
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise integrity_to_meeting_error(exc)
    db.refresh(meeting)

    _emit_creation_notifications(db, meeting, ctx, entry, channels=channels)
    return meeting


# =============================================================================
# 알림 발화 (전부 커밋 이후)
# =============================================================================
def _emit_creation_notifications(
    db: Session, meeting: Meeting, ctx: PairContext, entry: EntryState, *, channels=None
) -> None:
    """생성 알림 — 수락대기면 수신측에 '신청받음', 즉시 확정이면 **양쪽 각 1회** '확정'."""
    my_name = notification_service.org_display_name(db, ctx.me.org_id)
    counterpart_name = notification_service.org_display_name(db, ctx.counterpart.org_id)
    if entry is EntryState.PROPOSED:
        notification_service.notify_after_commit(
            db,
            lambda: notification_service.notify_meeting_requested(
                db,
                event_id=str(meeting.event_id),
                meeting_id=str(meeting.id),
                recipient_org_id=ctx.counterpart.org_id,
                counterpart_org_name=my_name,
                requested_by_role=ctx.my_role,
                channels=channels,
            ),
            description=f"meeting_requested (meeting_id={meeting.id})",
        )
        return

    # 즉시 확정(초청 바이어 수신 등) — 양쪽 다 "확정됐다"를 받아야 한다. counterpart_org_name이
    # 서로 다르므로 한 번의 호출로 두 org를 덮을 수 없다.
    venue_label = notification_service.venue_label(db, meeting.venue_id)
    for recipient_org_id, other_name in (
        (ctx.me.org_id, counterpart_name),
        (ctx.counterpart.org_id, my_name),
    ):
        notification_service.notify_after_commit(
            db,
            lambda org=recipient_org_id, name=other_name: notification_service.notify_meeting_accepted(
                db,
                event_id=str(meeting.event_id),
                meeting_id=str(meeting.id),
                recipient_org_id=org,
                counterpart_org_name=name,
                scheduled_start=meeting.scheduled_start,
                venue_label=venue_label,
                channels=channels,
            ),
            description=f"meeting_accepted (meeting_id={meeting.id}, org={recipient_org_id})",
        )


# =============================================================================
# 수락 / 거절 / 취소
# =============================================================================
def _role_of(meeting: Meeting, org_id: str) -> str:
    return "exhibitor" if str(meeting.exhibitor_org_id) == str(org_id) else "buyer"


def _require_awaiting(meeting: Meeting, org_id: str) -> None:
    if str(meeting.awaiting_org_id or "") != str(org_id):
        raise MeetingError(
            "NOT_AWAITING_PARTY", "이 미팅에 응답할 수 있는 당사자가 아닙니다.", 403
        )


def _assert_cancel_allowed(meeting: Meeting, org_id: str) -> None:
    """cancel_meeting의 전이+권한 검사 — 락 앞뒤로 같은 검사를 두 번 돌리므로 헬퍼로 뺀다."""
    _assert_transition(meeting, "cancelled")
    if meeting.status == "proposed":
        requester_org_id = _requested_by_org_id(meeting)
        if requester_org_id is None or str(requester_org_id) != org_id:
            raise MeetingError(
                "NOT_CANCELLABLE_PARTY",
                "수락 대기 중인 미팅은 신청한 쪽만 취소할 수 있습니다(수신측은 거절을 사용하세요).",
                403,
            )


def accept_meeting(
    db: Session,
    *,
    principal: Principal,
    meeting_id: str,
    attendee_member_ids: Sequence[str] | None = None,
    channels=None,
) -> Meeting:
    """수락 — 수신측만, proposed에서만. **락을 다시 잡고 점유를 재검증**한다.

    proposed는 슬롯을 점유하지 않으므로, 신청 이후 수락 사이에 같은 시간이 다른 미팅으로
    확정됐을 수 있다(정상 흐름 — 첫 수락이 이긴다). 그래서 수락 시점이 곧 점유 시점이고,
    여기서 다시 검사하지 않으면 DB EXCLUDE가 500으로 터진다. 충돌하면 미팅은 proposed로 남는다
    — 사용자가 시간을 바꿔 다시 시도할 수 있어야 하므로 상태를 내리지 않는다.
    """
    org_id = str(principal.organization_id)
    meeting = get_participant_meeting(db, meeting_id, org_id)
    _assert_transition(meeting, "accepted")
    _require_awaiting(meeting, org_id)

    slot_booking.meeting_write_lock(
        db,
        event_id=str(meeting.event_id),
        org_ids=(str(meeting.exhibitor_org_id), str(meeting.buyer_org_id)),
    )
    if meeting.venue_id:
        slot_booking.meeting_write_lock(
            db, event_id=str(meeting.event_id), venue_id=str(meeting.venue_id)
        )

    # 위 두 검사는 advisory lock을 잡기 **전** 값으로 했다 — 그 사이 다른 트랜잭션이 이 행을
    # reject/cancel 해서 커밋했을 수 있다(둘 다 락을 안 거치므로 advisory lock으로는 못 막는다).
    # 행을 FOR UPDATE로 재로드해 락 안에서 상태 전이·권한을 다시 검증한다 — 안 그러면 stale
    # proposed 값을 들고 그대로 accepted로 덮어써 불법 전이(rejected→accepted)가 커밋된다.
    db.refresh(meeting, with_for_update=True)
    _assert_transition(meeting, "accepted")
    _require_awaiting(meeting, org_id)

    if slot_booking.has_accepted_overlap(
        db,
        event_id=str(meeting.event_id),
        org_ids=[str(meeting.exhibitor_org_id), str(meeting.buyer_org_id)],
        start=meeting.scheduled_start,
        end=meeting.scheduled_end,
        exclude_meeting_id=str(meeting.id),
    ):
        raise MeetingError(
            "SLOT_TAKEN", "그 사이 해당 시간에 다른 미팅이 확정되었습니다.", 409
        )
    if meeting.venue_id and slot_booking.has_venue_overlap(
        db,
        venue_id=str(meeting.venue_id),
        start=meeting.scheduled_start,
        end=meeting.scheduled_end,
        exclude_meeting_id=str(meeting.id),
    ):
        raise MeetingError("VENUE_TAKEN", "그 사이 해당 장소가 사용 중이 되었습니다.", 409)

    meeting.status = "accepted"
    meeting.awaiting_org_id = None
    meeting.updated_at = datetime.now(tz=_tz_of(meeting))
    if attendee_member_ids is not None:
        _replace_participants(db, meeting, org_id, attendee_member_ids)
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise integrity_to_meeting_error(exc)
    db.refresh(meeting)

    # 수락 알림은 **신청측**에게. 수락한 쪽은 자기 행동을 다시 통지받을 필요가 없다.
    requester_org_id = _requested_by_org_id(meeting)
    if requester_org_id:
        notification_service.notify_after_commit(
            db,
            lambda: notification_service.notify_meeting_accepted(
                db,
                event_id=str(meeting.event_id),
                meeting_id=str(meeting.id),
                recipient_org_id=requester_org_id,
                counterpart_org_name=notification_service.org_display_name(db, org_id),
                scheduled_start=meeting.scheduled_start,
                venue_label=notification_service.venue_label(db, meeting.venue_id),
                channels=channels,
            ),
            description=f"meeting_accepted (meeting_id={meeting.id})",
        )
    return meeting


def reject_meeting(
    db: Session,
    *,
    principal: Principal,
    meeting_id: str,
    reason_code: str,
    reason_text: str | None = None,
    channels=None,
) -> Meeting:
    """거절 — 수신측만, proposed에서만.

    거절 통지는 **신청한 쪽**(요청자 org)에게 간다. 거절 사유는 payload에 담지 않는다(GitHub #4
    권고 — 사유를 그대로 노출하면 거절하는 쪽이 부담을 느껴 사유 선택을 회피할 수 있어, 1차에는
    상대 기업명·제안했던 시간만 전달하고 "다른 시간으로 다시 신청해 보세요" 수준으로 안내한다).
    """
    org_id = str(principal.organization_id)
    meeting = get_participant_meeting(db, meeting_id, org_id)
    _assert_transition(meeting, "rejected")
    _require_awaiting(meeting, org_id)
    _require_reason_text(reason_code, reason_text)

    # 거절/취소는 advisory lock을 안 거치므로(accept와 달리 겹침 술어가 필요 없다), 행 자체를
    # FOR UPDATE로 잠가 재검증한다 — 그 사이 다른 트랜잭션이 같은 행을 accept/reject/cancel
    # 했다면 여기서 잡아야 감사 컬럼이 섞이는 걸 막는다.
    db.refresh(meeting, with_for_update=True)
    _assert_transition(meeting, "rejected")
    _require_awaiting(meeting, org_id)

    now = datetime.now(tz=_tz_of(meeting))
    scheduled_start = meeting.scheduled_start
    event_id = str(meeting.event_id)
    meeting.status = "rejected"
    meeting.awaiting_org_id = None
    meeting.rejected_at = now
    meeting.rejected_by_org_id = org_id
    meeting.rejected_reason_code = reason_code
    meeting.rejected_reason_text = reason_text
    meeting.updated_at = now
    db.commit()
    db.refresh(meeting)

    # proposed는 신청측만 만들 수 있으므로(organizer 생성분은 애초에 proposed로 대기하지 않는다),
    # requester_org_id가 없으면(organizer 생성 등 이례 상황) 통지를 보낼 대상이 없어 조용히 스킵.
    requester_org_id = _requested_by_org_id(meeting)
    if requester_org_id:
        notification_service.notify_after_commit(
            db,
            lambda: notification_service.notify_meeting_rejected(
                db,
                event_id=event_id,
                meeting_id=str(meeting.id),
                recipient_org_id=requester_org_id,
                counterpart_org_name=notification_service.org_display_name(db, org_id),
                scheduled_start=scheduled_start,
                channels=channels,
            ),
            description=f"meeting_rejected (meeting_id={meeting.id})",
        )
    return meeting


def cancel_meeting(
    db: Session,
    *,
    principal: Principal,
    meeting_id: str,
    reason_code: str,
    reason_text: str | None = None,
    channels=None,
) -> Meeting:
    """취소 — proposed면 **신청측만**, accepted면 양측 누구나.

    proposed에서 수신측이 취소를 쓰면 "거절"과 같은 일을 다른 이름으로 하게 된다(사유 어휘도
    다르고 감사 컬럼도 다르다). 그래서 수신측은 reject로 보낸다(403).
    """
    org_id = str(principal.organization_id)
    meeting = get_participant_meeting(db, meeting_id, org_id)
    _assert_cancel_allowed(meeting, org_id)
    _require_reason_text(reason_code, reason_text)

    # reject_meeting과 같은 이유로 행 자체를 FOR UPDATE로 잠가 재검증한다 — 그 사이 다른
    # 트랜잭션이 같은 행을 accept/reject/cancel 했을 수 있다(동시 reject+cancel이면 감사
    # 컬럼이 섞인다).
    db.refresh(meeting, with_for_update=True)
    _assert_cancel_allowed(meeting, org_id)

    actor_role = _role_of(meeting, org_id)
    counterpart_org_id = (
        str(meeting.buyer_org_id) if actor_role == "exhibitor" else str(meeting.exhibitor_org_id)
    )
    now = datetime.now(tz=_tz_of(meeting))
    scheduled_start = meeting.scheduled_start
    event_id = str(meeting.event_id)

    meeting.status = "cancelled"
    meeting.awaiting_org_id = None
    meeting.cancelled_at = now
    meeting.cancelled_by = actor_role
    meeting.cancelled_by_org_id = org_id
    meeting.cancelled_reason_code = reason_code
    meeting.cancelled_reason_text = reason_text
    meeting.updated_at = now
    db.commit()
    db.refresh(meeting)

    notification_service.notify_after_commit(
        db,
        lambda: notification_service.notify_meeting_cancelled(
            db,
            event_id=event_id,
            meeting_id=str(meeting.id),
            recipient_org_id=counterpart_org_id,
            counterpart_org_name=notification_service.org_display_name(db, org_id),
            cancelled_by_role=actor_role,
            scheduled_start=scheduled_start,
            channels=channels,
        ),
        description=f"meeting_cancelled (meeting_id={meeting.id})",
    )
    return meeting


def _tz_of(meeting: Meeting):
    from datetime import timezone as _timezone

    if meeting.scheduled_start is not None and meeting.scheduled_start.tzinfo is not None:
        return meeting.scheduled_start.tzinfo
    return _timezone.utc


def _assert_transition(meeting: Meeting, target: str) -> None:
    try:
        assert_transition(meeting.status, target)
    except IllegalTransitionError as exc:
        raise MeetingError("INVALID_TRANSITION", str(exc), 409)


def _require_reason_text(reason_code: str, reason_text: str | None) -> None:
    """'other'는 코드가 아무것도 설명하지 않는다 — 자유서술이 없으면 사유가 비어 있는 셈."""
    if reason_code == "other" and not (reason_text or "").strip():
        raise MeetingError(
            "REASON_REQUIRED", "기타 사유를 선택한 경우 사유를 직접 입력해야 합니다.", 422
        )


# =============================================================================
# 참석자
# =============================================================================
def _replace_participants(
    db: Session, meeting: Meeting, org_id: str, member_ids: Iterable[str]
) -> None:
    """내 org 참석자 명단을 주어진 목록으로 치환(다른 org의 참석자 행은 건드리지 않는다)."""
    wanted = [str(m) for m in member_ids]
    if wanted:
        owned = set(
            str(m)
            for m in db.execute(
                select(Member.id).where(Member.id.in_(wanted), Member.organization_id == org_id)
            ).scalars().all()
        )
        missing = [m for m in wanted if m not in owned]
        if missing:
            # NOT_PARTICIPANT(403)와 구분되는 코드를 쓴다 — 그건 "이 미팅의 당사자가 아니다"라는
            # 권한 거부고, 이건 "보낸 member가 내 org 소속이 아니다"라는 입력 검증이다. 같은 코드에
            # 두 상태를 실으면 화면이 코드만 보고 분기할 수 없다.
            raise MeetingError(
                "MEMBER_NOT_IN_ORG",
                f"본인 소속 기업의 담당자만 참석자로 지정할 수 있습니다: {', '.join(missing)}",
                422,
            )

    my_member_ids = set(
        str(m)
        for m in db.execute(
            select(Member.id).where(Member.organization_id == org_id)
        ).scalars().all()
    )
    existing = db.execute(
        select(MeetingParticipant).where(MeetingParticipant.meeting_id == meeting.id)
    ).scalars().all()
    for row in existing:
        if str(row.member_id) in my_member_ids and str(row.member_id) not in wanted:
            db.delete(row)
    already = {str(row.member_id) for row in existing}
    for member_id in wanted:
        if member_id not in already:
            db.add(MeetingParticipant(meeting_id=meeting.id, member_id=member_id))
    db.flush()


def set_participants(
    db: Session, *, principal: Principal, meeting_id: str, member_ids: Sequence[str]
) -> Meeting:
    """참석자 지정 — 당사자만, 본인 org 소속 member만."""
    org_id = str(principal.organization_id)
    meeting = get_participant_meeting(db, meeting_id, org_id)
    _replace_participants(db, meeting, org_id, member_ids)
    meeting.updated_at = datetime.now(tz=_tz_of(meeting))
    db.commit()
    db.refresh(meeting)
    return meeting


def list_participant_member_ids(db: Session, meeting_id: str) -> list[str]:
    return [
        str(m)
        for m in db.execute(
            select(MeetingParticipant.member_id).where(
                MeetingParticipant.meeting_id == meeting_id
            )
        ).scalars().all()
    ]


__all__ = [
    "MeetingError",
    "MeetingNotFoundError",
    "MeetingView",
    "PairContext",
    "accept_meeting",
    "build_availability",
    "build_views",
    "cancel_meeting",
    "create_meeting",
    "event_now",
    "exhibitor_unavailable_slots",
    "get_participant_meeting",
    "list_meetings",
    "list_participant_member_ids",
    "reject_meeting",
    "resolve_event_id",
    "resolve_pair",
    "schedule_policy",
    "serialize",
    "set_participants",
    "view_to_dict",
]
