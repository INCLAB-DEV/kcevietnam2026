"""meeting-booking — 미팅 "예약"(슬롯 점유 INSERT) 임계구역의 단일 공용 프리미티브 (F-MT-001, F-OP-005).

``app.meetings.service.create_meeting``(참가자 직접 신청, OPEN 채널)의 임계구역을 그대로 뽑아낸
것이다 — 락 획득 → 겹침 재검증 → (쌍,시각) 중복 신청 검사 → 장소 확정 → INSERT → IntegrityError
환산, 순서 그대로. :mod:`app.matching.slot_booking`의 계약 docstring이 예고한 지점이 여기다: "강제배정·
AI 포화배정·현장생성 어느 경로든 meeting_write_lock을 잡고 이 술어들을 통과해야 한다."

(#11, 2026-09-15) 예전에는 여기서 D9(같은 쌍의 활성 미팅 유일성)를 검사해 같은 두 기업이 미팅을
하나만 가질 수 있었다. 발주자 결정으로 그 제한은 풀렸다 — 같은 두 기업도 서로 다른 시각이면 여러
번 미팅할 수 있다. 대신 사용자 실수(같은 상대에게 같은 시각으로 중복 신청) 방지를 위해
(쌍, 시각) 단위 중복만 :func:`find_duplicate_proposed`로 막는다.

**책임 경계** — 이 모듈이 담당하는 건 딱 "예약"(슬롯 점유 INSERT)까지다:

- 신원·권한·가시성·신청기간·슬롯 형식 검증(다른 트랜잭션과 무관한 "front-matter")은 호출부 소유.
- 상태 결정 규칙(``resolve_entry_state``)은 호출부가 미리 계산해 ``entry_state``로 넘긴다 — 순수
  함수라 락 안팎 어디서 계산하든 값이 같으므로 락 밖에서 계산해도 무방하다.
- 알림 발화·commit은 호출부 소유(알림 실패가 이미 커밋된 예약을 되감으면 안 되므로 — 상태 전이는
  커밋 후 ``notify_after_commit``으로 감싼다는 원칙은 ``app.meetings.service`` 모듈 docstring 참고).
- 장소 확정은 호출부가 넘기는 ``resolve_venue`` 콜백이 담당한다. venue 종류(부스/존/룸)마다 후보
  선정 규칙이 다르고(``app.meetings.service._resolve_venue``), 그 로직 자체는 이 프리미티브의
  관심사가 아니다 — 다만 **호출 시점**((쌍,시각) 중복 검사 통과 직후, INSERT 직전)은 이
  프리미티브가 고정한다. 콜백 내부에서 장소별 advisory lock을 추가로 잡는 것도 호출부 책임(락 키
  접두사 정렬로 전역 획득 순서는 이미 보장된다 — ``slot_booking`` 모듈 docstring 참고).
- ``check_after_overlap``은 참가자 OPEN 경로 전용 정책(참가사 미팅-불가 슬롯 존중)처럼 경로마다
  다를 수 있는 검사를 위한 훅이다 — ``has_accepted_overlap`` 통과 직후, (쌍,시각) 중복 검사 전에
  호출된다. 운영자 강제/포화배정처럼 이 정책을 다르게(또는 아예 건너뛰고) 적용하려는 호출부는 이
  훅을 생략하거나 다른 검사로 교체하면 된다. 이 프리미티브 자체는 그 정책이 무엇인지 모른다.

**동시성 불변식(변경 금지)**: advisory lock은 org id를 정렬한 순서로 잡는다(``slot_booking``이
보장) — 두 트랜잭션이 같은 두 org를 반대 순서로 잡는 데드락을 구조적으로 없앤다. 임계구역 안의
검사 순서(겹침 → 훅 → (쌍,시각) 중복 → 장소 → INSERT)를 바꾸면 동시 요청 두 개가 충돌할 때 어느
쪽이 어떤 오류 코드를 받는지가 달라진다 — 순서 자체가 계약의 일부다.
"""

from __future__ import annotations

from datetime import datetime
from typing import Callable

from sqlalchemy import and_, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.matching import slot_booking
from app.matching.acceptance_rule import (
    Channel,
    EntryState,
    ForcedConfirmationError,
    RecipientType,
    recipient_type_from_buyer_subtype,
    validate_requested_state,
)
from app.models import Meeting, MeetingVenue, OrganizationEventRole


