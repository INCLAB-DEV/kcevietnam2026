# BM 프로필 필드/컬럼 정의 (데이터모델 — 바이어 · 셀러)

> **DB 데이터모델 산출물**(기능 PRD 아님 — page-list 화면ID에 1:1 대응하지 않는다). 비즈매칭
> 프로필(F-BM-001 바이어 / F-BM-002 셀러)이 **저장하는 모든 필드의 권위 있는 컬럼 정의**로,
> `docs/db/schema.sql` · `backend/app/models.py` · Alembic이 여기서 파생한다. db-schema-keeper가
> 이 문서를 소비해 schema.sql을 동기화한다. 화면별 폼 UX·필드 노출은 기능 PRD F-BM-001 /
> F-BM-002가 소유하고, 이 문서를 **컬럼 단위 상세의 출처로 링크**한다(1:1 규칙 유지).

## 출처 (진실원천 문서)

| 출처 | 역할 |
|------|------|
| `DxKorea/프로필/계정 카테고리 예시.pdf` | **실제 DX Korea 등록폼** — 바이어/셀러 입력 항목·고정 리스트·필수표시(*)의 원본 |
| `Korea 통합 상담주선 시스템 기능 요구사항.pdf` | KOTRA 통합 상담주선 요구사항 — 추가 필수정보(HS코드·KST 상담시간·국영문·승인 게이트·체류정보) |

