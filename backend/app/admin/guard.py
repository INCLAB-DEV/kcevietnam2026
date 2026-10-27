"""어드민 인가 — organizer_guard(#47/ADR-0012)의 포트를 재사용해 master+sub 겸용 가드를 얹는다.

``app.auth.organizer_guard``는 ``require_event_master``(master 전용)만 제공한다 — sub는 "자기
관할 콘솔(별도 슬라이스)에서 scope 가드로 다뤄진다"고 그 모듈 자체가 예고해 둔 자리다(같은 파일
docstring 참고). 이 모듈이 그 예고된 슬라이스: **읽기는 master+sub 겸용**(관할 필터는 호출부가
``EventOperatorPrincipal.organizer_id``로 적용), **쓰기는 여전히 ``require_event_master`` 그대로
재사용**한다(이 모듈은 쓰기 가드를 새로 만들지 않는다). 예외가 ``require_existing_master_identity``
(행사 **생성** 전용) — "어디선가 이미 master인 운영자"만 새 행사를 만들 수 있게 이 모듈이 새로
얹은 부트스트랩 가드다(발주자 권한 원칙 "슈퍼어드민은 DB에서만 부여"와 정합, 아래 정의부 참고).

organizer_guard.py 파일 자체는 건드리지 않는다 — ``SessionAuthenticator``/``EventOperatorDirectory``
포트와 그 FastAPI 의존성(``get_authenticator``/``get_operator_directory``)만 가져다 쓴다(공개 API).

**운영자 신원 브릿지**: 가드가 돌려주는 건 "회원ID"(``member_id``, Cognito sub와 동일 키 — 도메인
``Member.id``와는 다른 공간)뿐이라, ``organizers`` 테이블 FK(예: 대리작성 감사 컬럼
``proxy_written_by_organizer_id``, sub 관할 판정에 쓰는 ``managing_organizer_id``)를 채우려면
실제 ``Organizer`` 행이 필요하다. 실 Cognito 운영자 어댑터가 아직 없어(organizer_guard 자체가
문서화한 갭 — ``get_authenticator``/``get_operator_directory``는 cognito 모드에서 fail-closed) 이
매핑 테이블도 아직 없다. ``resolve_organizer_id``가 ``organizers.member_id``(이번 변경으로 추가)를
키로 get-or-create해 다리를 놓는다 — 실 Cognito 배선이 들어오면 이 자리를 실 매핑 조회로 교체한다.
"""

from __future__ import annotations

from dataclasses import dataclass

from fastapi import Depends, Header, HTTPException
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.auth.organizer_guard import (
    PERMISSION_MASTER,
    PERMISSION_SUB,
    EventOperatorDirectory,
    SessionAuthenticator,
    UnauthenticatedError,
    get_authenticator,
    get_operator_directory,
)
from app.db import get_session
from app.models import EventOrganizer, Organizer

_OPERATOR_LEVELS = (PERMISSION_MASTER, PERMISSION_SUB)


def resolve_organizer_id(db: Session, member_id: str) -> str:
    """member_id(회원ID) → organizers.id. 없으면 get-or-create(운영자 신원 브릿지, 위 모듈 docstring).

    이름/이메일은 자리표시자(placeholder) — 실 운영자 프로필 입력 UI가 생기면 그쪽이 채운다.
    이 함수는 identity 앵커만 보장한다(FK 채우기 목적).

    race condition 방지: 동시 요청이 같은 member_id로 들어와도 안전하도록, INSERT 충돌 시 재조회.
    """
    organizer = db.execute(select(Organizer).where(Organizer.member_id == member_id)).scalar_one_or_none()
    if organizer is not None:
        return organizer.id
    try:
        organizer = Organizer(name=f"운영자 {member_id}", email=f"{member_id}@organizer.nabi.local", member_id=member_id)
        db.add(organizer)
        db.flush()
        return organizer.id
    except IntegrityError:
        # 다른 동시 요청이 같은 member_id로 INSERT 완료 — 트랜잭션 롤백 후 재조회
        db.rollback()
        organizer = db.execute(select(Organizer).where(Organizer.member_id == member_id)).scalar_one()
        return organizer.id


