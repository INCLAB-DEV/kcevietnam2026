> 📄 **제출용 저장소입니다.** 범위·실행 방법·데모 계정은 [SUBMISSION.md](SUBMISSION.md)를 먼저 확인하세요.

# NABI — 2026 베트남 K-콘텐츠 엑스포 B2B 비즈매칭 플랫폼

**2026 베트남 K-콘텐츠 엑스포**(2026년 10월 20일~22일, 주최 마인즈그라운드)의 참가기업·해외 바이어
1:1 상담 매칭 서비스입니다. 참가자가 비즈매칭 신청서를 작성하고, 상대 기업을 탐색해 전시 기간의
상담 슬롯 위에서 미팅을 잡고, 운영자가 명단 적재부터 신청서 심사·배정·미팅 운영까지 콘솔에서
관리합니다.

- **운영 사이트**: https://kcevietnam.salesground.kr
- **구성**: 모노레포 (Next.js 프런트엔드 + FastAPI 백엔드 + PostgreSQL)
- **행사 종속성 없음**: 행사명·타임존·상담 시간·운영시간·열람 정책이 전부 행사(`events`) 레코드에서
  오므로, 같은 코드베이스로 다른 행사를 운영할 수 있습니다.

---

## 제출 산출물 대응표

이 저장소에 포함된 산출물의 위치입니다.

