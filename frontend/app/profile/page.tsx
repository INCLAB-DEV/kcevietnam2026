import { redirect } from "next/navigation"
import { AppShellForRequest } from "@/components/layout/app-shell"
import { resolveRequestSession } from "@/lib/mock/session-server"
import { resolveHttpSession } from "@/lib/auth/http-session"
import { fetchMe } from "@/lib/auth/me-client"
import { BuyerProfileHub } from "@/components/apply/buyer-profile-hub"

export const dynamic = "force-dynamic"

// BM-004 바이어 내 프로필 조회 허브 — 저장된 신청서를 작성 폼 구획대로 읽기전용 표시(조회 전용, 결정 A).
// nav 라우트라 route-guard가 승인+신청기간 종료에만 진입 허용. 데이터(draft)는 클라 스토어라 클라이언트
// 자식(BuyerProfileHub)이 읽는다 — 서버 페이지는 역할 가드 + 세션(orgId·buyerType) 주입만 한다.
//
// 역할 가드는 real 세션이면 로그인 BFF가 심은 역할 쿠키를 따른다(app/meetings/page.tsx와 동일 원칙,
// app/exhibitor/profile/page.tsx와 대칭) — resolveRequestSession()만으로는 real 세션이 기본값(buyer)
// 으로 고정돼 real exhibitor가 이 화면에 잘못 머무를 수 있다.
// 실 세션이면 fetchMe()로 org_event_role_id를 확보해 허브에 내려준다(있으면 실 프로필 배선).
export default async function ProfilePage() {
  const session = await resolveRequestSession()
  const realSession = await resolveHttpSession()
  const role = realSession?.role ?? session.role
  if (role === "organizer") redirect("/organizer")
  if (role === "exhibitor") redirect("/exhibitor/profile")

  const me = realSession ? await fetchMe() : null
  const buyerRole = me?.roles.find((r) => r.is_buyer) ?? null

  return (
    <AppShellForRequest session={realSession ? undefined : session}>
      <BuyerProfileHub profileKey={session.orgId} orgEventRoleId={buyerRole?.org_event_role_id ?? null} />
    </AppShellForRequest>
  )
}