class MeetingError(Exception):
    """미팅 도메인 거부 — 라우터가 ``{"code", "message"}`` 바디로 환산한다.

    HTTP 상태를 예외가 들고 있는 건 의도적이다. "왜 거부됐는가"(code)와 "어떤 종류의 거부인가"
    (status)는 같은 판단에서 나오는데, 이걸 라우터의 별도 매핑표로 떼어놓으면 새 코드를 추가할
    때마다 두 곳을 고쳐야 하고 한쪽을 잊으면 500이 된다.

    (``app.meetings.service``에서 이 모듈로 이동 — book_meeting이 던지는 예외라 정의도 여기 있어야
    순환 임포트가 안 생긴다. ``app.meetings.service``는 이 클래스를 재노출해서 기존 호출부
    ``service.MeetingError``가 그대로 동작한다.)
    """

    def __init__(self, code: str, message: str, status_code: int, **extra: object) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code
        self.extra = extra

    def to_detail(self) -> dict:
        return {"code": self.code, "message": self.message, **self.extra}


def find_duplicate_proposed(
    db: Session,
    event_id: str,
    exhibitor_org_id: str,
    buyer_org_id: str,
    start: datetime,
) -> str | None:
    """(쌍, 시각) 중복 — 이 쌍에 정확히 같은 시작 시각으로 이미 ``proposed``된 신청이 있는가.

    #11로 D9(쌍 단위 유일성)는 풀렸지만, 같은 상대에게 같은 시각으로 실수로 두 번 신청하는 건
    여전히 막는 게 사용자에게 이득이다. **양방향**으로 본다 — 역할이 뒤집힌 쌍(내가 참가사로
    신청했는데 상대가 나에게 바이어로 신청해둔 경우)도 같은 두 기업 사이의 신청이다.

    ``accepted``는 대상이 아니다 — 그 경우엔 이미 ``has_accepted_overlap``이 두 org 중 하나라도
    그 시간대에 확정 미팅이 있으면 SLOT_TAKEN으로 앞서 막는다(이 함수가 불리는 시점엔 이미 통과한
    뒤라 accepted 겹침은 없다고 봐도 된다). DB 제약이 아니라 애플리케이션 검사로 두는 이유는
    advisory lock(정렬된 org id 쌍) 안에서 실행돼 레이스가 없고, exhibitor_org_id/buyer_org_id가
    역할에 따라 미팅마다 뒤바뀔 수 있어 대칭적인 부분 unique 인덱스로 표현하기 애매하기 때문이다.
    """
    return db.execute(
        select(Meeting.id).where(
            Meeting.event_id == event_id,
            Meeting.status == "proposed",
            Meeting.scheduled_start == start,
            or_(
                and_(
                    Meeting.exhibitor_org_id == exhibitor_org_id,
                    Meeting.buyer_org_id == buyer_org_id,
                ),
                and_(
                    Meeting.exhibitor_org_id == buyer_org_id,
                    Meeting.buyer_org_id == exhibitor_org_id,
                ),
            ),
        ).limit(1)
    ).scalar_one_or_none()


def integrity_to_meeting_error(exc: IntegrityError) -> MeetingError:
    """DB 최후 방어선(EXCLUDE) 위반을 의미 있는 409로 환산한다.

    앞단 술어가 잡았어야 하지만 락 획득과 커밋 사이의 극단적 레이스에서는 DB가 먼저 잡는다 —
    사용자에게 500이 아니라 "이미 찼습니다"로 보여야 한다.
    """
    detail = str(getattr(exc, "orig", exc))
    if "meetings_venue_slot_excl" in detail:
        return MeetingError("VENUE_TAKEN", "해당 시간에 장소가 이미 사용 중입니다.", 409)
    if "meetings_exhibitor_slot_excl" in detail or "meetings_buyer_slot_excl" in detail:
        return MeetingError("SLOT_TAKEN", "해당 시간에 이미 확정된 미팅이 있습니다.", 409)
    raise exc


# matching_type(스키마 CHECK 허용값) → Channel. 'ai'는 전체 포화배정·단일 재트리거가 공유하는
# 값이라(스키마 주석 참고) AI_SATURATION으로 근사한다 — 이 모호함은 스키마 설계상 기존에 이미
# 있던 것이고 F1의 범위가 아니다(오늘 이 프리미티브를 부르는 'ai' 호출부는 포화배정뿐).
_MATCHING_TYPE_TO_CHANNEL: dict[str, Channel] = {
    "open": Channel.OPEN,
    "forced": Channel.FORCED,
    "ai": Channel.AI_SATURATION,
    "on_site": Channel.ON_SITE,
}


