"""기업 탐색 HTTP 엔드포인트 — ``/api/discover`` + ``/api/me``.

모든 라우트가 ``get_current_principal``을 통과한다(미팅·BM과 같은 인증 경로). 권한의 닻은
``Principal.organization_id`` — 뷰어가 어느 기업으로 보는지가 열람 범위를 결정한다.

**에러 바디 규약**(미팅 라우터와 동일)::

    {"detail": {"code": "NOT_VISIBLE", "message": "이 기업은 열람할 수 없습니다."}}

코드 목록: EVENT_AMBIGUOUS(400) · NOT_PARTICIPANT(403) · PROFILE_NOT_APPROVED(403) ·
NOT_VISIBLE(403) · NOT_FOUND(404).

``/api/me``가 별도 라우터인 건 경로 때문이다 — ``/api/discover`` prefix를 공유할 수 없다. 슬라이스를
쪼개지 않는 이유는 ``app/discover/__init__.py`` 참고(같은 역할 행 조회를 쓰는 뷰어 컨텍스트).
"""

from __future__ import annotations

from contextlib import contextmanager
from typing import Iterator
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy.orm import Session

from app.auth.principal import Principal, get_current_principal
from app.db import get_session
from app.discover import service
from app.discover.schemas import (
    BookmarkCreateBody,
    BookmarkListResponse,
    BookmarkOut,
    DiscoverListResponse,
    DiscoverOrgOut,
    MeOut,
)

router = APIRouter(prefix="/api/discover", tags=["discover"])
me_router = APIRouter(prefix="/api/me", tags=["me"])


@contextmanager
def _domain_errors() -> Iterator[None]:
    """도메인 예외 → HTTP. 코드 바디 규약을 여기 한 곳에서만 만든다."""
    try:
        yield
    except service.DiscoverError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.to_detail()) from exc
    except service.DiscoverNotFoundError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "NOT_FOUND", "message": str(exc)},
        ) from exc


def _require_uuid(value: str, message: str) -> str:
    """형식이 틀린 id는 존재 여부를 가리지 않고 404 — 자원 열거를 막는다(미팅·BM과 같은 규약)."""
    try:
        UUID(value)
    except (ValueError, AttributeError, TypeError):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "NOT_FOUND", "message": message},
        ) from None
    return value


@router.get("/organizations", response_model=DiscoverListResponse)
def list_organizations(
    event_id: str | None = Query(default=None),
    locale: str = Query(default=service.DEFAULT_LOCALE),
    principal: Principal = Depends(get_current_principal),
    db: Session = Depends(get_session),
) -> DiscoverListResponse:
    """열람 가능한 참가기업 목록. ``event_id``는 참가 행사가 하나면 생략할 수 있다.

    dual-role 기업은 보이는 역할마다 카드가 하나씩 나온다 — ``total``은 기업 수가 아니라 카드 수다.

    ``locale``(ko|en)은 **응답 키가 아니라 값**을 고른다 — en이면 기업명·소개·키워드·전시품목이
    영문 컬럼으로 채워지고, 영문이 없으면 국문으로 폴백한다. 모르는 값은 422가 아니라 ko로
    접는다(``service.normalize_locale``): 로케일은 권한이 아니라 표시 선택지라, 오타 하나로
    화면이 통째로 에러가 되는 편이 더 나쁘다.
    """
    with _domain_errors():
        items, total = service.list_organizations(
            db, principal=principal, event_id=event_id, locale=locale
        )
    return DiscoverListResponse(
        items=[DiscoverOrgOut.model_validate(item) for item in items], total=total
    )


@router.get("/organizations/{org_id}", response_model=DiscoverOrgOut)
def get_organization(
    org_id: str,
    event_id: str | None = Query(default=None),
    locale: str = Query(default=service.DEFAULT_LOCALE),
    principal: Principal = Depends(get_current_principal),
    db: Session = Depends(get_session),
) -> DiscoverOrgOut:
    """기업 카드 단건. 자기 기업이면 가시성 검사 없이 열린다(내 카드 미리보기).

    타 기업은 미승인/미참가면 404(존재 은닉), 열람 범위 밖이면 403 NOT_VISIBLE.
    ``locale``의 의미는 목록과 같다(키 불변, 값만 선택).
    """
    _require_uuid(org_id, "기업을 찾을 수 없습니다")
    with _domain_errors():
        card = service.get_organization(
            db, principal=principal, org_id=org_id, event_id=event_id, locale=locale
        )
    return DiscoverOrgOut.model_validate(card)


@router.get("/bookmarks", response_model=BookmarkListResponse)
def list_bookmarks(
    event_id: str | None = Query(default=None),
    principal: Principal = Depends(get_current_principal),
    db: Session = Depends(get_session),
) -> BookmarkListResponse:
    """내(뷰어 org)가 이 행사에서 담은 관심기업 전부 — 최근 담은 순."""
    with _domain_errors():
        items = service.list_bookmarks(db, principal=principal, event_id=event_id)
    return BookmarkListResponse(items=[BookmarkOut.model_validate(item) for item in items])


@router.post("/bookmarks", response_model=BookmarkOut, status_code=status.HTTP_201_CREATED)
def create_bookmark(
    body: BookmarkCreateBody,
    event_id: str | None = Query(default=None),
    principal: Principal = Depends(get_current_principal),
    db: Session = Depends(get_session),
) -> BookmarkOut:
    """관심기업 등록(멱등) — 이미 담겨 있으면 기존 행을 그대로 돌려준다(원래 출처 보존)."""
    org_id = _require_uuid(body.target_org_id, "기업을 찾을 수 없습니다")
    with _domain_errors():
        item = service.add_bookmark(
            db, principal=principal, event_id=event_id, target_org_id=org_id, source=body.source
        )
    return BookmarkOut.model_validate(item)


@router.delete("/bookmarks/{org_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_bookmark(
    org_id: str,
    event_id: str | None = Query(default=None),
    principal: Principal = Depends(get_current_principal),
    db: Session = Depends(get_session),
) -> Response:
    """관심기업 해제(멱등) — 담겨 있지 않아도 204."""
    org_id = _require_uuid(org_id, "기업을 찾을 수 없습니다")
    with _domain_errors():
        service.remove_bookmark(db, principal=principal, event_id=event_id, target_org_id=org_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@me_router.get("", response_model=MeOut)
def get_me(
    principal: Principal = Depends(get_current_principal),
    db: Session = Depends(get_session),
) -> MeOut:
    """현재 주체의 소속 기업과 참가 역할 전부 — 화면이 승인 상태를 아는 유일한 경로."""
    return MeOut.model_validate(service.build_me(db, principal=principal))


__all__ = ["me_router", "router"]
