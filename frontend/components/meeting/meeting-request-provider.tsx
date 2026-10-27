"use client"

import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react"
import { useLocale, useTranslations } from "next-intl"
import { toast } from "sonner"
import { MeetingRequestModal } from "@/components/meeting/meeting-request-modal"
import type { Organization, ViewerRole } from "@/lib/types"
import type { MeetingAvailability } from "@/lib/meeting/types"

export interface OpenMeetingRequestOptions {
  viewerRole: ViewerRole
  // 슬롯·장소·AI 초안. 있으면 그대로 쓰고(풀페이지: 서버에서 미리 읽음), 없으면 lazy-fetch
  // (모달·카드: 미팅 신청을 누르는 순간 route handler로 읽음 — 읽기 seam은 server-only).
  availability?: MeetingAvailability
}

interface MeetingRequestContextValue {
  open: (org: Organization, options: OpenMeetingRequestOptions) => void
  // lazy-fetch 진행 중인 대상 org id(없으면 null) — 트리거 버튼이 자기 것만 disable/loading 표시.
  pendingOrgId: string | null
}

// provider 밖에서 호출돼도 앱이 죽지 않게 no-op 기본값(격리 렌더·테스트 안전).
const MeetingRequestContext = createContext<MeetingRequestContextValue>({
  open: () => {},
  pendingOrgId: null,
})

export function useMeetingRequest() {
  return useContext(MeetingRequestContext)
}

type MeetingRequestState =
  | { kind: "meeting"; org: Organization; availability: MeetingAvailability; viewerRole: ViewerRole }
  | null

// 미팅 신청 모달(F-MT-001)을 띄우는 단일 호스트. 상세(DV-002)·AI 추천 카드(DV-001) 등
// "미팅 신청"을 누르는 모든 곳이 useMeetingRequest().open(org, …)로 같은 모달을 연다.
// 상세 모달의 액션바(OrgDetailProvider 안)도 이 호스트를 쓰므로, 이 provider가 그 상위에 온다.
export function MeetingRequestProvider({ children }: { children: React.ReactNode }) {
  const locale = useLocale()
  const t = useTranslations("meeting.toast")
  const [state, setState] = useState<MeetingRequestState>(null)
  const [pendingOrgId, setPendingOrgId] = useState<string | null>(null)
  // 최신 open만 승자로 인정(레이스 방지): 매 open마다 seq를 올려 이전 in-flight 응답을 stale 처리.
  const reqSeq = useRef(0)
  const abortRef = useRef<AbortController | null>(null)

  const open = useCallback(async (org: Organization, options: OpenMeetingRequestOptions) => {
    // 진행 중이던 fetch 취소 + seq 증가 → 빠른 A→B 클릭에서 A의 늦은 응답이 B를 덮어쓰지 않게 한다.
    abortRef.current?.abort()
    const seq = ++reqSeq.current

    if (options.availability) {
      setPendingOrgId(null)
      setState({ kind: "meeting", org, availability: options.availability, viewerRole: options.viewerRole })
      return
    }

    const controller = new AbortController()
    abortRef.current = controller
    setPendingOrgId(org.id)
    try {
      const res = await fetch(
        `/api/discover/availability?org=${encodeURIComponent(org.id)}&locale=${encodeURIComponent(locale)}`,
        { signal: controller.signal }
      )
      if (seq !== reqSeq.current) return // 더 최신 open이 시작됨 → 이 응답은 버린다
      if (!res.ok) throw new Error(`availability ${res.status}`)
      const availability = (await res.json()) as MeetingAvailability
      if (seq !== reqSeq.current) return
      setState({ kind: "meeting", org, availability, viewerRole: options.viewerRole })
    } catch {
      if (controller.signal.aborted || seq !== reqSeq.current) return // 취소·stale은 조용히 무시
      toast(t("availabilityError"))
    } finally {
      if (seq === reqSeq.current) setPendingOrgId(null)
    }
  }, [locale, t])

  const value = useMemo<MeetingRequestContextValue>(
    () => ({ open, pendingOrgId }),
    [open, pendingOrgId]
  )

  return (
    <MeetingRequestContext.Provider value={value}>
      {children}
      {state?.kind === "meeting" && (
        <MeetingRequestModal
          org={state.org}
          availability={state.availability}
          viewerRole={state.viewerRole}
          open
          onOpenChange={(o) => !o && setState(null)}
        />
      )}
    </MeetingRequestContext.Provider>
  )
}