def _resolve_meeting_recipient_type(
    db: Session,
    *,
    event_id: str,
    exhibitor_org_id: str,
    buyer_org_id: str,
    requested_by: str | None,
) -> RecipientType:
    """entry_state 검증 대상 "받는 쪽" 유형 — ``requested_by``로 어느 org가 수신측인지 정한다.

    OPEN 채널에서 바이어가 신청(``requested_by == "buyer"``)하면 참가사가 수신측이라
    :class:`RecipientType.EXHIBITOR`. 그 외(참가사 신청·운영자 강제/포화배정)는 전부 바이어가
    수신측이다 — 강제/포화배정은 참가사 측 동의를 아예 요구하지 않는 설계라(``assignment_service``
    모듈 docstring "바이어만 응답을 쥔다") 그 경로들도 바이어 유형만 보면 된다. 현재 이 프리미티브의
    3개 호출부(create_meeting·create_forced_meeting·confirm_saturation_run) 전부 이 규칙과 정확히
    같은 축으로 recipient를 고른다.
    """
    if requested_by == "buyer":
        return RecipientType.EXHIBITOR

    role = db.execute(
        select(OrganizationEventRole).where(
            OrganizationEventRole.event_id == event_id,
            OrganizationEventRole.organization_id == buyer_org_id,
        )
    ).scalar_one_or_none()
    if role is None or not role.buyer_subtype:
        # 바이어 세부유형 미지정/역할 없음 — 보수적으로 일반 바이어(수락대기)로 본다
        # (``app.meetings.service._recipient_type``·``assignment_service._buyer_recipient_type``과
        # 동일 정책 — 동의 없는 즉시확정보다 과보수적 수락대기가 덜 나쁜 실패다).
        return RecipientType.GENERAL_BUYER
    return recipient_type_from_buyer_subtype(role.buyer_subtype)


def _guard_entry_state(
    db: Session,
    *,
    event_id: str,
    exhibitor_org_id: str,
    buyer_org_id: str,
    requested_by: str | None,
    matching_type: str,
    entry_state: EntryState,
    channel: Channel | None = None,
) -> None:
    """F1 하드닝 — entry_state/matching_type 불변식을 프리미티브 스스로 방어한다(ADR-0005).

    호출부(create_meeting·assignment_service)는 전부 ``resolve_entry_state``로 계산한 값을
    넘기므로 이 가드는 그들을 절대 막지 않는다 — 잡는 건 미래/실수 호출부가 규칙을 거슬러
    entry_state를 강제 지정하는 경우뿐이다("동의 없이 일정이 확정되지 않는다").

    matching_type이 스키마 CHECK 허용값(``ai``/``open``/``forced``/``on_site``) 밖이면 INSERT까지
    가지 않고 여기서 거부한다 — 안 그러면 알려지지 않은 제약 위반 문자열이라
    :func:`integrity_to_meeting_error`가 인식 못 하고 원본 ``IntegrityError``를 그대로 재던져 500이
    샌다.

    ``channel``을 명시하면 ``matching_type``→``Channel`` 근사(_MATCHING_TYPE_TO_CHANNEL, 'ai'가
    AI_SATURATION으로 뭉개지는 모호함)를 건너뛰고 그 채널로 검증한다 — 호출부가 스키마 CHECK
    허용값(matching_type='ai') 안에 머물면서도 실제 채널이 AI_SATURATION이 아닌 경우(예:
    AI_RETRIGGER, F-OP-003 ⚡ 단일기업 재보충)를 구분하기 위한 탈출구다. DB에 저장되는
    ``Meeting.matching_type``은 그대로 'ai'라 CHECK 제약과 기존 조회·집계는 안 바뀐다 — 다만
    수락 상태 검증(어느 채널 규칙을 적용할지)만 이 인자로 바로잡는다.

    ⚠ 락 획득 **전**에 호출한다 — 락 보유 시간에 영향 없게. 이 함수는 읽기 쿼리 하나만 던지고
    아무것도 쓰지 않는다.

    Raises:
        MeetingError: matching_type이 허용값 밖이거나(``MATCHING_TYPE_INVALID``), entry_state가
            수락 규칙과 충돌할 때(``ENTRY_STATE_INVALID``).
    """
    resolved_channel = channel or _MATCHING_TYPE_TO_CHANNEL.get(matching_type)
    if resolved_channel is None:
        raise MeetingError(
            "MATCHING_TYPE_INVALID", f"알 수 없는 matching_type입니다: {matching_type!r}", 500
        )

    recipient_type = _resolve_meeting_recipient_type(
        db,
        event_id=event_id,
        exhibitor_org_id=exhibitor_org_id,
        buyer_org_id=buyer_org_id,
        requested_by=requested_by,
    )
    try:
        validate_requested_state(recipient_type, resolved_channel, entry_state)
    except ForcedConfirmationError as exc:
        raise MeetingError("ENTRY_STATE_INVALID", str(exc), 500) from exc


