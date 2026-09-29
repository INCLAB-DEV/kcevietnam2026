---
title: Phase 2·3 작업 보고 — OP-005 배정 쓰기 · OP-003 상태 변경 · EX-002 스키마 · MY-002 실사
date: 2026-07-06
scope: OP-005(강제 배정), OP-003(기업 상세/상태), EX-002(전시자 지원), MY-002(회의록)
status: 완료 (Phase 2 전체 + Phase 3 중 실질 필요분)
previous: 2026-07-06-phase1-ad001-wl001.md
---

# Phase 2·3 작업 보고

## 요약

"모든 페이지 적용" 요청의 실범위 = 쓰기 기능이 필요한 나머지 4개 도메인.
읽기 전용 페이지들(HM/DIS/MY-001/PR/LG/NF/OP-001/EX-001)은 REFACTORING.md 지침대로 무변경.

| 도메인 | 결과 |
|--------|------|
| OP-005 강제 배정 | ✅ API 4개 + useTransition/낙관적 업데이트/롤백 — [확정]이 이제 실제 저장됨 |
| OP-003 상태 변경 | ✅ PATCH API + 승인 심사 모달 연결 — 새로고침 후 유지 |
| EX-002 전시자 지원 | ✅ Zod 스키마 + 동등성 테스트 (폼 본체는 이미 구현돼 있었음) |
| MY-002 회의록 | ✅ 변경 없음 — 실사 결과 이미 문서 계획보다 앞선 구현 완비 |

전체 **580 테스트 통과** (기존 575 + EX-002 동등성 5), tsc/eslint 클린, 라우트 스모크 전부 통과.

## 1. OP-005 — 강제 배정 쓰기 (Phase 2 핵심)

**문제**: [확정] 클릭이 로컬 useState만 바꿈 — 새로고침하면 증발.

**새 파일**:
| 파일 | 역할 |
|------|------|
| `app/api/organizer/assignments/route.ts` | POST — 강제 배정·단일 일괄배정 확정분 저장 |
| `app/api/organizer/assignments/[assignmentId]/route.ts` | DELETE — 계약만 (UI 동선은 spec TBD-4) |
| `app/api/organizer/saturation/route.ts` | POST — **Draft를 서버에서 계산**해 반환 (미발효) |
| `app/api/organizer/saturation/confirm/route.ts` | POST — Draft 발효 |
| `lib/organizer/assignment-store.ts` | 서버 메모리 store (확정분, 추가 전용) |
| `lib/organizer/assignment-schemas.ts` | 요청 검증 Zod (라우트 공유) |
| `lib/organizer/assignment-actions.ts` | 클라 fetcher (실패를 결과로 반환 — 호출측이 롤백 결정) |

