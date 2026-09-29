-- =============================================================================
-- NABI Biz-Matching Platform — DB Schema (파생 ERD 산출물 — 진실원천 아님)
-- =============================================================================
-- 출처: CONTEXT.md(Language/Relationships), docs/adr/0001·0002·0004·0005·0006·0007·0008·0009·0010·0012·0013,
--       docs/db/bm-profile-fields.md(BM 프로필 컬럼 정의 — A층 등록/B층 신청서 2레이어), docs/prd/F-DV-001·F-AU-001·F-MT-001·F-OP-002·F-OP-005·F-BM-001·F-BM-002
--   부스 위치 3계층 정규화(halls/booths) — CONTEXT.md Meeting Venue 글로서리(전시장 부스 계층). 평문 booth → 정규화.
--   멀티 행사 정책 컬럼·통역사 배정·대리작성 감사·운영자 신원 브릿지 — Alembic adminvn0001(#OP 슈퍼어드민 콘솔·베트남 전시 피벗),
--   알림 6종(review_ready) 정합 — Alembic nt001type01(ADR-0010),
--   미팅 도메인 확정 — Alembic mt001meet01(F-MT-001·ADR-0005): 취소/거절 감사 컬럼·awaiting_org_id·request_reason·
--     슬롯 EXCLUDE 점유(accepted만)·D9 활성쌍 유니크·events.timezone·slot_minutes 진실원천 단일화(events) —
--     겸사 드리프트 정정: events 컬럼 구성·event_schedule_settings 별도 테이블 복원(실 DB=Alembic 기준),
--   키워드 영문 라벨 — Alembic i18n0001(docs/backlog/i18n-full-bilingual.md): keywords.label_en 추가(ko/en 데이터 이중언어).
--   K-콘텐츠 택소노미 피벗 — Alembic kct001tax01(현 head): defense_field(13) → business_field(8, 셀러·바이어
--     공용 멀티, exhibitor_products.category rename) + content_category(3, 셀러 전용 단일선택 신규 스칼라).
-- DB: AWS RDS(PostgreSQL) — ADR-0008(구 Supabase). Postgres 문법이라 DDL·ERDCloud 임포트는 그대로 유효.
--   enum은 이식성을 위해 CHECK 제약으로 표현.
--
-- [진실원천 — ADR-0008]
--   운영 DDL의 진실원천은 backend의 Alembic 마이그레이션(Python만 DDL). 이 파일(schema.sql)은
--   거기서 파생되는 사람이 읽는 ERD 소스일 뿐 캐노니컬이 아니다(외주 드리프트 예방).
--   FK·제약을 명시해 ERDCloud 관계선을 그린다. 실제 마이그레이션 작성은 외주 빌드 단계에서 한다.
--
-- [ERD 임포트 — ERDCloud]
--   새 ERD → 하단 Import → 이 파일 전체 붙여넣기 → Import → Auto Layout: Relationship Grouped
--   관계선은 아래 FOREIGN KEY 제약을 ERDCloud가 읽어 자동으로 그림 (Postgres 문법 그대로 통과).
--   ERD: erdcloud.com/d/4GX4DDMkrXe4fTuAh
--
-- [미해결 영역 — CONTEXT.md Flagged ambiguities]
--   · 진입은 딥링크 + 당일 QR Visitor만(ADR-0007: 자체 회원가입 없음). 비밀번호는 DX Korea 인증 API가 검증 → 미저장
--
-- [등록자 적재·참가자 게이트 — ADR-0009]
--   · 주관사 명단 스냅샷은 registrants 로 멱등 upsert(주키 = event_id + organizer_member_id). 원본은 raw jsonb 통째 보존.
--   · import 시점 eager 생성: registrants + organizations + members + organization_event_roles 동시 upsert(로그인은 read-only).
--   · organization_event_roles.application_status 게이트(bm-profile-fields §6 갱신): registered→submitted→{approved|changes_requested|rejected}.
--     매칭 노출은 approved 부터(제출만으론 부족 — 운영 승인 2단계화). registered=명단만, submitted=프로필 제출(운영 검토 대기).
--
-- [주관사 의존 — 미해결(backlog), 스키마는 가정값으로 선반영]
--   · 전 레코드 고유·안정 회원ID 제공 여부 → registrants.organizer_member_id 멱등 주키 전제(ADR-0007/0009)
--   · 실제 명단 컬럼 구조 미확정(선행 블로커) → registrants.raw 로 원본 통째 보존, 컬럼 매핑은 합의 후
--   · DX Korea 인증 API 규격(엔드포인트/회원ID 반환) → 인증이 organizer_member_id 로 registrants 에 매핑되는 전제
-- =============================================================================


-- =============================================================================
-- 1. 이벤트 (전시회 단위 — 역할/매칭/프로필이 모두 이벤트에 종속)
-- =============================================================================
CREATE TABLE events (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),  -- 이 행을 구별하는 고유 번호 (시스템이 자동 생성)
    name                text NOT NULL,                       -- 예: DX Korea 2026
    name_en             text,                                -- 행사명(영문) — 한/영 다국어 요건(FE 어드민 콘솔)
    slug                text NOT NULL UNIQUE,  -- 행사를 주소(URL)에 쓰는 짧은 영문 식별자 (예: dx-korea-2026)
    -- 행사 타임존(IANA) — 슬롯 벽시계 시각 ↔ timestamptz 변환 기준 (mt001meet01 / F-MT-001).
    --   멀티 행사: 베트남 행사는 'Asia/Ho_Chi_Minh'. 슬롯 그리드 생성·미팅 시간 표시가 이 값으로 변환.
    timezone            text NOT NULL DEFAULT 'Asia/Seoul',
    -- 비즈매칭 신청 일정 (실 DB 컬럼명 = application_*/open_at — Alembic 정본 대조로 정정. 구 biz_* 표기는 schema.sql만의 드리프트였음)
    application_start   date,                                -- 비즈매칭 신청 시작 (예: 2026-08-26)
    application_end     date,                                -- 비즈매칭 신청 마감 (예: 2026-09-11)
    open_at             date,                                -- 신청 마감 후 매칭·전체기능 활성일 (예: 2026-09-12)
    -- 전시장·전시 기간 — 슈퍼어드민이 행사 생성 시 입력(멀티 행사 운영 — adminvn0001).
    --   전시 기간 = 실제 미팅이 열리는 날(슬롯 그리드의 날짜 출처). 운영 시각(event_schedule_settings)과 곱해 슬롯 날짜×시간을 만든다.
    venue_name          text,                                -- 전시장 장소명(예: SECC 호치민) — 자유텍스트
    exhibition_start    date,                                -- 전시(미팅 진행) 시작일 (예: 2026-09-16)
    exhibition_end      date,                                -- 전시(미팅 진행) 종료일 (예: 2026-09-19)
    -- 미팅 슬롯 한 칸 길이(분) — 진실원천은 여기 단일. 구 event_schedule_settings.slot_minutes 사본은
    --   mt001meet01 에서 제거(settings 쪽을 읽는 코드 0개 — 이원화 해소).
    slot_minutes        integer NOT NULL DEFAULT 30
                        CHECK (slot_minutes IN (10, 20, 30, 60)),  -- 운영자가 10/20/30/60 중 선택(adminvn0001). 기본 30
    -- 행사별 정책 (#OP 슈퍼어드민 콘솔·베트남 전시 피벗 — adminvn0001). 특정 행사 전용 값을 스키마에 박지 않고
    --   행사마다 뒤집을 수 있게 컬럼화. 소비처: enabled_venue_types=미팅 장소 배정, allow_same_role_discovery=열람 규칙.
    enabled_venue_types text[] NOT NULL DEFAULT '{booth,zone_table,business_room}'
                        CHECK (enabled_venue_types <@ ARRAY['booth','zone_table','business_room']::text[]),  -- 이 행사에서 쓰는 미팅 장소 유형 부분집합(meeting_venues.venue_type과 동일 값집합). 예: 베트남 행사는 booth만
    allow_same_role_discovery boolean NOT NULL DEFAULT false,  -- 같은 역할끼리(참가사↔참가사·바이어↔바이어) 상호 열람 허용 여부 — 기본 false
    created_at          timestamptz NOT NULL DEFAULT now()  -- 이 행이 처음 만들어진 시각 (updated_at 없음 — 실 모델 기준 드리프트 정정)
);


-- =============================================================================
-- 2. 운영사(Organizer) — NABI 발급 내부 계정(주관사 roster 밖 — ADR-0007/0012).
--    권한등급(master/sub)은 계정 전역이 아니라 계정×행사 단위 → event_organizers 로 이동(ADR-0012).
--    행사별 조직 역할(주최사·KOTRA 본부·무역관)은 스키마 enum이 아니라 데이터로 표현(어떤 계정이
--    그 행사 master/sub냐 + 어떤 바이어를 소유하냐). 그래서 여기엔 권한 컬럼을 두지 않는다.
-- =============================================================================
CREATE TABLE organizers (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),  -- 이 행을 구별하는 고유 번호 (시스템이 자동 생성)
    name                text NOT NULL,  -- 운영자(운영사 담당자) 이름
    email               text NOT NULL UNIQUE,  -- 운영자 로그인 아이디 겸 연락용 이메일 (서로 겹치지 않는 고유값)
    password_hash       text NOT NULL,  -- NABI 자체 인증용 비밀번호 해시(평문 저장 금지·bcrypt 등). 운영자는 외부(DX Korea/Cognito) 검증 없이 이 아이디+비번으로 로그인
    -- 운영자 가드 신원 브릿지(adminvn0001) — 인증(운영자 가드)이 쥐는 "회원ID"와 이 행 사이의 다리.
    --   실 Cognito 운영자 어댑터 부재로 어드민 서비스가 최초 접근 시 get-or-create로 지연 백필(기존 행 NULL 허용).
    member_id           text UNIQUE,
    created_at          timestamptz NOT NULL DEFAULT now()  -- 이 행이 처음 만들어진 시각
);

-- 운영사 ↔ 이벤트 (한 운영사가 여러 이벤트 운영 가능) — 권한등급을 여기에 둔다(ADR-0012 결정 2).
--   permission_level: 계정×행사 단위 capability 등급. 같은 계정이 행사마다 master/sub/없음(행 부재).
--   전역 기본 없음 — 행사별로 명시 부여(NOT NULL, DEFAULT 미설정). admin 게이트는 master-for-this-event.
CREATE TABLE event_organizers (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),  -- 이 행을 구별하는 고유 번호 (시스템이 자동 생성)
    event_id            uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,  -- 이 권한이 적용되는 행사를 가리킴
    organizer_id        uuid NOT NULL REFERENCES organizers(id) ON DELETE CASCADE,  -- 권한을 받는 운영자 계정을 가리킴
    permission_level    text NOT NULL
                        CHECK (permission_level IN ('master', 'sub')),  -- 행사별 명시 부여(전역 기본 없음). ADR-0012
    UNIQUE (event_id, organizer_id)
);


