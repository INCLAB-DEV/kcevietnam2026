// 참가사 프로필 드래프트를 RHF form 위에서 부분 병합/멀티토글하는 공용 배선.
// 작성 폼(apply-form.tsx)과 프로필 섹션 편집(profile-section-edit-dialog.tsx)이 같은 스텝
// 컴포넌트(Step1Basic~Step4Target)를 쓰므로, 그 컴포넌트가 기대하는 patch/toggleIn 계약도 한 곳에
// 둔다 — 두 곳에 베껴두면 shouldDirty·토글 규칙이 갈라진다.
//
// 출처 배지(SourceMap) 해제는 여기 없다 — 작성 폼 고유 관심사(Smart Fill·로스터 프리필)라
// 호출부가 이 헬퍼 위에 얹는다.

import type { UseFormReturn } from "react-hook-form"

import type { ExhibitorProfileDraft } from "@/lib/bm/types"

type DraftForm = UseFormReturn<ExhibitorProfileDraft>

// 드래프트 부분 병합 — 키별 setValue로 반영한다(전체 reset과 달리 다른 필드의 미저장 입력 보존).
export function mergeDraftInto(
  form: DraftForm,
  update: Partial<ExhibitorProfileDraft>
): void {
  for (const key of Object.keys(update) as (keyof ExhibitorProfileDraft)[]) {
    form.setValue(key as never, update[key] as never, { shouldDirty: true })
  }
}

// 목록 필드(사업분야·선호 바이어 등) 칩 토글 — 있으면 빼고 없으면 넣는다(전체 교체 단위).
export function toggleCodeIn<T extends string>(
  form: DraftForm,
  key: keyof ExhibitorProfileDraft,
  code: T
): void {
  const list = (form.getValues(key as never) as T[] | undefined) ?? []
  const next = list.includes(code)
    ? list.filter((c) => c !== code)
    : [...list, code]
  form.setValue(key as never, next as never, { shouldDirty: true })
}
