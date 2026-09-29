"""NABI 백엔드 FastAPI 엔트리. 모든 DB 접근·컴퓨트·AI·시크릿을 소유(ADR-0008 경계 B).

도메인 라우터는 각 기능 슬라이스에서 붙는다 — roster import(OP-002/#50)가 첫 적재 엔드포인트,
인증 슬라이스는 #20에서 시작. 데이터모델/마이그레이션 기반선은 #48에서 깔았다.
미팅 회의록(MY-002) 리뷰 라우터는 review 슬라이스가 붙인다.
"""

from fastapi import FastAPI, Request, status
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.admin.router import router as admin_router
from app.api.love_call import router as love_call_mail_router
from app.api.reviews import router as reviews_router
from app.auth.login_router import router as login_router
from app.auth.router import router as auth_router
from app.auth.signup_router import router as signup_router
from app.bm.router import router as bm_router
from app.config import settings
from app.consent.router import router as consent_router
from app.discover.router import me_router
from app.discover.router import router as discover_router
from app.excel.router import router as excel_router
from app.meetings.router import router as meetings_router
from app.notifications.router import router as notifications_router
from app.notifications.scheduler import reminder_scheduler_lifespan
from app.roster.router import router as roster_router

# 알림 10분 리마인더 폴링(ADR-0010)을 SCHEDULER_ENABLED 게이트 아래 lifespan 태스크로 돈다.
app = FastAPI(title="NABI Backend", version="0.0.1", lifespan=reminder_scheduler_lifespan)

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
# 슈퍼어드민 콘솔(#OP) — 행사 CRUD, 참가기업 직접수정/대리작성, 미팅 운영, 통역사 배정(ADR-0012).
app.include_router(admin_router)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}