-- =============================================================================
-- 3. Organization(기업) — 법인 단위 단일 엔티티 (ADR-0001)
--    한 기업이 Exhibitor/Buyer 역할을 동시에 가질 수 있음 → 역할은 이벤트별 분리(아래)
--    안정 법인정체성만 보유(bm-profile-fields §2, codex P0): 행사별 선언값(위치·연락처·
--    연매출·소개·파일·직원수)은 역할 프로필에 스냅샷 → 행사 간 공유 org 행을 변형하지 않음.
-- =============================================================================
CREATE TABLE organizations (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),  -- 이 행을 구별하는 고유 번호 (시스템이 자동 생성)
    -- name_ko/name_en 모두 nullable: org는 로그인 시 Registrant에서 이른 생성(ADR-0009)되어 한쪽만
    -- 있을 수 있다. "폼 필수(셀러=둘 다, 바이어=영문)"는 제출 API 검증으로 강제(부분저장 비차단). bm-profile-fields §2
    name_ko             text,                                -- 기업명(국문)
    name_en             text,                                -- 기업명(영문)/Organization
    -- 사업자등록번호 = 법인정체성 정본(부가속성, upsert 키 아님; 해외 바이어 결측 D4). registrants.business_number(관찰값)와
    --   충돌 시 명시 충돌검토 동기화로만 갱신(bm-profile-fields §9 ⑥) — 조용한 덮어쓰기 금지. ADR-0007
    business_reg_no     text,                                -- 법인정체성 정본(부가속성, 키 아님; 해외 결측 D4). registrants.business_number(관찰값) 충돌은 명시 동기화로만(§9 ⑥). ADR-0007
    website             text,                                -- 홈페이지/Website — 안정 식별값. 현재 BM-001/002 폼에서 트림되어 미수집→NULL(결정 8). bm-profile-fields §2
    created_at          timestamptz NOT NULL DEFAULT now()
    -- ※ 기존 단일 name → name_ko/name_en 분리(백필). description·founded·employees·위치·Tel·Fax 는
    --    역할 프로필(buyer_profiles/exhibitor_profiles)로 이관/스냅샷. bm-profile-fields §2
);

-- =============================================================================
-- 3b. Registrant 적재층 — 주관사 명단 스냅샷이 착지하는 멱등 upsert 테이블. (ADR-0009, 출처 ADR-0007)
--     멱등 주키 = (event_id, organizer_member_id) — 사업자번호 아님(해외/개인 결측), 전 레코드 존재 회원ID.
--     명단 원본은 raw jsonb 로 통째 보존(주관사 컬럼 구조 미확정 = 선행 블로커). 어떤 스키마가 와도 추후 매핑 가능.
--     ※ 불변과 정정의 경계(F-OP-002 D17, codex P1): 영구 박제는 raw(주관사 원본 jsonb)에만 — 절대 손대지 않는다.
--       정규 컬럼(name·contact_email/phone·business_number 등)과 매핑된 organizations 는 운영자 정정·명단 재업로드(D2)로
--       갱신 가능(mutable). 즉 "주관사가 준 사실"의 원본은 raw에 불변 보존, 표시·운영용 값은 가변(D16 빠른 정정·D2 덮어쓰기와 정합).
--     인증 신원 앵커: DX Korea 인증 API 반환 회원ID = organizer_member_id 로 이 레코드를 찾아 세션 발급(ADR-0007/0008).
--     import는 이 행을 흡수할 때 organizations/members/organization_event_roles 까지 eager upsert(아래 FK로 연결).
--     ※ 적재 경로 공존(ADR-0013): 무역관(sub)이 현지 모집한 해외 바이어는 주관사 스냅샷·회원ID가 없어 이 적재층을 거치지 않고,
--       운영자가 곧장 organizations + organization_event_role 로 직접 생성한다(registrant 행 없음, organizer_member_id 없음, 본인 로그인 없음).
--       스냅샷 경로=DX Korea 신청자(국내기업·국내 바이어)용으로 유지. 직접 등록분도 master 승인(application_status→approved) 후 매칭 노출.
-- =============================================================================
CREATE TABLE registrants (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),  -- 이 행을 구별하는 고유 번호 (시스템이 자동 생성)
    event_id            uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,  -- 이 등록자가 속한 행사를 가리킴
    organizer_member_id text NOT NULL,                       -- 주관사(DX Korea)가 매긴 회원 고유번호. 같은 사람을 명단에 다시 올려도 중복으로 안 생기게 식별하는 열쇠이자, 로그인 때 본인을 찾아 연결하는 키 (멱등 주키, ADR-0007)
    organization_id     uuid REFERENCES organizations(id) ON DELETE SET NULL,  -- 이 등록자가 속한 기업을 가리킴. 명단을 들여올 때 기업 행을 함께 미리 만들어 연결한다 (즉시 생성, ADR-0009)
    name                text,                                -- 등록자(사용자) 성명 — 명단에서 매핑(미확정 시 raw 에서 보강). ADR-0009
    org_name            text,                                -- 소속 기업명 — 명단에서 매핑(eager org 생성 시드). ADR-0009
    contact_email       text,                                -- 연락처(알림 발송용) + 회원ID 결측·충돌 시 보조 대조(ADR-0007)
    contact_phone       text,                                -- 휴대폰 — 알림 발송용. ADR-0007/0009 (OTP 폐기 → 발송용으로만 보존)
    -- 사업자등록번호 = 명단에서 가져온 관찰값(부가속성, 키 아님; 해외/개인 결측 nullable). ADR-0007
    -- 충돌정책(bm-profile-fields §9 ⑥): 이건 관찰값, organizations.business_reg_no 가 정본 — 멤버ID upsert 한 줄이
    --   org 정체성(business_reg_no)을 조용히 덮어쓰지 않게, org 갱신은 명시 충돌검토 동기화로만.
    business_number     text,                                -- 관찰값(명단). 정본=organizations.business_reg_no; org 갱신은 명시 충돌검토 동기화로만(§9 ⑥). ADR-0007
    role_hint           text CHECK (role_hint IN ('exhibitor', 'buyer', 'both')),  -- 출처 명단 파일로 유추한 잠정 역할(프로필 경로로 확정). ADR-0009
    raw                 jsonb NOT NULL,                      -- 명단 원본 전체 영구 박제(불변 — 절대 갱신 안 함; 컬럼 구조 미확정. ADR-0009 / F-OP-002 D17)
    created_at          timestamptz NOT NULL DEFAULT now(),  -- 이 행이 처음 만들어진 시각
    updated_at          timestamptz NOT NULL DEFAULT now(),  -- 멱등 upsert 갱신 시각
    UNIQUE (event_id, organizer_member_id)                   -- 멱등 주키(ADR-0009)
);


-- Member — Organization 하위 사용자 계정. 같은 기업 내 동일 권한(플랫) → 권한 컬럼 없음. (ADR-0002 참고)
-- = 주관사 명단에서 eager 생성되는 Registrant의 사용자 측 (CONTEXT: Registrant).
--   회원ID(organizer_member_id)의 정본 위치는 registrants(멱등 주키) — members는 키를 중복 보유하지 않고
--   registrant_id FK로 적재 레코드에 연결한다(ADR-0009 재조정). DX Korea 인증 API 반환 회원ID로
--   registrants 를 찾고, 그 행에 매달린 member 로 세션을 잇는다(ADR-0007/0008).
--   비밀번호는 저장하지 않음(DX Korea 인증 API가 검증). email은 회원ID 결측·충돌 시 보조 대조용(ADR-0007).
CREATE TABLE members (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),  -- 이 행을 구별하는 고유 번호 (시스템이 자동 생성)
    organization_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,  -- 이 계정이 어느 기업 소속인지 가리킴
    registrant_id       uuid UNIQUE REFERENCES registrants(id) ON DELETE SET NULL,  -- 이 계정이 어느 명단 적재 기록에서 나왔는지 가리킴. 주관사 회원번호의 원본은 registrants에 있고 계정은 거기 연결만 한다 (ADR-0009)
    name                text NOT NULL,  -- 회원(로그인 사용자) 이름
    email               text NOT NULL UNIQUE,  -- 회원 로그인·연락용 이메일 (서로 겹치지 않는 고유값)
    title               text,                                -- 직급 (미팅 수락 후 공개 — F-DV-001 D9)
    created_at          timestamptz NOT NULL DEFAULT now()  -- 이 행이 처음 만들어진 시각
);


-- =============================================================================
-- 3c. 약관 동의 모델 — 방산=민감정보 동의를 항목별·버전별·감사 가능하게 보존. (ADR-0009, 출처 ADR-0007/0008)
--     최초 로그인 시 NABI 약관 동의 + NABI 계정(Cognito) 발급(ADR-0007).
--     한국 개인정보보호법: 약관은 항목별 분리 동의(서비스 이용/개인정보/민감정보(방산)/제3자/마케팅, 필수·선택 구분).
--     항목별 동의·철회·버전·시각을 법적 증빙 가능하게 → 3테이블(문서·마스터·이력)로 모델링. (단일 user_consents 대체)
--       · consent_documents     : 약관 문서(버전 관리)
--       · user_consent_states   : 개인별 현재 동의 상태(마스터, 가변) — 빠른 조회
--       · user_consent_history  : 동의/철회 이력(append-only 감사 로그) — 불변 증빙
-- =============================================================================

-- 약관 문서(버전 관리). (type, version) 으로 한 약관의 개정본을 행으로 누적. ADR-0009
CREATE TABLE consent_documents (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),  -- 이 행을 구별하는 고유 번호 (시스템이 자동 생성)
    type                text NOT NULL CHECK (type IN ('tos', 'privacy', 'sensitive', 'third_party', 'marketing')),  -- 항목 분리(서비스/개인정보/민감정보(방산)/제3자/마케팅)
    title               text NOT NULL,                       -- 약관명(화면 노출). ADR-0009
    version             text NOT NULL,                       -- 약관 버전(개정 추적)
    content_url         text,                                -- 약관 본문 위치
    is_required         boolean NOT NULL,                    -- 필수/선택 구분. ADR-0009
    effective_date      date,                                -- 시행일
    created_at          timestamptz NOT NULL DEFAULT now(),  -- 이 행이 처음 만들어진 시각
    UNIQUE (type, version)                                   -- 항목+버전 유일
);

-- 개인별 동의 상태 마스터(현재값, 가변). "이 회원이 지금 X에 동의 중인가?" 빠른 조회. ADR-0009
CREATE TABLE user_consent_states (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),  -- 이 행을 구별하는 고유 번호 (시스템이 자동 생성)
    member_id           uuid NOT NULL REFERENCES members(id) ON DELETE CASCADE,  -- 이 동의 상태가 누구(어느 회원) 것인지 가리킴
    type                text NOT NULL CHECK (type IN ('tos', 'privacy', 'sensitive', 'third_party', 'marketing')),  -- 어떤 약관 항목인지 구분 (tos=서비스이용, privacy=개인정보, sensitive=민감정보(방산), third_party=제3자제공, marketing=마케팅)
    consent_document_id uuid REFERENCES consent_documents(id),  -- 현재 동의한 약관 버전
    agreed              boolean NOT NULL,                    -- 현재 동의 여부
    agreed_at           timestamptz,                         -- 현재 동의 시각
    withdrawn_at        timestamptz,                         -- 철회 시각(nullable)
    updated_at          timestamptz NOT NULL DEFAULT now(),  -- 이 행이 마지막으로 수정된 시각
    UNIQUE (member_id, type)                                 -- 회원×항목 당 1 마스터 행
);