@dataclass(frozen=True, slots=True)
class OperatorPrincipal:
    """행사에 국한되지 않는 운영자 신원 — 행사 목록 조회·행사 생성처럼 아직 event_id가 없는 경로용."""

    member_id: str
    organizer_id: str


@dataclass(frozen=True, slots=True)
class EventOperatorPrincipal:
    """이 행사의 master 또는 sub. sub는 관할 필터(``organizer_id``)를 호출부가 적용해야 한다."""

    member_id: str
    event_id: str
    permission_level: str  # 'master' | 'sub'
    organizer_id: str

    @property
    def is_master(self) -> bool:
        return self.permission_level == PERMISSION_MASTER


def _identify(authenticator: SessionAuthenticator, authorization: str | None) -> str:
    try:
        return authenticator.identify(authorization)
    except UnauthenticatedError as exc:
        raise HTTPException(status_code=401, detail="인증이 필요합니다.") from exc


def require_operator_identity(
    authorization: str | None = Header(default=None),
    authenticator: SessionAuthenticator = Depends(get_authenticator),
    db: Session = Depends(get_session),
) -> OperatorPrincipal:
    """행사 무관 운영자 신원만 — 행사 목록(자기가 organizer로 등록된 행사들)·행사 생성(부트스트랩)용.

    아직 어떤 행사의 master/sub인지 묻지 않는다(그 질문 자체가 event_id를 요구하므로 여기선 불가).
    행사 **생성**은 이 신원만으로 허용하고, 생성자를 그 행사의 master로 자동 배정한다(app.admin.service.
    create_event) — "슈퍼어드민이 행사마다 새로 만든다"는 새 행사엔 아직 event_organizers 행이 없어
    사전 배정을 전제로 게이트할 수 없기 때문. 기존 행사 개별 조작(PATCH 등)은 여전히
    ``require_event_master``/``require_event_operator``로 그 행사 권한을 검사한다.
    """
    member_id = _identify(authenticator, authorization)
    organizer_id = resolve_organizer_id(db, member_id)
    return OperatorPrincipal(member_id=member_id, organizer_id=organizer_id)


def require_assigned_operator(
    authorization: str | None = Header(default=None),
    authenticator: SessionAuthenticator = Depends(get_authenticator),
    db: Session = Depends(get_session),
) -> OperatorPrincipal:
    """"이미 어느 행사엔가 배정된 운영자"만 통과 — ``GET /api/admin/me`` 전용 신원 가드.

    ``require_operator_identity``와 다른 점은 **get-or-create를 하지 않는다**는 것이다. 저쪽은
    행사 목록/생성 경로라 신원 앵커를 만들어야 하지만, "내 신원·권한을 알려달라"는 조회는 아무
    회원이나 부르면 그 회원 몫의 ``organizers`` 행을 새로 파버린다(참가자가 호출해도 운영자
    자리표시자가 생긴다). 그래서 여기서는 **기존 행을 찾기만** 하고, ``event_organizers`` 배정이
    하나도 없으면 403으로 닫는다(fail-closed) — 배정이 없다는 건 어느 행사의 운영자도 아니라는 뜻이다.

    권한등급(master/sub)은 행사별이므로(ADR-0012) 이 가드는 등급을 판정하지 않는다. 등급은
    응답 본문이 행사별로 실어 보내고(``app.admin.service.build_admin_me``), 실제 조작의 권위는
    여전히 ``require_event_master``/``require_event_operator``가 쥔다 — 이 응답은 화면 표시용이다.
    """
    member_id = _identify(authenticator, authorization)
    organizer = db.execute(select(Organizer).where(Organizer.member_id == member_id)).scalar_one_or_none()
    if organizer is None or not _has_any_assignment(db, organizer.id):
        raise HTTPException(status_code=403, detail="운영자 권한이 필요합니다.")
    return OperatorPrincipal(member_id=member_id, organizer_id=organizer.id)


