# 제출용 저장소 안내

**B2B 비즈매칭 CMS**(개발 코드명 NABI)의 개발단계 산출물 제출용 저장소입니다. 운영 중인 원본 저장소의 **제출 시점 스냅샷**이며, 배포 자격증명과 내부 운영
설정을 제거한 정제본입니다.

- **운영 사이트**: https://kcevietnam.salesground.kr
- **스냅샷 기준일**: 2026-10-27
- **적용 행사 일정**: 2026년 10월 20일 ~ 22일

## 구성

| 디렉터리 | 내용 | 파일 수 |
|---|---|---|
| `frontend/` | Next.js 16 · TypeScript · Tailwind v4 · shadcn/ui | 614 |
| `backend/` | FastAPI · SQLAlchemy 2.0 · Alembic · PostgreSQL | 249 |
| `docs/` | 도메인 용어 · ADR · PRD · 화면 목록 · DB 스키마 · UI 프로토타입 | 76 |
| `tokens/` | W3C DTCG 디자인 토큰 | 8 |
| `research/` | 개발 보고서 (2026-08, 2026-09) · 개발현황 및 배포계획 | 6 |

주요 문서:

- `CONTEXT.md`, `CONTEXT-MAP.md` — 도메인 용어 정의(공유 커널)
- `docs/adr/` — 아키텍처 의사결정 기록 15건
- `docs/prd/` — 기능별 요구사항 정의 17건
- `docs/db/schema.sql` — DB 스키마 정의
- `docs/page-list.csv` — 화면 목록 및 기능 ID 대응표

## 이 저장소에 포함하지 않은 것

제출 범위 밖이거나 공개가 부적절한 항목입니다. 애플리케이션 소스코드는 전부 포함되어 있습니다.

| 항목 | 제외 사유 |
|---|---|
| CI/CD 워크플로 설정 | 클라우드 계정 식별자·배포 역할·인스턴스 식별자 포함 |
| 내부 개발 도구 설정 | 개발 보조 도구 구성 파일로, 산출물과 무관 |
| 내부 작업 계획·QA 로그 | 진행 중 내부 메모 |
| 디자인 도구 연동 설정 | 외부 서비스 파일 식별자 포함 |
| 운영 보조 도구(부하 테스트·내부 운영 현황 패널·번역 잔존 점검 스크립트) | 운영 서버 주소·인스턴스 식별자를 포함한 내부 운영 도구 |
| 실 참가사·참관객 명단 | 개인정보. 원본 저장소에도 포함된 적이 없으며 별도 안전 채널로만 취급 |

## 테스트 데이터

`backend/sample_data/roster/`의 명단 파일은 **전부 합성 데이터**입니다. 기업명·담당자명·이메일·
연락처·사업자등록번호가 모두 가상의 값이며 실제 개인정보를 포함하지 않습니다.
(이메일 도메인이 `-test.go.kr`, `mod-test.gov.my` 형태인 것에서 확인할 수 있습니다.)

## 데모 계정

로컬 실행 시 `AUTH_BACKEND=demo` 설정에서만 동작하는 데모 계정이 코드에 포함되어 있습니다
(`backend/app/auth/login_router.py`). 검수자가 별도 계정 발급 없이 각 권한의 화면을 확인할 수
있도록 한 것입니다.

**운영 환경은 Amazon Cognito 인증을 사용하므로 이 데모 계정으로 로그인할 수 없습니다.**

| 계정 | 권한 |
|---|---|
| `organizer` | 주최사 최고 권한 운영자 (master) |
| `trade-office` | 위임 운영자 (sub) |
| `exhibitor` | 참가기업 |
| `buyer` | 바이어 |

비밀번호는 `backend/app/auth/login_router.py`의 `_DEMO_CREDENTIALS`에 정의되어 있으며,
같은 위치에 신청 상태별 시나리오(최초 가입·재방문·명단 미등록 등)를 확인할 수 있는
변형 계정도 함께 정의되어 있습니다.

참가기업·바이어 화면의 왼쪽 메뉴는 행사 설정 '참가자 메뉴'를 따르며, 기본값은 '미팅만'입니다.
메뉴에서 숨긴 화면(기업 탐색·알림·프로필)도 주소로 직접 열 수 있고, 설정은 master 운영자가 관리자
콘솔의 행사 설정에서 바꿉니다(`docs/adr/0015-participant-menu-is-presentation-not-permission.md`).

## 로컬 실행

```bash
# 백엔드 (Python 3.12 이상, uv)
cd backend
uv sync
uv run alembic upgrade head
AUTH_BACKEND=demo uv run uvicorn app.main:app --reload

# 프론트엔드 (Node 20.9 이상)
cd frontend
npm install
npm run dev
```

PostgreSQL 16 인스턴스가 필요하며, 접속 정보는 `DATABASE_URL` 환경변수로 주입합니다.
API 명세는 백엔드 기동 후 `/docs`(Swagger UI) 또는 `/openapi.json`에서 확인할 수 있습니다.

- `backend/uv.lock`의 `psycopg-binary` 휠은 Python 3.12~3.14용만 있습니다. 시스템 기본 Python이 그보다
  새 버전이면 `uv sync --python 3.12`처럼 버전을 지정합니다.
- `EMAIL_BACKEND` 기본값은 `fake`(발송 내용을 기록만 함)라 로컬 실행에서는 외부로 메일이 나가지 않습니다.
  행사 설정 '참가사·바이어 알림 메일'도 기본값이 꺼짐입니다.
- 녹음 업로드 전사를 확인하려면 `ffmpeg`·`ffprobe`가 PATH에 있어야 합니다.

## 테스트

```bash
cd backend  && uv run pytest        # 백엔드 테스트 (1736 passed, 2 skipped)
cd frontend && npm test             # 프론트엔드 테스트 (2189 passed)
```

백엔드 테스트는 PostgreSQL에 전용 테스트 DB를 만들었다 지우므로 접속 롤에 `CREATEDB` 권한이 필요합니다.
skip 2건은 실제 AWS Cognito를 호출하는 통합 테스트로, `RUN_COGNITO_IT=1`과 유저풀 설정이 있을 때만
실행됩니다.
