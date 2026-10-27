"""NABI 백엔드 FastAPI 엔트리. 모든 DB 접근·컴퓨트·AI·시크릿을 소유(ADR-0008 경계 B).

도메인 라우터는 각 기능 슬라이스에서 붙는다 — roster import(OP-002/#50)가 첫 적재 엔드포인트,
인증 슬라이스는 #20에서 시작. 데이터모델/마이그레이션 기반선은 #48에서 깔았다.
미팅 회의록(MY-002) 리뷰 라우터는 review 슬라이스가 붙인다.
"""

import asyncio
import logging
from contextlib import asynccontextmanager
from datetime import datetime, timezone

from fastapi import FastAPI, Request, status
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy import text

from app.admin.router import router as admin_router
from app.api.deps import get_job_store
from app.api.love_call import router as love_call_mail_router
from app.api.reviews import router as reviews_router
from app.auth.credentials import PasswordHashBusyError
from app.auth.login_router import router as login_router
from app.auth.password_router import router as password_change_router
from app.auth.router import router as auth_router
from app.auth.signup_router import router as signup_router
from app.bm.router import router as bm_router
from app.config import settings
from app.consent.router import router as consent_router
from app.db import engine
from app.discover.router import me_router
from app.discover.router import router as discover_router
from app.excel.router import router as excel_router
from app.meetings.router import router as meetings_router
from app.notifications.bulk_dispatch import shutdown_bulk_email
from app.notifications.router import router as notifications_router
from app.notifications.scheduler import reminder_scheduler_lifespan
from app.roster.router import router as roster_router
from app.services.ai_concurrency import shutdown_ai_workers
from app.services.transcription_jobs import TRANSCRIPTION_FAILED_MESSAGE

logger = logging.getLogger(__name__)

# 준비 상태 확인(/health/ready)의 DB 응답 대기 상한(초). 외부 헬스체크(Route 53)는 연결 뒤 2초 안에 응답을 받아야
# 정상으로 본다 — 경로가 Caddy → Next(/api/health/ready, 백엔드 대기 1.5초) → 여기라서 DB 확인은 1초로 끊는다.
READY_DB_TIMEOUT_SECONDS = 1.0


def _fail_orphaned_transcription_jobs(app: FastAPI, started_at: datetime) -> None:
    """이 프로세스가 뜨기 전에 만들어져 아직 pending인 전사 작업을 실패로 정리한다.

    전사는 프로세스 메모리의 전용 풀에서 돈다 — 그 프로세스가 재시작(배포·장애)으로 사라지면 작업 행은 pending
    으로 남아 화면이 30분 동안 헛폴링하다 '지연'으로 끝난다. 시작 시 바로 실패로 바꿔 두면 다음 폴링에서
    고정 실패 문구가 나가고 사용자가 곧바로 다시 올릴 수 있다.

    ⚠ 백엔드 프로세스가 **하나**라는 전제다(standalone: uvicorn 1개, 재배포는 기존 컨테이너를 멈춘 뒤 새로
    띄운다). 여러 프로세스가 같은 DB를 쓰거나 롤링 배포로 겹치면, 살아 있는 다른 프로세스의 대기·진행 작업까지
    실패로 만든다 — 그런 배포에선 ``TRANSCRIPTION_FAIL_ORPHANS_ON_STARTUP=false``로 끈다.

    저장소는 요청과 같은 의존성으로 고른다(테스트 override 포함). 실패해도 앱 시작을 막지 않는다 — 정리는
    부가 작업이고, 못 하면 그 작업들은 예전처럼 화면 쪽 상한(30분)에서 끝난다.
    """
    store_factory = app.dependency_overrides.get(get_job_store, get_job_store)
    try:
        failed = store_factory().fail_pending_created_before(started_at, TRANSCRIPTION_FAILED_MESSAGE)
    except Exception:  # noqa: BLE001 - 정리 실패가 앱 시작을 막지 않는다
        logger.exception("시작 시 고아 전사 작업 정리 실패")
        return
    if failed:
        logger.warning("이전 프로세스가 남긴 전사 작업 %d건을 실패로 정리했다", failed)


