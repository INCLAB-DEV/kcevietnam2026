"""알림 생성·조회·읽음 처리 (F-NT-001, ADR-0010).

핵심 불변식:
- **멱등 생성**: ``notifications`` 유니크(type, meeting_id, recipient_org_id, due_at) NULLS NOT
  DISTINCT를 ``INSERT ... ON CONFLICT DO NOTHING``으로 존중한다 — 같은 사건을 두 번 통지해도
  중복 행이 생기지 않고, 중복이면 채널 디스패치도 건너뛴다(중복 이메일 방지).
- **payload 스냅샷**: 생성 시점 표시 데이터를 jsonb로 박제(schemas.py의 Pydantic 모델로 형태 강제).
  미팅이 사후 변경돼도 통지 당시 내용을 보존한다.
- **org 공유 인박스/읽음**: recipient_org_id로 조회하고, read_at/read_by_member_id는 org 전체가 공유.
- **채널 팬아웃**: 생성 성공 시 활성 채널 전체(v1: 인앱+이메일)에 디스패치, 결과를
  ``notification_dispatches``에 기록.
- **행사별 참가자 알림 메일 스위치**(``event_schedule_settings.participant_email_enabled``, nt004mail0001):
  꺼진 행사의 알림은 인앱만 남고 외부 채널(이메일 등)은 보내지 않는다 — dispatch는 ``skipped`` +
  ``event_email_disabled``. 같은 스위치로 러브콜 메일도 막는다(app/api/love_call.py가 아래
  ``participant_email_enabled_for_event``로 읽어 409) — 꺼진 행사에서 나가는 메일은 가입 인증 코드뿐이다.

DB 접근은 이 모듈로 모은다(app/bm/service.py와 동일하게 Session을 직접 받아 트랜잭션을 소유).
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from functools import lru_cache
from typing import Callable, Sequence, TypeVar
from uuid import UUID

from sqlalchemy import and_, func, or_, select, tuple_, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Session

from app.display_locale import localized_booth_venue_label, normalize_locale
from app.models import (
    DEFAULT_PARTICIPANT_EMAIL_ENABLED,
    DEFAULT_PARTICIPANT_MENU,
    EventScheduleSettings,
    Hall,
    Meeting,
    MeetingVenue,
    Member,
    Notification,
    NotificationDispatch,
    Organization,
    OrganizationEventRole,
)
from app.notifications.channels import (
    DEFAULT_EXTERNAL_CHANNEL_NAMES,
    ChannelRecipient,
    DispatchResult,
    InAppChannel,
    NotificationChannel,
    NotificationEnvelope,
    build_channels,
    send_isolated,
    suppressed_dispatch_results,
)
from app.notifications.email import build_email_sender
from app.notifications.schemas import (
    ApplicationApprovedPayload,
    MeetingAcceptedPayload,
    MeetingCancelledPayload,
    MeetingRejectedPayload,
    MeetingReminderPayload,
    MeetingRequestedPayload,
    ReviewPromptPayload,
    ReviewReadyPayload,
)

_NOTIFICATION_UNIQUE_COLS = ["type", "meeting_id", "recipient_org_id", "due_at"]

logger = logging.getLogger(__name__)

_T = TypeVar("_T")


def notify_after_commit(
    db: Session, emit: Callable[[], _T], *, description: str
) -> _T | None:
    """상태 전이가 **이미 커밋된 뒤** 알림을 쏜다 — 실패해도 전이를 되감지 않는다.

    ``_emit_notification``은 내부에서 ``db.commit()``을 한다. 그래서 알림을 상태 전이와 같은
    트랜잭션에 두면 두 가지가 동시에 깨진다: (1) 알림 실패가 이미 확정된 수락/취소를 롤백하고,
    (2) 알림의 커밋이 아직 검증 중인 전이를 조기에 확정시킨다. 호출 규약은 항상 같다 —
    **전이를 커밋한 뒤** 이 헬퍼로 감싼다.

    실패는 삼키고 로그만 남긴다. 알림이 안 갔다고 미팅이 취소되지 않은 척할 수는 없다 —
    사용자에게는 취소가 성공한 게 맞고, 못 간 통지는 관측(로그·발송 이력)으로 복구할 문제다.
    세션은 깨진 트랜잭션을 남기지 않도록 롤백해 되돌려준다.

    Args:
        db: 알림 발화에 쓰는 세션(실패 시 롤백 대상).
        emit: 실제 알림 호출(무인자 콜러블).
        description: 로그에 남길 맥락(예: "meeting_cancelled (meeting_id=...)").

    Returns:
        ``emit``의 반환값, 실패했으면 None.
    """
    try:
        return emit()
    except Exception:  # noqa: BLE001 - 알림 실패가 이미 커밋된 도메인 전이를 무르지 않는다
        db.rollback()
        logger.exception("알림 발송 실패 — %s", description)
        return None


@lru_cache
def _default_channels() -> tuple[NotificationChannel, ...]:
    """앱 프로세스당 1회 생성(SMTP 자격증명 없으면 여기서 fail-closed로 즉시 실패)."""
    return tuple(build_channels(build_email_sender()))


def active_channels() -> tuple[NotificationChannel, ...]:
    """지금 활성인 채널 목록 — 호출부가 일부 채널을 감싸서(예: 이메일 지연 발송,
    ``app.notifications.bulk_dispatch``) 생성 함수의 ``channels=``로 넘길 때 출발점으로 쓴다."""
    return _default_channels()


def record_dispatches(
    db: Session, notification_id: str, results: Sequence[DispatchResult], *, now: datetime
) -> None:
    """채널 발송 결과를 ``notification_dispatches`` 행으로 추가한다(커밋은 호출부). 'sent'만 sent_at을 남긴다.

    알림 생성(``_emit_notification``)과 응답 이후의 지연 발송(bulk_dispatch)이 같은 규칙으로 기록하도록
    한 곳에 둔다.
    """
    for result in results:
        db.add(
            NotificationDispatch(
                notification_id=notification_id,
                member_id=result.member_id,
                channel=result.channel,
                status=result.status,
                sent_at=now if result.status == "sent" else None,
                error=result.error,
            )
        )


def _is_uuid(value: str) -> bool:
    try:
        UUID(str(value))
        return True
    except (ValueError, AttributeError, TypeError):
        return False


def org_display_name(db: Session, org_id: str) -> str:
    """표시용 기업명(payload 스냅샷·이메일 본문용). 없으면 id 그대로(빈 화면 방지).

    org_id 가 UUID 형식이 아니면(테스트 픽스처 등) DB 조회 자체를 건너뛴다 — PG UUID 컬럼 비교는
    비-UUID 문자열에 500(DataError)로 터지므로, 여기서 조용히 걸러 id 폴백으로 수렴시킨다.
    """
    if not _is_uuid(org_id):
        return org_id
    org = db.get(Organization, org_id)
    if org is None:
        return org_id
    return org.name_ko or org.name_en or org_id


def venue_label(db: Session, venue_id: str | None) -> str | None:
    if venue_id is None or not _is_uuid(venue_id):
        return None
    venue = db.get(MeetingVenue, venue_id)
    return venue.label if venue else None


def _recipients_for_org(db: Session, org_id: str) -> list[ChannelRecipient]:
    rows = db.execute(select(Member.id, Member.email).where(Member.organization_id == org_id)).all()
    return [ChannelRecipient(member_id=str(mid), email=email) for mid, email in rows]


def _participant_menu_for_event(db: Session, event_id: str) -> str:
    """행사의 참가자 메뉴(``meetings_only``/``full``) — 메일 본문이 안내할 화면을 고르는 데 쓴다.

    설정 행이 없는 행사는 기본값(미팅만)이다(``/api/me``와 같은 규칙 — 같은 상수를 본다). 여기서 행을
    만들지 않는다 — 알림을 쏘는 경로가 설정 테이블에 쓰기를 남기면 안 된다(읽기만).
    """
    if not _is_uuid(event_id):
        return DEFAULT_PARTICIPANT_MENU
    value = db.execute(
        select(EventScheduleSettings.participant_menu).where(
            EventScheduleSettings.event_id == event_id
        )
    ).scalar_one_or_none()
    return value or DEFAULT_PARTICIPANT_MENU


def participant_email_enabled_for_event(db: Session, event_id: str) -> bool:
    """행사 설정 "참가자 알림 메일" — false면 자동 알림을 외부 채널(이메일 등)로 보내지 않고 러브콜 메일도 막는다.

    설정 행이 없는 행사는 기본값(**꺼짐**, ``DEFAULT_PARTICIPANT_EMAIL_ENABLED``)이다. 참가자 메뉴와 같은 규칙으로
    여기서 행을 만들지 않는다(알림 경로는 설정 테이블에 쓰지 않는다 — 읽기만). 알림 생성(커밋 전)·지연 발송
    (``bulk_dispatch`` 발송 직전)·재발송, 그리고 러브콜 메일 발송·상태 조회(app/api/love_call.py)가 이 함수
    하나로 읽는다.
    """
    if not _is_uuid(event_id):
        return DEFAULT_PARTICIPANT_EMAIL_ENABLED
    value = db.execute(
        select(EventScheduleSettings.participant_email_enabled).where(
            EventScheduleSettings.event_id == event_id
        )
    ).scalar_one_or_none()
    return DEFAULT_PARTICIPANT_EMAIL_ENABLED if value is None else bool(value)


class ParticipantEmailDisabledError(Exception):
    """참가자 알림 메일이 꺼진 행사에서 외부 채널(이메일 등) 재발송을 요청했다 — 409 매핑, dispatch 행은 그대로."""


# =============================================================================
# 생성 + 채널 디스패치(내부 코어)
# =============================================================================
def _emit_notification(
    db: Session,
    *,
    event_id: str,
    type: str,
    recipient_org_id: str,
    meeting_id: str | None,
    due_at: datetime | None,
    payload: dict,
    channels: Sequence[NotificationChannel] | None = None,
) -> Notification | None:
    """멱등 생성 + 채널 디스패치. 이미 존재하는 행(멱등 충돌)이면 None(디스패치도 스킵).

    외부로 나가는 채널(이메일 등)은 **알림 행을 커밋한 뒤에** 보낸다 — 예전엔 INSERT 직후 열린 트랜잭션
    안에서 SMTP를 기다려, 그동안 DB 커넥션이 'idle in transaction'으로 묶였다(수락·취소처럼 요청 안에서
    알림을 쏘는 모든 경로). 인앱은 알림 행 자체가 발신이라 같은 트랜잭션에서 기록한다. 외부 발송 결과
    (dispatch 행)는 보낸 뒤 짧은 트랜잭션으로 기록한다 — 만들어지는 알림·메일은 예전과 같고 순서만 바뀐다.
    일괄 확정(bulk_dispatch)이 넘기는 지연 채널도 같은 자리(커밋 뒤)에서 대기열에 담긴다.

    행사 설정 "참가자 알림 메일"이 꺼져 있으면(``participant_email_enabled_for_event``) 외부 채널은 부르지도,
    대기열에 담지도 않는다 — 보냈을 수신자마다 ``skipped``(``event_email_disabled``) 행을 인앱 기록과 같은
    트랜잭션에 남긴다. 누가 조작했든(참가자 본인·운영자·스케줄러) 같다. 채널을 넘겨받지 않았으면 기본 채널
    (SMTP sender 생성 포함)을 **만들지도 않는다** — 메일 설정이 깨져 채널 구성이 실패해도 꺼진 행사의 인앱 알림은
    남는다. 켜진 행사의 채널 구성 실패는 예전처럼 예외로 올라간다(호출부 notify_after_commit이 삼킨다).
    """
    stmt = (
        pg_insert(Notification)
        .values(
            event_id=event_id,
            recipient_org_id=recipient_org_id,
            type=type,
            meeting_id=meeting_id,
            due_at=due_at,
            payload=payload,
        )
        .on_conflict_do_nothing(index_elements=_NOTIFICATION_UNIQUE_COLS)
        .returning(Notification.id)
    )
    new_id = db.execute(stmt).scalar_one_or_none()
    if new_id is None:
        return None  # 멱등 충돌 — 이미 통지됨, 재디스패치하지 않는다.

    envelope = NotificationEnvelope(
        notification_id=str(new_id),
        type=type,
        event_id=str(event_id),
        meeting_id=str(meeting_id) if meeting_id else None,
        payload=payload,
        # 커밋 전에 읽는다 — 외부 발송은 커밋 뒤라 그때는 이 세션이 커넥션을 쥐고 있지 않다.
        participant_menu=_participant_menu_for_event(db, str(event_id)),
    )
    recipients = _recipients_for_org(db, recipient_org_id)
    # 스위치도 커밋 전에 읽는다(참가자 메뉴와 같은 이유). 채널을 고르기 **전에** 읽는다 — 꺼진 행사는 기본
    # 채널(이메일 sender 생성)을 만들지 않고 인앱만 쓴다.
    email_enabled = participant_email_enabled_for_event(db, str(event_id))
    target_channels: Sequence[NotificationChannel]
    if channels is not None:
        target_channels = channels
    elif email_enabled:
        target_channels = _default_channels()
    else:
        target_channels = (InAppChannel(),)
    now = datetime.now(timezone.utc)
    external: list[NotificationChannel] = []
    for channel in target_channels:
        if channel.name == InAppChannel.name:
            record_dispatches(db, new_id, channel.send(envelope, recipients), now=now)
        else:
            external.append(channel)
    if not email_enabled:
        # 꺼져 있으면 외부 채널은 보내지 않고 사유만 남긴다. 기본 채널을 만들지 않았으면 레지스트리의 외부 채널
        # 이름으로(켜져 있었다면 생겼을 행과 같은 집합).
        muted = (
            [c.name for c in external] if channels is not None else list(DEFAULT_EXTERNAL_CHANNEL_NAMES)
        )
        for name in muted:
            record_dispatches(db, new_id, suppressed_dispatch_results(name, recipients), now=now)
        external = []
    db.commit()
    if external:
        _send_after_commit(db, new_id, envelope, recipients, external)
    return db.get(Notification, new_id)


def _send_after_commit(
    db: Session,
    notification_id: str,
    envelope: NotificationEnvelope,
    recipients: list[ChannelRecipient],
    channels: Sequence[NotificationChannel],
) -> None:
    """커밋된 알림을 외부 채널로 보내고 결과만 짧게 기록한다 — 보내는 동안 이 세션은 커넥션을 쥐지 않는다.

    알림 행은 이미 커밋됐으므로 여기서 생긴 실패는 위로 올리지 않는다: 채널 예외는 'failed' dispatch 행으로
    (send_isolated), 기록 자체의 실패는 로그로 남긴다(메일은 이미 나갔다 — 알림을 실패로 돌릴 이유가 없다).
    """
    results: list[DispatchResult] = []
    for channel in channels:
        results.extend(send_isolated(channel, envelope, recipients))
    if not results:
        return
    try:
        record_dispatches(db, notification_id, results, now=datetime.now(timezone.utc))
        db.commit()
    except Exception:  # noqa: BLE001 - 기록 실패가 이미 커밋된 알림·나간 메일을 실패로 만들지 않는다
        db.rollback()
        logger.exception("알림 외부 발송 결과 기록 실패 (notification_id=%s)", notification_id)


# =============================================================================
# 8종 생성 함수 — 서비스 함수로 노출(트리거 연결은 호출부 소관, ADR-0010 수신 매트릭스)
# =============================================================================
def notify_meeting_requested(
    db: Session,
    *,
    event_id: str,
    meeting_id: str,
    recipient_org_id: str,
    counterpart_org_name: str,
    requested_by_role: str,
    channels: Sequence[NotificationChannel] | None = None,
) -> Notification | None:
    """미팅 신청받음 — 받는 쪽(신청 안 한 org) 1행."""
    payload = MeetingRequestedPayload(
        counterpart_org_name=counterpart_org_name, requested_by_role=requested_by_role
    ).model_dump()
    return _emit_notification(
        db, event_id=event_id, type="meeting_requested", recipient_org_id=recipient_org_id,
        meeting_id=meeting_id, due_at=None, payload=payload, channels=channels,
    )


def notify_meeting_accepted(
    db: Session,
    *,
    event_id: str,
    meeting_id: str,
    recipient_org_id: str,
    counterpart_org_name: str,
    scheduled_start: datetime | str,
    venue_label: str | None = None,
    channels: Sequence[NotificationChannel] | None = None,
) -> Notification | None:
    """내 신청 수락됨 — 신청한 쪽(요청자 org) 1행."""
    payload = MeetingAcceptedPayload(
        counterpart_org_name=counterpart_org_name,
        scheduled_start=_iso(scheduled_start),
        venue_label=venue_label,
    ).model_dump()
    return _emit_notification(
        db, event_id=event_id, type="meeting_accepted", recipient_org_id=recipient_org_id,
        meeting_id=meeting_id, due_at=None, payload=payload, channels=channels,
    )


def notify_meeting_cancelled(
    db: Session,
    *,
    event_id: str,
    meeting_id: str,
    recipient_org_id: str,
    counterpart_org_name: str,
    cancelled_by_role: str,
    scheduled_start: datetime | str | None = None,
    channels: Sequence[NotificationChannel] | None = None,
) -> Notification | None:
    """미팅 취소됨 — 취소 안 한 쪽 1행."""
    payload = MeetingCancelledPayload(
        counterpart_org_name=counterpart_org_name,
        scheduled_start=_iso(scheduled_start) if scheduled_start else None,
        cancelled_by_role=cancelled_by_role,
    ).model_dump()
    return _emit_notification(
        db, event_id=event_id, type="meeting_cancelled", recipient_org_id=recipient_org_id,
        meeting_id=meeting_id, due_at=None, payload=payload, channels=channels,
    )


def notify_meeting_rejected(
    db: Session,
    *,
    event_id: str,
    meeting_id: str,
    recipient_org_id: str,
    counterpart_org_name: str,
    scheduled_start: datetime | str | None = None,
    channels: Sequence[NotificationChannel] | None = None,
) -> Notification | None:
    """미팅 거절됨 — 신청한 쪽(거절당한 쪽) 1행. 거절 사유는 payload에 담지 않는다(GitHub #4).

    멱등 키가 (type, meeting_id, recipient_org_id, due_at=NULL)이고, ``reject_meeting``의 상태
    전이가 proposed→rejected 단방향이라 같은 미팅을 두 번 거절하는 경로 자체가 없다(재거절 시도는
    ``_assert_transition``에서 막힌다) — 멱등 충돌은 이론상의 안전망이지 실제로 걸릴 일은 없다.
    """
    payload = MeetingRejectedPayload(
        counterpart_org_name=counterpart_org_name,
        scheduled_start=_iso(scheduled_start) if scheduled_start else None,
    ).model_dump()
    return _emit_notification(
        db, event_id=event_id, type="meeting_rejected", recipient_org_id=recipient_org_id,
        meeting_id=meeting_id, due_at=None, payload=payload, channels=channels,
    )


def notify_meeting_reminder(
    db: Session,
    *,
    event_id: str,
    meeting_id: str,
    recipient_org_id: str,
    counterpart_org_name: str,
    scheduled_start: datetime | str,
    due_at: datetime,
    venue_label: str | None = None,
    channels: Sequence[NotificationChannel] | None = None,
) -> Notification | None:
    """10분 리마인더 — 양측 각 1행(호출부가 org별로 2번 호출). due_at이 멱등 키의 일부."""
    payload = MeetingReminderPayload(
        counterpart_org_name=counterpart_org_name,
        scheduled_start=_iso(scheduled_start),
        venue_label=venue_label,
    ).model_dump()
    return _emit_notification(
        db, event_id=event_id, type="meeting_reminder", recipient_org_id=recipient_org_id,
        meeting_id=meeting_id, due_at=due_at, payload=payload, channels=channels,
    )


def notify_review_prompt(
    db: Session,
    *,
    event_id: str,
    meeting_id: str,
    recipient_org_id: str,
    counterpart_org_name: str,
    due_at: datetime | None = None,
    channels: Sequence[NotificationChannel] | None = None,
) -> Notification | None:
    """리뷰 입력 안내 — 양측 각 1행(리뷰는 org별 독립)."""
    payload = ReviewPromptPayload(counterpart_org_name=counterpart_org_name).model_dump()
    return _emit_notification(
        db, event_id=event_id, type="review_prompt", recipient_org_id=recipient_org_id,
        meeting_id=meeting_id, due_at=due_at, payload=payload, channels=channels,
    )


def notify_review_ready(
    db: Session,
    *,
    event_id: str,
    meeting_id: str,
    recipient_org_id: str,
    counterpart_org_name: str,
    channels: Sequence[NotificationChannel] | None = None,
) -> Notification | None:
    """회의록 정리 완료 — 녹음 업로드한 org 1행. due_at NULL(이벤트형), 재전사해도 재통지 안 함(멱등)."""
    payload = ReviewReadyPayload(counterpart_org_name=counterpart_org_name).model_dump()
    return _emit_notification(
        db, event_id=event_id, type="review_ready", recipient_org_id=recipient_org_id,
        meeting_id=meeting_id, due_at=None, payload=payload, channels=channels,
    )


def notify_application_approved(
    db: Session,
    *,
    event_id: str,
    recipient_org_id: str,
    org_name: str,
    role: str,
    channels: Sequence[NotificationChannel] | None = None,
) -> Notification | None:
    """신청 승인 완료 — 승인된 org 1행. meeting_id/due_at 둘 다 NULL(미팅·시한 개념이 없는 이벤트형).

    멱등 키가 (type, meeting_id=NULL, recipient_org_id, due_at=NULL)이라, 같은 org를 반려 후
    재승인해도(예: changes_requested → 재제출 → 재승인) 이 조합이 그대로 재충돌해 재통지가
    스킵된다 — "이미 한 번 승인 통지를 받은 조직"이라는 의미로 의도한 동작이다(중복 폭탄 방지).
    ⚠ 알려진 한계: org가 여러 행사에 각각 신청하는 멀티이벤트 시나리오에서는 event_id가 멱등
    키에 없어 두 번째 행사 승인 통지가 억제될 수 있다 — 현재 배포는 단일 행사 운영이라 실질
    영향이 없고, 멀티이벤트를 지원하게 되면 멱등 키에 event_id를 추가하는 마이그레이션이 필요하다.
    """
    payload = ApplicationApprovedPayload(org_name=org_name, role=role).model_dump()
    return _emit_notification(
        db, event_id=event_id, type="application_approved", recipient_org_id=recipient_org_id,
        meeting_id=None, due_at=None, payload=payload, channels=channels,
    )


def _iso(value: datetime | str) -> str:
    return value.isoformat() if isinstance(value, datetime) else value


# =============================================================================
# org 공유 인박스 조회 + 읽음 처리
# =============================================================================
def list_inbox(
    db: Session, org_id: str, *, limit: int = 20, cursor: str | None = None
) -> tuple[list[Notification], int, str | None]:
    """최신순(created_at desc) 커서 페이지네이션 + 안읽음 수. cursor는 이전 페이지 마지막 행의 id."""
    limit = max(1, min(limit, 100))
    q = select(Notification).where(Notification.recipient_org_id == org_id)
    if cursor:
        anchor = db.get(Notification, cursor)
        if anchor is not None:
            q = q.where(
                tuple_(Notification.created_at, Notification.id)
                < tuple_(anchor.created_at, anchor.id)
            )
    q = q.order_by(Notification.created_at.desc(), Notification.id.desc()).limit(limit + 1)
    rows = list(db.execute(q).scalars().all())
    has_more = len(rows) > limit
    items = rows[:limit]
    next_cursor = items[-1].id if has_more and items else None

    unread_count = db.execute(
        select(func.count()).select_from(Notification).where(
            Notification.recipient_org_id == org_id, Notification.read_at.is_(None)
        )
    ).scalar_one()
    return items, unread_count, next_cursor


def read_by_member_names(db: Session, notifications: Sequence[Notification]) -> dict[str, str]:
    """``read_by_member_id`` → ``members.name`` 일괄 해석. 인박스 한 페이지에 **쿼리 한 번**.

    행마다 ``db.get(Member, ...)``을 부르면 20행짜리 인박스가 최대 21쿼리가 된다. 조인 대신 이
    보조 조회로 푸는 건 ``list_inbox``가 커서 페이지네이션(``tuple_`` 비교 + limit+1)을 이미
    갖고 있어서다 — 거기에 조인을 얹으면 커서 로직과 표시 이름 해석이 한 쿼리에 얽혀, 한쪽을
    고칠 때 다른 쪽이 깨진다.

    이름을 못 찾은 id는 결과에 아예 없다(빈 문자열을 지어내지 않는다). 호출부는 ``.get()``으로
    받아 None으로 흘린다.
    """
    ids = {n.read_by_member_id for n in notifications if n.read_by_member_id}
    if not ids:
        return {}
    rows = db.execute(select(Member.id, Member.name).where(Member.id.in_(ids))).all()
    return {str(member_id): name for member_id, name in rows}


def localized_payloads(
    db: Session,
    notifications: Sequence[Notification],
    *,
    org_id: str,
    locale: str | None,
) -> dict[str, dict]:
    """알림 id → 표시 로케일로 옮긴 payload **사본**. 기본(ko)에서는 빈 dict다(추가 쿼리 없음).

    payload는 통지 시점 스냅샷이고, 그 안의 기업명은 국문 우선(``org_display_name``)으로 박제된다.
    en 화면에 그 스냅샷을 그대로 내면 문장은 영어인데 기업명만 한글이 된다. 그래서 **읽을 때**
    사람이 읽는 세 값만 현재 영문 값으로 바꾼 사본을 만든다:

    - ``counterpart_org_name`` — 그 미팅의 상대 org ``name_en``
    - ``org_name``(application_approved) — 수신 org 자신의 ``name_en``
    - ``venue_label`` — 장소가 부스일 때만 ``localized_booth_venue_label``(운영자가 이름 붙인
      매칭존·비즈니스룸 라벨은 손대지 않는다)

    영문명이 없으면 스냅샷 그대로다 — 지어내지 않는다. 저장된 payload는 건드리지 않는다: 인박스는
    org 공유라 같은 행을 한국어 담당자도 읽고, 스냅샷은 "통지 당시 무엇을 알렸는가"의 기록이다.

    인박스 한 페이지에 쿼리 최대 4번(미팅·기업·장소·홀)이고 행마다 조회하지 않는다.
    """
    if normalize_locale(locale) != "en" or not notifications:
        return {}

    meeting_ids = {str(n.meeting_id) for n in notifications if n.meeting_id}
    # 미팅 id → (참가사 org, 바이어 org, 행사, 장소). 미팅 행을 못 찾은 알림은 맵에 없고,
    # 스냅샷 그대로 나간다.
    meetings: dict[str, tuple[str, str, str, str | None]] = {}
    if meeting_ids:
        meetings = {
            str(meeting_id): (
                str(exhibitor_org_id),
                str(buyer_org_id),
                str(event_id),
                str(venue_id) if venue_id else None,
            )
            for meeting_id, exhibitor_org_id, buyer_org_id, event_id, venue_id in db.execute(
                select(
                    Meeting.id,
                    Meeting.exhibitor_org_id,
                    Meeting.buyer_org_id,
                    Meeting.event_id,
                    Meeting.venue_id,
                ).where(Meeting.id.in_(meeting_ids))
            ).all()
        }

    org_ids = {str(org_id)}
    for exhibitor_org_id, buyer_org_id, _, _ in meetings.values():
        org_ids.update((exhibitor_org_id, buyer_org_id))
    # 비-UUID org(테스트 픽스처·데모 주체)는 PG UUID 비교에서 DataError를 내므로 조회에서 뺀다.
    lookup_ids = {oid for oid in org_ids if _is_uuid(oid)}
    names_en: dict[str, str] = {}
    if lookup_ids:
        names_en = {
            str(oid): name_en
            for oid, name_en in db.execute(
                select(Organization.id, Organization.name_en).where(Organization.id.in_(lookup_ids))
            ).all()
            if name_en
        }

    # 부스 라벨 변환에 필요한 조회는 "venue_label이 실린 알림"이 있을 때만 한다(수락·리마인더).
    labelled = {
        str(n.meeting_id)
        for n in notifications
        if n.meeting_id and (n.payload or {}).get("venue_label")
    }
    venue_ids = {meetings[mid][3] for mid in labelled if mid in meetings and meetings[mid][3]}
    booth_venue_ids: set[str] = set()
    if venue_ids:
        booth_venue_ids = {
            str(venue_id)
            for (venue_id,) in db.execute(
                select(MeetingVenue.id).where(
                    MeetingVenue.id.in_(venue_ids), MeetingVenue.venue_type == "booth"
                )
            ).all()
        }
    halls_by_event: dict[str, list[tuple[str, str]]] = {}
    if booth_venue_ids:
        event_ids = {meetings[mid][2] for mid in labelled if mid in meetings}
        for event_id, hall_no, hall_name in db.execute(
            select(Hall.event_id, Hall.hall_no, Hall.hall_name).where(Hall.event_id.in_(event_ids))
        ).all():
            halls_by_event.setdefault(str(event_id), []).append((hall_no, hall_name))

    localized: dict[str, dict] = {}
    for notification in notifications:
        if notification.payload is None:
            continue
        payload = dict(notification.payload)
        own_name_en = names_en.get(str(org_id))
        if notification.type == "application_approved" and own_name_en and "org_name" in payload:
            payload["org_name"] = own_name_en
        meeting = meetings.get(str(notification.meeting_id)) if notification.meeting_id else None
        if meeting is not None:
            exhibitor_org_id, buyer_org_id, event_id, venue_id = meeting
            counterpart_id = buyer_org_id if exhibitor_org_id == str(org_id) else exhibitor_org_id
            counterpart_name_en = names_en.get(counterpart_id)
            if counterpart_name_en and "counterpart_org_name" in payload:
                payload["counterpart_org_name"] = counterpart_name_en
            if payload.get("venue_label") and venue_id in booth_venue_ids:
                payload["venue_label"] = localized_booth_venue_label(
                    payload["venue_label"],
                    exhibitor_name_en=names_en.get(exhibitor_org_id),
                    halls=halls_by_event.get(event_id, ()),
                    locale="en",
                )
        localized[str(notification.id)] = payload
    return localized


def mark_read(db: Session, org_id: str, notification_id: str, *, member_id: str | None) -> Notification | None:
    """단건 읽음(org 공유) — 이미 읽힌 행은 최초 읽은 주체·시각을 덮어쓰지 않는다."""
    n = db.execute(
        select(Notification).where(
            Notification.id == notification_id, Notification.recipient_org_id == org_id
        )
    ).scalar_one_or_none()
    if n is None:
        return None
    if n.read_at is None:
        n.read_at = datetime.now(timezone.utc)
        n.read_by_member_id = member_id
        db.commit()
        db.refresh(n)
    return n


def mark_all_read(db: Session, org_id: str, *, member_id: str | None) -> int:
    """안읽음 행만 일괄 읽음 처리(이미 읽힌 행은 보존). 갱신된 행 수를 돌려준다."""
    now = datetime.now(timezone.utc)
    result = db.execute(
        update(Notification)
        .where(Notification.recipient_org_id == org_id, Notification.read_at.is_(None))
        .values(read_at=now, read_by_member_id=member_id)
    )
    db.commit()
    return result.rowcount or 0


# =============================================================================
# 어드민 콘솔 발송 이력(#OP) — dispatch 행 단위 조회·재발송
# =============================================================================
@dataclass(frozen=True, slots=True)
class AdminNotificationLogRow:
    """어드민 발송 이력 한 행 = notification_dispatches 한 행(수신 멤버×채널 단위)."""

    id: str  # dispatch 행 id — 재발송 경로 키
    event_id: str
    type: str
    channel: str  # 'in_app' | 'email'
    recipient_org_id: str
    recipient_org_name: str
    meeting_id: str | None
    sent_at: datetime  # 미발송(실패/skipped)은 알림 생성 시각으로 폴백(정렬 키 보존)
    delivered: bool  # status == 'sent'
    # 발송 이력은 대상별 1행 유지(유니크 제약) — 재발송은 그 행을 갱신하므로 누적으로 셀 대상이 없다.
    # 콘솔의 재발송 횟수 증가는 화면 측 낙관 갱신(lib/admin/notifications applyResend)으로 표시된다.
    resend_count: int
    # 보내지 않은(skipped) 행의 사유 코드(dispatch.error) — 지금은 ``event_email_disabled``만 실린다.
    # skipped가 아닌 행(전달·실패)의 error(예: SMTP 원문)는 여기 싣지 않는다.
    skip_reason: str | None = None


def list_admin_logs(
    db: Session, event_id: str, *, jurisdiction_organizer_id: str | None = None
) -> list[AdminNotificationLogRow]:
    """행사의 발송 이력 — 최신순. 알림 없으면 빈 목록.

    ``jurisdiction_organizer_id``(sub 운영자)면 수신 기업이 그 sub의 열람 관할인 행만 — 국내기업
    (참가사)은 공유 열람 풀, 해외 바이어는 자기가 관리하는 건만(``app.admin.service.check_jurisdiction``과
    같은 규칙). 예전엔 이 목록이 관할 필터 없이 나가 다른 sub가 관리하는 바이어의 기업명이 sub 콘솔에
    그대로 보였다. master는 None으로 기존 그대로 전역.
    """
    stmt = (
        select(NotificationDispatch, Notification, Organization.name_ko, Organization.name_en)
        .join(Notification, NotificationDispatch.notification_id == Notification.id)
        .join(Organization, Notification.recipient_org_id == Organization.id)
        .where(Notification.event_id == event_id)
    )
    if jurisdiction_organizer_id is not None:
        stmt = stmt.join(
            OrganizationEventRole,
            and_(
                OrganizationEventRole.organization_id == Notification.recipient_org_id,
                OrganizationEventRole.event_id == Notification.event_id,
            ),
        ).where(
            or_(
                OrganizationEventRole.is_exhibitor.is_(True),
                OrganizationEventRole.managing_organizer_id == jurisdiction_organizer_id,
            )
        )
    rows = db.execute(stmt.order_by(Notification.created_at.desc(), NotificationDispatch.id)).all()
    return [
        AdminNotificationLogRow(
            id=dispatch.id,
            event_id=notification.event_id,
            type=notification.type,
            channel=dispatch.channel,
            recipient_org_id=notification.recipient_org_id,
            recipient_org_name=name_ko or name_en or notification.recipient_org_id,
            meeting_id=notification.meeting_id,
            sent_at=dispatch.sent_at or notification.created_at,
            delivered=dispatch.status == "sent",
            resend_count=0,
            skip_reason=dispatch.error if dispatch.status == "skipped" else None,
        )
        for dispatch, notification, name_ko, name_en in rows
    ]


@dataclass(frozen=True)
class ResendOutcome:
    """재발송 결과 — 라우터 응답(NotificationResendOut)에 필요한 값만, 이미 꺼낸 평범한 값으로 담는다."""

    id: str
    channel: str
    status: str
    sent_at: datetime | None
    error: str | None


def resend_dispatch(
    db: Session,
    dispatch_id: str,
    channels: Sequence[NotificationChannel] | None = None,
) -> ResendOutcome | None:
    """dispatch 한 행 재발송 — 같은 (알림·멤버·채널) 행을 갱신한다(유니크 제약상 신규 행 불가).

    재시도 결과는 그 자리에 덮어쓴다(status/sent_at/error). 발송 자체는 채널이 격리 처리하므로
    이 함수는 발송 실패를 예외로 던지지 않는다(실패는 행의 상태로 관찰). 없는 행이면 None.

    행사 설정 "참가자 알림 메일"이 꺼져 있으면 인앱이 아닌 채널(이메일 등)의 재발송은
    :class:`ParticipantEmailDisabledError` 로 거부한다 — 아무것도 보내지 않고 dispatch 행도 바꾸지 않는다.
    인앱 재발송은 스위치와 무관하다(인앱은 꺼지지 않는다).

    발송 전에 읽기 트랜잭션을 끝낸다 — SMTP를 기다리는 동안 커넥션을 쥐지 않게(_emit_notification과 같은 이유).
    응답에 쓸 값도 **발송 전에** 꺼내 두고, 발송 뒤엔 결과 한 줄만 UPDATE한다 — 예전엔 SMTP를 기다린 뒤 만료된 ORM
    객체를 다시 읽어(refresh·속성 접근) 그 순간 풀이 고갈되면 이미 나간 재발송이 500으로 보였다(리뷰 H2). 결과 기록
    자체가 실패해도 메일은 이미 나갔으므로 로그만 남기고 발송 결과를 그대로 돌려준다(_send_after_commit과 같은 규칙).
    """
    dispatch = db.get(NotificationDispatch, dispatch_id)
    if dispatch is None:
        return None
    notification = db.get(Notification, dispatch.notification_id)
    if notification is None:
        return None
    # 채널 구성(_default_channels)보다 먼저 본다 — 꺼진 행사에선 채널이 미구성이어도 "꺼짐"이 거부 사유다.
    if dispatch.channel != InAppChannel.name and not participant_email_enabled_for_event(
        db, str(notification.event_id)
    ):
        raise ParticipantEmailDisabledError(
            "참가자 알림 메일이 꺼져 있습니다. 행사 설정에서 켠 뒤 다시 보내세요."
        )
    channel = next((c for c in (channels or _default_channels()) if c.name == dispatch.channel), None)
    member = db.get(Member, dispatch.member_id)
    recipient = ChannelRecipient(member_id=dispatch.member_id, email=member.email if member else None)
    envelope = NotificationEnvelope(
        notification_id=notification.id,
        type=notification.type,
        event_id=notification.event_id,
        meeting_id=notification.meeting_id,
        payload=notification.payload or {},
        # 재발송은 **지금** 행사 설정을 따른다 — 처음 보낸 뒤 메뉴가 바뀌었다면 바뀐 메뉴에 맞는 안내가 나간다.
        participant_menu=_participant_menu_for_event(db, str(notification.event_id)),
    )
    dispatch_pk = dispatch.id
    dispatch_channel = dispatch.channel
    # 보낼 값은 다 꺼냈다(봉투·수신자는 평범한 값) — 읽기 트랜잭션을 끝내 커넥션을 돌려준 뒤 보낸다.
    db.commit()
    if channel is None:
        results = [
            DispatchResult(
                member_id=recipient.member_id,
                channel=dispatch_channel,
                status="failed",
                error=f"채널 미구성: {dispatch_channel}",
            )
        ]
    else:
        results = send_isolated(channel, envelope, [recipient])
    result = results[0]
    sent_at = datetime.now(timezone.utc) if result.status == "sent" else None
    try:
        db.execute(
            update(NotificationDispatch)
            .where(NotificationDispatch.id == dispatch_pk)
            .values(status=result.status, sent_at=sent_at, error=result.error)
            .execution_options(synchronize_session=False)
        )
        db.commit()
    except Exception:  # noqa: BLE001 - 기록 실패가 이미 나간 재발송을 실패로 만들지 않는다
        db.rollback()
        logger.exception("재발송 결과 기록 실패 (dispatch_id=%s)", dispatch_pk)
    return ResendOutcome(
        id=dispatch_pk,
        channel=dispatch_channel,
        status=result.status,
        sent_at=sent_at,
        error=result.error,
    )
