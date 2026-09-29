import { redirect } from "next/navigation"
import { AppShellForRequest } from "@/components/layout/app-shell"
import { resolveRequestSession } from "@/lib/mock/session-server"
import { resolveHttpSession } from "@/lib/auth/http-session"
import { fetchMe } from "@/lib/auth/me-client"
import { ExhibitorProfileHub } from "@/components/exhibitor/exhibitor-profile-hub"

export const dynamic = "force-dynamic"

// BM-005 참가사 내 프로필 조회 허브 — 저장된 프로필을 작성 폼 4구획대로 읽기전용 표시(조회 전용, 결정 A).
// nav 라우트라 route-guard가 승인+신청기간 종료에만 진입 허용. 프로필 데이터는 클라 클라이언트라
// 클라이언트 자식(ExhibitorProfileHub)이 읽는다 — 서버 페이지는 역할 가드 + orgId 주입만 한다.
//
// 역할 가드는 real 세션이면 로그인 BFF가 심은 역할 쿠키를 따른다(app/meetings/page.tsx와 동일 원칙) —
// resolveRequestSession()은 dev 전환 쿠키(?as=) 기반 mock 세션이라 real 세션에선 기본값(buyer)으로
// 고정돼, 이 보정이 없으면 real exhibitor가 /profile 로 잘못 튕겨나간다.
// 실 세션이면 fetchMe()로 org_event_role_id를 확보해 허브에 내려준다(있으면 실 프로필 배선).
export default async function ExhibitorProfilePage() {
  const session = await resolveRequestSession()
  const realSession = await resolveHttpSession()
  const role = realSession?.role ?? session.role
  if (role === "organizer") redirect("/organizer")
  if (role === "buyer") redirect("/profile")

  const me = realSession ? await fetchMe() : null
  const exhibitorRole = me?.roles.find((r) => r.is_exhibitor) ?? null

  return (
    <AppShellForRequest session={realSession ? undefined : session}>
      <ExhibitorProfileHub
        profileKey={session.orgId}
        orgEventRoleId={exhibitorRole?.org_event_role_id ?? null}
      />
    </AppShellForRequest>
  )
}