@asynccontextmanager
async def _lifespan(app: FastAPI):
    """알림 10분 리마인더 폴링(ADR-0010, SCHEDULER_ENABLED 게이트) + 전사 작업 고아 정리 + 백그라운드 워커 정리.

    종료 시 전사 전용 풀·일괄 메일 스레드는 ``wait=False``로 닫는다 — 아직 시작하지 않은(대기열의) 작업만
    취소되고, **실행 중인 작업은 중단되지 않는다**: 인터프리터 종료가 concurrent.futures 워커 스레드를 끝까지
    join하므로 프로세스는 그 작업이 끝날 때까지 남는다. 운영에선 ``docker stop``의 유예 시간(기본 10초)이 지나면
    SIGKILL로 끝나고, 그 작업 행은 pending으로 남아 다음 시작 때 위 고아 정리가 실패로 바꾼다.
    """
    if settings.transcription_fail_orphans_on_startup:
        # 시작 시각을 기준으로 — 요청을 받기 전이므로 이 시점의 pending 작업은 전부 이전 프로세스의 것이다.
        await asyncio.to_thread(_fail_orphaned_transcription_jobs, app, datetime.now(timezone.utc))
    async with reminder_scheduler_lifespan(app):
        try:
            yield
        finally:
            shutdown_ai_workers(wait=False)
            shutdown_bulk_email(wait=False)


app = FastAPI(title="Sales AI Backend", version="0.0.1", lifespan=_lifespan)

# 로컬 데모: Next(다른 포트)에서의 브라우저 호출 허용. 운영은 명시 오리진으로 좁힌다.
# allow_credentials=True 필수 — FE(http-exhibitor-client 등)가 credentials:"include"로 세션 쿠키를
# 실어 보내므로, 이게 없으면 브라우저가 프리플라이트 응답에 access-control-allow-credentials가
# 없다고 보고 본 요청 자체를 차단한다(E2E 재현). allow_origin_regex는 와일드카드가 아니라 매칭된
# origin 하나를 그대로 반사하므로 credentials 모드와도 안전하게 조합된다.
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=settings.cors_allow_origin_regex,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.exception_handler(RequestValidationError)
async def _validation_error_without_plaintext(
    request: Request, exc: RequestValidationError
) -> JSONResponse:
    """FastAPI 기본 422 바디는 각 에러에 ``input``(요청에 실제로 들어온 값)을 그대로 반사한다 —
    ``contact_password``/``password``처럼 형식이 틀려 검증에서 걸린 필드는 그 평문이 BFF를 거쳐
    응답에 고스란히 실린다(로그·프록시에도 남을 수 있다). ``loc``/``msg``는 클라이언트가 어느
    필드가 왜 틀렸는지 알아야 하니 그대로 두고, ``input``/``ctx``만 모든 에러에서 걷어낸다
    (특정 필드만 골라 막으면 새 비밀번호류 필드가 늘 때마다 또 빠뜨릴 수 있어 전역으로 막는다).
    """
    errors = [
        {k: v for k, v in error.items() if k not in ("input", "ctx")}
        for error in exc.errors()
    ]
    return JSONResponse(
        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        content={"detail": errors},
    )


@app.exception_handler(PasswordHashBusyError)
async def _password_hash_busy(request: Request, exc: PasswordHashBusyError) -> JSONResponse:
    """비밀번호 해시 자리(app.auth.credentials.password_hash_slot)를 못 얻은 요청 — 503 ``server_busy``.

    대기열이 이미 꽉 찼거나(즉시) 제한 시간 안에 차례가 오지 않은 경우다. 로그인은 라우터가 먼저 잡아 503
    ``login_busy``로 답한다(화면 문구가 따로 있다). 여기는 그 밖의 해시 경로(자체가입·비밀번호 변경·명단 공통
    비밀번호·담당자 비밀번호 설정)가 500으로 새지 않게 하는 안전망이다 — 로그인이 몰린 순간에만 날 수 있고,
    사용자는 잠시 뒤 같은 요청을 다시 보내면 된다.
    """
    logger.warning("요청 거절 — %s: %s", exc, request.url.path)
    return JSONResponse(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        content={"detail": {"code": "server_busy", "message": "요청이 많아요. 잠시 후 다시 시도해 주세요."}},
    )


