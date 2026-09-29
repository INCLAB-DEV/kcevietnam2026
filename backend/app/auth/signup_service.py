"""자체 회원가입 서비스 로직(개발계획서 §7.3) — ADR-0007 "공개 자체 회원가입은 열지 않는다"를
발주자 지시로 부분 supersede한다: **회원가입으로는 참가사(exhibitor)/바이어(buyer)만 될 수 있다.**
슈퍼어드민(event master)은 어떤 API로도 생성되지 않는다 — 오직 DB에서 직접 부여한다(운영 절차는
backend/README.md "슈퍼어드민 부여" 절 참고). 서브어드민 부여·참가 기업 역할 전환은 슈퍼어드민
전용 관리자 API(app.admin.router/service)가 담당하며, 이 모듈은 손대지 않는다.

**약관 동의는 이 서비스가 다루지 않는다.** 가입 시점엔 아직 세션이 없고, 기존 로그인 트랜잭션
(app.auth.login_router / ADR-0011)이 이미 "최초 로그인 시 약관 동의를 받고 게이트된 계정을 낸다"는
흐름을 갖고 있다 — 자체가입 회원의 첫 로그인도 그 흐름을 그대로 탄다(LocalCredentialVerifier가
검증에 성공하면 Cognito 풀에 계정이 없어 consent_required로 분기). 가입 API에 별도 동의 필드를
추가해 이중으로 관리하는 대신, 기존 게이트에 위임한다(복잡도 판단 — 작업 지시서의 "복잡하면 로그인
게이트에 맡기고 주석으로 명시" 조항).
"""

from __future__ import annotations

from datetime import date

from sqlalchemy import select
from sqlalchemy.orm import Session

# 비밀번호 해시(bcrypt)는 명단 업로드 공통 비밀번호(app.roster)와 공유하는 단일 정본을 쓴다.
from app.auth.credentials import hash_password
from app.auth.login_ticket import LoginTicketService
from app.auth.signup_schemas import SignupRequest
from app.models import Event, Member, Organization, OrganizationEventRole


class DuplicateEmailError(Exception):
    """이미 가입된 이메일 — 409 매핑."""


class EventNotFoundError(Exception):
    """지정된 event_id가 존재하지 않음 — 404 매핑."""


class NoActiveEventError(Exception):
    """event_id 미지정인데 가입시킬 행사가 DB에 하나도 없음 — 404 매핑."""


class InvalidVerificationTokenError(Exception):
    """이메일 인증 토큰이 위조·만료·소진됐거나 가입 email과 일치하지 않음 — 403 매핑(#9)."""


def resolve_signup_event(db: Session, event_id: str | None) -> Event:
    """가입 대상 행사를 정한다 — 지정 시 그 행사(없으면 404), 미지정 시 "진행 중인 최신 event".

    "진행 중"은 application_start~application_end 신청기간 안에 오늘이 든 행사를 최우선으로 하고,
    그런 행사가 없으면(신청기간을 아직 안 채운 신규 행사 등) 가장 최근 생성된 행사로 폴백한다 —
    작업 지시서에 정확한 정의가 없어 이렇게 해석했다(판단 — 신청기간 미설정 신규 행사도 가입
    대상에서 배제하지 않기 위함).
    """
    if event_id:
        event = db.get(Event, event_id)
        if event is None:
            raise EventNotFoundError(f"행사 {event_id!r}를 찾을 수 없습니다")
        return event

    events = db.execute(select(Event).order_by(Event.created_at.desc())).scalars().all()
    if not events:
        raise NoActiveEventError("가입할 수 있는 행사가 없습니다")

    today = date.today().isoformat()
    for event in events:
        # 드라이버는 Date 컬럼을 datetime.date로 돌려준다(모델의 Mapped[str] 표기와 무관) —
        # str과 섞어 비교하면 TypeError라 양쪽을 ISO 문자열로 정규화한다.
        start = event.application_start
        end = event.application_end
        start = start.isoformat() if isinstance(start, date) else start
        end = end.isoformat() if isinstance(end, date) else end
        if start and end and start <= today <= end:
            return event
    return events[0]  # 신청기간 내 행사가 없으면 가장 최근 생성 행사로 폴백


def signup(db: Session, data: SignupRequest, ticket_service: LoginTicketService) -> None:
    """자체 회원가입 — Organization 신규 생성 → Member(비번 해시 포함) → OrganizationEventRole(registered).

    동일 org_name+이메일 도메인이면 기존 조직에 합류시키는 정책은 v2로 미룬다(지시) — 지금은 매
    가입이 새 Organization을 만든다. 이메일 중복은 members.email UNIQUE 제약(기존 스키마,
    416bbb825e07부터 NOT NULL UNIQUE)에 기대지 않고 사전 조회로 명확한 409 메시지를 낸다
    (제약 위반 IntegrityError를 그대로 노출하지 않기 위해).

    #9(가입 이메일 실존 인증): ``data.email_verification_token``이 먼저 검증된다 — 위조·만료·
    소진이거나 토큰에 묶인 email이 가입 email과 다르면 InvalidVerificationTokenError. 토큰은
    ``POST /api/auth/signup/email-code/verify``가 발급하며(app.auth.email_verification_service),
    ``ticket_service``는 그 발급에 쓰인 것과 **같은 프로세스 단일 인스턴스**여야 한다(app.auth.
    signup_router가 두 엔드포인트에 동일 singleton을 주입).
    """
    result = ticket_service.verify(data.email_verification_token)
    if not result.allowed or (result.payload or {}).get("email") != data.email:
        raise InvalidVerificationTokenError("이메일 인증이 필요합니다. 인증코드를 먼저 확인해주세요")

    existing = db.execute(select(Member).where(Member.email == data.email)).scalar_one_or_none()
    if existing is not None:
        raise DuplicateEmailError(f"이미 가입된 이메일입니다: {data.email}")

    event = resolve_signup_event(db, data.event_id)

    org = Organization(name_ko=data.org_name_ko, name_en=data.org_name_en)
    db.add(org)
    db.flush()  # org.id 확보 → 아래 FK에 즉시 사용

    member = Member(
        organization_id=org.id,
        name=data.name,
        email=data.email,
        phone=data.phone,
        password_hash=hash_password(data.password),
    )
    db.add(member)

    role = OrganizationEventRole(
        organization_id=org.id,
        event_id=event.id,
        is_exhibitor=(data.role == "exhibitor"),
        is_buyer=(data.role == "buyer"),
        # application_status는 컬럼 서버 디폴트 'registered'(=미신청)를 그대로 쓴다.
    )
    db.add(role)
    db.commit()
