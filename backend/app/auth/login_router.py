"""login-router — 접힌 로그인 트랜잭션 엔드포인트(F-AU-001, #23 slice A, ADR-0011).

기존 deep module들(검증·매핑·세션·역할분기)과 새 포트(ConsentGate·LoginTicketService)를
**얇게 엮어** 두 HTTP 단계로 노출한다:

- ``POST /api/auth/login/start`` — 아이디/비번 검증 → 매핑 → (재방문이면) 세션 발급해 succeeded,
  (최초면) 약관 목록 + 일회성 login_ticket을 주고 consent_required.
- ``POST /api/auth/login/complete`` — login_ticket을 소진하고 동의를 기록해 세션을 발급(succeeded),
  필수 미동의면 consent_incomplete, 티켓이 위조·만료·소진이면 ticket_invalid.

비즈니스 분기는 항상 200으로 노출한다(거부도 결과 — 422는 본문 형식 오류에만). 라우트/역할은
``role_branch.decide_route``가, 세션 발급은 ``session_issue.issue_session``이 소유한다.

포트는 모두 FastAPI 의존성으로 주입해 테스트가 ``dependency_overrides``로 더블을 꽂을 수 있다.
``LoginTicketService``·``CognitoUserPool``은 두 단계가 상태를 공유해야 하므로 **프로세스 단일
인스턴스**다(데모 시드 포함). 데모 자격증명은 dev/test 전용 시드라 deps 팩토리에만 둔다.
"""

from __future__ import annotations

from functools import lru_cache
from typing import Any, Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth.consent_gate import ConsentDoc, ConsentGate, InMemoryConsentGate
from app.auth.dx_korea_verify import (
    DxKoreaVerifier,
    StubDxKoreaVerifier,
    VerifyOk,
)
from app.auth.local_verify import (
    ChainedRegistrantDirectory,
    ChainedVerifier,
    LocalCredentialVerifier,
    LocalRegistrantDirectory,
)
from app.auth.login_ticket import LoginTicketService
from app.auth.registrant_mapping import (
    InMemoryRegistrantDirectory,
    RegistrantDirectory,
    RegistrantNotFoundError,
    RegistrantRef,
    map_member_to_registrant,
)
from app.auth.role_branch import (
    ROLE_BUYER,
    ROLE_EXHIBITOR,
    decide_route,
)
from app.auth.session_issue import (
    CognitoUserPool,
    InMemoryCognitoUserPool,
    SessionResult,
    issue_session,
)
from app.config import settings
from app.db import get_session
from app.models import EventOrganizer, Organizer

router = APIRouter(prefix="/api/auth", tags=["auth"])


# --- 데모 시드(dev/test 전용) -------------------------------------------------
# 아래 자격증명·명단·약관은 6/17 컨셉 데모와 계약 테스트용 목업 데이터다. 실 DX Korea·
# Cognito·약관 DB로 교체되면 이 시드는 사라진다(프로덕션 배선에 절대 들어가지 않음).

