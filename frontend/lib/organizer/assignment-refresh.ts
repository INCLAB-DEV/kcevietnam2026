"use server"

// OP-005 QA B4 — 배정이 바뀐 뒤 관련 화면의 캐시를 한 번에 무효화하는 서버 액션.
// 무효화 대상은 assignment-refresh-paths.ts가 소유한다(왜 이 목록인지도 거기 설명).
//
// "use server" 모듈은 async 함수만 export할 수 있어(Next 규약) 경로 목록은 옆 모듈에 둔다.
// 실패해도 배정 자체는 이미 저장된 뒤라 화면을 막지 않는다 — 호출부가 catch해서 삼킨다.

import { revalidatePath } from "next/cache"
import { ASSIGNMENT_REFRESH_PATHS } from "./assignment-refresh-paths"

export async function refreshAssignmentViews(): Promise<void> {
  for (const { path, type } of ASSIGNMENT_REFRESH_PATHS) {
    if (type) revalidatePath(path, type)
    else revalidatePath(path)
  }
}
