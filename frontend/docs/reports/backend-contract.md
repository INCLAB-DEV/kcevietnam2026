---
title: 백엔드 계약 — 프론트가 확정한 쓰기 API (FastAPI 구현 대상)
date: 2026-07-06
audience: 서버 개발자
status: 프론트는 아래 계약대로 완성됨. 현재 Next Route Handler + 목업 store가 대역.
---

# 백엔드 계약 — 프론트가 기대하는 쓰기 API

## 0. 지금 구조 & 넘길 것

프론트는 아래 엔드포인트를 `fetch("/api/...")`로 호출하도록 **이미 완성**돼 있다.
현재는 Next.js Route Handler(`app/api/**/route.ts`) + 목업 store(서버 메모리, 재시작 시 증발)가
그 자리를 채우고 있다. **실제 영속·인증·집계는 없다.**

연동 방식(택1):
- (A) Next Route Handler 내부를 FastAPI proxy로 교체 — 프론트 호출부 불변, URL도 `/api/...` 유지
- (B) 프론트가 FastAPI를 직접 호출 — 이 경우 아래 계약(경로·body·상태코드)을 FastAPI가 그대로 구현.
  회의록(ReviewFlow)이 쓰는 방식: `NEXT_PUBLIC_*_API_BASE` env로 base URL 주입, mock/http 스왑.

**공통 규약**
- 성공/실패 body: `{ success: boolean, ... }`. 실패는 `{ success:false, error:"<code>", details?:{} }`.
- 상태코드: 400(형식) · 401(미인증) · 403(권한) · 404(없음) · 409(상태 충돌) · 422(검증 실패) · 500.
- **인증**: 현재 목업은 dev 쿠키(`nabi_dev_as`)로 role을 흉내낸다. 실서버는 **세션 토큰(Cognito JWT
  예정)에서 role·소유자를 도출**해야 한다. 아래 "세션에서 도출"이라 쓴 값은 절대 body로 받지 말 것
  (클라가 위조 가능).
- **소유권**: `profileKey`/`orgId` 류는 body가 아니라 토큰에서. 목업은 세션 orgId 사용.

---

## 1. POST /api/buyer-profile — 바이어 draft 단계 부분저장

- 권한: 인증된 바이어. status ∈ {registered, changes_requested}만 (그 외 409 locked).
- Req: `{ step: 1|2, draft: { ...해당 단계 소유 필드만 } }`
  - profileKey는 **세션에서** (body 아님).
  - **빈 값 허용** — 부분저장은 제출 게이트가 아니다(미완성 단계도 저장). 필수 미충족이어도 422 아님.
  - 단계 소유 필드 = `STEP_FIELDS`(백엔드 `/steps/{step}` 미러). 미지의 키는 버린다.
- Res 200: `{ success:true, draft: <병합된 전체 draft> }`
- 에러: 400 invalid_json·invalid_step·invalid_draft / 401 / 403(바이어 아님) / 409 locked
- 백엔드 미러: `PATCH /buyer/{org_event_role_id}/steps/{step}`

## 2. POST /api/buyer-apply — 바이어 최종 제출

- 권한: 인증 바이어 + status ∈ {registered, changes_requested} (아니면 409 submit_blocked).
- Req: `{ draft?: <최종 draft> }` (선택 — 없으면 서버 저장분으로 판정)
- **검증 게이트**: 1~2단계 필수 전부 충족해야 함(부분저장과 달리 여기선 막는다).
  미충족 → 422 `{ error:"validation_failed", details:{ missing:[필드키...] } }`.
- 처리: draft 병합 + status 전환(registered/changes_requested → submitted, approved는 멱등,
  rejected는 재제출 차단). **원자적**으로.
- Res 200: `{ success:true, applicationStatus:"submitted" }`
- 에러: 401 / 403 / 409 submit_blocked / 422 / 500
- 백엔드 미러: `POST /buyer/{id}/submit`
- ⚠️ 필수 규칙 정본 = 프론트 `lib/apply/schemas.ts`. 백엔드도 같은 규칙으로 재검증할 것
  (프론트 검증은 UX용, 최종 권위는 서버). 1단계 필수 = contactNameEn·organizationNameEn·
  contactEmail·tel·country, 2단계 = interestCategories≥1·companyIntroEn. **email/tel 형식
  검사는 현재 없음**(빈값만 체크) — 형식 강화하려면 프론트와 동시에.