def _has_any_assignment(db: Session, organizer_id: str) -> bool:
    """이 운영자가 어느 행사엔가 (등급 무관) 배정돼 있는가 — ``require_assigned_operator`` 전용 질의."""
    return (
        db.execute(select(EventOrganizer.id).where(EventOrganizer.organizer_id == organizer_id)).first()
        is not None
    )


def _has_master_assignment(db: Session, organizer_id: str) -> bool:
    """이 운영자가 (행사 무관) 어디선가 master로 배정돼 있는가 — 행사 생성 게이트(아래) 전용 질의."""
    return (
        db.execute(
            select(EventOrganizer.id).where(
                EventOrganizer.organizer_id == organizer_id,
                EventOrganizer.permission_level == PERMISSION_MASTER,
            )
        ).first()
        is not None
    )


def require_existing_master_identity(
    authorization: str | None = Header(default=None),
    authenticator: SessionAuthenticator = Depends(get_authenticator),
    db: Session = Depends(get_session),
) -> OperatorPrincipal:
    """행사 **생성** 전용 신원 가드 — "어디선가 이미 master인 운영자"만 통과시킨다.

    발주자 권한 원칙("슈퍼어드민은 DB에서만 부여")과 정합하려면 아무 운영자나 새 행사를 만들어
    스스로 그 행사의 master가 되는 구멍을 막아야 한다(크로스리뷰 지적). 최초 부트스트랩 master는
    이 API로 만들 수 없다 — organizers/event_organizers에 **DB로 직접 INSERT**한다(운영 절차는
    backend/README.md "슈퍼어드민 부여" 절). 이 가드는 그 이후의 자기증식(이미 master인 사람이
    또 다른 행사를 만드는 것)만 API로 허용한다.

    ``require_operator_identity``(행사 목록 조회 등 신원만 필요한 다른 경로)는 그대로 둔다 —
    목록 조회까지 master로 좁히면 sub 운영자가 자기 행사 목록도 못 보는 과도한 제약이 된다. 이
    가드는 행사 **생성**(``POST /events``)에만 붙는다.
    """
    member_id = _identify(authenticator, authorization)
    organizer_id = resolve_organizer_id(db, member_id)
    if not _has_master_assignment(db, organizer_id):
        raise HTTPException(status_code=403, detail="행사 생성은 슈퍼어드민 권한입니다.")
    return OperatorPrincipal(member_id=member_id, organizer_id=organizer_id)


def require_event_operator(
    event_id: str,
    authorization: str | None = Header(default=None),
    authenticator: SessionAuthenticator = Depends(get_authenticator),
    directory: EventOperatorDirectory = Depends(get_operator_directory),
    db: Session = Depends(get_session),
) -> EventOperatorPrincipal:
    """읽기 전용 어드민 라우트 가드 — 이 행사의 master **또는** sub만 통과(그 외 401/403).

    master/sub 여부만 가른다 — 관할(sub가 어떤 바이어까지 볼 수 있는지) 판정은 호출부가
    ``organizer_id``로 별도 적용한다(ADR-0012, 이 함수는 "이 행사의 운영자인가"만 검사).
    """
    member_id = _identify(authenticator, authorization)
    level = directory.permission_level(member_id, event_id)
    if level not in _OPERATOR_LEVELS:
        raise HTTPException(status_code=403, detail="이 행사의 운영자 권한이 필요합니다.")
    organizer_id = resolve_organizer_id(db, member_id)
    return EventOperatorPrincipal(
        member_id=member_id, event_id=event_id, permission_level=level, organizer_id=organizer_id
    )
