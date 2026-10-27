"""알림 인박스 HTTP 엔드포인트 (F-NT-001, ADR-0010) — org 공유 인박스 조회/읽음 처리.

- ``GET /api/notifications`` — 커서 페이지네이션 + 안읽음 수.
- ``POST /api/notifications/{id}/read`` — 단건 읽음(org 공유, 최초 읽은 주체 보존).
- ``POST /api/notifications/read-all`` — 안읽음 전체 읽음.

인증은 미팅·리뷰 슬라이스와 같은 ``get_current_principal``이다. 읽은 주체(``read_by_member_id``)도
**요청 바디가 아니라 세션에서** 나온다 — 예전에는 ``X-Org-Id`` placeholder에 member 원천이 없어
클라이언트가 ``member_id``를 자기신고했는데, 그러면 "누가 먼저 읽었는가"라는 감사 기록을 읽는
사람이 스스로 써넣는 셈이라 기록으로서 의미가 없었다.
"""

from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from app.auth.principal import Principal, get_current_principal
from app.db import get_session
from app.display_locale import DEFAULT_LOCALE
from app.notifications import service
from app.notifications.schemas import (
    InboxResponse,
    MarkAllReadResponse,
    NotificationOut,
)

router = APIRouter(prefix="/api/notifications", tags=["notifications"])


def _is_uuid(value: str) -> bool:
    try:
        UUID(value)
        return True
    except (ValueError, AttributeError, TypeError):
        return False


def _out(
    notification, names: dict[str, str], payloads: dict[str, dict] | None = None
) -> NotificationOut:
    """ORM 행 + 이름 맵 → 응답 모델. ``read_by_member_name``만 ORM 밖에서 얹는다.

    ``model_copy(update=...)``를 쓰는 건 ``NotificationOut``이 ``from_attributes``라 ORM에 없는
    속성을 검증 단계에서 채울 수 없기 때문이다. 이름 해석을 ORM 관계로 만들지 않는 건 의도적
    이다 — lazy 관계를 달면 목록 조회가 조용히 N+1로 돌아간다(service.read_by_member_names 참고).

    ``payloads``는 표시 로케일로 옮긴 payload 사본이다(service.localized_payloads) — 있으면 저장된
    스냅샷 대신 그 사본을 싣는다. ORM 행의 payload를 직접 바꾸지 않는 것도 같은 이유다: 세션이
    그 변경을 더티로 보고 스냅샷을 덮어쓴다.
    """
    update: dict = {"read_by_member_name": names.get(notification.read_by_member_id or "")}
    localized = (payloads or {}).get(str(notification.id))
    if localized is not None:
        update["payload"] = localized
    return NotificationOut.model_validate(notification).model_copy(update=update)


def _read_by_member_id(principal: Principal) -> str | None:
    """읽음 주체로 기록할 member id — **UUID 주체일 때만**.

    ``notifications.read_by_member_id``는 ``members.id`` FK(uuid)다. 데모 토큰의 subject
    (``mbr-buyer-01`` 등)는 명단 적재층(``registrants.organizer_member_id``) 키라 members 행이
    아니다 — 그대로 넣으면 22P02/FK 위반으로 읽음 처리가 500이 된다. 기록할 수 없는 주체는
    ``None``으로 두고 읽은 **시각**만 남긴다: 읽음은 org 공유 상태라 주체 없이도 성립한다.
    """
    return principal.member_id if _is_uuid(principal.member_id) else None


@router.get("", response_model=InboxResponse)
def list_notifications(
    limit: int = 20,
    cursor: str | None = None,
    locale: str = Query(default=DEFAULT_LOCALE),
    principal: Principal = Depends(get_current_principal),
    db: Session = Depends(get_session),
) -> InboxResponse:
    """org 공유 인박스. ``locale``(ko|en)은 payload의 **값**만 고른다(탐색·미팅과 같은 규약) —
    en이면 기업명이 영문명으로, 부스 장소 라벨이 영문 표기로 온다. 문장 자체는 화면이 카탈로그로
    조립한다. 생략·모르는 값은 ko(저장된 스냅샷 그대로)다."""
    # 형식이 틀린 커서는 에러가 아니라 "커서 없음"으로 관대하게 처리(첫 페이지 취급).
    if cursor is not None and not _is_uuid(cursor):
        cursor = None
    items, unread_count, next_cursor = service.list_inbox(
        db, principal.organization_id, limit=limit, cursor=cursor
    )
    names = service.read_by_member_names(db, items)
    payloads = service.localized_payloads(
        db, items, org_id=principal.organization_id, locale=locale
    )
    return InboxResponse(
        items=[_out(n, names, payloads) for n in items],
        unread_count=unread_count,
        next_cursor=next_cursor,
    )


@router.post("/{notification_id}/read", response_model=NotificationOut)
def mark_notification_read(
    notification_id: str,
    principal: Principal = Depends(get_current_principal),
    db: Session = Depends(get_session),
) -> NotificationOut:
    # 형식이 틀린 id는 존재 여부를 가리지 않고 404(bm 슬라이스와 동일 관례).
    if not _is_uuid(notification_id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="알림 없음")
    n = service.mark_read(
        db,
        principal.organization_id,
        notification_id,
        member_id=_read_by_member_id(principal),
    )
    if n is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="알림 없음")
    return _out(n, service.read_by_member_names(db, [n]))


@router.post("/read-all", response_model=MarkAllReadResponse)
def mark_all_notifications_read(
    principal: Principal = Depends(get_current_principal),
    db: Session = Depends(get_session),
) -> MarkAllReadResponse:
    updated = service.mark_all_read(
        db, principal.organization_id, member_id=_read_by_member_id(principal)
    )
    return MarkAllReadResponse(updated_count=updated)
