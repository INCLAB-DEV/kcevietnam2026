import { MembersTable } from "@/components/organizer/members-table"
import { serverApiClient } from "@/lib/api-client/server"
import { resolveOrganizerConsoleAccess } from "@/lib/organizer/console-access"

export const dynamic = "force-dynamic"

// OP-002 참가기업 관리 (F-OP-002 / 이슈 #51).
// 크롬(사이드바)은 app/organizer/layout.tsx가 소유한다. 목록은 api-client seam 경유(ADR-0008).
//
// 권한등급(master/sub)의 원천이 두 갈래다(ADR-0012) — 판정은 resolveOrganizerConsoleAccess 한 곳:
//  · 실 운영자 세션 → GET /api/admin/me의 **콘솔 데이터와 같은 행사** 등급(백엔드 권위)
//  · 목업 모드(dev) → ?as=organizer-sub 스위처. 이 dev 쿠키는 resolveOrganizerRequestSession의
//    devCookie() 게이트 뒤에 있어 prod에서는 무시된다(예전엔 여기서 쿠키를 직접 읽어, httpOnly가
//    아닌 nabi_dev_as 한 줄로 prod 화면이 "박무역/KOTRA 프랑크푸르트무역관"으로 바뀌었다).
//
// 실세션에서 등급을 못 받으면(백엔드 조회 실패) **최소 권한(sub)** 으로 그린다(2026-09-17 정정). 예전엔
// master로 올려 그렸는데, 그러면 실제 sub가 심사·참가사 탭 같은 master UI를 보고 누른 뒤 403을 맞는다.
// sub 화면은 바이어 탭만 보이지만 서버가 이미 관할로 좁힌 목록을 그대로 쓰므로 데이터는 틀리지 않는다.
export default async function OrganizerMembersPage() {
  const all = await serverApiClient.getMembers()
  const { realSession: realOperator, session, permissionLevel } = await resolveOrganizerConsoleAccess()

  // sub(무역관) 관할 스코프는 **목업 전용**이다 — 목업 sub 계정은 tradeOffice(등록주체 문자열)로
  // 자기 바이어를 가린다. 실세션에서는 FastAPI가 이미 organizer_id 관할로 스코프해서 내려주므로
  // (app/admin/router.py list_organizations의 jurisdiction) 프론트가 다시 거르지 않는다.
  // MembersTable도 realSession이면 서버에서 이미 적용한 관할을 그대로 따른다.
  const isMockSub = !realOperator && permissionLevel === "sub"
  const members = isMockSub
    ? all.filter((m) => m.tab === "buyer" && m.registeredBy === session.tradeOffice)
    : all
  // 신청서(B층) 본문은 실 세션에서는 여기서 싣지 않는다 — "신청서 조회·심사" 다이얼로그의 패널이 열 때마다
  // 서버에서 그 기업 것만 새로 읽는다(목록과 함께 실려 온 값을 편집 초깃값으로 쓰지 않는다. 기업마다
  // 상세를 왕복하던 N+1도 사라진다). 목업 모드에는 읽어 올 서버가 없어 픽스처를 패널의 시드로 넘긴다.
  const profiles = realOperator ? undefined : await serverApiClient.getMemberProfiles()
  return (
    <div className="mx-auto flex w-full min-w-0 max-w-6xl flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-bold tracking-tight">참가기업 관리</h1>
        <p className="text-sm text-muted-foreground">
          {isMockSub
            ? `${session.tradeOffice} 관할 바이어를 등록·관리합니다.`
            : permissionLevel === "sub"
              ? "내가 관리하는 바이어를 등록·관리합니다."
              : "명단을 조회·정정하고, 비즈매칭 신청서를 승인 심사합니다."}
        </p>
      </header>
      <MembersTable
        realSession={realOperator}
        members={members}
        profiles={profiles}
        permissionLevel={permissionLevel}
        tradeOffice={realOperator ? undefined : session.tradeOffice}
      />
    </div>
  )
}