## 3. POST /api/organizer/assignments — 배정 확정 저장

- 권한: 운영자(organizer).
- Req: `{ meetings: AssignmentMeeting[] }` (min 1). 강제 배정·단일 일괄배정 확정분.
  - AssignmentMeeting: `{ id, exhibitorId, buyerId, slotId, status(proposed|accepted|completed|
    cancelled|rejected), matchingType(forced|ai|open|onsite), durationMinutes? }`
  - slotId 형식 `"2026-09-16T14:30"`.
- Res 200: `{ success:true, status:"created", count, ids:[...] }`
- ⚠️ REFACTORING.md 초안의 `{ meetingId, targetOrganizationId, slotId }` 단건 body로는 도메인
  타입을 못 담아 벌크로 조정함. 이 형태 기준으로.
- 배정 **계산 로직(적합도·포화 엔진)은 backend #53 소관**(ADR-0006). 이 라우트는 확정분 저장만.

## 4. DELETE /api/organizer/assignments/{id} — 배정 삭제

- 권한: 운영자. Res 200 `{ success:true }` / 404 not_found.
- 프론트 UI 동선은 아직 없음(계약만) — spec TBD-4.

## 5. POST /api/organizer/saturation — 포화배정 Draft 계산(미발효)

- 권한: 운영자.
- Req: `{ settings: ScheduleSettings, assignMinutes, runNumber, now:{date,time} }`
  - ScheduleSettings: `{ startTime,endTime,slotMinutes,lunchStart,lunchEnd,minSlots }` (HH:MM)
  - `now`는 클라가 보냄(dev ?now= 오버라이드·분 경계 정합). 실서버는 서버시각 KST 권장 검토.
- Res 200: `{ success:true, draft:{ runNumber, settings, meetings:DraftMeeting[] }, count }`
- ⚠️ **핵심**: 현재 목업은 프론트와 같은 순수 lib(`generateSaturationDraft`)로 서버에서 계산.
  실 배정 엔진(적합도 정의 HITL 블로커 ADR-0006)은 backend가 대체. Draft는 저장 안 함(미발효).

## 6. POST /api/organizer/saturation/confirm — Draft 확정(발효)

- 권한: 운영자. Req: `{ draftAssignments: AssignmentMeeting[] }` (min 1, 검토 통과분).
- Res 200: `{ success:true, status:"confirmed", count }`

## 7. PATCH /api/organizer/members/{memberId}/status — 참가기업 상태 변경

- 권한: 운영자 **master 전용** (sub 무역관은 403 forbidden_sub, ADR-0012).
- Req: `{ status: "approved"|"rejected"|"changes_requested", note?:string }`
  - registered/submitted 전이는 **불가**(참가측 제출 플로우 소관) — 목업은 body enum에서 아예 제외.
- Res 200: `{ success:true, id, status }` / 404 not_found(없는 멤버).

---

## 8. 목업이 감추는 것 = 서버가 채워야 할 것

1. **영속** — 전부 서버 메모리/localStorage. 진짜 DB 저장·조회 없음.
2. **인증·권한** — dev 쿠키 role 흉내. 실 토큰 검증·소유권 판정 없음. (ADR-0012 접근제한 권위=백엔드)
3. **읽기 조회 API 부재** — 프론트 draft 복구는 아직 **localStorage**가 소스. 서버에 다음이 필요:
   - `GET /api/buyer-profile`(바이어 draft 재개) — 이게 생겨야 프론트가 localStorage 걷어낸다.
   - 배정/멤버는 `serverApiClient.getAssignmentSchedule/getMembers`가 목업 픽스처+store 병합 중.
4. **집계·계산** — 포화배정 적합도(fit score) 정의가 HITL 블로커(ADR-0006). 추천/매칭 엔진 backend.
5. **동시성** — 여러 운영자 동시 편집 충돌 처리 없음(spec op-003 TBD-4).
6. **이미지 업로드** — AD-001 로고/사진 요구사항 미정(기획 TBD), 엔드포인트 없음.