-- 동의/철회 이력(append-only 감사 로그). 모든 동의·철회 이벤트를 영구 박제(불변 증빙). ADR-0009
CREATE TABLE user_consent_history (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),  -- 이 행을 구별하는 고유 번호 (시스템이 자동 생성)
    member_id           uuid NOT NULL REFERENCES members(id) ON DELETE CASCADE,  -- 이 동의·철회 기록이 누구(어느 회원) 것인지 가리킴
    consent_document_id uuid REFERENCES consent_documents(id),  -- 어떤 약관 버전에 대한 액션인가
    action              text NOT NULL CHECK (action IN ('agreed', 'withdrawn')),  -- 한 행위의 종류 (agreed=동의함, withdrawn=동의 철회함)
    acted_at            timestamptz NOT NULL DEFAULT now(),  -- 액션 발생 시각(감사용)
    ip                  text,                                -- 동의·철회 시점 IP(증빙)
    method              text                                 -- 동의·철회 경로/수단(증빙)
);


-- =============================================================================
-- 4. 이벤트별 역할 (Organization + roles 배열을 정규화 — ADR-0001)
--    한 (기업, 이벤트) 당 1행. exhibitor/buyer 둘 다 true 가능.
--    buyer_subtype: 플랫폼 경험 동일, 데이터에서만 구분 (CONTEXT: Buyer 하위유형)
--    application_status: 등록자 → 비즈매칭 참가자 게이트 (ADR-0009). import eager 생성 시 이 행도 함께 upsert.
-- =============================================================================
CREATE TABLE organization_event_roles (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),  -- 이 행을 구별하는 고유 번호 (시스템이 자동 생성)
    organization_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,  -- 이 역할 행이 어느 기업의 것인지 가리킴
    event_id            uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,  -- 이 역할이 적용되는 행사를 가리킴
    is_exhibitor        boolean NOT NULL DEFAULT false,  -- 이 기업이 이 행사에서 참가사(셀러) 역할인지 여부 (true=맞음)
    is_buyer            boolean NOT NULL DEFAULT false,  -- 이 기업이 이 행사에서 바이어 역할인지 여부 (true=맞음)
    buyer_subtype       text CHECK (buyer_subtype IN ('hosted', 'pre_registered', 'on_site')),  -- 바이어 종류 구분 (hosted=주최측 초청, pre_registered=사전등록, on_site=현장 전환). 기능은 같고 분류용
    -- 승인 게이트 상태머신 (bm-profile-fields §6, codex P0 — ADR-0009 갱신: 제출=승격 → 제출→운영승인→노출 2단계화).
    --   전이: registered→submitted(사용자 제출, 원자성 유지) / submitted→{approved|changes_requested|rejected}(운영) /
    --         changes_requested→submitted(재제출) / approved·rejected 종단. 매칭 노출은 approved 부터(현 submitted 에서 변경).
    application_status  text NOT NULL DEFAULT 'registered'
                        CHECK (application_status IN ('registered', 'submitted', 'changes_requested', 'approved', 'rejected')),
    -- 승인 감사 컬럼 (bm-profile-fields §6) — 운영/KOTRA 검토 슬라이스가 채움.
    reviewed_at         timestamptz,                         -- 최종 검토(승인/반려/보완요청) 시각
    reviewed_by         uuid REFERENCES organizers(id) ON DELETE SET NULL,  -- 검토한 운영자
    review_note         text,                                -- 보완요청/반려 사유

    -- 바이어 소유권 링크 (ADR-0012 결정 3) — sub 운영자의 관할(Jurisdiction)을 정의. 행사별 바이어 역할 단위에 귀속.
    --   해외 바이어는 "현재 관리 운영자 최대 하나"를 가짐(nullable·재배정 가능). sub는 자기가 현재 관리하는 바이어만 관리 행위 가능.
    --   프로필 제출 전(application_status='registered')에도 소유권이 존재할 수 있어(HQ/주최사가 배정 전 먼저 등록) 프로필이 아니라 역할 행에 둔다.
    --   exhibitor-only·국내 바이어 행은 NULL. master 운영자는 이 링크와 무관하게 전역 관할(검사는 FastAPI 경계 B).
    --   ※ 무역관 직접등록 바이어의 진입점(ADR-0013): registrant 없이 이 역할 행을 직접 생성하고 managing/created_by_organizer_id 로 소유를 박는다.
    --     이 경로 행은 organizer_member_id·registrant 의존이 없으며 master 승인(application_status→approved) 후 매칭 합류.
    managing_organizer_id    uuid REFERENCES organizers(id) ON DELETE SET NULL,  -- 현재 관리 운영자(재배정 가능). ADR-0012/0013
    created_by_organizer_id  uuid REFERENCES organizers(id) ON DELETE SET NULL,  -- 최초 등록 운영자 기록(ADR-0012 문서상 created_by_operator_id). FK=organizers 라 일관 네이밍
    -- 신청서 대리작성 감사(#OP 슈퍼어드민 콘솔 — adminvn0001): 엑셀 임포트만 되고 회원가입 안 한 기업의 프로필을
    --   운영자가 대신 작성한 경우 그 행위자. 채워져도 application_status는 'registered'(=미신청) 유지 — 대리작성은
    --   제출(submit)이 아니다(게이트는 앱 로직). 일반 자가작성/직접수정 경로는 NULL. meetings의 대리신청 도장과 별개 축.
    proxy_written_by_organizer_id uuid REFERENCES organizers(id) ON DELETE SET NULL,
    created_at          timestamptz NOT NULL DEFAULT now(),  -- 이 행이 처음 만들어진 시각
    UNIQUE (organization_id, event_id)
);


-- =============================================================================
-- 4b. 운영/스케줄 설정 — 행사당 1:1 별도 테이블 (ADR-0006 / F-OP-005 / F-MT-001 D12).
--     ※ 드리프트 정정: 구 schema.sql 은 이 테이블이 events 로 흡수·lunch_* 폐기된 것으로 그렸으나
--       실 DB(Alembic 정본)는 별도 테이블 + lunch_* 유지 — 파생물인 이 파일을 현실에 맞춘다.
--     운영 시각·점심 블록·최소 보장 건수는 하드코딩 금지, Organizer 설정 변수(D12). 일일·총 슬롯 수는
--     events(전시 기간 × slot_minutes × timezone) × 이 설정(운영 시각 − 점심 블록)
--     − 참가사별 불가 슬롯(exhibitor_profiles.unavailable_meeting_slots, B층 opt-out)에서 파생.
--     slot_minutes 는 mt001meet01 에서 제거 — 진실원천을 events.slot_minutes 로 단일화(사본 이원화 해소).
-- =============================================================================
CREATE TABLE event_schedule_settings (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),  -- 이 행을 구별하는 고유 번호 (시스템이 자동 생성)
    event_id            uuid NOT NULL UNIQUE REFERENCES events(id) ON DELETE CASCADE,  -- 어느 행사의 설정인지 가리킴 (행사당 1행)
    operating_start     time NOT NULL DEFAULT '09:00',       -- 운영 시작 시각 (F-OP-005 디폴트 09:00)
    operating_end       time NOT NULL DEFAULT '18:00',       -- 운영 종료 시각 (디폴트 18:00)
    lunch_start         time,                                -- 점심(미팅 제외) 블록 시작 — 행사 전역, 선택 (F-MT-001 D12)
    lunch_end           time,                                -- 점심(미팅 제외) 블록 종료
    min_guaranteed_slots integer NOT NULL DEFAULT 10,        -- 모든 참가사에 보장하는 최소 미팅 슬롯 수 N (ADR-0006 보장 라운드 기준)
    created_at          timestamptz NOT NULL DEFAULT now(),  -- 이 행이 처음 만들어진 시각
    updated_at          timestamptz NOT NULL DEFAULT now()  -- 이 행이 마지막으로 수정된 시각(운영 변수 변경 추적)
);


-- =============================================================================
-- 4c. 통역사 배정 (#OP 슈퍼어드민 콘솔 — adminvn0001) — 참가기업별 통역사 배정.
--     회의록 작성은 통역사 몫이나 통역사 로그인 계정 체계는 추후(v1은 스키마 + 운영자 관리만).
--     통역사는 회사(Organization)가 아니라 행사 소속 개인 인력 풀 — event_id로 행사에 귀속.
--     ※ 바이어 참석자의 통역 수요(buyer_attendees.interpreter_need/languages)와 별개 축 —
--       그쪽은 수요(필요 여부·언어), 이쪽은 공급(누가 어느 기업에 배정됐나).
-- =============================================================================
CREATE TABLE interpreters (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),  -- 이 행을 구별하는 고유 번호 (시스템이 자동 생성)
    event_id            uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,  -- 이 통역사가 소속된 행사(행사별 인력 풀)를 가리킴
    name                text NOT NULL,                       -- 통역사 이름
    languages           text[] CHECK (languages <@ ARRAY['ko','en','zh','ja','ru','other']::text[]),  -- 구사 언어(멀티, §1.2 meeting_language 값집합)
    phone               text,                                -- 연락처(전화)
    email               text,                                -- 연락처(이메일)
    note                text,                                -- 운영 메모(선택)
    created_at          timestamptz NOT NULL DEFAULT now(),  -- 이 행이 처음 만들어진 시각
    updated_at          timestamptz NOT NULL DEFAULT now()  -- 이 행이 마지막으로 수정된 시각
);

-- 참가기업(Organization) ↔ 통역사 배정. 한 기업은 행사당 통역사 하나(UNIQUE — 재배정은 기존 배정을 갈아끼움),
--   한 통역사는 여러 기업을 맡을 수 있다(반대 방향 제약 없음). adminvn0001
CREATE TABLE interpreter_assignments (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),  -- 이 행을 구별하는 고유 번호 (시스템이 자동 생성)
    interpreter_id      uuid NOT NULL REFERENCES interpreters(id) ON DELETE CASCADE,  -- 배정된 통역사를 가리킴
    organization_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,  -- 통역사를 배정받는 참가기업을 가리킴
    event_id            uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,  -- 이 배정이 속한 행사를 가리킴
    created_at          timestamptz NOT NULL DEFAULT now(),  -- 이 행이 처음 만들어진 시각
    UNIQUE (event_id, organization_id)                       -- 기업당 행사별 통역사 1명(재배정=갈아끼움)
);


-- =============================================================================
-- 5. 키워드 (고정 분류체계 시드 lookup — bm-profile-fields §1.1)
--    category 컬럼은 namespace 식별자(자유 텍스트) — 3-카테고리(content_category, exhibitor_profiles의
--    스칼라 컬럼)와는 무관하다. 매칭 구동 차원은 아래 두 category 로 시드(코드값=영문 슬러그,
--    label=국문·label_en=영문 표시):
--      · 'business_field' (K-콘텐츠 사업분야 8종) — 셀러 전시품목 = 바이어 관심분야(공용). Alembic kct001tax01
--          game_production·animation_distribution·content_production·music_platform·
--          newtech_content·character_licensor·webtoon_production·music_production
--          → 조인: buyer_interest_keywords / exhibitor_keywords
--      · 'org_type' (참가자 구분 8종) — 바이어·셀러 공통.
--          private_defense·private_commercial·association·government·exhibition_agent·
--          media·local_gov·other  → 조인: org_event_role_org_types (역할 단위, 아래)
-- =============================================================================
CREATE TABLE keywords (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),  -- 이 행을 구별하는 고유 번호 (시스템이 자동 생성)
    code                text,                                -- 고정 분류 슬러그(API·매칭 식별자, 예 'game_production'). bm-profile-fields §1.1
    label               text NOT NULL,                       -- 표시 라벨(국문)
    label_en            text,                                -- 표시 라벨(영문) — en 로케일은 label_en ?? label 폴백(번역 결측=NULL, code는 식별자라 화면 노출 금지). Alembic i18n0001
    category            text,                                -- 'business_field'(8)·'org_type'(8) 시드 — namespace, 3-카테고리와 무관
    UNIQUE (category, code)
);