# 데모 약관 — id == type 규약(tos/privacy/sensitive 필수, marketing 선택).
_DEMO_CONSENT_DOCUMENTS: list[ConsentDoc] = [
    # 전문은 데모용 플레이스홀더 — 실연동 시 DB consent_documents(#19)의 전문/버전으로 대체.
    ConsentDoc(
        id="tos",
        title="서비스 이용약관",
        summary="NABI 서비스 이용에 관한 기본 약관입니다.",
        version="v1",
        required=True,
        content=(
            "제1조 (목적)\n"
            "이 약관은 NABI 비즈매칭 서비스의 이용 조건 및 절차, 회사와 이용자의 권리·의무·"
            "책임사항을 규정함을 목적으로 합니다.\n\n"
            "제2조 (정의)\n"
            '1. "이용자"란 주관사 명단에 등재되어 본 서비스에 로그인하는 참가사·바이어·운영사를 말합니다.\n'
            '2. "비즈매칭"이란 참가사와 바이어 간 미팅을 주선·배정하는 기능을 말합니다.\n\n'
            "제3조 (이용자의 의무)\n"
            "이용자는 타인의 계정을 도용하거나 허위 정보를 등록해서는 안 되며, 취득한 상대 기업 정보를 "
            "매칭 목적 외로 사용해서는 안 됩니다."
        ),
    ),
    ConsentDoc(
        id="privacy",
        title="개인정보 수집·이용 동의",
        summary="매칭·상담을 위한 개인정보 수집·이용에 동의합니다.",
        version="v1",
        required=True,
        content=(
            "1. 수집 항목\n소속 기관명, 담당자 성명, 직위, 연락처(전화·이메일), 관심 분야 및 취급 품목.\n\n"
            "2. 수집·이용 목적\n바이어-셀러 매칭, 미팅 배정 및 안내, 상담 결과 기록, 서비스 운영.\n\n"
            "3. 보유·이용 기간\n전시회 종료 후 1년간 보관하며, 기간 경과 또는 동의 철회 시 지체 없이 파기합니다.\n\n"
            "4. 동의 거부 권리\n거부할 권리가 있으나, 필수 항목 미동의 시 매칭 서비스 이용이 제한됩니다."
        ),
    ),
    ConsentDoc(
        id="sensitive",
        title="민감정보 처리 동의",
        summary="콘텐츠 산업 특성상 민감정보 처리에 동의합니다.",
        version="v1",
        required=True,
        content=(
            "1. 처리하는 민감정보\n콘텐츠 사업분야·카테고리, 유통 채널, 수출 관심 국가 등.\n\n"
            "2. 처리 목적\n콘텐츠 산업 특성을 반영한 정밀 매칭 및 적합한 상담 상대 추천.\n\n"
            "3. 제3자 제공\n매칭된 상대 기업에 한하여 미팅 성사에 필요한 범위 내에서만 제공됩니다.\n\n"
            "4. 동의 거부 권리\n동의하지 않을 권리가 있으나, 미동의 시 콘텐츠 분야 매칭 정확도가 제한될 수 있습니다."
        ),
    ),
    ConsentDoc(
        id="marketing",
        title="마케팅 정보 수신 동의(선택)",
        summary="행사·매칭 관련 안내 수신에 동의합니다.",
        version="v1",
        required=False,
        content=(
            "1. 수신 내용\n전시회 일정 안내, 신규 매칭 추천, 후속 행사 및 프로모션 소식.\n\n"
            "2. 수신 방법\n이메일 및 문자메시지.\n\n"
            "3. 철회\n선택 사항이며, 동의하지 않아도 서비스 이용에 제한이 없습니다. 동의 후에도 언제든 철회할 수 있습니다."
        ),
    ),
]

# 데모 DX Korea 자격증명 — (아이디, 비번) → 회원ID.
_DEMO_CREDENTIALS: dict[tuple[str, str], str] = {
    ("buyer", "demo1234"): "mbr-buyer-01",  # 최초, registered/false → consent_required
    ("buyer-old", "demo1234"): "mbr-buyer-02",  # 재방문, submitted/true → succeeded
    ("buyer-wip", "demo1234"): "mbr-buyer-03",  # 재방문, registered/false → succeeded
    ("exhibitor", "demo1234"): "mbr-exh-01",  # 최초, registered/false → consent_required
    ("exhibitor-old", "demo1234"): "mbr-exh-02",  # 재방문, submitted/true → succeeded(약관 스킵)
    ("ghost", "demo1234"): "mbr-ghost",  # 검증은 통과하나 명단에 없음 → not_found
    ("organizer", "demo1234"): "mbr-org-01",  # 데모 운영사 master(주최사) — roster 밖, /organizer
    ("trade-office", "demo1234"): "mbr-trade-01",  # 데모 운영사 sub(무역관) — /organizer 랜딩, master API는 403
}

# 데모 전용 운영사(operator) 회원ID — roster 밖 내부계정(D5)을 흉내낸다. 정식 운영사 인증은
# 별도 경로로 구현 예정이고, 이 집합은 그 전까지 http 모드에서 /organizer 분기를 시연하기 위한
# 데모 배선일 뿐이다(프로덕션 아님). 이 회원은 registrants 매핑을 거치지 않는다.
# master(mbr-org-01)·sub(mbr-trade-01) 둘 다 /organizer로 랜딩하지만, 행사별 권한등급(ADR-0012)은
# API 가드(require_event_master)가 가른다 — sub는 master 전용 API에서 403. sub 전용 콘솔은 후속 슬라이스.
_DEMO_OPERATOR_MEMBER_IDS: frozenset[str] = frozenset({"mbr-org-01", "mbr-trade-01"})