## 9. 참고 — 이미 seam이 있는 도메인(MY-002 회의록)

회의록은 이미 mock/http 스왑 구조 완비(`lib/review/http-review-client.ts`,
env `NEXT_PUBLIC_REVIEW_API_BASE`, 인증 `X-Org-Id`). 계약: `/meetings/{id}/review/*`
(step1, step2/structure, step2/transcribe, step2, export, love-call). snake_case payload.
위 1~7번 API도 최종적으로 이 방식(env 스왑)으로 가는 게 목표.

---

# 부록 — 프론트 전수 조사: 서버가 채워야 할 지점 전부

위 1~7은 이번 리팩토링으로 프론트가 만든 쓰기 API다. 아래는 **프론트 코드 전체에 이미
존재하는** seam·mock·TODO 전수 목록 — 실서버(FastAPI) 붙일 때 구현/교체 대상.
교체 지점을 파일 경로로 명시했다. (조사 근거: `grep "실연동 시|TODO(슬라이스|NEXT_PUBLIC.*API_BASE"`)

## A. env로 mock↔http 스왑되는 seam (계약이 http 클라에 이미 정의됨)

실서버는 아래 env를 켜고 http 클라가 때리는 엔드포인트를 구현하면 프론트 코드 불변.

| 도메인 | env | http 클라(계약 정본) | 엔드포인트 |
|--------|-----|----------------------|-----------|
| 인증 | `NEXT_PUBLIC_AUTH_CLIENT=http` | `lib/auth/http-auth-client.ts` | `POST /api/auth/{deeplink, login/start, login/complete}` |
| 회의록 | `NEXT_PUBLIC_REVIEW_API_BASE` | `lib/review/http-review-client.ts` | `/meetings/{id}/review/*` (§9) |
| 참가사 프로필 | `NEXT_PUBLIC_BM_API_BASE` | `lib/bm/http-exhibitor-client.ts` | `GET/PATCH/POST /bm/exhibitor/{id}[/steps/{step}][/submit]` |
| **SmartFill(AI 추출)** | `NEXT_PUBLIC_BM_API_BASE` | `lib/bm/smartfill-client.ts` | `POST /extract` (multipart 파일 → presigned S3 → Claude 추출) |

### A-1. SmartFill — "AI가 신청서를 자동으로 채워주는" 기능

- 상태: **프론트 완성(UI·seam·채우기 로직), 실제 AI 추출은 mock**. 지금은 파일 안 읽고 1.2초 뒤
  고정 데모(TICN/C4I) 반환 — 뭘 올리든 같은 결과.
- 실서버 `POST /extract`: 파일 업로드 → S3 저장 → **Claude로 회사소개·전시품목 추출**
  (Claude 키는 backend 한정, ADR-0008). 응답(snake_case):
  `{ products:[{name_ko,name_en?,category?,hs_code?,spec?}], exhibition_categories:[], intro_ko?, intro_en? }`
- 프론트 규칙: 빈 칸만 채움(사용자 입력 보존), "AI 초안" 배지, 검토·수정 후 확정(D9). 이건 이미 됨.

### A-2. 인증 (일부 route handler는 이미 존재)

- `app/api/auth/{deeplink,login/start,login/complete}/route.ts` 파일은 있음(BFF 2-hop).
  내부가 FastAPI를 실제로 호출하는지 서버측 확인 필요. 계약: `lib/auth/auth-types.ts` 주석에 명시
  (자격검증 + 명단매핑 + 재방문/최초 분기 + 약관 동의 → 세션 발급).