-- 참가자 구분(기관유형 8종) 멀티선택 — 역할(org_event_role) 단위 부착. (bm-profile-fields §1.1)
--   바이어·셀러 공통 차원이라 프로필이 아니라 역할에 붙임(category='org_type' 키워드만 부착).
CREATE TABLE org_event_role_org_types (
    org_event_role_id   uuid NOT NULL REFERENCES organization_event_roles(id) ON DELETE CASCADE,  -- 기관유형 태그를 붙이는 기업-행사 역할을 가리킴
    keyword_id          uuid NOT NULL REFERENCES keywords(id) ON DELETE CASCADE,  -- category='org_type'
    PRIMARY KEY (org_event_role_id, keyword_id)
);


-- =============================================================================
-- 5b. 전시장 부스 계층 (Hall / Booth) — 부스 위치를 3계층으로 정규화. (CONTEXT.md Meeting Venue 글로서리)
--     3계층 = Hall Number / Hall 이름(ㅇㅇㅇ관) / Booth code(예 "b-12").
--     기존 exhibitor_profiles.booth(평문 "A-101") 한 칸을 제거하고 이 두 테이블 + booth_id FK로 대체.
--     계층·그룹·정렬이 평문에선 불가 → 정규화(Model A). FK 의존상 exhibitor_profiles·meeting_venues 보다 먼저 정의.
-- =============================================================================
CREATE TABLE halls (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),  -- 이 행을 구별하는 고유 번호 (시스템이 자동 생성)
    event_id            uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,  -- 이 전시관이 속한 행사를 가리킴
    -- Hall Number: 정렬·식별용. text 로 둔다 — "1관/2관" 숫자형도 "A홀" 영문형도 모두 수용(전시장 표기 미확정).
    --   순수 숫자면 정렬 시 캐스팅/제로패딩으로 처리. 무난한 공통분모로 text 채택.
    hall_no             text NOT NULL,
    hall_name           text NOT NULL,                       -- 예 "제1전시관"
    created_at          timestamptz NOT NULL DEFAULT now(),  -- 이 행이 처음 만들어진 시각
    UNIQUE (event_id, hall_no)
);

CREATE TABLE booths (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),  -- 이 행을 구별하는 고유 번호 (시스템이 자동 생성)
    hall_id             uuid NOT NULL REFERENCES halls(id) ON DELETE CASCADE,  -- 이 부스가 속한 전시관을 가리킴
    code                text NOT NULL,                       -- 부스 코드, 예 "b-12"
    created_at          timestamptz NOT NULL DEFAULT now(),  -- 이 행이 처음 만들어진 시각
    UNIQUE (hall_id, code)
);


-- =============================================================================
-- 5c. 파일 (files) — 업로드 원본·메타·스캔·보관 (bm-profile-fields §5, codex P1)
--     방산 문서라 단순 s3_key 부족 → 메타/스캔/보관기간/교체이력을 행으로 관리.
--     프로필은 *_file_id FK 로 참조. Smart Fill 업로드 원본도 같은 테이블(purpose='smartfill_source').
--     FK 의존상(buyer_profiles/exhibitor_profiles 가 참조) 프로필보다 먼저 정의. organizations·members 는 위에서 정의됨.
-- =============================================================================
CREATE TABLE files (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),  -- 이 행을 구별하는 고유 번호 (시스템이 자동 생성)
    s3_key              text NOT NULL,                       -- S3 객체 키(암호화 버킷)
    s3_version_id       text,                                -- S3 버전 ID(버저닝 — 교체이력)
    original_filename   text,                                -- 업로드 원본 파일명
    content_type        text,                                -- MIME 타입
    byte_size           bigint,                              -- 바이트 크기
    checksum_sha256     text,                                -- 무결성 체크섬
    purpose             text NOT NULL CHECK (purpose IN ('company_logo', 'company_profile', 'company_profile_doc', 'smartfill_source')),  -- 파일 용도 (company_logo=기업로고, company_profile=기업소개, company_profile_doc=기업소개서, smartfill_source=스마트필 입력 원본)
    owner_org_id        uuid REFERENCES organizations(id) ON DELETE SET NULL,        -- 소유 기업
    uploaded_by_member_id uuid REFERENCES members(id) ON DELETE SET NULL,           -- 업로더(nullable)
    scan_status         text NOT NULL DEFAULT 'pending' CHECK (scan_status IN ('pending', 'clean', 'infected')),  -- 악성코드 스캔 상태
    retention_until     date,                                -- 보관기간(방산 보관정책 — nullable)
    created_at          timestamptz NOT NULL DEFAULT now()  -- 이 행이 처음 만들어진 시각
);


-- =============================================================================
-- 6. Exhibitor 프로필 (이벤트별 전시 정보) — F-DV-001 참가사 카드/상세 필드
-- =============================================================================
-- 셀러 프로필 필드 = bm-profile-fields §4.1 (DX Korea 셀러 등록폼 + KOTRA 요구사항). 잠정 컬럼 대체.
CREATE TABLE exhibitor_profiles (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),  -- 이 행을 구별하는 고유 번호 (시스템이 자동 생성)
    org_event_role_id   uuid NOT NULL UNIQUE REFERENCES organization_event_roles(id) ON DELETE CASCADE,  -- 이 셀러 프로필(신청서)이 어느 기업-행사 역할에 붙는지 가리킴 (역할당 하나)
    -- 부스 위치 — 정규화된 booths 참조(미배정 가능 → NULL 허용). 평문 booth 컬럼 대체.
    --   F-DV-001 카드/상세 "부스 위치" 표시값은 {hall_name} {code} 파생(halls·booths 조인). 평문 저장 아님.
    booth_id            uuid REFERENCES booths(id) ON DELETE SET NULL,
    -- step1 기본정보: 회원가입 등록 신고값 스냅샷(읽기 전용). 부스는 Hall>관>부스위치 3단계 신고값 —
    --   실제 배정은 위 booth_id FK(정규화 halls/booths, 현재 미배정 가능). 신고 vs 배정은 별개.
    booth_hall          text,                                -- 부스 Hall(7·8·9·10)
    booth_pavilion      text,                                -- 관(대한민국관·드론/대드론/로봇관 등)
    booth_location      text,                                -- 부스위치(미배정 시 NULL)
    booth_type          text,                                -- 부스타입(독립부스 등)
    booth_count         integer,                             -- 부스개수
    representative_name_ko text,                             -- 대표자명(국문)
    representative_name_en text,                             -- 대표자명(영문)
    company_email       text,                                -- 회사 이메일
    zip_code            text,                                -- 회사 우편번호
    business_type       text,                                -- 업태
    business_item       text,                                -- 종목
    -- step1: 연락/주소/규모(행사별 스냅샷)
    main_tel            text,                                -- 대표번호
    fax                 text,                                -- 팩스번호
    address_ko          text,                                -- 주소(국문)
    address_detail      text,                                -- 상세주소
    address_en          text,                                -- 주소(영문)
    annual_sales_range  text CHECK (annual_sales_range IN ('krw_1_5', 'krw_5_10', 'krw_10_50', 'krw_50plus')),  -- 연매출(KRW, 단위 억원) §1.4 annual_sales_seller
    employee_range      text CHECK (employee_range IN ('e_0_10', 'e_11_50', 'e_51_100', 'e_101plus')),          -- 회사규모(직원 수) §1.4
    available_languages text[] CHECK (available_languages <@ ARRAY['ko','en','zh','ja','ru','other']::text[]),  -- 상담 가능언어(멀티) §1.2 meeting_language
    -- step2/3: 소개·상품(국/영 컬럼 분리 — §3 KO/EN 고정)
    intro_ko            text,                                -- 기업 소개(국문, 500)
    intro_en            text,                                -- 기업 소개(영문, 500)
    product_intro_ko    text,                                -- 상품 소개(국문, 500)
    product_intro_en    text,                                -- 상품 소개(영문, 500)
    product_price_range text CHECK (product_price_range IN ('krw_0_10m', 'krw_10_30m', 'krw_30_50m', 'krw_50_70m', 'krw_70_100m')),  -- 상품 가격대(KRW, 단위 백만원) §1.4
    company_logo_file_id        uuid REFERENCES files(id) ON DELETE SET NULL,  -- 기업 로고(파일)
    company_profile_doc_file_id uuid REFERENCES files(id) ON DELETE SET NULL,  -- 기업 소개서(파일)
    -- step4: 선호 바이어(국가/구분 멀티선택으로 정렬, BM-002)
    preferred_buyer_country text,                            -- (구) 자유텍스트 — 아래 멀티선택으로 대체(비파괴 보존)
    preferred_buyer_countries text[],                        -- 선호 바이어 국가(멀티 선택)
    preferred_buyer_types   text[],                          -- 선호 바이어 구분(기관유형 멀티)
    -- 참가 경로(조건부 CHECK §1.3) — KOTRA 요구사항
    participation_route text CHECK (participation_route IN ('re_1_2', 're_3_5', 're_6plus', 'new')),
    new_acquisition_channel text CHECK (new_acquisition_channel IN ('edm', 'official_letter', 'kotra_invitation', 'website_sns', 'media')),  -- 신규 발굴 경로 (edm=이메일, official_letter=공문, kotra_invitation=KOTRA초청, website_sns=웹/SNS, media=언론). 참가경로가 '신규'일 때만 입력
    kst_available_time  text,                                -- KST 상담 가능 시간(v1 text — §7 HITL: 슬롯 구조화)
    unavailable_meeting_slots text[],                        -- 행사 미팅 '불가' 슬롯(opt-out; "YYYY-MM-DDTHH:MM", events.timezone 벽시계). 그리드=events(전시 기간·slot_minutes) × event_schedule_settings(운영 시각−점심)에서 파생
    kotra_member        boolean,                             -- KOTRA 기업회원 가입 유무
    -- 카테고리(3종, 단일선택) — kct001tax01. Hall 필터를 대체하는 회사 분류축, 셀러 전용(바이어엔 없음).
    -- keyword 조인이 아니라 스칼라인 이유: discover 태그 쿼리가 namespace를 필터하지 않아, 조인에
    -- 넣으면 business_field(8) 태그와 뒤섞인다.
    content_category    text CHECK (content_category IN ('animation_character', 'broadcasting', 'comics_game_music')),
    created_at          timestamptz NOT NULL DEFAULT now(),  -- 이 행이 처음 만들어진 시각
    -- §1.3: 채널은 route='new'일 때만 허용. route NULL(부분저장 #26)·기타는 통과. "route=new면 채널 필수"는 API 제출검증.
    CHECK (new_acquisition_channel IS NULL OR participation_route = 'new')
    -- 주요 전시품목(멀티 8, business_field)→exhibitor_keywords / 참가자 구분(멀티 8)→org_event_role_org_types(역할 단위).
    -- ※ 잠정 컬럼(strength·achievements·target_buyer_types·target_buyer_nationalities·target_org_types) 제거.
);

