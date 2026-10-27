// 참가자 메뉴(F-NV-001 D15) 컨텍스트로 감싸는 테스트 헬퍼.
//
// 실제 화면에서는 셸(AppShell)이 서버에서 구한 값을 ParticipantMenuProvider로 내려준다. provider 없이
// 렌더하면 기본값(미팅만)이라, 전체 메뉴에서만 보이는 것(기업 탐색으로 가는 버튼·기업 상세의 미팅 신청과
// 관심기업 토글·원래 도움말 문구)을 전제하는 테스트는 값을 "full"로 명시해 감싼다:
//
//   render(withParticipantMenu("full", <OrganizationDetail … />))
//
// 기본값의 동작을 보는 테스트는 감싸지 않거나 "meetings_only"를 명시한다.
import type { ReactElement } from "react"

import { ParticipantMenuProvider } from "@/components/layout/participant-menu-provider"
import type { ParticipantMenu } from "@/lib/event/participant-menu"

export function withParticipantMenu(menu: ParticipantMenu, ui: ReactElement): ReactElement {
  return <ParticipantMenuProvider value={menu}>{ui}</ParticipantMenuProvider>
}