def book_meeting(
    db: Session,
    *,
    event_id: str,
    exhibitor_org_id: str,
    buyer_org_id: str,
    start: datetime,
    end: datetime,
    resolve_venue: Callable[[], MeetingVenue],
    entry_state: EntryState,
    matching_type: str,
    requested_by: str | None,
    request_reason: str | None = None,
    awaiting_org_id: str | None = None,
    saturation_run_id: str | None = None,
    proxy_applied_by_organizer_id: str | None = None,
    check_after_overlap: Callable[[], None] | None = None,
    channel: Channel | None = None,
) -> Meeting:
    """미팅 예약 임계구역 — lock → 겹침 재검증 → (선택 훅) → (쌍,시각) 중복 → 장소 확정 → INSERT.

    ``channel``: entry_state 검증에 쓸 채널을 명시적으로 지정한다(``_guard_entry_state`` 참고) —
    matching_type='ai'가 AI_SATURATION·AI_RETRIGGER 두 채널을 공유해 모호한 경우(예: 단일기업
    재트리거)에 쓴다. 생략하면 종전처럼 matching_type에서 근사한다.

    호출부가 이미 잡아둔 advisory lock이 있어도 다시 호출해 안전하다(``pg_advisory_xact_lock``은
    같은 트랜잭션 안에서 반복 획득해도 문제없고, 트랜잭션 종료 시 한 번에 해제된다).

    반환된 ``Meeting``은 **flush만** 됐고 commit되지 않았다 — commit은 호출부 소유다(알림 발화를
    상태 전이 커밋 뒤로 미루는 원칙과 배치 호출(포화배정 confirm)의 항목별 원자성 때문). 호출부는
    이 함수가 반환한 뒤 자기 트랜잭션 경계에서 commit하고, 그 commit 자체가 던질 수 있는
    ``IntegrityError``도 :func:`integrity_to_meeting_error`로 환산해야 한다(이론상 이 레포의 제약은
    전부 non-deferrable이라 flush 시점에 이미 걸리지만, 방어적으로 맞춰둘 것).

    Raises:
        MeetingError: MATCHING_TYPE_INVALID·ENTRY_STATE_INVALID(락 밖 F1 가드, :func:`_guard_entry_state`) ·
            SLOT_TAKEN(겹침·check_after_overlap 거부) · DUPLICATE_APPLICATION((쌍,시각) 중복 신청) ·
            그리고 ``resolve_venue``/``check_after_overlap``이 던지는 것(주로 VENUE_TAKEN) ·
            flush 시점 IntegrityError 환산.
    """
    _guard_entry_state(
        db,
        event_id=event_id,
        exhibitor_org_id=exhibitor_org_id,
        buyer_org_id=buyer_org_id,
        requested_by=requested_by,
        matching_type=matching_type,
        entry_state=entry_state,
        channel=channel,
    )

    slot_booking.meeting_write_lock(
        db, event_id=event_id, org_ids=(exhibitor_org_id, buyer_org_id)
    )

    if slot_booking.has_accepted_overlap(
        db,
        event_id=event_id,
        org_ids=[exhibitor_org_id, buyer_org_id],
        start=start,
        end=end,
    ):
        raise MeetingError("SLOT_TAKEN", "해당 시간에 이미 확정된 미팅이 있습니다.", 409)

    if check_after_overlap is not None:
        check_after_overlap()

    existing = find_duplicate_proposed(db, event_id, exhibitor_org_id, buyer_org_id, start)
    if existing is not None:
        raise MeetingError(
            "DUPLICATE_APPLICATION",
            "같은 상대에게 같은 시간으로 이미 신청했습니다.",
            409,
            existing_meeting_id=str(existing),
        )

    venue = resolve_venue()

    meeting = Meeting(
        event_id=event_id,
        exhibitor_org_id=exhibitor_org_id,
        buyer_org_id=buyer_org_id,
        venue_id=venue.id,
        matching_type=matching_type,
        status=entry_state.value,
        requested_by=requested_by,
        awaiting_org_id=awaiting_org_id,
        request_reason=request_reason,
        scheduled_start=start,
        scheduled_end=end,
        saturation_run_id=saturation_run_id,
        proxy_applied_by_organizer_id=proxy_applied_by_organizer_id,
    )
    db.add(meeting)
    try:
        db.flush()
    except IntegrityError as exc:
        db.rollback()
        raise integrity_to_meeting_error(exc)
    return meeting