-- 전시 제품 (F-BM-002 step2 + KOTRA 요구사항·별첨2 로스터) — 제품 단위 정규화, 국/영·HS코드 포함.
CREATE TABLE exhibitor_products (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),  -- 이 행을 구별하는 고유 번호 (시스템이 자동 생성)
    exhibitor_profile_id uuid NOT NULL REFERENCES exhibitor_profiles(id) ON DELETE CASCADE,  -- 이 제품이 어느 셀러 프로필(기업)의 것인지 가리킴
    name_ko             text NOT NULL,                       -- 제품/서비스명(국문) — 기존 name 분리 백필
    name_en             text,                                -- 제품/서비스명(영문)
    business_field      text CHECK (business_field IN ('game_production','animation_distribution','content_production','music_platform','newtech_content','character_licensor','webtoon_production','music_production')),  -- 사업분야(business_field, 8종) 코드 — (구) category, kct001tax01에서 rename
    category_ko         text,                                -- (구) 자유텍스트 카테고리(국문) — business_field로 대체
    category_en         text,                                -- (구) 자유텍스트 카테고리(영문)
    hs_code             text,                                -- HS코드(요구사항 "품목 정보")
    hs_description      text,                                -- HS 설명(요구사항)
    spec                text,                                -- 사양(국문)
    spec_en             text,                                -- 사양(영문)
    price_range         text CHECK (price_range IN ('krw_0_10m', 'krw_10_30m', 'krw_30_50m', 'krw_50_70m', 'krw_70_100m')),  -- 제품별 가격대(KRW 백만원) — 프로필 단위에서 이동
    sort_order          integer NOT NULL DEFAULT 0,          -- 표시 정렬 순서
    created_at          timestamptz NOT NULL DEFAULT now()  -- 이 행이 처음 만들어진 시각
);

-- 참가사 전시품목 키워드 (N:M — category='business_field' 8종)
CREATE TABLE exhibitor_keywords (
    exhibitor_profile_id uuid NOT NULL REFERENCES exhibitor_profiles(id) ON DELETE CASCADE,  -- 전시품목 태그를 붙이는 셀러 프로필(기업)을 가리킴
    keyword_id           uuid NOT NULL REFERENCES keywords(id) ON DELETE CASCADE,  -- 셀러가 전시하는 사업분야 키워드를 가리킴 (8종 중 선택)
    PRIMARY KEY (exhibitor_profile_id, keyword_id)
);

-- 셀러 담당자 (복수 — bm-profile-fields §4.3, 국/영 이중). member_id nullable(로그인·미팅 인물과 동일인이면 연결, 폼값 스냅샷).
CREATE TABLE exhibitor_attendees (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),  -- 이 행을 구별하는 고유 번호 (시스템이 자동 생성)
    exhibitor_profile_id uuid NOT NULL REFERENCES exhibitor_profiles(id) ON DELETE CASCADE,  -- 이 담당자가 속한 셀러 프로필(기업)을 가리킴
    member_id           uuid REFERENCES members(id) ON DELETE SET NULL,  -- codex P1: 동일인 연결(nullable)
    last_name_ko        text,  -- 담당자 성(국문)
    last_name_en        text,  -- 담당자 성(영문)
    first_name_ko       text,  -- 담당자 이름(국문)
    first_name_en       text,  -- 담당자 이름(영문)
    division_ko         text,  -- 담당자 부서(국문)
    division_en         text,  -- 담당자 부서(영문)
    title_ko            text,  -- 담당자 직책(국문)
    title_en            text,  -- 담당자 직책(영문)
    email               text,  -- 담당자 이메일
    tel                 text,  -- 담당자 유선 전화번호
    mobile              text,  -- 담당자 휴대폰 번호
    whatsapp_id         text,  -- 담당자 WhatsApp 아이디 (해외 연락용)
    languages           text[] CHECK (languages <@ ARRAY['ko','en','zh','ja','ru','other']::text[]),  -- §1.2 meeting_language
    sort_order          integer NOT NULL DEFAULT 0,  -- 여러 담당자를 화면에 보여줄 순서 (작을수록 먼저)
    created_at          timestamptz NOT NULL DEFAULT now(),  -- 이 행이 처음 만들어진 시각
    UNIQUE (exhibitor_profile_id, email)
);

-- 셀러 초청 바이어 추천 (복수 — bm-profile-fields §4.4). resolved_organization_id = 후속 dedupe(codex P2).
CREATE TABLE exhibitor_recommended_buyers (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),  -- 이 행을 구별하는 고유 번호 (시스템이 자동 생성)
    exhibitor_profile_id uuid NOT NULL REFERENCES exhibitor_profiles(id) ON DELETE CASCADE,  -- 이 추천 바이어를 적어낸 셀러 프로필(기업)을 가리킴
    continent           text,  -- 추천 바이어가 속한 대륙
    country             text,  -- 추천 바이어가 속한 국가
    org_name_en         text,  -- 추천 바이어 회사명(영문)
    person_name_en      text,  -- 추천 바이어 담당자 이름(영문)
    email               text,  -- 추천 바이어 연락 이메일
    contact             text,  -- 추천 바이어 기타 연락처(전화 등)
    resolved_organization_id uuid REFERENCES organizations(id) ON DELETE SET NULL,  -- 후속 매칭/초청 dedupe(§7 HITL)
    sort_order          integer NOT NULL DEFAULT 0,  -- 여러 추천을 보여줄 순서 (작을수록 먼저)
    created_at          timestamptz NOT NULL DEFAULT now()  -- 이 행이 처음 만들어진 시각
);


-- =============================================================================
-- 7. Buyer 프로필 (BM-001) — F-DV-001 바이어 카드 필드
-- =============================================================================
-- 바이어 프로필 필드 = bm-profile-fields §3.1. 진실원천 = BM-001 바이어 자가등록 폼(2026-06-29). 잠정 컬럼 대체.
CREATE TABLE buyer_profiles (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),  -- 이 행을 구별하는 고유 번호 (시스템이 자동 생성)
    org_event_role_id   uuid NOT NULL UNIQUE REFERENCES organization_event_roles(id) ON DELETE CASCADE,  -- 이 바이어 프로필(신청서)이 어느 기업-행사 역할에 붙는지 가리킴 (역할당 하나)
    -- (A) 폼 수집 — step1 신청자 식별(contact_*; 이름·직위 국/영, 영문 필수 — 확정결정 #3 갱신)
    contact_name_ko     text,                                -- 신청자 이름(국문)
    contact_name_en     text,                                -- 신청자 이름(영문, 폼 필수)
    contact_title_ko    text,                                -- 신청자 직위(국문)
    contact_title_en    text,                                -- 신청자 직위(영문)
    contact_email       text,                                -- 신청자 이메일(폼 필수)
    tel                 text,                                -- 신청자 전화번호(폼 필수; 과거 "현장 연락"에서 재용도)
    contact_language    text,                                -- 상담/소통 언어(단일값). FE Lang(lib/apply/types.ts, 현재 en/vi)이 §1.2 meeting_language(ko/en/zh/ja/ru/other)와 다른 별개 어휘라 CHECK 미적용(vi가 막히지 않게)
    contact_interpreter_need boolean,                        -- 통역 필요 여부(nullable)
    -- (A) 폼 수집 — step1 소속(행사별 스냅샷; 소속명 국/영·홈페이지·사업자번호는 organizations §2)
    country             text,                                -- Country(소속 국가, 폼 필수)
    annual_sales_range  text CHECK (annual_sales_range IN ('usd_lt_500k', 'usd_500k_1m', 'usd_1m_5m', 'usd_gt_5m')),  -- Annual Sales(USD) §1.4 annual_sales_buyer
    employee_range      text CHECK (employee_range IN ('e_0_10', 'e_11_50', 'e_51_100', 'e_101plus')),         -- Number of Regular Employees §1.4
    -- (A) 폼 수집 — step2 소개/예산/도입시기
    company_intro_ko    text,                                -- 기업소개(국문, 500)
    company_intro_en    text,                                -- 기업소개(영문, 500, 폼 필수)
    budget_range        text CHECK (budget_range IN ('usd_lt_100k', 'usd_100k_500k', 'usd_500k_1m', 'usd_1m_5m', 'usd_5m_10m', 'usd_10m_plus')),  -- 지출 가능 예산(USD) §1.4 budget_range
    adoption_timeline   text CHECK (adoption_timeline IN ('2026_h2', '2027_h1', '2027_h2', '2028_h1', '2028_h2', '2029_h1', '2029_h2', '2030_h1', '2030_h2', 'undecided')),  -- 도입 시기(년도+반기) §1.4 adoption_timeline
    -- (B) 폼 미노출(v1) — 컬럼만 유지(노출 축소, 1단계 트림). bm-profile-fields §3.1 (B)
    continent           text,                                -- Continent
    city_state          text,                                -- City, State
    zip_code            text,                                -- Zip Code
    address1            text,                                -- Address1
    address2            text,                                -- Address2
    last_year_best_buyer text,                               -- Last year's Best Buyer
    business_perf_korea_3y text CHECK (business_perf_korea_3y IN ('none', 'usd_1_1m', 'usd_1m_5m', 'usd_5m_plus')),  -- Business Perf w/ Korea 3y(USD) §1.4
    travelers_korea_3y  text CHECK (travelers_korea_3y IN ('t_0_500', 't_501_1000', 't_1001_5000', 't_5001_10000', 't_10000plus')),  -- Travelers to Korea 3y §1.4
    -- (C) BM-001 폼 미수집 — KOTRA 상담주선 요구항목, 무역관/운영 슬라이스로 이관(컬럼 유지). §3.1 (C)
    company_logo_file_id   uuid REFERENCES files(id) ON DELETE SET NULL,  -- Company Logo(파일)
    company_profile_file_id uuid REFERENCES files(id) ON DELETE SET NULL,  -- Company Profile(파일)
    note                text,                                -- Note
    participation_route text CHECK (participation_route IN ('re_1_2', 're_3_5', 're_6plus', 'new')),  -- 참가 경로 (re_1_2=재참가 1~2회, re_3_5=3~5회, re_6plus=6회 이상, new=신규)
    new_acquisition_channel text CHECK (new_acquisition_channel IN ('edm', 'official_letter', 'kotra_invitation', 'website_sns', 'media')),  -- 신규 발굴 경로 (edm=이메일, official_letter=공문, kotra_invitation=KOTRA초청, website_sns=웹/SNS, media=언론). 참가경로가 '신규'일 때만 입력
    kst_available_time  text,                                -- KST 상담 가능 시간(v1 text — §7 HITL: 슬롯 구조화)
    -- kotra_member(KOTRA 기업회원 가입 유무)는 REQ-06B로 컬럼째 drop(bm003nokotra, 2026-09-05).
    created_at          timestamptz NOT NULL DEFAULT now(),  -- 이 행이 처음 만들어진 시각
    -- §1.3: 채널은 route='new'일 때만 허용. route NULL(부분저장 #26)·기타는 통과. "route=new면 채널 필수"는 API 제출검증.
    CHECK (new_acquisition_channel IS NULL OR participation_route = 'new')
    -- 주요 관심분야(멀티 8, business_field)→buyer_interest_keywords / 참가자 구분(멀티 8)→org_event_role_org_types(역할 단위).
    -- ※ 잠정 컬럼(looking_for·use_environment·required_spec·adoption_stage·current_adoption) 제거. budget_range·adoption_timeline은 §1.4 enum으로 재도입.
);

-- 바이어 관심 분야 키워드 (N:M — category='business_field' 8종. 폼 [3] Exhibition Fields 도 동일 차원으로 통합 — §부록A HITL)
CREATE TABLE buyer_interest_keywords (
    buyer_profile_id    uuid NOT NULL REFERENCES buyer_profiles(id) ON DELETE CASCADE,  -- 관심분야 태그를 붙이는 바이어 프로필(기업)을 가리킴
    keyword_id          uuid NOT NULL REFERENCES keywords(id) ON DELETE CASCADE,  -- 바이어가 관심 있는 사업분야 키워드를 가리킴 (8종 중 선택)
    PRIMARY KEY (buyer_profile_id, keyword_id)
);

-- 바이어 참석자 (복수 — bm-profile-fields §3.2, Attendee Information [2]). member_id nullable(동일인 연결, 폼값 스냅샷).
-- ※ BM-001 바이어 자가등록 폼 미수집(2026-06-29) — KOTRA 상담주선 요구항목, 무역관/운영 슬라이스. 테이블 유지.
CREATE TABLE buyer_attendees (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),  -- 이 행을 구별하는 고유 번호 (시스템이 자동 생성)
    buyer_profile_id    uuid NOT NULL REFERENCES buyer_profiles(id) ON DELETE CASCADE,  -- 이 참석자가 속한 바이어 프로필(기업)을 가리킴
    member_id           uuid REFERENCES members(id) ON DELETE SET NULL,  -- codex P1: 동일인 연결(nullable)
    first_name          text,  -- 참석자 이름
    last_name           text,  -- 참석자 성
    division            text,  -- 참석자 부서
    job_title           text,  -- 참석자 직책
    email               text,  -- 참석자 이메일
    tel                 text,  -- 참석자 유선 전화번호
    mobile              text,  -- 참석자 휴대폰 번호
    whatsapp_id         text,  -- 참석자 WhatsApp 아이디 (해외 연락용)
    messenger_id        text,                                -- KAKAO/LINE/TELEGRAM 메신저 ID
    languages           text[] CHECK (languages <@ ARRAY['ko','en','zh','ja','ru','other']::text[]),  -- §1.2 meeting_language
    interpreter_need    boolean NOT NULL DEFAULT false,      -- 통역 필요 여부 (체류정보 통역 — 신설 안 함, 재사용. ADR-0013)
    interpreter_languages text[] CHECK (interpreter_languages <@ ARRAY['ko','en','zh','ja','ru','other']::text[]),  -- 통역 언어 (체류정보 재사용)
    -- 체류정보(Stay Info) — 방한 해외 바이어의 항공·숙박. 참석자(사람) 단위(일행이 서로 다른 편/호텔 가능 → 회사로 묶지 않음).
    --   통역(필요·언어)은 위 interpreter_* 재사용(중복 신설 금지). 매칭과 무관한 운영 로지스틱스. 1:1이라 보조표 대신 컬럼 부착(파일 스타일 일관). ADR-0013
    arrival_flight_no   text,                                -- 도착 항공편명
    arrival_at          timestamptz,                         -- 도착 일시
    departure_flight_no text,                                -- 출발 항공편명
    departure_at        timestamptz,                         -- 출발 일시
    hotel_name          text,                                -- 숙박 호텔명
    hotel_check_in      date,                                -- 체크인 날짜
    hotel_check_out     date,                                -- 체크아웃 날짜
    stay_note           text,                                -- 체류 관련 자유 메모(선택)
    sort_order          integer NOT NULL DEFAULT 0,  -- 여러 참석자를 보여줄 순서 (작을수록 먼저)
    created_at          timestamptz NOT NULL DEFAULT now(),  -- 이 행이 처음 만들어진 시각
    UNIQUE (buyer_profile_id, email)
);