# 데모 명단 — 회원ID → 적재 레코드(역할·게이트).
_DEMO_REGISTRANTS: dict[str, RegistrantRef] = {
    "mbr-buyer-01": RegistrantRef(
        registrant_id="R-b1",
        member_id="mbr-buyer-01",
        is_exhibitor=False,
        is_buyer=True,
        application_status="registered",
        has_profile=False,
    ),
    "mbr-buyer-02": RegistrantRef(
        registrant_id="R-b2",
        member_id="mbr-buyer-02",
        is_exhibitor=False,
        is_buyer=True,
        application_status="submitted",
        has_profile=True,
    ),
    "mbr-buyer-03": RegistrantRef(
        registrant_id="R-b3",
        member_id="mbr-buyer-03",
        is_exhibitor=False,
        is_buyer=True,
        application_status="registered",
        has_profile=False,
    ),
    "mbr-exh-01": RegistrantRef(
        registrant_id="R-e1",
        member_id="mbr-exh-01",
        is_exhibitor=True,
        is_buyer=False,
        application_status="registered",
        has_profile=False,
    ),
    "mbr-exh-02": RegistrantRef(
        registrant_id="R-e2",
        member_id="mbr-exh-02",
        is_exhibitor=True,
        is_buyer=False,
        application_status="submitted",
        has_profile=True,
    ),
}

# 재방문(returning) 회원ID — Cognito 유저풀에 미리 계정을 심어 find_account != None이 되게 한다.
_DEMO_RETURNING_MEMBER_IDS: tuple[str, ...] = ("mbr-buyer-02", "mbr-buyer-03", "mbr-exh-02")


def _seed_demo_pool() -> InMemoryCognitoUserPool:
    """재방문 회원의 계정을 미리 발급한 데모 유저풀을 만든다(최초 진입자는 미발급)."""
    pool = InMemoryCognitoUserPool()
    for member_id in _DEMO_RETURNING_MEMBER_IDS:
        # get_or_create로 심으면 find_account가 그 회원ID에 대해 None이 아니게 된다(= 재방문).
        pool.get_or_create_account(member_id)
    return pool


# --- 프로세스 단일 인스턴스(두 단계가 상태를 공유) -----------------------------
# /start와 /complete가 login_ticket·Cognito 계정 상태를 공유해야 하므로 모듈 단위 싱글톤.
# 테스트는 dependency_overrides로 자기 인스턴스를 꽂아 격리한다.
_ticket_service = LoginTicketService()
_cognito_pool = _seed_demo_pool()
_consent_gate = InMemoryConsentGate(_DEMO_CONSENT_DOCUMENTS)
_verifier = StubDxKoreaVerifier(credentials=_DEMO_CREDENTIALS)
_directory = InMemoryRegistrantDirectory(_DEMO_REGISTRANTS)


def get_verifier(db: Session = Depends(get_session)) -> DxKoreaVerifier:
    """FastAPI 의존성 — 로그인 검증자 체인. 로컬(자체가입, ``LocalCredentialVerifier``)을 항상
    맨 앞에 두고, AUTH_BACKEND=demo일 때만 데모 스텁을 폴백으로 더한다(그 외는 fail-closed).

    자체 회원가입(§7.3, ADR-0007 supersede) 도입 전에는 실 DX Korea 검증 어댑터가 없어 cognito
    모드에서 로그인 자체가 통째로 막혀 있었다(RuntimeError). 이제는 로컬 검증이 "데모 스텁이 아닌
    실 경로"이므로 cognito 모드에서도 살아있다 — codex P1이 막던 건 "데모 자격증명이 prod로
    새는 것"이지 로컬 자체 인증 자체가 아니다. 데모 자격증명(_DEMO_CREDENTIALS)·운영자 승격은
    여전히 AUTH_BACKEND=demo가 아니면 검증 체인에 들어오지 않는다(가드 get_authenticator와 동일한
    fail-closed 규율, 조용한 폴백 금지 유지). 테스트는 dependency_overrides로 자기 더블을 꽂아 이
    게이트와 무관하게 돈다.
    """
    local = LocalCredentialVerifier(db)
    if settings.auth_backend == "demo":
        return ChainedVerifier([local, _verifier])
    return local


def get_directory(db: Session = Depends(get_session)) -> RegistrantDirectory:
    """FastAPI 의존성 — 적재 레코드 조회 포트. 로컬(자체가입) 디렉터리를 데모 시드 앞에 체인한다.

    ``LocalRegistrantDirectory``는 UUID가 아닌 회원ID(데모의 "mbr-*")를 즉시 통과(None)시켜
    데모 동작은 그대로 유지된다 — auth_backend 무관하게 항상 체인에 둔다(기존 get_directory도
    auth_backend 게이팅이 없었다). 테스트는 dependency_overrides로 교체.
    """
    return ChainedRegistrantDirectory([LocalRegistrantDirectory(db), _directory])


