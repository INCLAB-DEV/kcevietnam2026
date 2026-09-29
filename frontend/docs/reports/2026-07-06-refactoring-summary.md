---
title: 리팩토링 종합 요약 — 라우트별
date: 2026-07-06
branch: refactor/forms-write-apis
commits: 13
tests: 574 → 589 (전부 통과)
related:
  - 2026-07-06-phase1-ad001-wl001.md
  - 2026-07-06-phase2-3-write-apis.md
  - 2026-07-06-shared-form-fields.md
---

# 리팩토링 종합 요약

읽기 전용 코드를 회사 컨벤션에 맞추는 리팩토링. **기능 보존**(라우트·export 이름·상태 enum·
쿼리스트링 계약 무변경) 전제에서 폼 스택(RHF+Zod) 전환 + 쓰기 API 신설.

- 브랜치: `refactor/forms-write-apis` (커밋 13개, main 미병합)
- 테스트: 574 → **589** 전부 통과 / tsc·eslint 클린 / dev 서버 라우트·렌더 스모크 통과

---

## 1. 라우트별 변경

### `/apply` — AD-001 바이어 지원 폼 🔴 Phase 1

| 항목 | Before | After |
|------|--------|-------|
| 폼 상태 | useState 수동 | React Hook Form (`useForm` control) |
| 검증 | `validateStep()` 순수함수 | Zod 스키마(`lib/apply/schemas.ts`) 정본 위임 |
| 필드 | 인라인 제어 컴포넌트 | 공용 RHF 래퍼(`components/form/rhf-fields`) |
| 저장 | localStorage 직접 | localStorage(복구) + `POST /api/buyer-profile` 비차단 미러 |
| 에러 UX | [다음] 시 필드 에러 | + **첫 오류 필드 포커스** 추가 |

- 신규: `app/api/buyer-profile/route.ts`(부분저장, 빈 값 허용·세션에서 profileKey 도출),
  `lib/apply/form-actions.ts`, `lib/apply/use-buyer-profile.ts`(RSC 경계용 훅 분리)
- 🐛 수정: `STEP_FIELDS[1]`에 `tel` 누락 → 전화번호 저장 유실 버그 + 회귀 테스트

### `/welcome` — WL-001 웰컴 🔴 Phase 1

- 최종 제출을 서버 경유로: `app/api/buyer-apply/route.ts`(POST) — 1~2단계 필수 검증(422),
  submitted/rejected 잠금(409). 서버 성공 시에만 로컬 status 전이.
- `components/welcome/application-actions.tsx` decide 경로 연결.

### `/exhibitor/apply` — EX-002 전시자 지원 폼 🟡 Phase 3

- ① 컴포넌트 테스트 0 → 10개(안전망 선작성) → ② useState → RHF 컨테이너 전환 →
  ③ 인라인 부품(Field/Chip/Select) → 공용 위 얇은 어댑터 → ④ **[다음] 필수 게이트 신설**.
- 게이트 규칙: 미충족 시 이동·저장 차단 + 필드 에러 + 첫 오류 입력 포커스, 입력 시 실시간 해제.
  1단계(읽기 전용·로스터 소관) 검사 제외, 레일 점프·저장하고 나가기는 자유 이동 유지.
- 전시품목은 스키마 집계 이슈("products")를 행별 필수 필드로 되짚어 표시, 유효 제품 0개면
  목록이 오류 앵커.
- 신규 검증 정본: `lib/bm/schemas.ts`(`isStepComplete` 위임).

### `/organizer/forced-matching` — OP-005 강제 배정 🔴 Phase 2

- 문제: [확정]이 로컬 상태만 바꾸고 저장 안 됨 → 새로고침 시 증발.
- 신규 API: `assignments`(POST 벌크 저장 / `[assignmentId]` DELETE), `saturation`(POST — Draft를
  **서버에서 계산**), `saturation/confirm`(POST 발효).
- `assignment-hub.tsx`: useTransition + 낙관적 업데이트 → 실패 시 롤백(포화 확정 실패는 Draft
  검토 상태까지 복원) + Sonner toast.
- `serverApiClient.getAssignmentSchedule`이 mock 픽스처 + store 병합 → 새로고침 유지.

### `/organizer/members` — OP-002/003 참가기업 🟡 Phase 2

- 승인 심사 모달(승인/반려/수정요청)의 결정을 서버 영속: `PATCH /api/organizer/members/{id}/status`
  (master 전용 — sub 403). 상태 변경 UI가 OP-003 상세가 아니라 OP-002 모달에 있어 그쪽에 연결.
