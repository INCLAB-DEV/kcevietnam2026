---
title: 리팩토링 가이드 — 기능 보존 + 코드 개선
---

# 🔧 리팩토링 가이드

**목표**: 기능은 모두 동작하되, 코드를 회사 컨벤션에 맞게 개선.

**원칙**:
1. ✅ **현재 동작하는 기능 유지** (사용자 UX 변화 없음)
2. 🔴 **내부 구현만 개선** (React Hook Form, Zod, 서버 액션 등)
3. ⚠️ **API 계약은 최소한의 변경** (백엔드와 협의 필수)

---

## 1️⃣ 우선순위 & 범위

### Phase 1: 긴급 (2주) — 🔴 반드시 변경

#### AD-001 (지원 폼)

**현재 상태** ✅:
- 3단계 폼 진행 가능
- draft localStorage 저장 + 복구 동작
- validation 기본 동작 (필수 필드 확인)

**리팩토링 필요** 🔴:
```
[ 현재 구현 ]
useState (draft, step, showErrors)
validateStep() 순수함수
localStorage 직접 접근

[ 변경할 것 ]
useForm + React Hook Form
Zod 스키마 기반 validation
서버 액션 또는 API route
```

**⚠️ 주의 — 다음은 변경하지 말 것**:
- ✅ `/apply?step=N` 쿼리스트링 직접 진입 (유지)
- ✅ 3단계 구조 (Step 1/2/3) (유지)
- ✅ StepBasicInfo / StepInterests / StepReview 컴포넌트명 (변경 가능하지만 기능 동일)
- ✅ draft 자동 저장 (UX 변화 없게 유지)
- ✅ `/welcome`으로 redirect (유지)

**API 계약** (변경 필요):
```typescript
// Before (localStorage)
saveStep(key, step, draft) → localStorage.setItem()

// After (서버)
POST /api/buyer-profile { step, draft } → 200 OK
Response: { success: true, draft: {...} }
```

**체크리스트**:
- [ ] `package.json`에 `react-hook-form@^7` + `zod@^3` 추가
- [ ] `lib/apply/form-state.ts` → Zod schema 변환
  - [ ] StepBasicInfoSchema
  - [ ] StepInterestsSchema
  - [ ] 각 필드 validation rule 유지
- [ ] `components/apply/apply-form.tsx` → useForm 전환
  - [ ] draft 초기값 설정 (prefill)
  - [ ] 에러 메시지 필드별 표시 (현재와 동일한 UX)
  - [ ] [저장 및 다음] 클릭 → validation → API 호출
- [ ] `app/api/buyer-profile/route.ts` 작성 (POST)
- [ ] localStorage 호출 제거 (lib/apply/buyer-profile-store.ts)
- [ ] `/welcome`에서 최종 제출 (기존과 동일)

---

### Phase 2: 높음 (2주) — 🟡 API 추가 필요

#### OP-005 (강제 배정)

**현재 상태** ✅:
- 매트릭스 조회 가능 (읽기)
- Forced Fill / Saturation UI 프리뷰 동작
- [폐기] [확정] 버튼 클릭 가능

**문제점**:
```
❌ [확정] 클릭 → 아무것도 저장 안 됨 (로컬 상태만 변경)
❌ Saturation 실행 → preview 후 폐기되거나 저장 안 됨
```

**리팩토링 필요** 🔴:
```
[ 현재 ]
onClick → useState 업데이트 → preview UI 변경

[ 변경할 것 ]
onClick → useTransition → POST API → 서버 저장 → UI 반영
```

**⚠️ 주의 — 다음은 변경하지 말 것**:
- ✅ 매트릭스 레이아웃 (기업×슬롯)
- ✅ Forced Fill / Saturation 2가지 모드 (유지)
- ✅ 필터 (날짜, 시간대, 토글) (유지)
- ✅ ?target=organizationId 쿼리스트링 (유지)

**API 계약** (새로 추가):
```typescript
// Forced Fill 저장
POST /api/organizer/assignments
{ meetingId, targetOrganizationId, slotId }
Response: { id, status: "created" }

// Saturation 실행
POST /api/organizer/saturation
{ filters: { date?, time?, minutes? } }
Response: { draftAssignments: [...], count: number }

// Saturation 확정
POST /api/organizer/saturation/confirm
{ draftAssignments: [...] }
Response: { count: number, status: "confirmed" }

// 배정 삭제
DELETE /api/organizer/assignments/{id}
Response: { success: true }
```