-- 바이어 추천(다른 바이어 추천) (복수 — bm-profile-fields §3.3, Recommend as a buyer [4]).
-- ※ BM-001 바이어 자가등록 폼 미수집(2026-06-29) — KOTRA 상담주선 요구항목, 무역관/운영 슬라이스. 테이블 유지.
CREATE TABLE buyer_recommended_buyers (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),  -- 이 행을 구별하는 고유 번호 (시스템이 자동 생성)
    buyer_profile_id    uuid NOT NULL REFERENCES buyer_profiles(id) ON DELETE CASCADE,  -- 이 추천을 적어낸 바이어 프로필(기업)을 가리킴
    continent           text,  -- 추천 바이어가 속한 대륙
    country             text,  -- 추천 바이어가 속한 국가
    organization        text,  -- 추천 바이어 회사명
    person_in_charge    text,  -- 추천 바이어 담당자 이름
    email               text,  -- 추천 바이어 연락 이메일
    tel                 text,  -- 추천 바이어 연락 전화번호
    resolved_organization_id uuid REFERENCES organizations(id) ON DELETE SET NULL,  -- 후속 dedupe(§7 HITL — codex P2)
    sort_order          integer NOT NULL DEFAULT 0,  -- 여러 추천을 보여줄 순서 (작을수록 먼저)
    created_at          timestamptz NOT NULL DEFAULT now()  -- 이 행이 처음 만들어진 시각
);


-- =============================================================================
-- 8. Visitor — QR 진입 비등록 사용자의 초기 상태. BM-001 완료 시 On-site Buyer로 전환.
--    CONTEXT: "A Visitor must complete Biz-Matching Application to become an On-site Buyer"
-- =============================================================================
CREATE TABLE visitors (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),  -- 이 행을 구별하는 고유 번호 (시스템이 자동 생성)
    event_id            uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,  -- 이 방문자가 입장한 행사를 가리킴
    qr_token            text NOT NULL UNIQUE,  -- 현장 QR로 입장한 방문자를 구별하는 고유 토큰값
    status              text NOT NULL DEFAULT 'browsing'
                        CHECK (status IN ('browsing', 'converted')),  -- 방문자 상태 (browsing=둘러보는 중, converted=신청을 마쳐 현장 바이어로 전환됨)
    converted_org_id    uuid REFERENCES organizations(id) ON DELETE SET NULL,  -- 전환된 On-site Buyer 기업
    created_at          timestamptz NOT NULL DEFAULT now()  -- 이 행이 처음 만들어진 시각
);


-- =============================================================================
-- 9. Meeting Venue — 모든 미팅에 필요. 부스/비즈매칭 존 테이블/비즈니스 룸.
--    CONTEXT: "Every meeting in the Schedule Table requires a Meeting Venue"
-- =============================================================================
CREATE TABLE meeting_venues (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),  -- 이 행을 구별하는 고유 번호 (시스템이 자동 생성)
    event_id            uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,  -- 이 미팅 장소가 속한 행사를 가리킴
    venue_type          text NOT NULL CHECK (venue_type IN ('booth', 'zone_table', 'business_room')),  -- 미팅 장소 종류 (booth=부스, zone_table=비즈매칭존 테이블, business_room=비즈니스룸)
    -- venue_type='booth' 행이 같은 물리 부스를 가리키도록 정규화된 booths 를 옵션 FK로 참조(부스 위치 단일 출처).
    --   zone_table/business_room 은 부스 아님 → NULL. label 은 유지(부스 아닌 장소의 라벨 + booth 행의 표시 보조).
    booth_id            uuid REFERENCES booths(id) ON DELETE SET NULL,
    label               text NOT NULL,                       -- 위치/식별 라벨 (부스는 {hall_name} {code} 파생 가능, 비부스는 자체 라벨)
    created_at          timestamptz NOT NULL DEFAULT now(),  -- 이 행이 처음 만들어진 시각
    UNIQUE (event_id, venue_type, label)                     -- 부스 venue get-or-create 멱등키 (mt001meet01)
);


-- =============================================================================
-- 9b. AI 전체 포화배정 실행 기록 (run/batch) — ADR-0006 / F-OP-001·F-OP-005
--     전체 포화배정은 1회성이 아니라 반복 실행 가능 → 실행 회차·시각·파라미터를 추적.
--     F-OP-001 "전체 포화배정 현황" 지표가 최근 실행 회차·시각·Draft 검토중 여부를 표시.
--     run_number: 이벤트 내 1부터 증가하는 실행 회차. min_guaranteed_slots: 실행 시 입력 N(설정값 덮어쓰기 가능).
--     meetings 가 이 테이블을 FK로 참조하므로(아래) Schedule Table보다 먼저 정의.
-- =============================================================================
CREATE TABLE saturation_batch_runs (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),  -- 이 행을 구별하는 고유 번호 (시스템이 자동 생성)
    event_id            uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,  -- 이 배정 실행이 속한 행사를 가리킴
    run_number          integer NOT NULL,                    -- 이벤트별 실행 회차 (1, 2, 3 …)
    min_guaranteed_slots integer NOT NULL,                   -- 이 실행에 적용된 N (실행 파라미터 — ADR-0006)
    status              text NOT NULL DEFAULT 'draft'        -- Draft 생성 → 운영자 검토 → 확정 (F-OP-005 게이트)
                        CHECK (status IN ('draft', 'confirmed', 'discarded')),
    triggered_by        uuid REFERENCES organizers(id) ON DELETE SET NULL,  -- 이 배정 실행을 시작시킨 운영자를 가리킴
    created_at          timestamptz NOT NULL DEFAULT now(),  -- 실행 시각
    confirmed_at        timestamptz,  -- 이 배정 결과를 운영자가 최종 확정한 시각 (미확정이면 비어 있음)
    UNIQUE (event_id, run_number)
);


