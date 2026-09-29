# 등록자 적재층(Registrant) + 비즈매칭 참가자 게이트

ADR-0007은 주관사 전체 신청자 스냅샷을 회원ID 키로 멱등 upsert한다고 정했다. 그러나 현행 `schema.sql`엔 **등록자(Registrant) 적재층이 없고**, "명단에만 있음"과 "비즈매칭 프로필 완료(매칭 대상)"를 구분하는 장치도 없다. 이 ADR은 그 갭을 메운다 — (1) `registrants` 적재 테이블, (2) import 시점 **eager 생성**, (3) `application_status` 참가자 게이트.

## registrants — 적재 착지층 + 인증 신원 앵커

- 주관사 명단(CSV/엑셀) 스냅샷이 착지하는 멱등 upsert 테이블.
- **멱등 주키 = `(event_id, organizer_member_id)`** (ADR-0007: 사업자번호 아님, 전 레코드 존재하는 회원ID).
- **명단 원본 전체를 `raw jsonb`로 보존한다.** 주관사가 어떤 컬럼을 줄지 확정 전이라(선행 블로커), 원본을 통째로 저장해 추후 어떤 스키마가 와도 매핑 가능하게 한다. 향후 비즈매칭 서비스 확장에 필요한 데이터 자산을 버리지 않는다.
- 인증 신원 앵커(ADR-0007): DX Korea 인증 API가 반환하는 회원ID로 이 적재 레코드를 매핑한다. 연락처(이메일/휴대폰)는 알림 발송용으로 보존(OTP는 폐기 — DX Korea API 아이디/비번 검증으로 대체).

## eager 생성 — import 시점에 org/member/role 생성

- import가 명단 한 레코드를 흡수할 때 `registrants`뿐 아니라 `organizations` + `members` + `organization_event_roles`까지 **함께 멱등 upsert**한다.
- **로그인은 read-only** — 이미 존재하는 행을 읽기만 한다. (lazy 생성을 기각한 이유: 한 회사 다중 담당자·동시 첫로그인 시 org 중복 생성 레이스. 방산 대표단은 다중 담당자가 흔하다.)
- **role(참가사/바이어)** 은 명시 컬럼이 없을 수 있다 → **출처 명단 파일로 유추**한다(참가기업 목록=exhibitor, 참관객 목록=buyer). 모호하면 잠정으로 두고 **프로필 작성 경로로 확정**(`/exhibitor/apply`=exhibitor, `/apply`=buyer). 한 회사가 둘 다일 수 있으므로 `organization_event_roles`는 exhibitor/buyer 불리언을 동시에 가질 수 있다(ADR-0001).

## application_status — 매칭 참가자 게이트 (2단계 승인, 2026-06-28 갱신)

> **갱신 사유:** KOTRA 통합 상담주선 요구사항("입력 내용은 관리자의 승인을 통해 최종 등록")을
> 반영해 게이트를 **제출 + 운영 승인 2단계**로 확장한다. 컬럼 정의는 `docs/db/bm-profile-fields §6`.

- `organization_event_roles.application_status` ∈ {`registered`, `submitted`, `changes_requested`, `approved`, `rejected`} (기본 `registered`).
  - `registered` = 명단엔 있으나 프로필 미작성.
  - `submitted` = 프로필 작성 완료, **운영 승인 대기**(아직 매칭 대상 아님).
  - `changes_requested` = 운영이 보완 요청 → 사용자가 수정 후 `submitted`로 재제출.
  - `approved` = 주최사/KOTRA 승인 → **매칭 엔진 진입 대상(비즈매칭 참가자)**.
  - `rejected` = 운영이 반려(종단).
  - 감사: `reviewed_at` · `reviewed_by`(FK organizers) · `review_note`.