- 약관 전문: 지금 데모 플레이스홀더 — 실서버 `consent_documents`(#19) 전문/버전으로 대체.

## B. serverApiClient 읽기 seam (전부 mock 픽스처 — FastAPI 조회로 교체)

`lib/api-client/server.ts` 한 파일이 모든 읽기의 이음새(ADR-0008). 아래 메서드 내부만 FastAPI로.

| 메서드 | 화면 | 현재 |
|--------|------|------|
| `getHomeDashboard/getHomeNotifications` | 홈 HM-001 | mock 집계 |
| `getOrganizations/getOrganization` | 발견 DIS | mock-orgs |
| `getRecommendations` | 추천/매칭 | **휴리스틱 mock** — 실 매칭 엔진 backend(#14) |
| `getMyMeetings/getEventDates` | 미팅 MY-001 | mock |
| `getMembers/getMember/getMemberProfiles` | 운영 OP-002/003 | mock + 이번 status store 병합 |
| `getOpsDashboard` | 대시보드 OP-001 | mock 집계 |
| `getAssignmentSchedule` | 배정 OP-005 | mock + 이번 assignment store 병합 |
| `getMeetingAvailability` | 미팅 신청 | mock |
| `getViewerOrg` | 전역 | 세션 orgId↔기업 1:1 shim — 실연동 시 Cognito org_id 조회 |

## C. 아직 http 클라도 없는 것 (엔드포인트 신설 필요)

| 기능 | 파일 | 현재 | 서버 할 일 |
|------|------|------|-----------|
| **바이어 draft 조회** | `lib/apply/buyer-profile-store.ts` | **localStorage** | `GET /api/buyer-profile` 신설 — 이게 있어야 프론트가 localStorage 걷어냄 (§8-3) |
| 관심기업 북마크 | `lib/discover/bookmark-store.ts` | localStorage | `interested_organizations` CRUD(#14) |
| 명단 임포트 | `lib/organizer/roster-import.ts` | 클라 파싱 | 업로드부만 FastAPI(S3 원본 + RDS upsert, 멱등)(#50) |
| 추천 피드백 | `sessionApiClient.recordRecommendationFeedback` | console 스텁 | `POST` 추천 학습/성과(#14) |
| 알림 인박스 | `sessionApiClient.listNotifications` 등 | 인메모리 | `GET/PATCH` org 공유 알림(#44/#45) |
| 로그아웃 | `sessionApiClient.logout` | 쿠키 삭제 스텁 | Cognito 사인아웃(토큰 폐기) |

## D. 세션·권한 (전역 전제 — 제일 먼저)

- 현재: dev 쿠키 `nabi_dev_as`/`nabi_dev_status`로 role·status 흉내(`lib/mock/session.ts`).
  `?as=`/`?status=` 쿼리 스위처는 dev 전용.
- 실서버: **Cognito JWT에서 role·org_id·application_status 도출**. dev 스위처 제거.
  권한 경계의 권위는 백엔드(ADR-0012) — 프론트 가드는 UX용. 위 모든 API의 "세션에서 도출"
  값(profileKey/orgId/role/permissionLevel)은 토큰이 소스.

## E. 데이터·정책 미결(HITL/기획 — 서버 스키마에 영향)

- 포화배정 **적합도(fit score) 정의** — HITL 블로커(ADR-0006). 매칭 엔진 backend #53.
- 신규 로스터 컬럼(부스/대표자/업태/종목) — 백엔드 #26 스키마 미반영, 현재 http 클라가 누락 처리.
- 신청기간(opensAt/closesAt) — 하드코딩/env 아니라 **Event 레코드**에서 내려와야(`application-period.ts`).
- 행사 일자(현재 DX Korea 2026 9/16~18 하드코딩) — 행사 설정에서 주입.
- email/tel 형식 검사 — 현재 없음(빈값만). 도입 시 프론트 스키마와 동시.
- 이미지 업로드(로고/사진) — 요구사항 미정, 엔드포인트 없음.
- 동시성(운영자 동시 편집 충돌) — 처리 없음(op-003 TBD-4).

## F. 우선순위 제안 (프론트 관점)

1. **세션·인증(D)** — 나머지 전부의 전제.
2. **읽기 seam(B) + 바이어 draft GET(C)** — 화면이 실데이터로 뜨고 localStorage 제거 가능.
3. **이번 쓰기 API(§1~7)** — 폼·배정·상태변경 실저장.
4. **SmartFill /extract(A-1) + 매칭 엔진(E)** — AI 기능. 별도 난이도(Claude·fit score HITL).