**체크리스트**:
- [ ] `app/api/organizer/assignments/route.ts` (POST)
- [ ] `app/api/organizer/saturation/route.ts` (POST)
- [ ] `app/api/organizer/saturation/confirm/route.ts` (POST)
- [ ] `components/organizer/assignment-hub.tsx`:
  - [ ] confirmSingleFill() → POST /assignments
  - [ ] confirmSaturation() → POST /saturation/confirm
  - [ ] useTransition + 낙관적 업데이트
  - [ ] 에러 처리 → toast (Sonner 사용)
- [ ] 삭제 기능 (optional)

---

#### 공용 폼 필드 컴포넌트 추출

**배경**: 폼마다 같은 스타일의 인풋(라벨 + 필수 표시 + 에러 메시지) 마크업이 반복됨.
유지보수를 위해 공용 컴포넌트로 추출한다. (AD-001 RHF 전환 완료 후 진행 — 전환 전에 빼면
RHF 연결 방식이 바뀌면서 두 번 손대게 됨.)

**범위**:
- 라벨 + 필수 별(*) + 인풋 + 필드 에러 메시지를 묶은 공용 필드 컴포넌트
  (`components/ui/` 또는 `components/form/`, shadcn Form 패턴 + RHF Controller 기반)
- AD-001 폼 필드를 공용 컴포넌트로 교체
- 이후 MY-002(회의록)·EX-002(전시자 지원) 폼에서 재사용 (Phase 3)

**체크리스트** (2026-07-06 완료):
- [x] 공용 폼 필드 컴포넌트 작성 — `components/form/field-controls.tsx`(부품) + `rhf-fields.tsx`(RHF 래퍼)
- [x] AD-001 각 스텝 필드 교체 (UX 변화 없음 — 기존 컴포넌트 테스트 무수정 통과)
- [x] EX-002 인라인 부품(Field/ChipMultiSelect/NativeSelect) → 공용 위 얇은 어댑터로 교체
- [x] 스타일은 design.md 토큰 준수 (에러 빨강 12px 등 기존과 동일)
- 원칙: **공통으로 할 수 있는 것만 공통** — 마크업/스타일 부품은 공용, 폼별 시맨틱(출처 배지·
  undefined 값·네비 정책·저장 계약)은 각 폼의 어댑터/오케스트레이터에 남긴다. 폼 아키텍처
  통일(스텝 프레임 공용화)은 3번째 다단계 폼이 생길 때 재평가.

---

### Phase 3: 중간 (1주) — 🟢 선택사항

#### 기타 개선

| 페이지 | 변경 사항 | 영향도 | 우선순위 |
|--------|---------|--------|---------|
| **AD-001** | 이미지 업로드 (로고, 사진) | 새 필드 추가 | 🟡 중간 |
| **DIS-001** | 클라이언트 검색/필터 | UI 개선 | 🟢 낮음 |
| **MY-001** | 상태별 필터 쿼리스트링 연동 | 기존 동작 | 🟡 중간 |
| **MY-002** | 회의록 작성 폼 | 새 폼 추가 | 🟡 중간 |
| **EX-002** | 전시자 지원 폼 (AD-001과 유사) | 코드 재사용 | 🟡 중간 |

---

## 2️⃣ 페이지별 상세 가이드

### HM-001 (홈) — ✅ 변경 없음

**현재**: 완전히 동작 (읽기 전용)  
**변경 필요**: 없음

---

### AD-001 (지원) — 🔴 Phase 1

[위의 Phase 1 AD-001 참고]

---

### DIS-001 (발견 리스트) — 🟢 변경 없음

**현재**: 조직 리스트 조회 동작 (읽기 전용)  
**변경 필요**: 없음 (향후 검색 UI 개선 가능)

---

### DIS-002 (발견 상세) — 🟢 변경 없음

**현재**: 조직 상세 조회 동작 (읽기 전용)  
**변경 필요**: 없음

---

### MY-001 (미팅 목록) — 🟢 변경 없음

**현재**: 미팅 목록 + 필터/정렬 동작 (읽기 전용)  
**변경 필요**: 없음

---

### MY-002 (미팅 상세) — ✅ 변경 없음 (2026-07-06 실사 결과)

**현재**: 회의록은 이미 3단계 위저드(ReviewFlow)로 구현돼 있음 — intake(진행/만족도) →
compose(직접 입력 또는 음성→AI 구조화) → done. 클라이언트 seam(`lib/review/` mock/http 스왑,
`NEXT_PUBLIC_REVIEW_API_BASE`)까지 완비. 아래의 기존 계획(단순 memo 폼 + POST /memo)은
구현 이전에 쓰인 것으로 **실코드와 불일치 — 폐기**.