- `getMembers`/`getMember`가 status 오버라이드 병합 → 새로고침 유지.

### `/meetings/[meetingId]` — MY-002 회의록 ✅ 변경 없음

- 실사 결과: 이미 3단계 위저드(ReviewFlow) + API seam(`/meetings/{id}/review/*`, mock/http 스왑)
  완비. 문서 계획(단순 memo 폼)이 낡았던 것 — 리팩토링 목표를 이미 초과 달성. 손대지 않음.

### 읽기 전용 — 변경 없음 ✅

`/`(HM-001), `/discover`(DIS-001/002), `/meetings`(MY-001), `/profile`(PR-001),
`/login`(LG-001), `/notifications`(NF-001), `/organizer`(OP-001), `/exhibitor/profile`(EX-001)
— REFACTORING.md 지침대로 무변경.

---

## 2. 횡단(공통) 작업

| 영역 | 내용 |
|------|------|
| 공용 폼 부품 | `components/form/field-controls.tsx`(Field·TextField·Select·Chip 등 + badge 슬롯 + `data-field-error` 앵커 + `focusFirstErrorField`) / `rhf-fields.tsx`(RHF 래퍼). 중복 2벌→1벌 |
| 검증 단일화 | Zod 스키마가 정본. `validateStep`(바이어)·`isStepComplete`(전시자)는 위임 → 형식 검사 강화는 한 곳만 |
| 원칙 | "공통으로 할 수 있는 것만 공통" — 마크업/스타일 부품·검증 스키마는 공용, 폼별 시맨틱(네비 정책·저장 계약·출처 배지)은 각자 |
| 문서 | REFACTORING.md 현행화, spec 4건(ad-001·op-003·my-002·ex-002) 실코드 동기화 |

---

## 3. 발견·수정한 기존 버그

1. **tel 유실** — `STEP_FIELDS[1]`에 `tel` 없어 1단계 부분저장 시 전화번호 증발. API 스모크에서 발견.
2. **RSC 번들 크래시** — store의 `useSyncExternalStore`(클라 전용)를 서버 라우트가 import → 컴파일
   실패. tsc·vitest 통과, dev 서버에서만 노출. `useBuyerProfile` 훅 분리로 해결.
3. **문서 3건 실코드 불일치** — ad-001(필수 필드), op-003(enum 3종↔5종·POST↔PATCH),
   my-002/ex-002(전면). 동기화.

---

## 4. 커밋 목록 (13, 의존 순서)

```
af1398d feat: 폼 [다음] 필수 검증 게이트 — 에러 표시 + 첫 오류 필드 포커스
f51866c refactor: EX-002 폼 상태를 React Hook Form으로 전환
209e70e test: EX-002 참가사 폼 컴포넌트 테스트 (외부 동작 고정)
cc2abb1 refactor: 검증 규칙 정본을 Zod 스키마로 단일화
542ee1a docs: 리팩토링 가이드 현행화 + 작업 보고서 3건
95d06c0 feat: EX-002 단계 검증 Zod 스키마 (isStepComplete 동등성 고정)
a2d4f90 feat: OP-003 참가기업 상태 변경 API + 심사 결정 영속
e3d84be feat: OP-005 배정 쓰기 API + 낙관적 업데이트
f6a2407 refactor: 공용 폼 필드 부품 + RHF 래퍼, AD-001·EX-002 적용
0a00e6a feat: 바이어 draft 서버 저장·최종 제출 API (BM-001/WL-001)
2f50295 feat: AD-001 단계 검증 Zod 스키마 (validateStep 동등성 고정)
ba5966c fix: 1단계 부분저장 시 전화번호(tel) 유실
476db46 chore: react-hook-form·zod·@hookform/resolvers 도입
```

---

## 5. 잔여 (서버/기획 블로킹)

- **FastAPI 연동 시**: `GET /api/buyer-profile`(draft 조회) → localStorage 제거
- **기획 결정 필요**: AD-001 이미지 업로드(TBD), MY-001 필터 쿼리스트링(문서 자기모순),
  OP-005 확정 배정 삭제 UI(DELETE 라우트는 준비됨), email/tel 형식 검사(동작 변경)
- **정리**: `docs/specs/` 등 untracked 문서 커밋 여부(외주 공유 결정), `yarn.lock` 삭제
