"""참가자용 미팅 HTTP 엔드포인트 (F-MT-001) — ``/api/meetings``.

모든 라우트가 ``get_current_principal``을 통과한다. 권한의 닻은 ``Principal.organization_id``
하나 — 내 org가 낀 미팅만 보이고 바꿀 수 있다.

**에러 바디 규약(이 라우터 한정)**::

    {"detail": {"code": "SLOT_TAKEN", "message": "해당 시간에 이미 확정된 미팅이 있습니다."}}

FastAPI 기본 ``detail`` 은 사람이 읽는 문자열이라 클라이언트가 분기하려면 문자열 매칭을 해야
한다. 미팅 신청은 실패 종류마다 화면 처리가 다르므로(시간 다시 고르기 / 승인 안내 / 기존 미팅으로
이동) **기계가 읽는 code**를 함께 싣는다. 일부 코드는 추가 데이터를 붙인다 —
``DUPLICATE_APPLICATION``은 ``existing_meeting_id``를 함께 준다(그 미팅으로 이동시키려고).

같은 두 기업이 미팅을 여러 건 갖는 건 허용된다(#11, 2026-09-15 발주자 결정) — 예전엔 쌍 단위로
활성 미팅을 하나만 허용하는 ``ACTIVE_MEETING_EXISTS``가 있었지만 제거됐다. 같은 상대에게 같은
시각으로 중복 신청하는 사용자 실수만 ``DUPLICATE_APPLICATION``으로 막는다.

코드 목록: EVENT_AMBIGUOUS(400) · ROLE_AMBIGUOUS(400) · PROFILE_NOT_APPROVED(403) ·
NOT_VISIBLE(403) · APPLICATION_WINDOW_CLOSED(403) · NOT_PARTICIPANT(403) · NOT_AWAITING_PARTY(403) ·
NOT_CANCELLABLE_PARTY(403) · VENUE_TYPE_DISABLED(422) · SLOT_INVALID(422) · REASON_REQUIRED(422) ·
MEMBER_NOT_IN_ORG(422) · SLOT_TAKEN(409) · DUPLICATE_APPLICATION(409) · VENUE_TAKEN(409) ·
INVALID_TRANSITION(409) · EVENT_SCHEDULE_UNSET(409).

한 코드는 한 상태만 갖는다 — 같은 코드가 403과 422를 오가면 클라이언트가 코드만으로 분기할 수
없어 결국 상태코드까지 함께 보게 되고, 그럴 거면 코드를 실을 이유가 없다.
"""

from __future__ import annotations

from contextlib import contextmanager
from typing import Iterator
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from app.auth.principal import Principal, get_current_principal
from app.db import get_session
from app.display_locale import DEFAULT_LOCALE
from app.meetings import schemas, service
from app.meetings.schemas import (
    AvailabilityOut,
    MeetingAcceptIn,
    MeetingCancelIn,
    MeetingCreateIn,
    MeetingListResponse,
    MeetingOut,
    MeetingParticipantsIn,
    MeetingRejectIn,
)

router = APIRouter(prefix="/api/meetings", tags=["meetings"])


@contextmanager
def _domain_errors() -> Iterator[None]:
    """도메인 예외 → HTTP. 코드 바디 규약을 여기 한 곳에서만 만든다."""
    try:
        yield
    except service.MeetingError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.to_detail()) from exc
    except service.MeetingNotFoundError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "NOT_FOUND", "message": str(exc)},
        ) from exc


def _valid_uuid(value: str) -> bool:
    try:
        UUID(value)
        return True
    except (ValueError, AttributeError, TypeError):
        return False


def _require_uuid(value: str, message: str) -> str:
    """형식이 틀린 id는 존재 여부를 가리지 않고 404 — 자원 열거를 막는다(bm/router와 같은 규약)."""
    if not _valid_uuid(value):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail={"code": "NOT_FOUND", "message": message}
        )
    return value


def _out(
    db: Session, meeting, viewer_org_id: str, *, locale: str = DEFAULT_LOCALE
) -> MeetingOut:
    return MeetingOut.model_validate(service.serialize(db, meeting, viewer_org_id, locale=locale))


