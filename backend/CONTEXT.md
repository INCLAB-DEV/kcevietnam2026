# Backend Context (FastAPI 도메인·데이터 레이어)

> **먼저 루트 `CONTEXT.md`(공유 커널)를 읽을 것.** 사용자 유형·매칭·프로세스·미팅 후 평가의 정의는 전부 거기에 있다. 이 파일은 백엔드 *고유* 구현 어휘만 보완한다.

백엔드(FastAPI)가 **모든 DB 접근·컴퓨트·AI·시크릿을 소유**한다(ADR-0008). 프론트는 API만 호출한다. 도메인 모델의 실제 거처는 여기다.

## Language

**DB Ownership (DB 소유)**:
모든 DB 접근은 FastAPI를 통한다. DB는 AWS RDS(PostgreSQL). Next.js는 DB에 직접 붙지 않는다.
_Avoid_: 프론트 직접 쿼리, Supabase(전환 전 잔재 — ADR-0008로 폐기)

**Migration / schema.sql (마이그레이션)**:
스키마 변경의 단일 권한은 **Alembic**(Python만 DDL을 친다). `docs/db/schema.sql`은 캐노니컬이 아니라 **파생 ERD 산출물**(CONTEXT.md·docs/adr·docs/prd에서 파생, ERDCloud 임포트용). 스키마 동기화는 서브에이전트 `db-schema-keeper`가 담당.
_Avoid_: 손수 DDL, schema.sql을 진실원천 취급

**Smart Fill (`/extract`)**:
업로드 문서/입력에서 프로필 필드를 자동 채우는 백엔드 컴퓨트 엔드포인트. AI 호출 포함.
_Avoid_: 자동완성(일반 UI), 프론트 추론

**Auth (인증)**:
자체 회원가입 없음. 딥링크 진입 + **DX Korea 인증 API**(아이디/비번 검증, OTP 폐기)로 신원 확인 → 세션/JWT는 **Amazon Cognito**(JWKS/RS256 검증). ADR-0007/0008.
_Avoid_: 자체 가입, OTP, 비밀번호 자체 저장

**Registrant Import (등록자 적재)**:
주관사 전체 신청자 스냅샷 파일을 운영자가 업로드 → **주관사 회원ID 키로 멱등 upsert**. 키는 사업자등록번호가 아니라(해외업체·개인 바이어 커버) **전 레코드에 존재하는 회원ID**. 라이브 API 아님. ADR-0007. (도메인 용어 *Registrant* 정의는 루트 커널 참조)
_Avoid_: 라이브 연동, 사업자번호 키, 부분 업로드

**File Storage (파일 저장)**:
원본 파일은 **S3**(영구보관, 암호화·접근통제).
_Avoid_: DB blob, 로컬 디스크

**AI / Secrets**:
OpenAI API 등 모든 시크릿·AI 키는 **backend에만** 둔다. 프론트로 노출 금지.
_Avoid_: 프론트 API 키, 클라이언트 직접 호출

## 상태 모델 메모

`Schedule Table`의 상태 전이(`proposed`/`accepted`/...)와 **provenance(누가 만들었나) ↔ acceptance rule(받는 쪽이 누구·언제냐)이 별개 축**이라는 규칙은 루트 커널의 *매칭*·*Schedule Table* 절에 정의돼 있다. 백엔드 상태머신·배정 로직은 그 정의를 진실원천으로 구현한다.

## 참조

- 캐노니컬 스키마 파생: `docs/db/schema.sql`, 유지관리 `.claude/agents/db-schema-keeper.md`
- 백엔드 한정 아키텍처 결정: `backend/docs/adr/` (현재 없음 — 시스템 전역 결정은 루트 `docs/adr/`)
