---
title: 공용 폼 필드 컴포넌트 — "공통으로 할 수 있는 것만 공통"
date: 2026-07-06
scope: components/form/ 신설, AD-001 RHF 필드 전환, EX-002 부품 교체
status: 완료
previous: 2026-07-06-phase2-3-write-apis.md
---

# 공용 폼 필드 리팩토링 보고

## 결정 (사용자 합의)

폼 공용화 3단계(A 부품만 / B 부품+RHF / C 폼 아키텍처 통일) 중 **B** —
원칙은 "**공통으로 할 수 있는 것만 공통**(유지보수 극대화)".

- **공통**: 필드 마크업/스타일 부품(라벨+필수별+에러+힌트+인풋), Zod 스키마(이미 완료)
- **각자**: 네비 정책(바이어=게이트/전시자=자유), 저장 계약(localStorage store/client seam),
  에러 표시 정책(필드별/없음), 폼 고유 표식(출처 배지)
- C(스텝 프레임 통일) 보류 근거: 두 폼의 차이가 뼈대 수준(네비·에러·저장) — 지금 통일하면
  공용 프레임이 분기 옵션 덩어리가 됨. 3번째 다단계 폼 등장 시 재평가 (rule of three).

## 새 구조

```
components/form/                    ← 신설 (모든 폼 공용)
├─ field-controls.tsx               부품: Field(badge 슬롯), TextField, TextAreaField,
│                                   SelectField, ChipMultiSelect, RadioCards, BoolField
│                                   + bare: NativeSelectControl, ChipToggleGroup
└─ rhf-fields.tsx                   RHF useController 래퍼: FormTextField, FormTextAreaField,
                                    FormSelectField, FormChipMultiSelect, FormBoolField

components/apply/field-controls.tsx ← re-export 심만 남김 (기존 import 경로·export 이름 보존)
```

핵심 설계 2가지:
1. **Field에 `badge` 슬롯** — 전시자 폼의 출처 배지(등록정보/AI 초안)를 공용 부품에 폼 도메인을
   넣지 않고 수용.
2. **RHF 래퍼는 에러를 formState가 아니라 부모 prop으로 받음** — "오류는 [다음] 시도 후에만,
   입력하면 실시간 해제" 정책이 오케스트레이터 소유라서. 부품에 표시 정책이 새면 폼마다 다른
   정책을 못 담는다.

## AD-001 (바이어) — RHF 필드 전환

- `steps/step-basic-info.tsx`, `step-interests.tsx`: `draft`/`update` 수동 배선 → `Form*` 래퍼
  (control+name). 칩 토글 로직도 래퍼로 흡수 — 스텝 파일에서 상태 조작 코드 소멸.
- `step-props.ts`: `{ draft, update, errors }` → `{ control, errors }` (내부 계약 — 사용처 전부 함께 변경).
- `apply-form.tsx` 오케스트레이터 단순화: 이전 RHF 전환기에 넣었던 resolver 우회(stepRef)·
  setError/clearErrors 동기화가 전부 사라짐. 에러는 렌더마다 `STEP_SCHEMAS[step].safeParse`로
  **파생** — watch() 리렌더 덕에 "입력 시 실시간 해제"가 코드 없이 성립 (원래 useState 구현과
  같은 파생 상태 패턴, 소스만 validateStep → Zod).

## EX-002 (전시자) — 부품 교체

인라인 부품 3개를 공용 위 **얇은 어댑터**로 교체 (호출부 ~1,100줄 무변경):
- `Field` → SharedField + badge 슬롯 (출처 배지 유지)
- `NativeSelect` → NativeSelectControl + undefined↔"" 값 어댑트 (placeholder 복귀 허용 유지)
- `ChipMultiSelect` → ChipToggleGroup (시각: primary 채움 → near-mono foreground 채움으로 통일
  — design.md 정합 방향, 두 색은 거의 동일한 진회색)

폼 본체(useState·client seam)는 계획대로 안 건드림.

## 검증

- `vitest run` — 63 파일 / **580 테스트 전부 통과** (apply-form 컴포넌트 테스트 무수정 —
  에러 표시·단계 진행·?step 보정 시나리오가 새 필드로 그대로 검증됨)
- `tsc --noEmit` / `eslint` 클린
- dev 서버: `/apply`, `/apply?step=2`, `/exhibitor/apply`, `/welcome` 전부 200, 컴파일 에러 없음

## 효과

- ChipMultiSelect·Field·select 중복 구현 2벌 → 1벌
- 새 폼(MY-002류 제외한 미래 폼)은 `Form*` 래퍼 + Zod 스키마로 필드 코드 최소화
- 다음 단계 후보: `RadioCards`/`BoolField`의 RHF 래퍼는 사용처 생길 때 추가 (지금은 YAGNI)

## 잔여 (변동 없음 — 이전 보고서 §6 참조)

커밋 정리(이제 6묶음), GET /api/buyer-profile, spec 동기화 3건, yarn.lock 삭제.