-- =============================================================================
-- 10. Schedule Table — 모든 매칭 유형이 기록되는 중앙 테이블.
--     ADR-0004: 매칭 출처(provenance) — matching_type/ai_score/ai_score_reasons 를
--               데이터 발생 시점에 영구 보존. 사후 소급 불가.
--     매칭 단위 = Organization (ADR-0002). 참석 Member는 별도 지정(아래).
-- =============================================================================
CREATE TABLE meetings (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),  -- 이 행을 구별하는 고유 번호 (시스템이 자동 생성)
    event_id            uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,  -- 이 미팅이 속한 행사를 가리킴
    exhibitor_org_id    uuid NOT NULL REFERENCES organizations(id),  -- 참가사 측 기업
    buyer_org_id        uuid NOT NULL REFERENCES organizations(id),  -- 바이어 측 기업
    venue_id            uuid REFERENCES meeting_venues(id),  -- 이 미팅이 열리는 장소를 가리킴 (미정이면 비어 있음)

    -- 매칭 출처 메타 (provenance, ADR-0004) — 발생 시점에 박아 영구 보존.
    -- matching_type 은 단일 출처 축(누가 만들었나): 'ai'(AI 매칭 — 전체 포화배정·단일 재트리거 공통)/'open'/'forced'/'on_site'.
    --   수락 규칙(받는 쪽 유형)은 provenance와 독립 축이라 여기 두지 않음(ADR-0005). 양방향 수락대기 없음 → 참가자별 수락 컬럼 불필요.
    matching_type       text NOT NULL CHECK (matching_type IN ('ai', 'open', 'forced', 'on_site')),
    saturation_run_id   uuid REFERENCES saturation_batch_runs(id) ON DELETE SET NULL, -- 전체 포화배정 산출 미팅이면 그 실행 회차. ADR-0006
    ai_score            numeric,                             -- AI 매칭일 때만. Open/On-site는 NULL(대조군)
    ai_score_reasons    jsonb,                               -- AI 추천 근거  ※ draw.io 막히면 text

    -- 상태 흐름: proposed → accepted/rejected/cancelled → completed (CONTEXT / F-MT-001).
    --   opt-out 즉시 확정(ADR-0005): 받는 쪽 유형에 따라 생성 즉시 accepted 이거나 proposed 로 대기.
    --   noshow는 상태가 아니라 사후 리뷰 입력값으로 이동(ADR-0004 보정/ADR-0010). 종료 상태는 completed만.
    --   스케줄러가 scheduled_end 경과한 accepted 미팅만 completed로 자동 전환(취소/거부 제외 — ADR-0010).
    status              text NOT NULL DEFAULT 'proposed'
                        CHECK (status IN ('proposed', 'accepted', 'rejected', 'cancelled', 'completed')),
    awaiting_org_id     uuid NULL REFERENCES organizations(id) ON DELETE CASCADE,  -- proposed 상태의 응답 대기 org(수락/거절 결정 주체). 즉시 확정 건·종결 건은 NULL (F-MT-001 D1/D6, mt001meet01)
    requested_by        text CHECK (requested_by IN ('exhibitor', 'buyer', 'organizer')),  -- 대칭 신청 주체
    request_reason      text NULL,                           -- 신청 사유 — 3탭 모달 ③ AI 초안 수정본 (F-MT-001 D4)
    -- 대리신청(Proxy Application) 대행 도장 — sub(무역관) 운영자가 자기 관할 바이어를 대신해 신청한 경우 그 행위자를 기록(ADR-0013).
    --   대리신청도 신청자=바이어(requested_by='buyer')·채널=Open(matching_type='open')으로 환원되고(enum 불변),
    --   대행 운영자만 여기 별도로 남겨 감사·추적을 보장. 일반(바이어 자가/타 출처) 신청은 NULL.
    proxy_applied_by_organizer_id uuid REFERENCES organizers(id) ON DELETE SET NULL,  -- 대리신청 대행 운영자(nullable). ADR-0013
    scheduled_start     timestamptz,  -- 미팅 예정 시작 시각
    scheduled_end       timestamptz,  -- 미팅 예정 종료 시각
    -- 취소 감사 (F-MT-001 D6 — accepted 건을 출처·유형 무관 양쪽 누구나, 사유 입력 필수·슬롯 자동 해제)
    cancelled_at        timestamptz NULL,                    -- 취소 시각
    cancelled_by        text NULL CHECK (cancelled_by IN ('exhibitor','buyer','organizer')),  -- 취소 주체 측
    cancelled_by_org_id uuid NULL REFERENCES organizations(id) ON DELETE SET NULL,  -- 취소한 기업(운영자 취소면 NULL 가능)
    cancelled_reason_code text NULL,                         -- 취소 사유 키워드
    cancelled_reason_text text NULL,                         -- 취소 사유 자유 입력
    -- 거절 감사 (F-MT-001 D6 — 거절은 proposed 에서만. 거절 ≠ 취소)
    rejected_at         timestamptz NULL,                    -- 거절 시각
    rejected_by_org_id  uuid NULL REFERENCES organizations(id) ON DELETE SET NULL,  -- 거절한 기업
    rejected_reason_code text NULL,                          -- 거절 사유 키워드
    rejected_reason_text text NULL,                          -- 거절 사유 자유 입력
    created_at          timestamptz NOT NULL DEFAULT now(),  -- 이 행이 처음 만들어진 시각
    updated_at          timestamptz NOT NULL DEFAULT now(),  -- 이 행이 마지막으로 수정된 시각(상태 전이 추적. mt001meet01)
    -- 사유 코드 어휘는 의도적으로 CHECK 없음 — 어휘 미확정, Pydantic Literal 로 앱 계층 강제(mt001meet01):
    --   취소 schedule_conflict/counterpart_request/internal_change/other · 거절 interest_mismatch/schedule_unavailable/other
    CHECK (cancelled_reason_code IS NULL OR status='cancelled'),   -- 취소 사유는 취소 상태에만
    CHECK (rejected_reason_code IS NULL OR status='rejected'),     -- 거절 사유는 거절 상태에만
    CHECK (scheduled_end IS NULL OR scheduled_start IS NULL OR scheduled_end > scheduled_start),  -- 시간 순서
    CHECK (status <> 'accepted' OR (scheduled_start IS NOT NULL AND scheduled_end IS NOT NULL))   -- 확정 미팅은 시간 필수
);

-- 슬롯 점유·중복 방지 제약 (mt001meet01 / F-MT-001 D2·D9)
CREATE EXTENSION IF NOT EXISTS btree_gist;  -- EXCLUDE 안에서 uuid 컬럼(WITH =)을 비교하기 위한 확장

-- D9: "같은 상대 Organization과 동시 활성 미팅 1건" — 활성(proposed/accepted) 쌍 부분 유니크.
--   completed 후 추가 신청·거절 후 재신청은 허용(활성 아님 → 인덱스 비적용).
CREATE UNIQUE INDEX meetings_active_pair_uniq
    ON meetings (event_id, exhibitor_org_id, buyer_org_id)
    WHERE status IN ('proposed','accepted');

-- 슬롯 점유는 accepted 만 — proposed 는 슬롯을 잡지 않는다(확정 정책, mt001meet01).
--   같은 org·같은 장소가 확정 미팅 시간대(tstzrange '[)' 반개구간)를 겹쳐 잡을 수 없다.
--   ※ 이중역할(한 org가 참가사이자 바이어) 교차 충돌은 EXCLUDE 로 표현 불가 →
--     앱의 advisory lock(`mtslot:{event_id}:{org_id}` 정렬 획득)이 최종 방어선.
ALTER TABLE meetings ADD CONSTRAINT meetings_exhibitor_slot_excl
    EXCLUDE USING gist (exhibitor_org_id WITH =, tstzrange(scheduled_start, scheduled_end, '[)') WITH &&)
    WHERE (status='accepted' AND scheduled_start IS NOT NULL AND scheduled_end IS NOT NULL);
ALTER TABLE meetings ADD CONSTRAINT meetings_buyer_slot_excl
    EXCLUDE USING gist (buyer_org_id WITH =, tstzrange(scheduled_start, scheduled_end, '[)') WITH &&)
    WHERE (status='accepted' AND scheduled_start IS NOT NULL AND scheduled_end IS NOT NULL);
ALTER TABLE meetings ADD CONSTRAINT meetings_venue_slot_excl
    EXCLUDE USING gist (venue_id WITH =, tstzrange(scheduled_start, scheduled_end, '[)') WITH &&)
    WHERE (status='accepted' AND scheduled_start IS NOT NULL AND scheduled_end IS NOT NULL AND venue_id IS NOT NULL);

-- 조회 인덱스 (mt001meet01)
CREATE INDEX meetings_event_status_idx    ON meetings (event_id, status);                                        -- 행사별 상태 필터(운영 대시보드·MY-001)
CREATE INDEX meetings_exhibitor_sched_idx ON meetings (exhibitor_org_id, scheduled_start) WHERE status='accepted';  -- 참가사 확정 일정 조회·교집합 계산
CREATE INDEX meetings_buyer_sched_idx     ON meetings (buyer_org_id, scheduled_start) WHERE status='accepted';      -- 바이어 확정 일정 조회·교집합 계산
CREATE INDEX meetings_sched_end_idx       ON meetings (scheduled_end) WHERE status='accepted';                      -- completed 자동전이 스케줄러 스캔(ADR-0010)
CREATE INDEX meetings_event_created_idx   ON meetings (event_id, created_at DESC);                                  -- 최근 생성순 목록

-- 미팅 참석자 — 기업이 내부에서 지정한 Member (ADR-0002: "미팅 수락 시 참석 Member를 지정")
CREATE TABLE meeting_participants (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),  -- 이 행을 구별하는 고유 번호 (시스템이 자동 생성)
    meeting_id          uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,  -- 어느 미팅의 참석자인지 가리킴
    member_id           uuid NOT NULL REFERENCES members(id) ON DELETE CASCADE,  -- 그 미팅에 참석하도록 지정된 회원(사람)을 가리킴
    UNIQUE (meeting_id, member_id)
);


-- =============================================================================
-- 10b. Saturation Draft Item (OP-005 Phase 2) — 전체 포화배정 run의 미확정 제안.
--      proposed-Meeting 재사용은 참가자 노출·D9(활성 쌍 유니크) 오염이라 기각, JSON blob은
--      항목 단위 추적·부분 confirm/skip이 안 돼 기각 — 별도 테이블로 신설.
--      confirm 시 각 항목이 book_meeting() 으로 물질화되어 materialized_meeting_id 가 채워진다.
-- =============================================================================
CREATE TABLE saturation_draft_items (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),  -- 이 행을 구별하는 고유 번호 (시스템이 자동 생성)
    saturation_run_id   uuid NOT NULL REFERENCES saturation_batch_runs(id) ON DELETE CASCADE,  -- 이 제안이 속한 포화배정 실행을 가리킴
    exhibitor_org_id    uuid NOT NULL REFERENCES organizations(id),  -- 참가사 측 기업
    buyer_org_id        uuid NOT NULL REFERENCES organizations(id),  -- 바이어 측 기업
    venue_id            uuid REFERENCES meeting_venues(id),  -- 제안된 미팅 장소 (미정이면 비어 있음)
    scheduled_start     timestamptz NOT NULL,                -- 제안된 슬롯 시작
    scheduled_end       timestamptz NOT NULL,                -- 제안된 슬롯 종료
    status              text NOT NULL DEFAULT 'draft'        -- draft → confirmed(물질화)/skipped(충돌·수동제외)
                        CHECK (status IN ('draft', 'confirmed', 'skipped')),
    materialized_meeting_id uuid REFERENCES meetings(id),     -- confirm 시 생성된 실제 미팅을 가리킴 (미확정이면 비어 있음)
    seq_no              integer,                             -- run 내 표시/결정 순서
    created_at          timestamptz NOT NULL DEFAULT now(),  -- 이 행이 처음 만들어진 시각
    UNIQUE (saturation_run_id, buyer_org_id, exhibitor_org_id)  -- 한 run에서 같은 (바이어, 참가사) 쌍 중복 제안 방지
);