# =============================================================================
# 목록 / 가용 슬롯 / 단건
# =============================================================================
@router.get("", response_model=MeetingListResponse)
def list_meetings(
    event_id: str | None = Query(default=None),
    status_filter: list[str] | None = Query(default=None, alias="status"),
    limit: int = Query(default=20, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    locale: str = Query(default=DEFAULT_LOCALE),
    principal: Principal = Depends(get_current_principal),
    db: Session = Depends(get_session),
) -> MeetingListResponse:
    """내 org가 낀 미팅 목록(최신순). ``status``는 반복 지정 가능(``?status=proposed&status=accepted``).

    ``locale``(ko|en)은 **응답 키가 아니라 값**을 고른다(탐색·가용성과 같은 규약) — en이면
    ``counterpart_name``이 영문 기업명(없으면 국문명)으로, 부스 장소의 ``venue_label``이 영문 표기
    (``"{기업명} Booth"``·``"Hall 7 A-12"``)로 온다. 저장값은 바뀌지 않고, 생략·모르는 값은 ko다.
    """
    with _domain_errors():
        rows, total = service.list_meetings(
            db,
            principal=principal,
            event_id=event_id,
            statuses=status_filter,
            limit=limit,
            offset=offset,
        )
        views = service.build_views(db, rows, principal.organization_id, locale=locale)
    return MeetingListResponse(
        items=[MeetingOut.model_validate(service.view_to_dict(v)) for v in views],
        total=total,
        limit=limit,
        offset=offset,
    )


# ⚠ 이 라우트는 반드시 ``/{meeting_id}`` **앞에** 선언돼야 한다. 뒤에 두면 "availability"가
#   meeting_id 경로 파라미터로 먹혀 404가 난다(FastAPI는 선언 순서대로 매칭한다).
#   test_meetings_availability.py에 선언 순서 회귀 테스트가 있다.
@router.get("/availability", response_model=AvailabilityOut)
def get_availability(
    counterpart_org_id: str = Query(...),
    event_id: str | None = Query(default=None),
    slot_ids: list[str] | None = Query(default=None),
    my_role: str | None = Query(default=None),
    locale: str = Query(default="ko"),
    principal: Principal = Depends(get_current_principal),
    db: Session = Depends(get_session),
) -> AvailabilityOut:
    """상대 기업과의 가용 슬롯·장소·신청사유 초안. ``slot_ids``를 주면 장소 가용을 그 시간 기준으로."""
    with _domain_errors():
        payload = service.build_availability(
            db,
            principal=principal,
            counterpart_org_id=counterpart_org_id,
            event_id=event_id,
            slot_ids=slot_ids,
            my_role=my_role,
            locale=locale,
        )
    return AvailabilityOut.model_validate(payload)


@router.get("/{meeting_id}", response_model=MeetingOut)
def get_meeting(
    meeting_id: str,
    locale: str = Query(default=DEFAULT_LOCALE),
    principal: Principal = Depends(get_current_principal),
    db: Session = Depends(get_session),
) -> MeetingOut:
    """단건 — 참가 당사자만. 없는 id/형식 오류는 404, 남의 미팅은 403. ``locale``은 목록과 같다."""
    _require_uuid(meeting_id, "미팅을 찾을 수 없습니다")
    with _domain_errors():
        meeting = service.get_participant_meeting(db, meeting_id, principal.organization_id)
        return _out(db, meeting, principal.organization_id, locale=locale)


# =============================================================================
# 신청 / 응답
# =============================================================================
@router.post("", response_model=MeetingOut, status_code=status.HTTP_201_CREATED)
def create_meeting(
    body: MeetingCreateIn,
    principal: Principal = Depends(get_current_principal),
    db: Session = Depends(get_session),
) -> MeetingOut:
    """미팅 신청. 수신측 유형에 따라 즉시 확정(accepted)되거나 수락대기(proposed)로 들어간다."""
    with _domain_errors():
        meeting = service.create_meeting(
            db,
            principal=principal,
            counterpart_org_id=body.counterpart_org_id,
            slot_ids=body.slot_ids,
            venue_type=body.venue_type,
            venue_label=body.venue_label,
            event_id=body.event_id,
            my_role=body.my_role,
            request_reason=body.request_reason,
        )
        return _out(db, meeting, principal.organization_id)


@router.post("/{meeting_id}/accept", response_model=MeetingOut)
def accept_meeting(
    meeting_id: str,
    body: MeetingAcceptIn | None = None,
    principal: Principal = Depends(get_current_principal),
    db: Session = Depends(get_session),
) -> MeetingOut:
    """수락 — 응답 대기 중인 당사자만. 수락 시점에 슬롯/장소 점유를 재검증한다."""
    _require_uuid(meeting_id, "미팅을 찾을 수 없습니다")
    payload = body or MeetingAcceptIn()
    with _domain_errors():
        meeting = service.accept_meeting(
            db,
            principal=principal,
            meeting_id=meeting_id,
            attendee_member_ids=payload.attendee_member_ids,
        )
        return _out(db, meeting, principal.organization_id)


@router.post("/{meeting_id}/reject", response_model=MeetingOut)
def reject_meeting(
    meeting_id: str,
    body: MeetingRejectIn,
    principal: Principal = Depends(get_current_principal),
    db: Session = Depends(get_session),
) -> MeetingOut:
    """거절 — 응답 대기 중인 당사자만. 알림은 발화하지 않는다(알림 6종에 거절 타입 부재)."""
    _require_uuid(meeting_id, "미팅을 찾을 수 없습니다")
    with _domain_errors():
        meeting = service.reject_meeting(
            db,
            principal=principal,
            meeting_id=meeting_id,
            reason_code=body.reason_code,
            reason_text=body.reason_text,
        )
        return _out(db, meeting, principal.organization_id)


@router.post("/{meeting_id}/cancel", response_model=MeetingOut)
def cancel_meeting(
    meeting_id: str,
    body: MeetingCancelIn,
    principal: Principal = Depends(get_current_principal),
    db: Session = Depends(get_session),
) -> MeetingOut:
    """취소 — 수락대기면 신청측만, 확정이면 양측 누구나."""
    _require_uuid(meeting_id, "미팅을 찾을 수 없습니다")
    with _domain_errors():
        meeting = service.cancel_meeting(
            db,
            principal=principal,
            meeting_id=meeting_id,
            reason_code=body.reason_code,
            reason_text=body.reason_text,
        )
        return _out(db, meeting, principal.organization_id)


@router.put("/{meeting_id}/participants", response_model=MeetingOut)
def set_participants(
    meeting_id: str,
    body: MeetingParticipantsIn,
    principal: Principal = Depends(get_current_principal),
    db: Session = Depends(get_session),
) -> MeetingOut:
    """내 org 참석자 명단 치환 — 본인 소속 담당자만 지정할 수 있다."""
    _require_uuid(meeting_id, "미팅을 찾을 수 없습니다")
    with _domain_errors():
        meeting = service.set_participants(
            db, principal=principal, meeting_id=meeting_id, member_ids=body.member_ids
        )
        return _out(db, meeting, principal.organization_id)


__all__ = ["router", "schemas"]
