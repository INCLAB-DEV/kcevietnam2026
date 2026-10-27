"use client"

// 참가자 메뉴(F-NV-001 D15)를 셸 안쪽 클라이언트 컴포넌트에 내려주는 컨텍스트.
//
// 값은 서버(AppShellForRequest)가 GET /api/me에서 한 번 구해 여기에 넣는다. 사이드바는 prop으로 직접
// 받지만, 셸 깊숙이 있는 화면 조각 — 미팅 화면의 빈 상태 패널, 기업 상세(모달·풀페이지)의 하단 액션,
// 도움말 패널 — 은 서버 페이지와 여러 겹 떨어져 있어 prop으로 꿰면 중간 컴포넌트가 전부 이 값을 알아야
// 한다. 그 조각들이 이 훅으로 읽는다.
//
// provider 밖(셸 없는 단독 화면·격리 렌더·테스트)에서는 기본값(DEFAULT_PARTICIPANT_MENU = 미팅만)이다
// — 프런트의 다른 폴백과 같은 상수를 본다. 전체 메뉴의 화면을 보려면(테스트 포함) 값을 "full"로 명시한
// provider로 감싼다.

import { createContext, useContext } from "react"

import { DEFAULT_PARTICIPANT_MENU, type ParticipantMenu } from "@/lib/event/participant-menu"

const ParticipantMenuContext = createContext<ParticipantMenu>(DEFAULT_PARTICIPANT_MENU)

export function ParticipantMenuProvider({
  value,
  children,
}: {
  value: ParticipantMenu
  children: React.ReactNode
}) {
  return <ParticipantMenuContext.Provider value={value}>{children}</ParticipantMenuContext.Provider>
}

export function useParticipantMenu(): ParticipantMenu {
  return useContext(ParticipantMenuContext)
}