| 산출물 | 위치 | 비고 |
|---|---|---|
| ② 소스코드 | [`frontend/`](frontend/) · [`backend/`](backend/) | 애플리케이션 전체 소스 |
| ④ 완료보고서 근거자료 | [`docs/prd/`](docs/prd/) 기능정의서 17건 · [`docs/adr/`](docs/adr/) 아키텍처 결정기록 14건 · [`research/`](research/) 개발보고서 | 기능 ID는 [`docs/page-list.csv`](docs/page-list.csv)의 화면 목록과 1:1 대응 |
| ⑥ 테스트 | 아래 [테스트](#테스트) 절 | 백엔드 1,197건 · 프런트엔드 1,396건 |
| ⑦ DB 스키마·ERD | [`docs/db/schema.sql`](docs/db/schema.sql) · 아래 [데이터 모델](#데이터-모델) 절의 ERD | 필드 정의서는 [`docs/db/schema-spec-v2.xlsx`](docs/db/schema-spec-v2.xlsx) |
| ⑧ API 명세 | 백엔드 기동 후 `/docs`(Swagger UI) · `/openapi.json` | OpenAPI 3.1 자동 생성, 엔드포인트 94개 |
| ⑨ 계정·권한체계 | 아래 [권한 체계](#권한-체계) 절 · [SUBMISSION.md](SUBMISSION.md)의 데모 계정 | 운영자 축(master/sub)과 참가자 축(참가기업/바이어)이 분리 |

---

## 시스템 구성

### 레이어 경계

**FastAPI가 모든 DB 접근·컴퓨트·AI 호출·시크릿을 소유합니다.** Next.js는 DB에 직접 접속하지 않고
FastAPI API만 호출합니다([`docs/adr/0008-platform-stack-aws-and-backend-owns-db.md`](docs/adr/0008-platform-stack-aws-and-backend-owns-db.md)
경계 B). 프런트엔드의 Route Handler(`frontend/app/api/`, 30개)는 세션 쿠키를 읽어 백엔드에
`Authorization: Bearer` 헤더로 중계하는 BFF 계층이며, 자체 DB 드라이버 의존성이 없습니다.

```
 브라우저
    │  (httpOnly 세션 쿠키)
    ▼
 Next.js (frontend/)
    ├─ 페이지·컴포넌트  : 화면 렌더링, 라우트 가드(UX 리다이렉트)
    └─ app/api/*        : BFF — 쿠키 → Bearer 토큰 변환 후 백엔드로 중계
    │
    │  HTTPS / REST (Bearer)
    ▼
 FastAPI (backend/)
    ├─ auth          : 로그인·약관 동의·회원가입(이메일 인증코드)·권한 가드
    ├─ roster        : 참가자 명단 스냅샷 적재(CSV/XLSX, 멱등 upsert)
    ├─ bm            : 비즈매칭 신청서 단계 저장·제출
    ├─ admin         : 운영자 콘솔 API(행사·기업·심사·배정·미팅·통역사·알림)
    ├─ discover      : 기업 탐색·관심기업(열람 범위 규칙 적용)
    ├─ meetings      : 미팅 신청·수락·거절·취소·가용 슬롯
    ├─ matching      : 슬롯 격자·점유 제어·강제배정·포화배정 엔진
    ├─ notifications : 조직 공유 인박스 + 이메일 채널 + 폴링 스케줄러
    ├─ excel         : 기업·미팅·회의록 엑셀 내보내기 / 명단 가져오기
    └─ api/services  : 미팅 회의록(전사·구조화·PDF/DOCX 내보내기)
    │
    ├──────────────▶ PostgreSQL (Alembic 마이그레이션이 스키마 진실원천)
    ├──────────────▶ Amazon Cognito (세션 토큰 발급·JWKS/RS256 검증)
    ├──────────────▶ S3 (업로드 원본 영구보관)
    ├──────────────▶ SMTP (알림·인증코드·러브콜 메일 발송)
    └──────────────▶ OpenAI API (회의록 전사·구조화)
```

### 기술 스택

| 레이어 | 구성 |
|---|---|
| 프런트엔드 | Next.js 16 · React 19 · TypeScript 5 · Tailwind CSS v4 · shadcn/ui(Radix) · next-intl(ko/en) · Vitest |
| 백엔드 | Python 3.12+ · FastAPI · SQLAlchemy 2.0 · Alembic · Pydantic Settings · pytest |
| 데이터베이스 | PostgreSQL (`btree_gist` 확장 — 슬롯 점유 EXCLUDE 제약) |
| 인증 | 계정 검증(자체 회원가입 · 명단 계정 · 외부 인증 API 어댑터) → 세션 토큰은 Amazon Cognito 발급, 검증은 JWKS/RS256 |
| 파일 저장 | S3 (업로드 원본 영구보관, `files` 테이블이 메타데이터 소유) |
| 외부 AI | OpenAI API (Whisper 전사 + Chat Completions structured outputs) — API 키는 백엔드에만 |

---

## 주요 기능

코드로 확인한 구현 기능만 정리했습니다.

### 참가자 (참가기업 · 바이어)

| 기능 | 설명 |
|---|---|
| 회원가입 | 이메일 6자리 인증코드 발송·확인을 통과해야 가입 진행(`backend/app/auth/email_verification_service.py`). 코드는 해시로만 저장, 재발송 쿨다운·시간당 발송 상한·시도 횟수 제한 |
| 로그인 | 아이디·비밀번호 검증 → 명단 레코드 매핑 → 세션 발급을 한 트랜잭션으로 처리. 최초 진입은 필수 약관 동의를 거쳐야 세션이 나옵니다(ADR-0011) |
| 비즈매칭 신청서 | 참가기업·바이어 각각 4단계 폼. 단계별 임시저장(`PATCH .../steps/{step}`)과 최종 제출(`POST .../submit`)이 분리되어 있고, 필수값 미충족 시 제출이 거부됩니다 |
| 내 프로필 | 제출한 신청서를 작성 구획 그대로 조회·수정(`/profile`, `/exhibitor/profile`) |
| 기업 탐색 | 참가기업↔바이어 **교차 역할만** 열람. 동일 역할 상호 열람은 행사 설정(`events.allow_same_role_discovery`)으로 전환 가능(`backend/app/domain/visibility_rules.py`). 응답은 공개 필드 화이트리스트만 투영 |
| 다국어 | 한국어·영어 UI(`frontend/messages/`). 탐색 API는 `?locale=` 값으로 기업명·소개·키워드를 해당 언어 컬럼으로 채우고, 없으면 국문으로 폴백 |
| 관심기업 | 기업 북마크 등록·해제·목록(`interested_organizations`) |
| 미팅 신청 | 시간 → 장소 → 사유 3단계. 양측이 모두 빈 슬롯의 교집합만 선택 가능하고, 점심시간은 격자에서 아예 생성하지 않으며, 참가사가 지정한 불가 슬롯은 차단됩니다 |
| 미팅 처리 | 수락 · 거절(사유) · 취소(사유). 거절과 취소는 별도 어휘·별도 감사 컬럼으로 분리해 기록합니다 |
| 참석자 명단 | 미팅별 우리 측 참석자 등록(`meeting_participants`) |
| 알림 | 조직 공유 인박스 + 안읽음 배지 + 딥링크. 미팅 요청·수락·취소·거절·리마인더·회의록 요청·신청 승인 7종 |
| 미팅 회의록 | 후기(진행 여부·만족도·후속 의향) → 녹음 업로드 전사 또는 메모 입력 → AI 구조화 초안(핵심 논의/합의/후속 액션) → 사용자 검수 저장 → PDF·DOCX 내보내기. 상대가 쓴 회의록은 비공개 항목을 제외하고 열람 |
| 러브콜 | 미팅 상대 기업에 후속 제안 메일 발송(AI 초안 → 검수·수정 → 실제 발송). 양방향이면 Mutual로 기록 |

### 운영자

| 기능 | 설명 |
|---|---|
| 행사 관리 | 행사 생성·수정, 운영시간·점심시간·상담 슬롯 길이·최소 보장 슬롯 수·열람 정책·사용 장소 유형 설정 |
| 명단 임포트 | CSV/XLSX 명단 스냅샷 적재. **회원ID 기준 멱등** — 같은 파일을 두 번 올려도 레코드가 늘지 않습니다. 원본 파일은 S3에, 원본 행 전체는 `registrants.raw`(JSONB)에 보존. 알려지지 않은 컬럼도 손실 없이 남습니다. 공통 비밀번호를 함께 지정하면 신규·비밀번호 미설정 계정에만 적용하고 기존 비밀번호는 덮어쓰지 않습니다. 비밀번호 컬럼이 포함된 파일은 파싱 단계에서 거부합니다 |
| 단건 등록 | 기업·담당자 개별 등록 및 삭제 |
| 비밀번호 재설정 | 담당자 계정 비밀번호 재설정(sub 운영자는 자기 관할 범위 내에서만) |
| 신청서 심사 | `submitted` → `approved` / `rejected` / `changes_requested` 상태 전이와 사유 기록. 검토자·검토 시각을 `organization_event_roles.reviewed_by` / `reviewed_at`에 남기며, 그 외 상태에서 심사를 시도하면 409로 거부합니다. 승인 시 해당 기업에 알림이 발화합니다 |
| 대리작성 | 미신청(`registered`) 상태 기업의 신청서를 운영자가 대신 작성. 작성한 운영자를 `proxy_written_by_organizer_id`에 감사 기록 |
| 불가 슬롯 관리 | 참가사별 미팅 불가 시간대 설정·조회 |
| 배정 엔진 | ① **강제배정** — 운영자가 대상·시간·장소를 직접 지정해 즉시 확정. ② **재배정** — 미팅이 0건인 기업 보충. ③ **전체 포화배정** — 최소 보장 슬롯 수를 기준으로 초안(draft)을 일괄 생성한 뒤 운영자가 확인하고 확정 또는 폐기. 초안과 확정본은 `saturation_batch_runs`·`saturation_draft_items`에 이력으로 남습니다 |
| 미팅 운영 | 행사 전체 미팅 목록, 기업별 일정, 강제 취소(양측 알림 발화) |
| 미팅 장소 | 비즈매칭존 테이블·비즈니스룸 등록·수정·삭제. 참조 중인 미팅이 있으면 삭제가 409로 막힙니다. 참가사 부스는 미팅 신청 시점에 장소 레코드를 멱등하게 자동 생성합니다 |
| 통역사 | 통역사 인력 등록·수정·삭제 및 기업별 배정·해제 |
| 운영지표 | 명단 현황, 참가자별 미팅 건수, 슬롯 사용률, 회의록 작성 현황, 포화배정 이력. 응답이 집계 범위(`event` / `jurisdiction`)를 스스로 밝혀 화면이 권한을 추측하지 않습니다 |
| 알림 발송 로그 | 채널별 발송 이력(`notification_dispatches`) 조회 및 재발송 |
| 엑셀 내보내기 | 기업 목록 · 미팅 목록 · 회의록 현황 |
| 운영자 계정 | 행사별 운영자 부여·회수 |

### 미팅 슬롯 격자

상담 길이와 슬롯 간격을 **분리**했습니다(`backend/app/matching/slot_grid.py`). 한 칸의 길이는
`events.slot_minutes`(10·20·30·40·60분 중 선택), 다음 칸까지의 간격은 `slot_minutes +
event_schedule_settings.slot_gap_minutes`입니다. 예를 들어 40분 상담 + 5분 텀이면 10:00~10:40,
10:45~11:25, 11:30~12:10 격자가 만들어지고, 5분 텀은 어떤 미팅에도 점유되지 않습니다.
미팅 1건의 최대 길이는 칸 수가 아니라 분(`max_meeting_minutes`)으로 제한합니다.

슬롯 시각은 모두 행사 타임존(`events.timezone`, IANA 문자열) 기준으로 해석하며 특정 시간대를
코드에 고정하지 않습니다.

### 동시성 제어

같은 슬롯에 동시에 수락·배정이 들어와도 **한 건만 성공**합니다. Postgres 트랜잭션 범위 advisory
lock으로 임계구역을 잡고, 확정(`accepted`) 미팅에 대한 `tstzrange` EXCLUDE 제약이 최후 방어선으로
동작합니다. 같은 두 기업 사이의 활성 미팅은 1건으로 제한됩니다(부분 유니크 인덱스).

---

## 권한 체계

운영자 축과 참가자 축은 **서로 다른 테이블 체계**이며 섞이지 않습니다.

### 운영자 축 — `organizers` × `event_organizers`

권한 등급은 계정 전역이 아니라 **계정 × 행사 단위**입니다
([`docs/adr/0012-organizer-permission-per-event-and-scoped-sub.md`](docs/adr/0012-organizer-permission-per-event-and-scoped-sub.md)).
같은 계정이 A 행사에서는 master, B 행사에서는 sub일 수 있습니다.

| 등급 | 권한 |
|---|---|
| `master` | 해당 행사 전역. 운영자 콘솔의 모든 조회·쓰기 |
| `sub` | 조회는 운영자 콘솔 공용, 쓰기는 자기 관할 범위. 관할은 `organization_event_roles.managing_organizer_id`(바이어 소유권)로 정의되며, master 전용 API 호출은 403 |

권한 판정의 권위는 **백엔드**에 있습니다(`backend/app/auth/organizer_guard.py`,
`backend/app/admin/guard.py`). 프런트엔드의 라우트 가드는 UX 리다이렉트일 뿐이며, 토큰을 위조하거나
화면을 우회해 API를 직접 호출해도 백엔드 의존성이 401/403으로 거부합니다.

운영자 계정은 자체 가입이 불가능한 구조이며, 행사별로 명시 부여해야만 생깁니다(전역 기본 권한 없음).

### 참가자 축 — `organizations` × `organization_event_roles`

참가기업과 바이어는 별도 엔티티가 아니라 **한 기업(`organizations`)이 행사별로 갖는 역할**입니다
([`docs/adr/0001-organization-unified-entity.md`](docs/adr/0001-organization-unified-entity.md)).
매칭의 단위도 담당자가 아니라 기업입니다
([`docs/adr/0002-matching-unit-is-organization.md`](docs/adr/0002-matching-unit-is-organization.md)).

| 축 | 값 |
|---|---|
| 역할 | `is_exhibitor` / `is_buyer` 플래그 (겸직 가능) |
| 바이어 유형 | `hosted`(초청) · `pre_registered`(사전등록) · `on_site`(현장) |
| 신청 상태 | `registered` → `submitted` → `approved` / `rejected` / `changes_requested` (`changes_requested` → `submitted` 재제출 가능) |

탐색·매칭 노출은 `approved`부터 열립니다. 알림 인박스는 개인이 아니라 **조직 공유**이며, 외부
발송(이메일)만 소속 담당자 개인 연락처로 팬아웃됩니다
([`docs/adr/0010-notification-model.md`](docs/adr/0010-notification-model.md)).

데모 계정 목록은 [SUBMISSION.md](SUBMISSION.md)에 있습니다.

---

## 데이터 모델

행사(`events`)를 축으로 기업(`organizations`)이 행사별 역할(`organization_event_roles`)로
참가하고 — 이 역할에 참가기업/바이어 신청서 프로필이 붙습니다 — 미팅(`meetings`)이 참가기업·바이어
두 기업을 잇습니다.

스키마의 진실원천은 **Alembic 마이그레이션**(`backend/migrations/versions/`, 32개)이며,
[`docs/db/schema.sql`](docs/db/schema.sql)은 거기서 파생한 열람용 DDL 문서입니다. ORM 모델
(`backend/app/models.py`)은 42개 테이블을 정의하고, `schema.sql`은 그중 40개를 수록합니다
(제출 시점 기준 `email_verification_codes`·`transcription_jobs` 2개가 문서에 미반영).

아래 ERD는 핵심 도메인 23개 테이블을 추린 것입니다(키워드 N:M 연결 테이블은 관계선으로만 표기).

```mermaid
erDiagram
    events {
        uuid id PK
        text name
        text slug UK
        text timezone
        int slot_minutes
        date application_start
        date application_end
        date exhibition_start
        date exhibition_end
        boolean allow_same_role_discovery
    }
    event_schedule_settings {
        uuid id PK
        uuid event_id FK
        time operating_start
        time operating_end
        time lunch_start
        int min_guaranteed_slots
    }
    organizers {
        uuid id PK
        text name
        text email UK
        text member_id
    }
    event_organizers {
        uuid id PK
        uuid event_id FK
        uuid organizer_id FK
        text permission_level
    }
    organizations {
        uuid id PK
        text name_ko
        text name_en
        text business_reg_no
        text website
    }
    organization_event_roles {
        uuid id PK
        uuid organization_id FK
        uuid event_id FK
        boolean is_exhibitor
        boolean is_buyer
        text buyer_subtype
        text application_status
        uuid reviewed_by FK "nullable"
        text review_note
        uuid managing_organizer_id FK "nullable"
    }
    registrants {
        uuid id PK
        uuid event_id FK
        text organizer_member_id
        uuid organization_id FK "nullable"
        text role_hint
        jsonb raw
    }
    members {
        uuid id PK
        uuid organization_id FK
        uuid registrant_id FK "nullable"
        text name
        text email UK
    }
    exhibitor_profiles {
        uuid id PK
        uuid org_event_role_id FK
        uuid booth_id FK "nullable"
        text booth_hall
        text intro_ko
        text annual_sales_range
        text_array unavailable_meeting_slots
    }
    buyer_profiles {
        uuid id PK
        uuid org_event_role_id FK
        text country
        text budget_range
        text adoption_timeline
    }
    exhibitor_products {
        uuid id PK
        uuid exhibitor_profile_id FK
        text name_ko
        text category_ko
        text hs_code
    }
    keywords {
        uuid id PK
        text code
        text label
        text label_en
        text category
    }
    halls {
        uuid id PK
        uuid event_id FK
        text hall_no
        text hall_name
    }
    booths {
        uuid id PK
        uuid hall_id FK
        text code
    }
    meeting_venues {
        uuid id PK
        uuid event_id FK
        text venue_type
        uuid booth_id FK "nullable"
        text label
    }
    saturation_batch_runs {
        uuid id PK
        uuid event_id FK
        int run_number
        int min_guaranteed_slots
        text status
        uuid triggered_by FK "nullable"
    }
    saturation_draft_items {
        uuid id PK
        uuid saturation_run_id FK
        uuid exhibitor_org_id FK
        uuid buyer_org_id FK
        uuid venue_id FK "nullable"
        timestamptz scheduled_start
        text status
        uuid materialized_meeting_id FK "nullable"
    }
    meetings {
        uuid id PK
        uuid event_id FK
        uuid exhibitor_org_id FK
        uuid buyer_org_id FK
        uuid venue_id FK "nullable"
        uuid saturation_run_id FK "nullable"
        text status
        text matching_type
        numeric ai_score "nullable"
        text requested_by
        timestamptz scheduled_start
        timestamptz scheduled_end
    }
    meeting_participants {
        uuid id PK
        uuid meeting_id FK
        uuid member_id FK
    }
    interested_organizations {
        uuid id PK
        uuid event_id FK
        uuid owner_org_id FK
        uuid target_org_id FK
        text source
    }
    post_meeting_reviews {
        uuid id PK
        uuid meeting_id FK
        uuid reviewer_org_id FK
        boolean counterpart_noshow
        text follow_up_intent
        text fit_rating
    }
    notifications {
        uuid id PK
        uuid event_id FK
        uuid recipient_org_id FK
        uuid meeting_id FK "nullable"
        text type
        timestamptz due_at
        timestamptz read_at
    }
    notification_dispatches {
        uuid id PK
        uuid notification_id FK
        uuid member_id FK
        text channel
        text status
        timestamptz sent_at
    }

    events ||--o| event_schedule_settings : "settings"
    events ||--o{ event_organizers : "grants"
    organizers ||--o{ event_organizers : "per-event level"
    organizers ||--o{ organization_event_roles : "reviews and manages"
    events ||--o{ registrants : "roster snapshot"
    organizations |o--o{ registrants : "eager-created org"
    organizations ||--o{ members : "employs"
    registrants |o--o| members : "account link"
    organizations ||--o{ organization_event_roles : "participates as"
    events ||--o{ organization_event_roles : "has roles"
    organization_event_roles ||--o| exhibitor_profiles : "exhibitor form"
    organization_event_roles ||--o| buyer_profiles : "buyer form"
    exhibitor_profiles ||--o{ exhibitor_products : "exhibits"
    exhibitor_profiles }o--o{ keywords : "exhibitor_keywords"
    buyer_profiles }o--o{ keywords : "buyer_interest_keywords"
    organization_event_roles }o--o{ keywords : "org_event_role_org_types"
    events ||--o{ halls : "has halls"
    halls ||--o{ booths : "contains"
    booths |o--o{ exhibitor_profiles : "assigned booth"
    events ||--o{ meeting_venues : "venue pool"
    booths |o--o{ meeting_venues : "booth venue"
    events ||--o{ saturation_batch_runs : "allocation runs"
    saturation_batch_runs ||--o{ saturation_draft_items : "drafts"
    saturation_draft_items |o--o| meetings : "materializes"
    saturation_batch_runs |o--o{ meetings : "confirmed batch"
    events ||--o{ meetings : "schedules"
    organizations ||--o{ meetings : "exhibitor side"
    organizations ||--o{ meetings : "buyer side"
    meeting_venues |o--o{ meetings : "hosts"
    meetings ||--o{ meeting_participants : "attendees"
    members ||--o{ meeting_participants : "attends"
    events ||--o{ interested_organizations : "bookmark scope"
    organizations ||--o{ interested_organizations : "owner"
    organizations ||--o{ interested_organizations : "target"
    meetings ||--o{ post_meeting_reviews : "per-side review"
    organizations ||--o{ post_meeting_reviews : "writes"
    events ||--o{ notifications : "notifies"
    organizations ||--o{ notifications : "org inbox"
    meetings |o--o{ notifications : "about"
    notifications ||--o{ notification_dispatches : "channel fanout"
    members ||--o{ notification_dispatches : "recipient"
```

ERD에 넣지 않은 나머지 테이블은 약관 동의 이력(`consent_documents`·`user_consent_states`·
`user_consent_history`), 참석자 명단(`exhibitor_attendees`·`buyer_attendees`), 추천 바이어,
통역사(`interpreters`·`interpreter_assignments`), 파일 메타데이터(`files`), 러브콜(`love_calls`),
대화 채널, 현장 참관객, AI 매칭 제안(`ai_match_suggestions`), 키워드 연결 테이블입니다.
전체 정의는 [`docs/db/schema.sql`](docs/db/schema.sql)을 참조하세요.

> `meetings.ai_score`·`ai_match_suggestions`는 향후 적합도 산출을 위해 nullable 컬럼으로 마련해
> 둔 자리이며, 현재 배정 엔진은 적합도 점수가 아니라 결정적 정렬·라운드로빈 규칙으로 동작합니다.

---

## 디렉터리 구조

```
.
├── frontend/              Next.js 애플리케이션
│   ├── app/               App Router 페이지(27개) + BFF Route Handler(30개)
│   ├── components/        화면 컴포넌트 (admin · organizer · apply · layout · ui)
│   ├── lib/               API 클라이언트, 도메인 로직, 인증·세션, 유틸
│   ├── messages/          ko.json · en.json (next-intl)
│   ├── hooks/             React 훅
│   └── proxy.ts           라우트 가드 미들웨어
│
├── backend/               FastAPI 애플리케이션
│   ├── app/
│   │   ├── auth/          로그인·회원가입·약관·권한 가드·Cognito 어댑터
│   │   ├── admin/         운영자 콘솔 API + 인가 가드
│   │   ├── roster/        명단 파싱·적재
│   │   ├── bm/            비즈매칭 신청서
│   │   ├── discover/      기업 탐색·관심기업
│   │   ├── meetings/      미팅 신청·처리
│   │   ├── matching/      슬롯 격자·점유 제어·배정 엔진
│   │   ├── notifications/ 알림 생성·채널·스케줄러
│   │   ├── excel/         엑셀 내보내기·가져오기
│   │   ├── api/           회의록·러브콜
│   │   ├── domain/        순수 도메인 규칙(열람 범위 등)
│   │   ├── services/      전사·구조화·내보내기·저장소 어댑터
│   │   ├── models.py      SQLAlchemy ORM (42 테이블)
│   │   └── main.py        앱 조립
│   ├── migrations/        Alembic 마이그레이션 (스키마 진실원천)
│   ├── tests/             pytest
│   └── sample_data/       합성 명단 픽스처 (실 개인정보 아님)
│
├── docs/
│   ├── prd/               기능정의서 F-{기능ID}.md (17건)
│   ├── adr/               아키텍처 결정기록 (14건)
│   ├── db/                schema.sql · 필드 정의서 · 스키마 개요
│   ├── design/            내비게이션 표준 · 컴포넌트 감사 · 디자인 토큰 연동 · 화면 ID 규칙
│   ├── prototypes/        UI 프로토타입 HTML
│   ├── scenarios/         사용자 시나리오
│   ├── specs/             화면 흐름 명세
│   └── page-list.csv      화면 목록 · 기능 ID 대응표
│
├── tokens/                W3C DTCG 디자인 토큰 → 프로토타입 CSS 빌드
├── research/              개발보고서 · 개발현황 및 배포계획
├── CONTEXT.md             도메인 용어 사전 (공유 커널)
└── CONTEXT-MAP.md         문서 읽는 순서
```

### 문서 읽는 순서

| 순서 | 문서 | 내용 |
|---|---|---|
| 0 | [`CONTEXT-MAP.md`](CONTEXT-MAP.md) | 어떤 순서로 읽을지 |
| 1 | [`CONTEXT.md`](CONTEXT.md) | 도메인 용어 사전. 레이어 고유 용어는 [`frontend/CONTEXT.md`](frontend/CONTEXT.md) · [`backend/CONTEXT.md`](backend/CONTEXT.md) |
| 2 | [`docs/adr/`](docs/adr/) | 아키텍처 결정 기록 — 특히 ADR-0008(스택·레이어 경계), ADR-0012(운영자 권한), ADR-0014(미팅 도메인), ADR-0005(수락 모델), ADR-0006(포화배정 정책), ADR-0009(명단 적재·참가자 게이트), ADR-0010(알림 모델) |
| 3 | [`docs/prd/`](docs/prd/) | 기능정의서. [`docs/page-list.csv`](docs/page-list.csv)의 화면 ID와 1:1 |
| 4 | [`docs/db/schema.sql`](docs/db/schema.sql) | DB 스키마(파생 문서 — 진실원천은 Alembic) |
| 5 | [`backend/README.md`](backend/README.md) | 백엔드 상세 — 셋업, 마이그레이션 절차, 엔드포인트 계약 |
| — | [`docs/prototypes/`](docs/prototypes/) | UI 프로토타입 HTML |
| — | [`research/`](research/) | 개발보고서(2026-08 · 2026-09), 개발현황 및 배포계획 |

---

## 실행

요약입니다. 전체 절차와 데모 계정은 [SUBMISSION.md](SUBMISSION.md)를 참조하세요.

```bash
# 백엔드 — Python 3.12 이상, uv, PostgreSQL 인스턴스 필요
cd backend
uv sync
uv run alembic upgrade head
AUTH_BACKEND=demo uv run uvicorn app.main:app --reload

# 프런트엔드 — Node 20 이상
cd frontend
npm install
npm run dev
```

- DB 접속 정보는 `DATABASE_URL` 환경변수로 주입합니다. 설정 항목은 각 디렉터리의 `.env.example`에
  정리되어 있습니다.
- `AUTH_BACKEND` 기본값은 `cognito`이며, 이 경우 Cognito 유저풀 설정이 없으면 기동 시점에 명확히
  실패합니다(조용한 폴백 없음). 로컬 검수는 `AUTH_BACKEND=demo`로 실행합니다.
- 기동 후 API 명세는 `/docs`(Swagger UI) 또는 `/openapi.json`에서 확인할 수 있습니다.

### API 엔드포인트 구성

생성된 OpenAPI 스키마 기준 **94개**입니다.

| 경로 | 개수 | 내용 |
|---|---|---|
| `/api/admin/*` | 50 | 운영자 콘솔 — 행사·기업·심사·대리작성·배정·미팅·장소·통역사·운영자·알림·엑셀 |
| `/meetings/{meeting_id}/*` | 11 | 미팅 회의록·러브콜 메일 |
| `/api/meetings/*` | 8 | 미팅 신청·수락·거절·취소·가용 슬롯·참석자 |
| `/api/auth/*` | 6 | 로그인·회원가입·이메일 인증코드·딥링크 검증 |
| `/api/bm/*` | 6 | 비즈매칭 신청서 조회·단계 저장·제출 (참가기업·바이어) |
| `/api/discover/*` | 5 | 기업 탐색·관심기업 |
| `/api/notifications/*` | 3 | 알림 인박스·읽음 처리 |
| `/api/consents/*` | 2 | 약관 조회·동의 기록 |
| `/api/me` | 1 | 내 소속 기업과 행사별 역할·승인 상태 |
| `/organizer/events/{event_id}/members/import` | 1 | 명단 스냅샷 적재 |
| `/health` | 1 | 헬스체크 |

인증은 `Authorization: Bearer <token>` 헤더로 통일되어 있습니다.

---

## 테스트

```bash
cd backend  && uv run pytest -q     # 1195 passed, 2 skipped (수집 1,197건)
cd frontend && npm test             # 1396 passed (155 files)
```

- 백엔드 테스트는 로컬 PostgreSQL이 필요합니다. 약관 동의 계열 테스트가 전용 DB를 생성했다
  삭제하므로, 접속 롤에 `CREATEDB` 권한이 있어야 합니다.
- 프런트엔드 부가 명령: `npm run typecheck` · `npm run lint` · `npm run build`
- 외부 의존(OpenAI·SMTP·S3·Cognito)은 전부 포트/어댑터 뒤에 격리되어 있어, 테스트는 결정적
  더블로 외부 호출 없이 실행됩니다.

---

## 저장소 범위 안내

이 저장소는 운영 중인 원본 저장소의 **2026-09-29 제출 시점 스냅샷 정제본**입니다. 배포 자격증명과
내부 운영 설정을 제거했으며, 애플리케이션 소스코드는 전부 포함되어 있습니다.

`backend/sample_data/roster/`의 명단 파일은 **전부 합성 데이터**로 실제 개인정보를 포함하지
않습니다. 실 참가기업·참관객 명단(개인정보)은 이 저장소에 포함된 적이 없으며 별도 안전 채널로만
취급합니다.

제외 항목 목록, 합성 데이터 고지, 데모 계정, 상세 실행 절차는 [SUBMISSION.md](SUBMISSION.md)에
있습니다.