def get_cognito_pool() -> CognitoUserPool:
    """FastAPI 의존성 — Cognito 유저풀 포트. demo=인메모리 데모 시드(프로세스 공유), 기본(cognito)=
    실 AWS 유저풀(``_prod_cognito_pool()``, lru_cache로 프로세스 공유). 테스트는 override로 교체.

    ``_seed_demo_pool()``/``_DEMO_*``는 demo 분기 안에서만 생성돼 prod로 새지 않는다(기존
    fail-closed 규율과 동일).
    """
    if settings.auth_backend == "demo":
        return _cognito_pool
    return _prod_cognito_pool()


@lru_cache
def _prod_cognito_pool() -> CognitoUserPool:
    """실 AWS Cognito 유저풀 어댑터 — 앱 구동 중 1회만 생성해 재사용(``app/api/deps.py`` 관례와 동일).

    유저풀 ID·앱클라이언트·파생 비밀번호 시크릿은 인프라 결정(HITL)이라 미설정이면 여기서
    명확히 실패한다(조용한 폴백 금지 — S3Storage/get_authenticator와 같은 fail-closed 패턴).
    """
    from app.auth.cognito_pool import AwsCognitoUserPool

    if settings.cognito_user_pool_id is None or settings.cognito_client_id is None:
        raise RuntimeError(
            "Cognito 유저풀 미구성: COGNITO_USER_POOL_ID/COGNITO_CLIENT_ID가 필요하다."
        )
    if settings.cognito_session_password_secret is None:
        raise RuntimeError(
            "Cognito 파생 비밀번호 시크릿 미구성: COGNITO_SESSION_PASSWORD_SECRET이 필요하다."
        )
    return AwsCognitoUserPool(
        user_pool_id=settings.cognito_user_pool_id,
        app_client_id=settings.cognito_client_id,
        region=settings.aws_region or "ap-northeast-2",
        password_secret=settings.cognito_session_password_secret,
        app_client_secret=settings.cognito_app_client_secret,
    )


def _session_token(session: SessionResult) -> str:
    """FE에 돌려줄 세션 토큰의 소스 — cognito는 **ID 토큰**, demo는 기존 **access 토큰** 그대로.

    ⚠ [배포차단 수정] ``principal.get_current_principal``은 참가자 라우트에서 세션 토큰을
    ``token_use="id"``로 검증한다. 실 Cognito 모드에서 access 토큰을 세션으로 내보내면 검증이
    항상 실패해 참가자 라우트 전원이 401난다 — 그래서 cognito 모드는 ID 토큰을 낸다. demo 모드는
    ``StubSessionAuthenticator``/데모 토큰 정규식(``access-{member_id}-{seq}``)이 여전히 access
    접두사를 기대하므로 그대로 access 토큰을 낸다(FE·기존 데모 테스트 무회귀). 응답 JSON의 키
    이름은 두 모드 모두 ``access_token``으로 유지한다(계약 무변경, 값만 바뀐다).
    """
    if settings.auth_backend == "demo":
        return session.tokens.access_token
    return session.tokens.id_token


def get_consent_gate() -> ConsentGate:
    """FastAPI 의존성 — 약관 동의 게이트 포트(프로세스 공유). 테스트는 override로 교체."""
    return _consent_gate


def get_ticket_service() -> LoginTicketService:
    """FastAPI 의존성 — 로그인 티켓 서비스(프로세스 공유). 테스트는 override로 교체."""
    return _ticket_service


# --- 응답 스키마 --------------------------------------------------------------
class LoginGate(BaseModel):
    """진행 게이트 상태 — 행사 신청 단계 + 프로필 작성 여부(FE landingHref 입력)."""

    application_status: Literal["registered", "submitted"]
    has_profile: bool


class ConsentDocOut(BaseModel):
    """동의 화면에 그릴 약관 문서 한 건."""

    id: str
    title: str
    summary: str
    version: str
    required: bool
    content: str  # 약관 전문(바텀시트 노출).