실제 API 계약: `/meetings/{id}/review` 하위 (step1, step2/structure, step2/transcribe,
export 등 — `lib/review/http-review-client.ts` 참조). RHF 전환은 이득 대비 회귀 리스크가
커서 하지 않는다(순수 검증 함수 `lib/review/review-step.ts`가 이미 테스트로 고정됨).

---

### WL-001 (웰컴) — 🟡 Phase 1 후

**현재**: 상태 표시만  
**필요**: [지원하기] 클릭 → 최종 제출

**API**:
```typescript
POST /api/buyer-apply
{ profileKey }
Response: { applicationStatus: "applied" }
```

---

### PR-001 (프로필) — 🟢 변경 없음

**현재**: 개인정보 조회 (읽기 전용)  
**변경 필요**: 없음 (향후 수정 폼 추가 가능)

---

### LG-001 (로그인) — ✅ 변경 없음

**현재**: mock 계정 선택 동작  
**변경 필요**: 없음

---

### NF-001 (알림) — 🟢 변경 없음

**현재**: 알림 조회 (읽기 전용)  
**변경 필요**: 없음

---

### OP-001 (운영 대시보드) — ✅ 변경 없음

**현재**: 요약 카드 + 일정 조회 (읽기 전용)  
**변경 필요**: 없음

---

### OP-002 (참가기업 관리) — 🟢 변경 없음

**현재**: 기업 리스트 조회 (읽기 전용)  
**변경 필요**: 없음

---

### OP-003 (기업 상세) — 🟡 Phase 2

**현재**: 상세 조회 (읽기 전용)  
**필요**: 상태 변경, 배정 (쓰기 기능)

**API**:
```typescript
PATCH /api/organizer/members/{id}/status
{ status: "approved" | "rejected" }

POST /api/organizer/assignments
{ organizationId, targetId, slotId }
```

---

### OP-005 (강제 배정) — 🔴 Phase 2

[위의 Phase 2 OP-005 참고]

---

### EX-001 (전시자 프로필) — ✅ 변경 없음

**현재**: 프로필 조회 (읽기 전용)  
**변경 필요**: 없음

---

### EX-002 (전시자 지원) — 🟡 Phase 3 (2026-07-06 실사: 폼은 이미 구현됨)

**현재**: 5단계 폼(`components/exhibitor/apply-form.tsx`) 완전 구현 — useState + 순수 검증
(`lib/bm/profile-form-state.ts`) + 클라이언트 seam(`lib/bm/exhibitor-client.ts`, mock/http 스왑).
"미구현"이라는 기존 기술은 낡음 — 폐기.

**완료(2026-07-06)**: `lib/bm/schemas.ts` — isStepComplete와 동등한 Zod 스키마 + 동등성 테스트
(`lib/bm/schemas.test.ts`). **잔여**: 폼 본체 RHF 전환은 Phase 2 "공용 폼 필드 컴포넌트"와
함께 진행(1,245줄 단일 파일 — 컴포넌트 테스트 없이 단독 전환은 고위험).

---

## 3️⃣ 전체 리팩토링 체크리스트

### Phase 1: 폼 & 검증 (2주)

**의존성 추가**:
- [ ] `npm install react-hook-form@^7 zod@^3`

**AD-001 폼 전환**:
- [ ] `lib/apply/schemas.ts` (Zod 스키마 작성)
  - [ ] StepBasicInfoSchema
  - [ ] StepInterestsSchema
- [ ] `components/apply/apply-form.tsx` (RHF 전환)
  - [ ] useForm 초기화
  - [ ] register, handleSubmit, formState 연결
  - [ ] 에러 메시지 필드별 표시
- [ ] `lib/apply/form-actions.ts` (서버 액션 또는 API)
  - [ ] saveStep(step, draft) → POST /api/buyer-profile
  - [ ] 에러 처리 (409 conflict 등)

**WL-001 제출 액션**:
- [ ] `app/api/buyer-apply/route.ts` (POST)
  - [ ] applicationStatus 업데이트
  - [ ] 응답 422 (validation fail) 처리

**테스트**:
- [ ] `/apply` 진입 → 폼 로드
- [ ] `/apply?step=2` 직접 진입 (1단계 미완료 시 1단계로 reset)
- [ ] 필드 입력 → 에러 표시
- [ ] [저장 및 다음] → 서버 저장 → 다음 단계
- [ ] 새 탭에서 `/apply` 진입 → draft 복구
- [ ] [제출하기] → /welcome → [지원하기] → 완료

---

### Phase 2: 쓰기 API (2주)

