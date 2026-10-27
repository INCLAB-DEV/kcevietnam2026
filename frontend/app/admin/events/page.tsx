import { redirect } from "next/navigation"
import { AdminShell, resolveAdminContext } from "@/components/admin/admin-shell"
import { EventsConsole } from "@/components/admin/events-console"
import { getEventSettingsSafe } from "@/lib/admin/server"
import type { AdminEventSettings } from "@/lib/admin/types"

export const dynamic = "force-dynamic"

// 행사 관리 — 멀티 행사 운영의 근간. 여기서 만든 행사가 상단 스위처에 뜨고, 각 행사가 자기
// 데이터(기업·미팅·알림·통역사)와 정책을 갖는다.
//
// 이 화면만은 "선택된 행사"에 스코프되지 않는다 — 행사 목록 전체를 다루는 자리이기 때문이다.
export default async function AdminEventsPage() {
  const resolved = await resolveAdminContext()
  if (!resolved.ok) redirect(resolved.redirectTo)
  const { event, access } = resolved.ctx
  const { events } = resolved

  // 카드에 정책을 함께 보이려면 행사별 설정이 필요하다. 실연동에서 행사 수가 늘면
  // 백엔드에 목록+설정 조인 응답을 요청하거나, 카드 진입 시 lazy-fetch로 바꾼다.
  // getEventSettingsSafe: 개별 행사 조회 실패(403 등)가 Promise.all 전체를 reject시켜 페이지를
  // 통째로 500 내리지 않도록 감싼 버전 — 실패한 행사는 이 배열에서 null로 남고 아래에서 스킵된다.
  const settingsList = await Promise.all(
    events.map((e) => getEventSettingsSafe(e.id)),
  )
  const settingsByEvent: Record<string, AdminEventSettings> = {}
  events.forEach((e, i) => {
    const s = settingsList[i]
    if (s) settingsByEvent[e.id] = s
  })

  return (
    <AdminShell
      title="행사 관리"
      description={`등록된 행사 ${events.length}개. 행사를 추가하면 상단 스위처에서 전환해 관리할 수 있습니다.`}
    >
      <EventsConsole
        events={events}
        settingsByEvent={settingsByEvent}
        selectedEventId={event.id}
        readOnly={!access.canWrite}
      />
    </AdminShell>
  )
}