def _is_registered_operator(db: Session, member_id: str) -> bool:
    """member_id가 실제 등록 운영자인지 — ``organizers.member_id`` 매칭 + 최소 1개
    ``event_organizers`` 배정이 있어야 True(운영자↔행사 조인). 데모 ID 집합과 별개로,
    cognito(prod) 모드의 실 운영자를 여기서 태운다(login_start 참고).

    ⚠ 보안 불변식: 이 판정을 통과해야만 login_start가 roster·consent를 건너뛰고 곧장
    /organizer 세션을 낸다 — organizers 행만 있고 event_organizers 배정이 없는 회원(콘솔이
    빌 운영자)이나, organizers에 아예 없는 임의 회원은 여기서 False라 승격되지 않는다(기존
    참가자 매핑 경로로 그대로 흐른다). ``admin.guard.resolve_organizer_id``와 같은 조인 키
    (``organizers.member_id``)를 쓴다.
    """
    return (
        db.execute(
            select(EventOrganizer.id)
            .join(Organizer, EventOrganizer.organizer_id == Organizer.id)
            .where(Organizer.member_id == member_id)
            .limit(1)
        ).scalar_one_or_none()
        is not None
    )


def _role_of(ref: RegistrantRef) -> str | None:
    """적재 레코드의 역할 불리언 → 단일 역할 문자열. 역할 없으면 None(/welcome 분기)."""
    if ref.is_exhibitor:
        return ROLE_EXHIBITOR
    if ref.is_buyer:
        return ROLE_BUYER
    return None


def _success_payload(ref: RegistrantRef) -> dict[str, Any]:
    """성공 결과(succeeded)와 티켓 payload가 공유하는 역할·게이트·라우트 묶음."""
    decision = decide_route(
        is_exhibitor=ref.is_exhibitor,
        is_buyer=ref.is_buyer,
        is_operator=False,
    )
    return {
        "role": _role_of(ref),
        "gate": {
            "application_status": ref.application_status,
            "has_profile": ref.has_profile,
        },
        "route": decision.route,
        "roles": list(decision.roles),
    }


# --- POST /api/auth/login/start ----------------------------------------------
class StartLoginRequest(BaseModel):
    username: str = Field(..., min_length=1, description="DX Korea 아이디")
    password: str = Field(..., min_length=1, description="DX Korea 비밀번호")
    deeplink_token: str | None = Field(
        default=None,
        description="딥링크 진입 토큰(프리필 편의 — slice A에선 통과만, 신원 닻 아님)",
    )


@router.post("/login/start", summary="접힌 로그인 시작(검증→매핑→세션 또는 약관)")
def login_start(
    body: StartLoginRequest,
    verifier: DxKoreaVerifier = Depends(get_verifier),
    directory: RegistrantDirectory = Depends(get_directory),
    pool: CognitoUserPool = Depends(get_cognito_pool),
    consent_gate: ConsentGate = Depends(get_consent_gate),
    ticket_service: LoginTicketService = Depends(get_ticket_service),
    db: Session = Depends(get_session),
) -> dict[str, Any]:
    """아이디/비번을 검증해 적재 레코드를 매핑하고, 재방문이면 세션을, 최초면 약관을 돌려준다.

    deeplink_token은 프리필 편의일 뿐 신원의 닻이 아니다(D2). slice A에선 검증·소비를 강제하지
    않고 통과시킨다 — 무효 토큰이어도 자격증명만 맞으면 진행한다(차단하지 않음).
    """
    result = verifier.verify(body.username, body.password)
    if not isinstance(result, VerifyOk):
        # 검증 실패 — 거부 사유를 그대로 노출(아이디/비번·잠김·업스트림 장애).
        return {"outcome": "rejected", "reason": result.reason.value}

    if result.member_id in _DEMO_OPERATOR_MEMBER_IDS or _is_registered_operator(db, result.member_id):
        # 운영자 경로 — roster 매핑을 건너뛰고 operator로 분기(D5 흉내 + 실 운영자 모두). 운영사는
        # roster 밖 내부계정이라 registrants에 없고, 약관도 통과 취급해 곧장 세션을 낸다(/organizer).
        # 두 갈래:
        #  - 데모 전용 회원ID(_DEMO_OPERATOR_MEMBER_IDS) — demo 모드에서만 검증 체인에 들어오는
        #    데모 cred이므로, get_verifier가 fail-closed인 cognito 모드에선 위 verify에서 이미
        #    막혀 이 갈래엔 도달하지 않는다(데모 운영자 백도어 차단, codex P1 계승).
        #  - 실 등록 운영자(_is_registered_operator) — organizers.member_id로 연결되고 최소 1개
        #    event_organizers 배정을 가진 회원. cognito(prod) 모드에서도 도달 가능(이번 변경) —
        #    LocalCredentialVerifier로 검증된 member_id가 organizers 테이블과 조인되는지로 판정하므로
        #    임의 회원은 절대 여기로 새지 않는다(_is_registered_operator 보안 불변식 참고).
        decision = decide_route(is_exhibitor=False, is_buyer=False, is_operator=True)
        session = issue_session(result.member_id, pool, consent_satisfied=True)
        return {
            "outcome": "succeeded",
            "role": "organizer",
            "gate": {"application_status": "submitted", "has_profile": True},
            "route": decision.route,
            "roles": list(decision.roles),
            # 후속 인증 요청(어드민 가드 등)에 쓸 세션 토큰 — FE BFF가 httpOnly 쿠키로 보관한다.
            # 응답 키는 access_token으로 유지하되 값은 모드별로 갈린다(_session_token).
            "access_token": _session_token(session),
        }

    try:
        ref = map_member_to_registrant(result.member_id, directory)
    except RegistrantNotFoundError:
        # 검증은 통과했으나 명단에 그 회원ID가 없음 — 인증 실패와 구분되는 분기.
        return {"outcome": "not_found"}

    common = _success_payload(ref)

    if pool.find_account(result.member_id) is not None:
        # 재방문 — 약관 재요구 없이 곧장 세션을 낸다(consent_satisfied=True로 게이트 통과).
        session = issue_session(result.member_id, pool, consent_satisfied=True)
        # 후속 인증 요청에 쓸 세션 토큰 — FE BFF가 httpOnly 쿠키로 보관한다(응답 키는 access_token
        # 유지, 값은 모드별로 갈린다 — _session_token).
        return {"outcome": "succeeded", **common, "access_token": _session_token(session)}

    # 최초 진입 — 약관 목록을 노출하고, 진입 상태를 일회성 티켓에 묶어 complete 단계로 넘긴다.
    documents = consent_gate.active_documents()
    login_ticket = ticket_service.issue({"member_id": result.member_id, **common})
    return {
        "outcome": "consent_required",
        "login_ticket": login_ticket,
        "documents": [
            ConsentDocOut(
                id=d.id,
                title=d.title,
                summary=d.summary,
                version=d.version,
                required=d.required,
                content=d.content,
            ).model_dump()
            for d in documents
        ],
    }


