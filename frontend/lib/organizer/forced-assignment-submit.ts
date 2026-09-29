// 강제 배정 저장(POST) 공용 seam — 낙관적으로 이미 화면에 추가된 미팅을 서버에 영속하고, 실패하면
// 롤백 + 에러 토스트를 낸다. 배정 그리드(assignment-hub, OP-005)와 기업 상세(member-detail, OP-003)
// 양쪽에서 강제 배정을 만들 수 있는데, 예전엔 각자 이 저장 로직을 따로 구현하다가 기업 상세 쪽이
// postAssignments 호출 자체를 빠뜨린 로컬 전용 구현으로 남아 "저장한 것처럼 보이지만 배정 탭에는
// 반영 안 됨" 사고가 났다(발주자 QA 3차 지적 #2). 이제 두 화면이 이 함수 하나를 쓴다 — 낙관적
// 반영·성공 후 동기화(router.refresh + refreshAssignmentViews)는 호출부 책임으로 남긴다(화면마다
// 토스트 문구·전환 방식이 달라 그 부분까지 강제로 묶지 않는다).

import { toast } from "sonner"
import type { Dispatch, SetStateAction } from "react"
import { postAssignments } from "./assignment-actions"
import type { AssignmentMeeting } from "./forced-assignment"

// 실패 시 setMeetings로 낙관적으로 넣어둔 meeting을 제거(롤백)하고 false를 돌려준다 — 호출부는
// true일 때만 동기화(router.refresh 등)를 이어간다.
export async function submitForcedAssignment(
  meeting: AssignmentMeeting,
  setMeetings: Dispatch<SetStateAction<AssignmentMeeting[]>>,
): Promise<boolean> {
  const result = await postAssignments([meeting])
  if (!result.success) {
    setMeetings((prev) => prev.filter((x) => x.id !== meeting.id))
    toast.error("배정 저장에 실패했어요", {
      description: "네트워크 확인 후 다시 시도해 주세요.",
    })
    return false
  }
  return true
}
