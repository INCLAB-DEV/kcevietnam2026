# 플랫폼 스택 AWS 전환 + 백엔드가 DB 접근 소유

NABI v1을 **외주 개발사**가 구축하며, 외주사 환경상 **Supabase를 쓰지 않고 AWS 매니지드 서비스로 구현**할 가능성이 높다. 이에 따라 (1) 기술 스택을 Supabase → AWS(RDS·Cognito·S3)로 전환하고, (2) FE/BE 경계를 **FastAPI가 모든 DB 접근을 소유**(Next.js는 DB 직접 접속 없이 FastAPI API만 호출)하는 구조로 확정한다. 첫 빌드 슬라이스는 **프로필 작성(F-BM-001/002) + 문서 업로드형 AI Smart Fill**이다.

이 ADR은 CLAUDE.md의 "DB: Supabase" 표기와 ADR-0007의 인증 구현 기술을 갱신한다 (ADR-0007의 *결정*은 유지, *구현 기술*만 AWS로 매핑). **인증 신원검증은 DX Korea 인증 API(아이디/비번, OTP 폐기 — ADR-0007 최신)이며, Cognito는 OTP 발송자가 아니라 세션/JWT 토큰 저장·검증(JWKS/RS256) 역할만 맡는다.**

## 기술 스택 매핑 (Supabase → AWS)

| 역할 | 채택(AWS) | 비고 |
|------|-----------|------|
| Frontend | Next.js + TS + Tailwind | DB 직접 접속 안 함. FastAPI API만 호출 |
| Backend | FastAPI (Python) — **모든 DB 접근 + 컴퓨트 소유** | 권한검사·DB 자격증명 단일 집중 |
| DB | **AWS RDS (PostgreSQL)** (또는 Aurora Serverless v2) | Postgres 그대로라 스키마/SQL 불변 |
| 인증 | **딥링크 + DX Korea 인증 API(아이디/비번)** → **NABI 계정 발급(Cognito 유저풀, JWKS/RS256)** | 신원검증=DX Korea API(ADR-0007, OTP 폐기). Cognito=NABI 유저풀+세션/JWT. **공개가입 없음**, 단 최초 진입 시 **약관동의 후 게이트된 NABI 계정 발급** |
| 파일저장 | **S3** + presigned URL | 원본 영구보관, at-rest 암호화·접근통제·버전닝 |
| 마이그레이션 | **Alembic** (Python, backend 동봉) | Python만 DDL. schema.sql은 파생 ERD 산출물로 강등 |
| AI | Claude API | 키는 backend에만 |

## FE/BE 경계 — FastAPI가 DB 소유 (옵션 B)

- **Next.js는 RDS에 직접 접속하지 않는다.** 모든 읽기/쓰기는 FastAPI API를 경유한다.
- 권한검사(누가 어떤 행에 접근 가능한가)는 **FastAPI 한 곳**에 집중한다. Cognito JWT를 FastAPI가 JWKS/RS256으로 검증한다.
- **컴퓨트(Smart Fill `/extract`)도 같은 FastAPI**에 둔다 — 문서 업로드 → S3 → Claude 추출 → 구조화 JSON 반환.
- 향후 매칭 엔진(ADR-0006)도 같은 FastAPI에 배치잡으로 합류한다.

## 왜 옵션 B인가 (Supabase 시절 옵션 A에서 역전)

- 초기 설계는 "Next.js가 Supabase에 직접 CRUD + RLS"(옵션 A)였다. 이는 **Supabase의 RLS·자동 API라는 공짜 혜택**에 기댄 결정이었다.
- AWS RDS엔 `auth.uid()` 기반 RLS 자동 통합·자동 API가 없다. 옵션 A로 가면 **권한검사를 TS로 손수 중복 구현**해야 하고, 두 코드베이스(TS·Python)가 DB 자격증명을 나눠 갖는다 → 실수·보안구멍.
- 옵션 B는 권한·DB 자격증명을 단일 지점(FastAPI)에 모으고, **외주 핸드오프에 단일 API 경계**를 제공한다. RLS가 사라진 AWS에선 A의 이점이 소멸하므로 트레이드오프가 B 우위로 역전된다.
- 옵션 B의 단점(CRUD마다 엔드포인트 필요, FastAPI가 크리티컬 패스)은 RLS 부재 환경의 A 보안부담보다 작다.

## Smart Fill 범위 (단순화)

- Smart Fill = **문서 업로드(PDF/PPT/Word)만** 유지. **회사 URL 스크레이핑·DART 자동조회는 제거**한다.
  - DART 제거로 외부 ToS·API 키·쿼터 블로커가 사라진다. URL 스크레이핑 복잡도도 제거.
- 업로드 원본은 **S3에 영구보관**(추출 후 즉시 삭제하지 않는다 — 프로토타입의 "즉시 삭제" 문구 폐기). 방산 문서이므로 암호화·접근통제·보관기간 정책을 둔다.
- 흐름: 브라우저 →(presigned URL)→ S3 저장 → FastAPI가 S3 key로 파일 읽어 Claude 추출 → 폼 prefill → 사용자 검토·수정 → 저장.

## Considered Options

- **Supabase 유지 (기각):** RLS·Auth·Storage를 공짜로 주지만, 외주사가 AWS 표준으로 구축할 가능성이 높아 운영·인수인계가 어긋난다.
- **옵션 A (Next.js가 RDS 직접 접속, 기각):** RLS 없는 RDS에서 권한로직을 TS로 중복 구현 → 보안·유지보수 비용 큼.
- **AWS + 옵션 B (채택):** 단일 API 경계·단일 권한지점. 외주 핸드오프와 보안에 유리.

## Consequences

- **CLAUDE.md 기술 스택 갱신** 필요 (DB: Supabase → AWS RDS/Cognito/S3).
- **ADR-0007 인증의 *결정*은 불변**(딥링크 진입 + 명단 앵커 + 공개가입 없음). **구현**: 신원검증=DX Korea 인증 API(아이디/비번, OTP 폐기) → 최초 진입 시 **약관동의 + NABI 계정(Cognito 유저풀) 발급** → 이후 로그인은 Cognito 세션/JWT(JWKS/RS256). DX Korea API가 회원ID를 반환하면 그 키로 적재 레코드·NABI 계정을 매핑한다. 약관동의 이력은 감사 가능하게 DB에 저장한다(ADR-0009).
- **schema.sql은 캐노니컬 → 파생 ERD 산출물로 강등.** 운영 진실원천은 `backend`의 Alembic 마이그레이션. Python 서비스만 DDL을 변경하고, 모든 변경은 Alembic으로만 흐른다(외주 드리프트 예방 규율).
- 등록자 적재·참가자 게이트 데이터 모델은 ADR-0009에서 정의한다.
- 배포: Frontend(Vercel 또는 AWS), Backend(ECS Fargate/App Runner/Lambda 등 외주사 선택), DB(RDS), 인증(Cognito), 저장(S3).
- **FE seam의 RSC 경계 구현**은 frontend ADR-0001을 따른다 — api-client를 서버 전용 read(`server-only` 봉인)와 클라 호출 session으로 분리해, read 어댑터(mock 픽스처·점수 휴리스틱)가 클라이언트 번들로 누출되지 않게 한다. 단일 변경점 수렴은 유지되되 수렴점이 read/session 두 어댑터로 갈린다(#94).

Status: accepted