> ⚠ 이 정의서는 기존 모델(#25, 마이그레이션 `e93488b8bc96`)의 **잠정 컬럼을 대체**한다.
> 잠정값(`buyer_profiles.looking_for/use_environment/required_spec/adoption_stage/budget_range/
> adoption_timeline/current_adoption`, `exhibitor_profiles.strength/achievements/target_*`,
> 자유입력 keywords)은 실제 폼에 없으므로 제거·교체한다. API 기계장치(부분저장·원자제출·소유권
> 인증·매칭쿼리, #26)는 유지하고 **저장 필드 집합만** 이 정의서로 갈아끼운다.

## 확정 결정 (2026-06-28, codex 교차검수 반영)

1. **전체 정의** — 두 폼의 전 필드를 모델에 반영(핵심목표 "정보 최대 수집 → 매칭 정확도").
2. **승인 게이트(상태머신)** — `application_status`: `registered → submitted → {approved | changes_requested
   | rejected}`, `changes_requested → submitted`(재제출). **매칭 노출은 `approved`부터.** ADR-0009 갱신.
3. **국/영 = 컬럼 분리**(`*_ko`/`*_en`). KO/EN 고정·일회성이라 EAV 대신 컬럼분리(사용자 결정).
   역할별 필수 로케일 차이는 **API 검증층**에서 강제(셀러=둘 다, 바이어=영문).
4. **고정 분류체계 = 시드 lookup + 조인** — 매칭 구동 차원(방산 13분야·기관유형 8종)은 전부 시드
   `keywords`+조인. `text[]+CHECK`는 **비랭킹 표시필드(언어)만**.
5. **org = 안정 법인정체성만** — 행사별 선언값(위치·연락처·연매출·소개·파일)은 역할 프로필에
   스냅샷(행사 간 공유 org 행을 변형하지 않음 — codex P0).
6. **업로드는 `files` 테이블 경유** — 프로필은 `*_file_id` FK(방산문서 메타·스캔·보관 — codex P1).
7. **A층(등록)·B층(신청서) 2레이어, 겹침은 "박제 + 선언"** (2026-06-30) — 주관사 명단(엑셀)으로
   들어오는 **등록 정보(A) = 신원·연락·역할·약관**(`registrants`·`organizations`·`members`·
   `organization_event_roles`·`consent_*`); 비즈매칭 신청서로 받는 **선언 정보(B) = 매칭에 쓰는
   모든 값**(`buyer_profiles`/`exhibitor_profiles`·`*_attendees`·키워드 조인·`files`). 명단에 이미
   들어있는 신청서성 항목(주소·업태/종목·전시품목·부스 등)은 A층에 **원본 박제**로 남고, 신청서를 열면
   그 A값으로 **prefill** → 사용자 확정값이 **B층 정본**으로 저장된다(A=주관사 사실 불변, B=사용자 선언).
   매칭·신청서 화면은 B 정본, **OP-002 리스트는 A만 표시**(신청서는 "신청서 조회"로 분리 — F-OP-002 D16/D17).
   5번(공유 org 행 변형 금지)의 상위 원칙이며, A층 1차 연락책은 명단의 담당자/이름 1명(`registrants.name/
   contact_email/contact_phone`) — 참가사 대표자·세금계산서·에이전트 담당자는 raw 보존만.
8. **실제 폼이 정의보다 작다 — 정의는 "최대 수집" 보존, 수집/필수는 폼이 정본** (2026-06-30, 실제 폼 대조) —
   바이어 폼(`frontend/lib/apply/form-state.ts`)에서 **website·대륙·City/State·대한실적·방한객·사업자번호·작년
   Best Buyer·상세주소**가 트림됐다(step1 필수 = 이름영문·소속영문·이메일·전화·국가). 이 정의서의 buyer 필드
   집합은 "DX Korea 원폼 = 정보 최대 수집" 목표라 **보존**하되, 실제 수집/필수는 **폼이 정본**이고 미수집 필드(예:
   `organizations.website`)는 현재 NULL이다. **바이어 명단(참관객 12컬럼)은 prefill 소스** — 이름·소속·직위·이메일·
   전화·언어를 step1 신청자 식별/`buyer_attendees`로 채운다(국가·관심분야·소개는 신청서 입력). 참가사 "소속 협회/
   단체명"은 `org_type`(8종) 매핑하지 않고 **raw 보존만**. `application_status`는 5값(§6)이 정본이며 프론트
   (`members.ts` 등 15파일)에 구버전 2값(`registered|submitted`)이 잔존 — **정본 정리 후 일괄 정합**(매칭 노출=`approved`).
9. **codex 교차검수 반영 (2026-06-30)** — (P1) ① **OP-002 리스트 행 단위는 `registrants`가 아니라
   `organization_event_roles`** — 무역관 직접등록 바이어(ADR-0013, registrant·organizer_member_id 없음)가
   리스트에서 누락되면 안 된다. 연락·적재는 registrant 있으면 거기, 없으면 운영자 직접입력분(`created_by_organizer_id`).
   ② **"불변 박제"는 `registrants.raw`에만** — 정규 컬럼·`organizations`는 정정/재업로드로 갱신 가능(F-OP-002 D17 정정).
   ③ B 제출이 `organizations`(name/business_reg_no) 갱신 시 **행사 간 공유 영향 주의**(법인정체성에 한정, 선언값은
   프로필 스냅샷). (P2) ④ `application_status` 게이트는 **중앙 술어**로 — `hasApplication`/`canEdit`/`canReview`/
   `isMatchingExposed`. "submitted 이상" 같은 문자열 대소 비교 금지(text enum). ⑤ prefill의 lossy 변환(자유텍스트
   전시품목→`defense_field` 13코드, `org_name`→`name_ko/en`)은 추측값을 B에 **조용히 저장 금지** — raw 증거 +
   미해결 제안으로 두고 사용자 확정 시에만 코드화. ⑥ `business_number` 3중 복제는 **충돌정책 필요** —
   `registrants.business_number`=가져온 관찰값, `organizations.business_reg_no` 갱신은 명시 충돌검토 동기화로만(멤버ID
   upsert 한 줄이 org 정체성을 조용히 바꾸지 않게). ⑦ no-coalesce UI: 신청서 뷰가 "미작성"일 때 **'A에 prefill 있음'을
   표시**해 데이터손실 오인 방지.

---

## 1. 공유 고정 코드 (분류체계 = 시드 / 표시 enum)

### 1.1 매칭 구동 분류 — 시드 `keywords` + 조인 (자유입력 폐기)
> `keywords(code, label, category)`에 고정 코드를 시드하고 **조인 테이블로 멀티선택**한다(매칭엔진이
> 단일 쿼리/인덱스 경로 + 메타데이터를 쓰도록). `code`=영문 슬러그(API·매칭 식별자), `label`=국문 표시.
> 두 분류에 같은 라벨('기타')이 있어 **UNIQUE는 (category, code)**(라벨 전역 unique 폐기). API는 code로 주고받는다.

| 분류 | category | 멀티선택 부착점(조인) | 코드 |
|------|----------|----------------------|------|
| **방산 분야 13종** (바이어 관심분야 = 셀러 전시품목) | `defense_field` | `buyer_interest_keywords` / `exhibitor_keywords` | `mobility`(기동장비) · `firepower`(화력장비) · `protection`(방호장비) · `aviation`(항공장비) · `unmanned_drone`(무인장비 및 드론) · `maritime`(해양장비) · `c4i_security`(지휘/통신/보안장비) · `training`(훈련장비) · `civmil_cooperation`(민군협력기술) · `air_space`(Air&Space) · `apparel_personal`(피복 및 개인장구류) · `rescue_medical`(인명구조 및 의료장비) · `other`(기타) |
| **참가자 구분 8종** (바이어·셀러 공통) | `org_type` | `org_event_role_org_types(org_event_role_id, keyword_id)` (신규, 역할 단위) | `private_defense`(민간기업 군납전문) · `private_commercial`(민간기업 민간기술) · `association`(협회 및 단체) · `government`(정부 및 공공기관) · `exhibition_agent`(전시회 및 에이전트) · `media`(미디어) · `local_gov`(지자체 및 기관) · `other`(기타) |

### 1.2 표시/필터 멀티 — `text[]` + 원소 CHECK (비랭킹)
- **상담 가능 언어** `meeting_language`: `ko` · `en` · `zh` · `ja` · `ru` · `other`
  (셀러 `available_languages`, attendee `languages`, 바이어 `interpreter_languages`)

### 1.3 참가 경로 — `participation_route` + `new_acquisition_channel` (조건부 CHECK)
- `participation_route`: `re_1_2` · `re_3_5` · `re_6plus` · `new`
- `new_acquisition_channel`(nullable): `edm` · `official_letter` · `kotra_invitation` · `website_sns` · `media`
- **CHECK**(드래프트 부분저장 허용): `new_acquisition_channel IS NULL OR participation_route = 'new'`
  — 채널은 `route='new'`일 때만 허용. `route` NULL(작성 중)도 통과. "route=new면 채널 필수"는
  DB가 아니라 **제출 시 API 검증**으로(부분저장이 막히지 않도록 — #26 정합).

### 1.4 구간 enum (셀렉트, CHECK)
> 코드값은 **ASCII 영문 슬러그**로 통일(다른 enum 컨벤션 정합 — schema-keeper #4). 화폐 단위는
> 주석으로: 억=억원(100M KRW), m=백만(KRW은 백만원, USD는 1,000,000).

| 코드 | 적용 | 코드값(=원본 구간) |
|------|------|---------|
| `annual_sales_buyer` | 바이어 연매출(USD) | `usd_lt_500k`(~500,000) · `usd_500k_1m` · `usd_1m_5m` · `usd_gt_5m` |
| `annual_sales_seller` | 셀러 연매출(억원) | `krw_1_5`(1~5억) · `krw_5_10` · `krw_10_50` · `krw_50plus` |
| `employee_range` | 직원 수 | `e_0_10` · `e_11_50` · `e_51_100` · `e_101plus` |
| `business_perf_korea_3y` | 바이어 대한실적 3년(USD) | `none` · `usd_1_1m` · `usd_1m_5m` · `usd_5m_plus` |
| `travelers_korea_3y` | 바이어 방한객 3년 | `t_0_500` · `t_501_1000` · `t_1001_5000` · `t_5001_10000` · `t_10000plus` |
| `product_price_range` | 셀러 상품 가격대(백만원) | `krw_0_10m`(0~1천만) · `krw_10_30m` · `krw_30_50m` · `krw_50_70m` · `krw_70_100m` |
| `budget_range` | 바이어 지출 가능 예산(USD) — BM-001 폼 2단계 | `usd_lt_100k`(~100,000) · `usd_100k_500k` · `usd_500k_1m` · `usd_1m_5m` · `usd_5m_10m` · `usd_10m_plus` |
| `adoption_timeline` | 바이어 도입 시기(년도+반기) — BM-001 폼 2단계 | `2026_h2` · `2027_h1` · `2027_h2` · `2028_h1` · `2028_h2` · `2029_h1` · `2029_h2` · `2030_h1` · `2030_h2` · `undecided` |

> `budget_range`·`adoption_timeline`은 BM-001 바이어 자가등록 폼이 실제 수집(2026-06-29 폼=진실원천).
> 과거 "제거(잠정)" 컬럼의 **재도입** — 위 enum으로 정식 정의(§3.1 제거 목록에서 제외). 구간 수치/환율은
> 표시용 근사(주최사 확인 여지) — 컬럼·코드값은 확정.

> 원본 USD 구간 표기 오류(`1,000,001~5,000,000`와 `1,000,001~` 중복) → 마지막은 `usd_gt_5m`로
> 해석. `business_perf_korea_3y`의 `usd_1_1m`(상한 1m) 동일. **HITL: 주최사 확인.**

---

## 2. 공유 식별(Organization) — 안정 법인정체성만

> 행사 간 공유되는 **불변에 가까운 식별값만** 둔다. 행사별 선언값(위치·연락처·연매출 등)은
> 역할 프로필에 스냅샷한다(codex P0 — 재등록 시 공유/이력 행 변형 방지).

| 폼 항목 | 컬럼 | 타입 | 비고 |
|---------|------|------|------|
| 기업명(국문) | `organizations.name_ko` | text **nullable** | 폼: 셀러 필수 |
| 기업명(영문) / Organization | `organizations.name_en` | text **nullable** | 폼: 둘 다 필수 |
| 사업자등록번호 | `organizations.business_reg_no` | text nullable | 해외 바이어 결측(upsert 키 아님, D4) |
| 홈페이지 / Website | `organizations.website` | text nullable | 안정 식별값 |

> **DB 컬럼은 모두 nullable**(name_ko/name_en 포함). org는 로그인 시 Registrant에서 **이른
> 생성**(ADR-0009)되는데 그 시점엔 한쪽 이름만 있을 수 있다(roster prefill). "폼 필수(셀러=둘 다,
> 바이어=영문)"는 **제출 API 검증**으로 강제한다(부분저장이 막히지 않게 — participation_route와 동일 원리).

> 기존 단일 `organizations.name` → `name_ko`/`name_en` 분리(백필). `description`·`founded`·
> `employees`는 프로필로 이관(아래). 위치·Tel·Fax는 프로필 스냅샷(§3·§4).

---

## 3. 바이어 프로필 (F-BM-001)

### 3.1 `buyer_profiles` (행사별 바이어 선언) — 1:1 with org_event_role

> ⚠ **BM-001 바이어 자가등록 폼이 진실원천(2026-06-29 결정).** 이 표는 폼 형태에서 파생한다(역방향
> 아님 — F-BM-001 "폼이 진실원천" 노트). 컬럼은 셋으로 나뉜다: **(A) 폼 수집(노출)** · **(B) 폼 미노출(v1,
> 컬럼만 유지)** · **(C) BM-001 폼 미수집 — KOTRA 상담주선 요구항목, 무역관/운영 슬라이스로 이관(컬럼 유지)**.

#### (A) 폼 수집 — 노출
| 폼 항목 | 컬럼 | 타입 | 단계 |
|---------|------|------|------|
| (PK/FK) | `org_event_role_id` | uuid uq | — |
| 신청자 이름(국문) | `contact_name_ko` | text | 1 |
| 신청자 이름(영문, 필수) | `contact_name_en` | text | 1 |
| 신청자 직위(국문) | `contact_title_ko` | text | 1 |
| 신청자 직위(영문) | `contact_title_en` | text | 1 |
| 신청자 이메일(필수) | `contact_email` | text | 1 |
| 신청자 전화번호(필수) | `tel` | text | 1 |
| 상담/소통 언어(단일) | `contact_language` | text(CHECK `meeting_language`) | 1 |
| 통역 필요 여부 | `contact_interpreter_need` | bool nullable | 1 |
| Country (소속 국가, 필수) | `country` | text | 1 |
| Annual Sales | `annual_sales_range` | text(CHECK `annual_sales_buyer`) | 1 |
| Number of Regular Employees | `employee_range` | text(CHECK) | 1 |
| 참가자 구분(멀티 8) | → `org_event_role_org_types` 조인 | — | 1 |
| 주요 관심분야(멀티 13) | → `buyer_interest_keywords` 조인 | — | 2 |
| 기업소개(국문, 500) | `company_intro_ko` | text | 2 |
| 기업소개(영문, 500, 필수) | `company_intro_en` | text | 2 |
| 지출 가능 예산(USD) | `budget_range` | text(CHECK `budget_range`) | 2 |
| 도입 시기(년도+반기) | `adoption_timeline` | text(CHECK `adoption_timeline`) | 2 |

> **신청자 식별 = `contact_*` 신규 컬럼**(F-BM-001 1단계 "기본정보" 재구성). `tel`(과거 "현장 연락")은
> **신청자 전화번호**로 재용도. 신청자 이름·직위는 **국/영 둘 다 수집**(영문 필수, 국문 선택) — 확정결정 #3
> 갱신("바이어=영문" → 바이어 신청자도 국/영). `contact_language`는 **단일값**(셀러 `available_languages`·
> attendee `languages`의 멀티 `text[]`와 달리 단일 text+CHECK).
> 소속명(국/영)·홈페이지·사업자번호는 `organizations`(§2, Registrant prefill). `company_intro_ko`는 기존
> `company_intro_en`과 짝. `budget_range`·`adoption_timeline`은 §1.4 enum으로 **재도입**(아래 제거 목록에서 제외).

#### (B) 폼 미노출(v1) — 컬럼만 유지(노출 축소, 1단계 트림)
`continent` · `city_state` · `zip_code` · `address1` · `address2` · `last_year_best_buyer` ·
`business_perf_korea_3y`(text CHECK §1.4) · `travelers_korea_3y`(text CHECK §1.4).
(`organizations.business_reg_no` · `organizations.website`도 폼 미노출(v1) — §2.)

#### (C) BM-001 폼 미수집 — KOTRA 상담주선 요구항목, 무역관/운영 슬라이스로 이관(컬럼 유지)
| 컬럼 | 타입 | 비고 |
|------|------|------|
| `company_logo_file_id` | uuid FK→files | Company Logo — 운영/무역관 슬라이스 |
| `company_profile_file_id` | uuid FK→files | Company Profile — 운영/무역관 슬라이스 |
| `note` | text | Note — 운영/무역관 슬라이스 |
| `participation_route` | text(CHECK) | 참가 경로 — KOTRA 요구항목 |
| `new_acquisition_channel` | text(CHECK, nullable) | 신규 획득채널(조건부 §1.3) — KOTRA 요구항목 |
| `kst_available_time` | text | KST 상담 가능 시간 — KOTRA 요구항목 |
| `kotra_member` | bool | KOTRA 기업회원 가입 유무 — KOTRA 요구항목 |

> (C)는 **폐기가 아니다.** KOTRA 통합 상담주선 요구항목이라 바이어 본인 자가등록 폼 밖(무역관 대리신청·
> 운영 슬라이스)에서 수집한다. 컬럼·CHECK는 schema.sql에 그대로 유지하고, BM-001 폼에서만 미수집.
> `buyer_attendees`(§3.2)·`buyer_recommended_buyers`(§3.3)도 동일 — 표는 유지하되 BM-001 폼 미수집.

**제거(잠정):** `looking_for` · `use_environment` · `required_spec` · `adoption_stage` · `current_adoption`.
(과거 `budget_range`·`adoption_timeline`은 제거 목록에서 **제외 — §1.4 enum으로 재도입**.)

### 3.2 `buyer_attendees` (신규, 복수 — Attendee Information [2])
> ⚠ **BM-001 바이어 자가등록 폼 미수집**(2026-06-29) — 담당자 복수는 KOTRA 상담주선 요구항목이라
> 무역관/운영 슬라이스로 이관. 테이블·컬럼은 유지(폐기 아님).

`id` · `buyer_profile_id`(FK CASCADE) · **`member_id`** uuid FK→members nullable(로그인·미팅
인물과 동일인이면 연결, 폼값은 스냅샷 — codex P1) · `first_name` · `last_name` · `division` ·
`job_title` · `email` · `tel` · `mobile` · `whatsapp_id` · `messenger_id`(KAKAO/LINE/TELEGRAM) ·
`languages` text[](CHECK) · `interpreter_need` bool · `interpreter_languages` text[] ·
`sort_order` · `created_at`. **UNIQUE(buyer_profile_id, email)**.

### 3.3 `buyer_recommended_buyers` (신규, 복수 — Recommend as a buyer [4])
> ⚠ **BM-001 바이어 자가등록 폼 미수집**(2026-06-29) — 추천 바이어는 KOTRA 상담주선 요구항목이라
> 무역관/운영 슬라이스로 이관. 테이블·컬럼은 유지(폐기 아님).

`id` · `buyer_profile_id`(FK CASCADE) · `continent` · `country` · `organization` ·
`person_in_charge` · `email` · `tel` · **`resolved_organization_id`** uuid FK→organizations
nullable(후속 dedupe — codex P2) · `sort_order` · `created_at`.

---

## 4. 셀러(참가사) 프로필 (F-BM-002)

### 4.1 `exhibitor_profiles` (행사별 셀러 선언) — 1:1 with org_event_role
| 폼 항목 | 컬럼 | 타입 | 단계 |
|---------|------|------|------|
| (PK/FK) | `org_event_role_id` | uuid uq | — |
| (배정 부스) | `booth_id` | uuid FK | — |
| 부스 Hall(신고값) | `booth_hall` | text | 1 |
| 관(pavilion) | `booth_pavilion` | text | 1 |
| 부스위치(미배정 가능) | `booth_location` | text | 1 |
| 부스타입 | `booth_type` | text | 1 |
| 부스개수 | `booth_count` | integer | 1 |
| 대표자명(국/영) | `representative_name_ko` / `_en` | text | 1 |
| 회사 이메일 | `company_email` | text | 1 |
| 대표번호 | `main_tel` | text | 1 |
| 팩스번호 | `fax` | text | 1 |
| 우편번호 | `zip_code` | text | 1 |
| 주소(국문) | `address_ko` | text | 1 |
| 상세주소 | `address_detail` | text | 1 |
| 주소(영문) | `address_en` | text | 1 |
| 업태 / 종목 | `business_type` / `business_item` | text | 1 |
| 담당자(복수, 국/영) | → `exhibitor_attendees` | — | 1 |
| 기업 소개(국/영, 500) | `intro_ko` / `intro_en` | text | 2 |
| 홈페이지 | → `organizations.website` | text | 2 |
| 연매출(KRW) | `annual_sales_range` | text(CHECK `annual_sales_seller`) | 2 |
| 회사규모(직원 수) | `employee_range` | text(CHECK) | 2 |
| 상담 가능언어(멀티) | `available_languages` | text[](CHECK `meeting_language`) | 2 |
| KOTRA 회원 여부 | `kotra_member` | bool | 2 |
| 주요 전시품목(멀티 13) | → `exhibitor_keywords` 조인 | — | 3 |
| 선호 바이어 국가(멀티) | `preferred_buyer_countries` | text[] | 4 |
| 선호 바이어 구분(멀티 8) | `preferred_buyer_types` | text[] | 4 |
| 행사 미팅 가능시간(불가 슬롯) | `unavailable_meeting_slots` | text[] | 4 |

> **`unavailable_meeting_slots`**(신규, 2026-06-29): 타겟 단계에서 설정하는 행사 기간 미팅 가능/불가.
> 기본 전부 가능 → **불가 슬롯만 opt-out** 저장(키=`YYYY-MM-DDTHH:MM`). 슬롯 **그리드**(행사일·운영시간·
> 슬롯길이)는 `event_schedule_settings`(operating_start/end·slot_minutes)·`events`에서 파생 — 여기엔 참가사의
> **선택만** 둔다. `kst_available_time`(자유텍스트 v1)의 구조화 보강(§7 일부 해소). 매칭 스케줄러(ADR-0006)
> 는 (행사 그리드 − 불가 슬롯)으로 가능 슬롯을 도출. 바이어 측은 buyer 폼 구조화 시 동일 적용(후속).

> **BM-002 프론트 정렬(2026-06-29, codex P1 후속).** 실제 폼 단계에 맞춰 단계 재배치·필드 추가:
> 1 기본정보=회원가입 등록 신고값(부스 Hall>관>부스위치 스냅샷·대표자·업태/종목·담당자, **읽기 전용**),
> 2 회사소개(소개·홈페이지·연매출·직원수·언어·KOTRA), 3 전시품목, 4 타겟(선호바이어 국가/구분·미팅슬롯).
> **부스**: `booth_*`는 등록 신고 스냅샷, `booth_id`는 실제 배정(정규화 halls/booths, 미배정 가능) — 별개.
> **선호바이어**: `preferred_buyer_country`(자유텍스트)→`preferred_buyer_countries/_types`(멀티) 대체.
> **상품 가격대**: 프로필 단위 `product_price_range`→**제품별** `exhibitor_products.price_range`로 이동.
> **비파괴 보존(컬럼 유지, 현 폼 미수집):** `product_intro_ko/en` · `product_price_range` ·
> `preferred_buyer_country` · `participation_route` · `new_acquisition_channel` · `kst_available_time` ·
> `company_logo_file_id` · `company_profile_doc_file_id` · 참가자구분(`org_event_role_org_types`).

**제거(잠정):** `strength` · `achievements` · `target_buyer_types` ·
`target_buyer_nationalities` · `target_org_types`(선호바이어/추천바이어로 대체).

### 4.2 `exhibitor_products` (기존 확장 — 제품 복수, 별첨2 로스터 양식 정합)
`name_ko`(기존 `name` 분리 백필) · `name_en` · **`category`(카테고리=전시품목 분야 방산13 코드, CHECK `defense_field`)** ·
`category_ko`/`category_en`(구 자유텍스트 — `category` 선택으로 대체, 비파괴 보존) · `hs_code` ·
`hs_description`(요구사항 "품목 정보 HS코드/설명") · `spec`(사양 국문) · **`spec_en`(사양 영문)** ·
**`price_range`(제품별 가격대, CHECK `product_price_range`)** · `sort_order`.
(가격대를 프로필 단위에서 제품별로 이동. 제품 카테고리는 자유입력 → 전시품목 분야 13 중 선택으로 변경.)

### 4.3 `exhibitor_attendees` (신규, 복수 — 담당자 정보 [2], 국/영 이중)
`id` · `exhibitor_profile_id`(FK) · **`member_id`** FK→members nullable · `last_name_ko/en` ·
`first_name_ko/en` · `division_ko/en` · `title_ko/en` · `email` · `tel` · `mobile` ·
`whatsapp_id` · `languages` text[] · `sort_order` · `created_at`. **UNIQUE(exhibitor_profile_id, email)**.

### 4.4 `exhibitor_recommended_buyers` (신규, 복수 — 초청 바이어 추천 [4])
`id` · `exhibitor_profile_id`(FK) · `continent` · `country` · `org_name_en` · `person_name_en` ·
`email` · `contact` · `resolved_organization_id` FK→organizations nullable · `sort_order` · `created_at`.

---

## 5. 파일 (`files`) — 신규 (codex P1)

> 방산 문서라 단순 s3_key로 부족(메타·스캔·보관기간·교체이력 — F-BM-002 D10, ADR-0008).
> 프로필은 `*_file_id`로 참조. Smart Fill 업로드 원본도 같은 테이블(`purpose='smartfill_source'`).

`id` · `s3_key` · `s3_version_id` · `original_filename` · `content_type` · `byte_size` ·
`checksum_sha256` · `purpose`(CHECK: `company_logo` · `company_profile` · `company_profile_doc` ·
`smartfill_source`) · `owner_org_id` FK→organizations · `uploaded_by_member_id` FK→members nullable ·
`scan_status`(CHECK: `pending` · `clean` · `infected`) · `retention_until` date nullable · `created_at`.

---

## 6. 승인 게이트 (organization_event_roles) — 상태머신 (codex P0)

| 변경 | 내용 |
|------|------|
| `application_status` CHECK | `registered` · `submitted` · `changes_requested` · `approved` · `rejected` |
| 전이 | `registered→submitted`(사용자 제출) · `submitted→{approved\|changes_requested\|rejected}`(운영) · `changes_requested→submitted`(재제출) · approved/rejected 종단 |
| 감사 컬럼 | `reviewed_at` timestamptz · `reviewed_by` FK→organizers nullable · `review_note` text nullable |
| 매칭 노출 | `select_exposed_org_ids` 기준을 **`approved`**로(현 `submitted` → 변경) |
| 제출(#26) | submit = `registered/changes_requested → submitted`(사용자 완료, 원자성 유지). 승인은 운영자/KOTRA 슬라이스 |

> ADR-0009 갱신: "제출=참가자 승격"이 아니라 "제출 → **운영 승인** → 매칭 노출"로 2단계화.
> submit의 원자성(프로필 최종저장 + submitted 전환)은 유지. **승인(approved) 후에도 프로필은 고칠 수 있고, 수정은
> 상태를 바꾸지 않는다**(2026-10-08 정정 — 예전 서술 "승인 후 편집 불가(종단)"는 코드와 어긋나 있었다):
> 저장(`patch_*_step`)에는 상태 조건이 없고 `application_status`를 전이시키지 않는다(app/bm/service.py).
> · 참가자 — **작성 폼** 진입은 `registered`·`changes_requested`뿐(`canEdit`), **마이페이지 구획 편집**은
>   `registered`·`changes_requested`·`approved`(`canSelfEditProfile`, F-BM-004 D5 승인 후 정정). `submitted`(검토 중
>   표류 방지)·`rejected`(종단)는 잠긴다.
> · 운영자 — 어느 상태에서나 신청서의 모든 항목을 직접 수정한다(`PATCH /api/admin/.../profile`, master + 관할 안의 sub.
>   F-OP-002 D26). 부스·미팅 불가 시간은 master 전용.
> "멱등"은 *재제출이 approved 를 내리지 않는다*는 뜻이다. 누가·언제 고쳤는지의 수정 이력은 아직 남기지 않는다(후속).

---

## 7. 범위 밖 / 후속 (HITL)

- **해외바이어 체류정보**(항공·숙박·통역) — 요구사항 ④, **KOTRA 무역관 관리**. 자기등록과 분리된 운영자 슬라이스.
- **KST 상담 가능 시간 구조화** — v1 `text`. **자동 스케줄링(ADR-0006)이 의존하기 전 슬롯 구조화 필수**(codex P2).
  - (셀러 일부 해소, 2026-06-29) `exhibitor_profiles.unavailable_meeting_slots text[]` 추가로 셀러는 슬롯
    단위 가능/불가를 구조화 저장(§4.1). 바이어 측 `kst_available_time` 구조화 + 슬롯 그리드 정규화(현재는
    `event_schedule_settings`에서 파생)는 후속.
- **USD 연매출 구간 오타** — 주최사 확인.
- **무역관 대리신청·승인 UX** — 요구사항 ④(무역관이 바이어 대리 등록·상담 신청).
- **추천 바이어 dedupe 워크플로** — `resolved_organization_id` 채우는 매칭/초청 후속.

---

## 부록 A. 원본 폼 라벨 → 목적지 매핑 (커버리지 증빙, codex P2)

### 바이어 폼
| 폼 라벨(필수) | 목적지 |
|------|------|
| Continent* · Country* · City/State* · Zip · Address1* · Address2 · Tel* | `buyer_profiles.continent/country/city_state/zip_code/address1/address2/tel` |
| Organization* · Website* | `organizations.name_en` · `organizations.website` |
| Last year's Best Buyer* | `buyer_profiles.last_year_best_buyer` |
| Annual Sales* · Employees* · Perf w/Korea* · Travelers* | `buyer_profiles.annual_sales_range/employee_range/business_perf_korea_3y/travelers_korea_3y` |
| 주요 관심분야(13)* · [3] Exhibition Fields(13)* | `buyer_interest_keywords` (동일 13분야 — 단일 차원으로 통합, 폼 중복) |
| 참가자 구분(8) | `org_event_role_org_types` |
| Company Introduction(EN)* | `buyer_profiles.company_intro_en` |
| Company Logo* · Company Profile* | `buyer_profiles.company_logo_file_id` · `company_profile_file_id` → `files` |
| Note | `buyer_profiles.note` |
| [2] Attendee*(복수: name/division/title/email/tel/mobile/WhatsApp/messenger/language/interpreter) | `buyer_attendees.*` |
| Participation Route* | `buyer_profiles.participation_route` (+ `new_acquisition_channel`) |
| [4] Recommend as a buyer(복수) | `buyer_recommended_buyers.*` |
| KST 상담시간·KOTRA 회원(요구사항) | `buyer_profiles.kst_available_time` · `kotra_member` |

> **바이어 [3] Exhibition Fields vs 주요 관심분야**: 동일 13분야 라벨 중복 → **단일 매칭 차원**
> (`buyer_interest_keywords`)으로 통합. 폼이 둘로 보이면 같은 조인에 합쳐 저장. **HITL: 주최사에
> 두 칸의 의미 차이 확인**(없으면 통합 확정).

### 셀러 폼
| 폼 라벨(필수) | 목적지 |
|------|------|
| 기업명 국/영* · 사업자번호* · 홈페이지* | `organizations.name_ko/name_en/business_reg_no/website` |
| 대표번호* · 팩스 · 주소 국/영* | `exhibitor_profiles.main_tel/fax/address_ko/address_en` |
| 연매출* · 직원수* · 가능언어* | `exhibitor_profiles.annual_sales_range/employee_range/available_languages` |
| 주요 전시품목(13)* | `exhibitor_keywords` |
| 참가자 구분(8) | `org_event_role_org_types` |
| 기업 소개 국/영* | `exhibitor_profiles.intro_ko/intro_en` |
| 상품 소개 국/영* · 가격대 | `exhibitor_profiles.product_intro_ko/product_intro_en/product_price_range` |
| 기업 로고* · 기업 소개서* | `exhibitor_profiles.company_logo_file_id` · `company_profile_doc_file_id` → `files` |
| 선호 바이어 국가/기관* | `exhibitor_profiles.preferred_buyer_country` |
| [2] 담당자*(복수, 국/영) | `exhibitor_attendees.*` |
| 참가 경로* | `exhibitor_profiles.participation_route` (+ `new_acquisition_channel`) |
| [4] 초청 바이어 추천(복수) | `exhibitor_recommended_buyers.*` |
| 품목 HS코드/설명·제품 카테고리 국/영·제품명 국/영(요구사항·별첨2) | `exhibitor_products.hs_code/hs_description/category_ko/category_en/name_ko/name_en` |
| 부스번호(별첨2) | `exhibitor_profiles.booth_id` → `booths` |
| KST 상담시간·KOTRA 회원(요구사항) | `exhibitor_profiles.kst_available_time` · `kotra_member` |

**제외 항목(사유):** 해외바이어 체류정보(항공·숙박·통역) = KOTRA 무역관 관리(자기등록 밖).