- **전이:** `registered→submitted` · `submitted→{approved|changes_requested|rejected}` · `changes_requested→submitted`(재제출) · `approved`/`rejected` 종단.
- **매칭 엔진·기업 목록은 `approved`만 노출/대상**으로 한다(미승인·작성 중·유령 org 비노출). 승인 워크플로는 운영자/KOTRA 슬라이스 소관.
- **참가자 판정 = `application_status='approved'`**.
- **제출은 원자적 트랜잭션(불변)** — 프로필 최종 저장과 `submitted` 전환을 하나의 트랜잭션으로 묶는다. 반쪽 제출(status는 submitted인데 데이터 불완전)을 구조적으로 방지. (승인은 별도 운영 트랜잭션 — 제출 원자성과 무관.) **멱등:** 이미 `approved`면 재제출·수정해도 비강등(approved 유지).
- 부수 효과: `application_status`는 "이 org가 이 이벤트에서 비즈매칭에 참여·승인됐다"는 **이벤트별 참여 기록**이 되어, 멀티 이벤트 확장 시 cross-event 이력 자산이 된다.

## 약관 동의 내역/이력 관리 (NABI 계정 발급 — ADR-0007/0008)

최초 로그인 시 **NABI 약관 동의(방산=민감정보)** 를 받고 NABI 계정(Cognito)을 발급한다. NABI 계정 ↔ DX Korea 회원ID ↔ registrants 적재 레코드를 동일 회원ID 키로 매핑한다.

한국 개인정보보호법상 약관은 **항목별로 분리 동의**해야 한다(서비스 이용약관·개인정보 수집이용·**민감정보 처리(방산)**·제3자 제공·마케팅 등, 필수/선택 구분). 항목별 동의/철회·버전·시각을 법적 증빙 가능하게 보존하기 위해 **3테이블**로 모델링한다.

- **`consent_documents`** — 약관 문서(버전 관리). 컬럼: `id`, `type`(check tos/privacy/sensitive/third_party/marketing), **`title`**(약관명, 화면 노출), `version`, `content_url`, `is_required`(필수/선택 bool), `effective_date`, `created_at`. UNIQUE `(type, version)`.
- **`user_consent_states`** — 개인별 동의 상태 **마스터(현재값, 가변)**. 컬럼: `id`, `member_id`(FK→members), `type`, `consent_document_id`(FK→consent_documents, 현재 동의한 버전), `agreed`(bool), `agreed_at`, `withdrawn_at`(nullable), `updated_at`. UNIQUE `(member_id, type)`. "이 회원이 지금 X에 동의 중인가?"를 빠르게 조회.
- **`user_consent_history`** — 동의/철회 **이력(append-only 감사 로그)**. 컬럼: `id`, `member_id`(FK→members), `consent_document_id`(FK→consent_documents), `action`(check agreed/withdrawn), `acted_at`, `ip`, `method`. 모든 동의·철회 이벤트를 영구 박제.

마스터/이력 분리 이유: 마스터는 현재 상태 빠른 조회, 이력은 불변 증빙. (기존 단일 `user_consents` 테이블은 이 3개로 대체 — 항목 분리·철회·버전 증빙을 단일 테이블론 표현 불가.)

## Considered Options

- **lazy 생성(로그인 시 org/role 생성, 기각):** 코드는 적지만 동시 첫로그인 레이스로 org 중복 → 수동 병합 지옥.
- **참가자를 프로필 존재만으로 판정(기각):** "작성 중(부분 저장)"과 "제출 완료"를 구분 못 함. status 게이트가 필요.
- **eager + raw 보존 + status 게이트(채택).**

## Consequences

- `schema.sql`(파생 ERD)과 Alembic 마이그레이션에 `registrants` 테이블 + `organization_event_roles.application_status` 컬럼 추가. **db-schema-keeper가 본 ADR과 ADR-0007/0008에서 파생해 동기화**한다.
- 실제 명단 컬럼 구조 확정은 **주관사 연동 합의(선행 블로커, backlog)** 에서 닫는다. 그 전까지 `raw jsonb` 보존으로 손실 없이 진행 가능.
- import 로직(주관사 스냅샷 업로드, OP-002)은 멱등 upsert + eager 생성 + role 출처유추를 구현한다.

Status: accepted