app.include_router(roster_router)
# 인증 슬라이스(F-AU-001) — 딥링크 토큰 검증 등. Next.js는 이 API만 호출(ADR-0008 경계 B).
app.include_router(auth_router)
# 접힌 로그인 트랜잭션(F-AU-001 / #23 slice A, ADR-0011) — POST /login/start, /login/complete.
app.include_router(login_router)
# 자체 회원가입(개발계획서 §7.3, ADR-0007 supersede) — POST /signup. 참가사/바이어만(422로 잠김).
app.include_router(signup_router)
# 약관 동의 슬라이스(F-AU-001 / #19) — GET /active, POST /agree.
app.include_router(consent_router)
# 미팅 회의록(MY-002) — Step1/Step2/내보내기/Love Call + 노출규칙.
app.include_router(reviews_router)
# 러브콜 메일(#13) — 회의록 기반 AI 초안 → 사용자 검수·수정 → 상대 기업 담당자에게 실제 발송.
app.include_router(love_call_mail_router)
# BM 프로필(F-BM-001/002 / #26) — 단계별 저장/조회 + 원자적 참가자 승격(Cognito JWT 소유권).
app.include_router(bm_router)
# 어드민 엑셀 export/import(F-OP-006) — 기업/미팅/회의록 export + roster import 어드민 별칭.
app.include_router(excel_router)
# 알림 인박스(F-NT-001/ADR-0010) — org 공유 인박스 조회/읽음 처리.
app.include_router(notifications_router)
# 참가자용 미팅(F-MT-001) — 신청/수락/거절/취소 + 가용 슬롯 조회. 권한의 닻은 소속 org.
app.include_router(meetings_router)
# 참가자용 기업 탐색 — 열람 범위(§8) 안의 기업 목록/단건. 응답은 공개 프로젝션 화이트리스트만.
app.include_router(discover_router)
# 뷰어 자신의 참가 컨텍스트(GET /api/me) — 소속 org + 행사별 역할·승인 상태.
app.include_router(me_router)
# 셀프 비밀번호 변경(POST /api/me/change-password) — 같은 /api/me prefix지만 자격증명 규칙은 auth
# 슬라이스 소관이라 라우터를 나눴다(app/auth/password_change.py 독스트링).
app.include_router(password_change_router)
# 슈퍼어드민 콘솔(#OP) — 행사 CRUD, 참가기업 직접수정/대리작성, 미팅 운영, 통역사 배정(ADR-0012).
app.include_router(admin_router)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


def _ping_database() -> None:
    """DB에 ``SELECT 1`` 한 번 — 요청과 같은 커넥션 풀에서 한 개를 잠깐 빌린다(풀이 고갈되면 그만큼 늦어진다)."""
    with engine.connect() as connection:
        connection.execute(text("SELECT 1"))


@app.get("/health/ready")
async def health_ready() -> JSONResponse:
    """준비 상태 — 프로세스가 살아 있는지(/health)에 더해 DB까지 응답하는지 본다. 200 ok / 503 unavailable.

    ``/health``는 그대로 둔다(컨테이너 생존 확인용 — DB 장애로 컨테이너를 재시작시키면 안 된다). 외부 헬스체크는
    프런트 ``/api/health/ready``가 이걸 거쳐 부른다. DB 확인은 스레드에서 돌리고 ``READY_DB_TIMEOUT_SECONDS``에서
    끊는다 — 풀이 고갈됐거나 DB가 멈췄을 때 헬스체크 요청이 풀 대기(최대 db_pool_timeout)만큼 매달리지 않게.
    끊긴 확인 스레드는 풀 대기가 끝나면 스스로 끝난다(응답은 이미 503으로 나갔다). 원인은 로그에만 남긴다.
    """
    try:
        await asyncio.wait_for(asyncio.to_thread(_ping_database), timeout=READY_DB_TIMEOUT_SECONDS)
    except Exception as exc:  # noqa: BLE001 - 시간 초과·연결 실패·풀 고갈 전부 같은 '준비 안 됨'
        logger.warning("준비 상태 확인 실패 — DB 응답 없음: %s", type(exc).__name__)
        return JSONResponse(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, content={"status": "unavailable"})
    return JSONResponse(content={"status": "ok"})