# --- POST /api/auth/login/complete -------------------------------------------
class CompleteLoginRequest(BaseModel):
    login_ticket: str = Field(..., min_length=1, description="start가 발급한 일회성 티켓")
    accepted_doc_ids: list[str] = Field(
        default_factory=list, description="사용자가 동의한 약관 문서 id 목록(id == type)"
    )


@router.post("/login/complete", summary="접힌 로그인 완료(약관 기록→세션)")
def login_complete(
    body: CompleteLoginRequest,
    pool: CognitoUserPool = Depends(get_cognito_pool),
    consent_gate: ConsentGate = Depends(get_consent_gate),
    ticket_service: LoginTicketService = Depends(get_ticket_service),
) -> dict[str, Any]:
    """티켓을 소진하고 동의를 기록해 세션을 발급한다.

    티켓은 일회성이라 검증 성공 시 그 자리에서 소진된다. 동의가 필수 미충족(consent_incomplete)
    이어도 티켓은 이미 소진된 상태다 — slice A에선 재시도 시 새 start가 필요하다(허용 제약, 문서화).
    """
    verified = ticket_service.verify(body.login_ticket)
    if not verified.allowed:
        # 위조·만료·소진 — 다음 안내를 위해 사유 코드를 노출한다.
        return {"outcome": "ticket_invalid", "reason": verified.rejection.value}

    payload = verified.payload or {}
    member_id = payload["member_id"]

    outcome = consent_gate.record(member_id, body.accepted_doc_ids)
    if not outcome.satisfied:
        # 필수 미동의 — 티켓은 이미 소진됨(위 NOTE). FE는 에러를 보이고 새 start로 재시작한다.
        return {
            "outcome": "consent_incomplete",
            "missing_required": outcome.missing_required,
        }

    session = issue_session(member_id, pool, consent_satisfied=True)
    return {
        "outcome": "succeeded",
        "role": payload.get("role"),
        "gate": payload.get("gate"),
        "route": payload.get("route"),
        "roles": payload.get("roles"),
        # 후속 인증 요청에 쓸 세션 토큰 — FE BFF가 httpOnly 쿠키로 보관한다(응답 키는 access_token
        # 유지, 값은 모드별로 갈린다 — _session_token).
        "access_token": _session_token(session),
    }