**`assignment-hub.tsx` 변경** (export/props/레이아웃 무변경):
- `assignForced`/`confirmSingleFill`: 낙관적 반영 → POST → 실패 시 해당 id 롤백 + 에러 toast
- `runSaturation`: 클라 로컬 계산 → **서버 계산으로 이동** (useTransition, 버튼 "실행 중..." 표시).
  실 배정 엔진이 backend 소관(ADR-0006 #53)이라 계산 위치를 서버로 옮겨 그 자리를 예약
- `confirmSaturation`: 낙관적 발효 → POST → 실패 시 롤백 + **Draft 검토 상태 복원** (검토 작업 보존)
- 계산 결정성 확인함(라이브러리에 랜덤/시각 의존 없음) — 서버/클라 결과 동일. `now`는 클라가
  보내서 분 단위 어긋남 방지 (dev `?now=` 오버라이드 정합)

**새로고침 유지**: `serverApiClient.getAssignmentSchedule()`이 mock 픽스처 + store를 병합 (id 충돌은 픽스처 우선).

**문서와 다른 점**: REFACTORING.md 초안 body(`{ meetingId, targetOrganizationId, slotId }`)로는
도메인 타입(AssignmentMeeting — exhibitorId/buyerId/status/matchingType...)을 저장 못 함 →
`{ meetings: AssignmentMeeting[] }` 벌크로 구현. 백엔드 협의 시 이 형태 기준으로.

## 2. OP-003 — 참가기업 상태 변경

**탐사 결과 (문서와 다름)**: member-detail(OP-003)에는 상태 변경 UI가 아예 없음. 실제 승인/반려/
수정요청은 **OP-002 MembersTable의 승인 심사 모달**에 이미 존재(in-memory). 기능 보존 원칙에
따라 새 UI를 만들지 않고 기존 모달을 영속화.

**새 파일**: `app/api/organizer/members/[memberId]/status/route.ts` (PATCH),
`lib/organizer/member-status-store.ts`, `lib/organizer/member-actions.ts`

**가드**: 운영자 master 전용 — sub(무역관)는 403 `forbidden_sub` (ADR-0012, spec §6.1).
허용 상태는 운영 결정 3종(`approved`/`rejected`/`changes_requested`)만 — registered/submitted
전이는 참가측 제출 플로우 소관이라 422.

**연결**: `members-table.tsx` `decide()` — 낙관적 반영 유지 + PATCH 미러, 실패 시 toast만
(비차단). 롤백 없음: 목업 단계에선 인메모리 오버라이드가 원래 소스고, 롤백을 넣으면 기존
테스트(모달 승인 → 배지 즉시 전환 단언)가 깨짐. **기존 테스트 28개 무수정 통과.**

**새로고침 유지**: `getMembers`/`getMember`가 status 오버라이드 병합.

**spec 불일치 발견**: op-003 spec은 상태 enum을 3종(registered/approved/rejected)으로, 메서드를
POST와 PATCH로 엇갈리게 기술 — 실코드는 5종 enum + 이번 구현은 PATCH. spec 정리 필요.

## 3. EX-002 — 전시자 지원 폼

**탐사 결과**: "미구현"이라던 문서와 달리 **5단계 폼 완전 구현** 상태 (1,245줄 단일 파일,
useState + 순수 검증 + mock/http 클라이언트 seam). REFACTORING.md 해당 절 현행화함.

**작업**: `lib/bm/schemas.ts` — `isStepComplete()`와 동등한 단계별 Zod 스키마
(StepBasic/StepIntro/StepProducts/StepTarget + `EXHIBITOR_STEP_SCHEMAS` 맵) +
`lib/bm/schemas.test.ts` 동등성 테스트 5건 (빈/완성/필드별 결손/제품 조합/D4 사업자번호 비게이트).

**RHF 전환 안 한 이유**: 컴포넌트 테스트가 없는 1,245줄 폼 — 단독 전환 고위험. Phase 2
"공용 폼 필드 컴포넌트" 작업에서 AD-001과 함께 필드 단위로 전환 (스키마는 이번에 준비 완료).

## 4. MY-002 — 회의록 (변경 없음)

문서 계획(단순 memo 폼 + `POST /api/meetings/{id}/memo`)은 구현 전 초안. 실코드는 이미:
- 3단계 위저드 `ReviewFlow` (intake → compose[직접입력/음성→AI 구조화] → done)
- `/meetings/{id}/review/*` API 계약 + mock/http 클라이언트 스왑 (`NEXT_PUBLIC_REVIEW_API_BASE`)
- 순수 검증(`lib/review/review-step.ts`) 테스트 고정

리팩토링 목표(폼+검증+API seam)를 이미 초과 달성 — 손대면 회귀 리스크만. REFACTORING.md
해당 절을 "변경 없음"으로 현행화.

## 5. 검증

- `vitest run` — **63 파일 / 580 테스트 전부 통과** (수정한 기존 테스트: 0개)
- `tsc --noEmit` / `eslint` 클린
- 라우트 스모크 (dev 서버 + curl):
  - assignments POST 200 / buyer 403 / 형태 오류 422 / DELETE 200 → 재삭제 404
  - saturation POST 200 (서버가 실제 Draft 계산해 반환) / confirm 200
  - members status PATCH 200 → getMembers 반영 / sub 403 / 없는 id 404 / submitted 전이 422

## 6. 잔여 / 후속

- [ ] Phase 2 "공용 폼 필드 컴포넌트" — AD-001·EX-002 RHF 필드 전환의 선행 작업 (스키마는 양쪽 준비됨)
- [ ] OP-005 확정 배정 삭제 UI (DELETE 라우트는 준비됨, spec TBD-4)
- [ ] spec 문서 3건 실코드 동기화: ad-001(필수 필드), op-003(enum·메서드), my-002/ex-002(전면)
- [ ] Phase 1 잔여: GET /api/buyer-profile → localStorage 제거, yarn.lock 삭제
- [ ] 커밋 분리 권장: ①Phase1(AD-001/WL-001) ②OP-005 ③OP-003 ④EX-002 스키마 ⑤문서