-- =============================================================================
-- 11. Post-meeting Review — completed 미팅당, 평가 주체(기업) 측마다 1행.
--     ADR-0004: Fit Assessment 를 이 미팅 레코드에 결합 저장.
--     CONTEXT: review collects Follow-up Intent + Love Call(Step1), Fit Assessment(Step2).
--     follow_up_intent / fit_* / counterpart_noshow 는 비공개(상대 비노출). Love Call만 상대에게 보이는 신호.
--     noshow는 미팅 상태가 아니라 여기 리뷰 입력값(리뷰어가 "상대가 안 왔다"를 입력). ADR-0004 보정/ADR-0010.
-- =============================================================================
CREATE TABLE post_meeting_reviews (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),  -- 이 행을 구별하는 고유 번호 (시스템이 자동 생성)
    meeting_id          uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,  -- 어느 미팅에 대한 평가인지 가리킴
    reviewer_org_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,  -- 이 평가를 작성한 기업(평가 주체)을 가리킴

    -- 노쇼 입력값 (비공개) — 리뷰어가 "상대 기업이 미팅에 안 왔다"를 표시. 상태 아님(ADR-0004 보정/ADR-0010).
    counterpart_noshow  boolean NOT NULL DEFAULT false,

    -- Step1: 만족도(비공개, 1~5 별점) + Follow-up Intent (비공개 — 매칭 효과 측정 핵심 지표)
    satisfaction_rating smallint CHECK (satisfaction_rating BETWEEN 1 AND 5),
    follow_up_intent    text CHECK (follow_up_intent IN ('none', 'reviewing', 'yes')),  -- 후속 거래 의향 (none=없음, reviewing=검토 중, yes=있음). 비공개 — 매칭 효과 측정 지표

    -- Step2: Fit Assessment (비공개 — 잘맞음/보통/안맞음 + 자유 사유 + AI 사후 태깅, ADR-0004)
    fit_rating          text CHECK (fit_rating IN ('good', 'normal', 'bad')),
    fit_reason          text,  -- 잘 맞았는지/안 맞았는지에 대한 자유 서술 사유 (비공개)
    fit_reason_tags     jsonb,                               -- AI 사후 카테고리 태깅(D10)

    -- Step2: AI 보고문서 (녹음 업로드 방향) — 원본 녹음은 S3, 전사·구조화는 비공개 원천.
    audio_s3_key        text,                                -- 원본 녹음 S3 키(비공개)
    transcript          text,                                -- 전사 원문(비공개)
    report_sections     jsonb,                               -- {discussion, agreements, actions} 내보내기 본문
    report_confirmed_at timestamptz,                         -- Step2 저장=보고문서 확정 시각

    created_at          timestamptz NOT NULL DEFAULT now(),  -- 이 행이 처음 만들어진 시각
    UNIQUE (meeting_id, reviewer_org_id)
);


-- =============================================================================
-- 12. Love Call — 미팅 상대 Organization에 보내는 공개 단방향 신호.
--     양방향 존재 시 Mutual Love Call로 격상 → 대화 채널 오픈(아래).
-- =============================================================================
CREATE TABLE love_calls (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),  -- 이 행을 구별하는 고유 번호 (시스템이 자동 생성)
    meeting_id          uuid REFERENCES meetings(id) ON DELETE SET NULL,  -- 이 러브콜이 어느 미팅에서 비롯됐는지 가리킴 (없을 수도 있음)
    event_id            uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,  -- 이 러브콜이 속한 행사를 가리킴
    from_org_id         uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,  -- 러브콜을 보낸 기업을 가리킴
    to_org_id           uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,  -- 러브콜을 받은 기업을 가리킴
    created_at          timestamptz NOT NULL DEFAULT now(),  -- 이 행이 처음 만들어진 시각
    -- 러브콜 메일(#13). 신호 행만 있고 메일은 안 보낸 상태가 정상이라 전부 nullable —
    -- "메일을 보냈는가"는 email_sent_at IS NOT NULL 로만 판정한다(행 존재 여부가 아니다).
    email_subject       text,  -- 사용자가 검수·수정해 실제로 보낸 메일 제목 (AI 초안이 아니라 발송본)
    email_body          text,  -- 실제로 보낸 메일 본문 (한/영 병기 그대로)
    email_recipient_count integer,  -- 발송 당시 실제로 수신한 상대 기업 담당자 수
    email_sent_at       timestamptz,  -- 메일이 실제로 발송된 시각 (중복 발송 판정 기준)
    UNIQUE (meeting_id, from_org_id, to_org_id)
);

-- Mutual Love Call로 열리는 대화 채널 (양방향 러브콜 성립 시 생성)
CREATE TABLE conversation_channels (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),  -- 이 행을 구별하는 고유 번호 (시스템이 자동 생성)
    event_id            uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,  -- 이 대화 채널이 속한 행사를 가리킴
    org_a_id            uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,  -- 대화에 참여한 한쪽 기업을 가리킴
    org_b_id            uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,  -- 대화에 참여한 다른쪽 기업을 가리킴
    opened_at           timestamptz NOT NULL DEFAULT now(),  -- 양방향 러브콜이 성립해 대화 채널이 열린 시각
    UNIQUE (event_id, org_a_id, org_b_id)
);


-- =============================================================================
-- 13. AI 매칭 제안 — AI는 제안만, 양측 수락 시 meetings에 확정 기록 (CONTEXT/ADR-0002)
--     양측 대칭으로 제안 받음. 카드 덱(F-DV-001 AI 추천 탭).
-- =============================================================================
CREATE TABLE ai_match_suggestions (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),  -- 이 행을 구별하는 고유 번호 (시스템이 자동 생성)
    event_id            uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,  -- 이 추천이 속한 행사를 가리킴
    for_org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,  -- 제안 받는 기업
    target_org_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,  -- 제안된 상대 기업
    ai_score            numeric,                             -- fit score 정의 미확정(#48 HITL) → nullable로 깔고 정의 확정 후 채움(ADR-0006 / #48 AC#4). 구버전 NOT NULL에서 보정.
    ai_score_reasons    jsonb,  -- AI가 이 기업을 추천한 근거 (구조화 데이터)
    status              text NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'requested', 'bookmarked', 'dismissed')),  -- 추천 카드 처리 상태 (pending=미확인, requested=미팅 신청함, bookmarked=관심 저장, dismissed=닫음)
    created_at          timestamptz NOT NULL DEFAULT now(),  -- 이 행이 처음 만들어진 시각
    UNIQUE (event_id, for_org_id, target_org_id)
);


-- =============================================================================
-- 14. 관심기업(북마크) — F-DV-001 관심기업 탭. AI추천/전체기업 양쪽에서 저장.
-- =============================================================================
CREATE TABLE interested_organizations (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),  -- 이 행을 구별하는 고유 번호 (시스템이 자동 생성)
    event_id            uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,  -- 이 북마크가 속한 행사를 가리킴
    owner_org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,  -- 관심기업을 저장한 주체(기업)를 가리킴
    target_org_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,  -- 관심기업으로 저장된 상대 기업을 가리킴
    source              text CHECK (source IN ('ai', 'all')),  -- 저장 출처 탭
    created_at          timestamptz NOT NULL DEFAULT now(),  -- 이 행이 처음 만들어진 시각
    UNIQUE (event_id, owner_org_id, target_org_id)
);


-- =============================================================================
-- 15. Notification — 도메인 사건 통지. Organization 공유 인박스 + payload 스냅샷. (ADR-0010)
--     수신 단위 = Organization (recipient_org_id). 같은 기업 Member 누구나 공유 인박스 조회,
--       읽음(read_at)도 기업 공유 + read_by_member_id로 읽은 주체 기록. (ADR-0002와 일관)
--     발화: 이벤트성(신청/수락/취소)=상태전이 시 즉시 / 시간성(리마인더·리뷰안내)=폴링 스케줄러가 due_at로 발화.
--       이벤트성은 due_at NULL, 시간성만 due_at 채움.
--     payload(jsonb)=표시 데이터 스냅샷(보낼 때 박제) → 미팅 사후 변경돼도 "통지 당시 내용" 불변 보존.
-- =============================================================================
CREATE TABLE notifications (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),  -- 이 행을 구별하는 고유 번호 (시스템이 자동 생성)
    event_id            uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,  -- 이 알림이 속한 행사를 가리킴
    recipient_org_id    uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,  -- 수신 org(공유 인박스)
    type                text NOT NULL CHECK (type IN ('meeting_requested', 'meeting_accepted', 'meeting_cancelled', 'meeting_reminder', 'review_prompt', 'review_ready')),  -- 알림 종류 (meeting_requested=미팅 신청 옴, meeting_accepted=미팅 수락됨, meeting_cancelled=미팅 취소됨, meeting_reminder=미팅 리마인더, review_prompt=리뷰 작성 안내, review_ready=회의록 정리 완료(AI 전사·구조화 완료, 이벤트형 due_at NULL))
    meeting_id          uuid REFERENCES meetings(id) ON DELETE CASCADE,  -- 링크·조인·스케줄러 조인용
    due_at              timestamptz,                         -- 시간성 발화시각. 이벤트성은 NULL (ADR-0010)
    payload             jsonb,                               -- 표시 데이터 스냅샷(불변 통지 기록 — ADR-0010)
    created_at          timestamptz NOT NULL DEFAULT now(),  -- 이 행이 처음 만들어진 시각
    read_at             timestamptz,                         -- org 공유 읽음(null=안읽음). 외부 발송 성공과 분리
    read_by_member_id   uuid REFERENCES members(id) ON DELETE SET NULL,  -- 읽은 주체 기록("읽음: 시각, 멤버")
    -- 멱등 유니크: 프로듀서가 INSERT … ON CONFLICT DO NOTHING 으로 중복 제거(ADR-0010).
    --   NULLS NOT DISTINCT(RDS Postgres 15+)라야 이벤트형 due_at NULL도 중복 제거됨.
    UNIQUE NULLS NOT DISTINCT (type, meeting_id, recipient_org_id, due_at)
    -- PG15 미만/임포터 호환 폴백(표준 UNIQUE는 NULL을 distinct 취급 → due_at NULL 중복 못 막음, 운영 DDL은 위 NULLS NOT DISTINCT 사용):
    --   UNIQUE (type, meeting_id, recipient_org_id, due_at)
);

-- =============================================================================
-- 16. Notification Dispatch — 알림의 외부 채널 발송 팬아웃(멤버×채널당 1행). (ADR-0010)
--     인박스는 Org, 발송은 Member 연락처로 팬아웃. 채널별 발송 상태·재시도 추적.
--     우아한 열화: 연락처 없는 멤버·SMS 인프라 미비 시 status='skipped'. 재시도 시 upsert(중복 발송 행 방지).
-- =============================================================================
CREATE TABLE notification_dispatches (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),  -- 이 행을 구별하는 고유 번호 (시스템이 자동 생성)
    notification_id     uuid NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,  -- 어느 알림을 외부 채널로 보내는 것인지 가리킴
    member_id           uuid NOT NULL REFERENCES members(id) ON DELETE CASCADE,  -- 이 알림을 받을 회원(사람)을 가리킴
    channel             text NOT NULL CHECK (channel IN ('in_app', 'email', 'sms')),  -- 보내는 통로 (in_app=앱 내, email=이메일, sms=문자)
    status              text NOT NULL CHECK (status IN ('pending', 'sent', 'failed', 'skipped')),  -- 발송 상태 (pending=대기, sent=발송됨, failed=실패, skipped=건너뜀(연락처 없음·인프라 미비))
    sent_at             timestamptz,  -- 실제로 발송된 시각 (아직 안 보냈으면 비어 있음)
    error               text,  -- 발송 실패 시 오류 내용
    UNIQUE (notification_id, member_id, channel)             -- 멤버×채널당 1행 + 재시도 upsert 키
);