**OP-005 배정 API** (2026-07-06 완료):
- [x] POST /api/organizer/assignments (Forced Fill — `{ meetings: AssignmentMeeting[] }` 벌크, 문서 초안과 body 다름)
- [x] POST /api/organizer/saturation (Saturation 실행 — Draft를 서버에서 계산해 반환)
- [x] POST /api/organizer/saturation/confirm (Saturation 확정)
- [x] DELETE /api/organizer/assignments/{id} (배정 삭제 — 계약만, UI 동선은 TBD-4)

**OP-003 상태 변경** (2026-07-06 완료):
- [x] PATCH /api/organizer/members/{id}/status (master 전용, approved·rejected·changes_requested만)
  - 연결 지점은 member-detail이 아니라 **OP-002 MembersTable 승인 심사 모달** — 상태 변경 UI가 원래 거기 있음

**OP-005 컴포넌트 업데이트** (2026-07-06 완료):
- [x] `components/organizer/assignment-hub.tsx`
  - [x] assignForced()/confirmSingleFill() → 낙관적 업데이트 + POST /assignments + 실패 롤백
  - [x] runSaturation() → useTransition + POST /saturation (서버 계산)
  - [x] confirmSaturation() → 낙관적 + POST /saturation/confirm + 실패 시 롤백·Draft 검토 상태 복원
  - [x] 에러 처리 → Sonner toast
- [x] 새로고침 후 유지 — serverApiClient.getAssignmentSchedule/getMembers가 서버 store 병합

**테스트**:
- [ ] 매트릭스 [빈] 셀 선택 → 우측 패널 활성화
- [ ] 상대 기업 선택 → [확정] → API 호출 → 매트릭스 반영
- [ ] [자동배정] 클릭 → 로딩 → preview → [확정] → API 호출
- [ ] 새로고침 → 변경사항 유지

---

### Phase 3: 추가 기능 (1주)

**MY-002 회의록**:
- [ ] 폼 (RHF+Zod)
- [ ] POST /api/meetings/{id}/memo

**선택사항**:
- [ ] AD-001 이미지 필드
- [ ] DIS-001 검색 UI
- [ ] EX-002 지원 폼

---

## 4️⃣ 주의사항

### ⚠️ Breaking Changes 방지

**절대 하지 말 것**:
1. ❌ 라우트 변경 (`/apply` → `/form/apply` 등)
2. ❌ 컴포넌트 이름 변경 (기존 import 깨짐)
3. ❌ props 인터페이스 변경 (상위 컴포넌트 영향)
4. ❌ Frontmatter type 변경 (쿼리스트링 해석 실패)
5. ❌ 상태값 변경 (confirmed → CONFIRMED 등)

**안전하게 변경**:
- ✅ 내부 구현 (useState → useForm)
- ✅ 스타일 (className 수정)
- ✅ 에러 처리 (새 try-catch 추가)
- ✅ API 라우트 추가 (기존 API 유지)

---

### 💾 API 설계 원칙

**요청**:
```typescript
// 명확한 body
{ step: 1, draft: { organizationNameKo: "...", ... } }

// 명확한 쿼리 (없으면 path param)
?step=1  // O
?s=1     // X
```

**응답**:
```typescript
// 성공
{ success: true, draft: {...} }

// 실패
{ success: false, error: "validation_failed", details: {...} }

// 에러 HTTP code
400 (bad request)
422 (validation error)
409 (conflict)
500 (server error)
```

---

### 🧪 테스트 우선순위

1. ✅ **주요 플로우** (AD-001 폼 → WL-001 제출)
2. ✅ **엣지 케이스** (없는 draft, validation fail, 네트워크 에러)
3. ✅ **통합** (여러 페이지 이동, 상태 유지)

**모바일 테스트**: 마지막에 (UI 개선)

---

## 5️⃣ 리팩토링 후 확인 사항

### 체크리스트

**기능 검증**:
- [ ] 모든 라우트 동작 (직접 진입 + 버튼 클릭)
- [ ] 폼 validation 메시지 표시
- [ ] API 에러 처리 (toast 메시지)
- [ ] draft 저장 & 복구
- [ ] 새 탭 진입 → 상태 유지
- [ ] 로그아웃 후 재로그인 → 이전 상태 복구

**code.spec 동기화**:
- [ ] design.spec.shared.md의 TBD 항목 정리
- [ ] API 계약 최종 확인
- [ ] 새 에러 타입 추가 (필요시)

---

## 📞 궁금한 점?

각 Phase의 **API 세부사항**은 해당 `page.spec.md`의 TBD 섹션 참고.
