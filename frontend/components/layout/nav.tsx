import type { ElementType } from "react"
import { Home, Search, CalendarDays, Bell, User, LayoutDashboard, Users, FileText, ShieldCheck } from "lucide-react"
import type { PermissionLevel } from "@/lib/mock/session"
import { DEFAULT_PARTICIPANT_MENU, type ParticipantMenu } from "@/lib/event/participant-menu"

export type UserRole = "buyer" | "exhibitor" | "organizer"

export interface NavItem {
  // messages/*.json의 "nav" 네임스페이스 키 — 소비 측(AppSidebar)이 useTranslations("nav")로 라벨을 뽑는다.
  labelKey: string
  href: string
  icon: ElementType
  // 운영자 중 이 행사의 master에게만 보이는 항목(ADR-0012 거버넌스·관리자 콘솔). sub(무역관)에겐
  // 숨긴다 — 눌러도 master 전용 API 403으로 막히는 화면으로 이끌지 않기 위해서다(2026-09-17).
  masterOnly?: true
  // 행사의 참가자 메뉴가 "미팅만"(기본)일 때도 남는 항목(F-NV-001 D15). 표시가 없는 참가자 항목은 그
  // 행사에서 메뉴에서만 빠진다 — 화면과 API는 그대로라 주소로 들어오면 열린다(숨김이지 차단이 아니다).
  inMeetingsOnlyMenu?: true
}

// 운영사무국 상시 연락처 — 참가사·바이어가 nav 하단에서 언제든 사무국에 문의(F-NV-001).
// 값 단일 소스: 프로토타입(apply/apply-seller)과 동일. 운영자(=사무국 본인)에겐 노출하지 않는다.
// 기관명은 여기 두지 않는다 — 행사명(lib/event/current-event.ts, 로케일별)에 messages의
// nav.secretariatOrg("{event} 사무국" / "{event} Secretariat")를 입혀 화면이 조립한다. 예전엔 국문
// 기관명을 상수로 박아 EN 화면의 문의 팝오버에 한국어가 그대로 남았다(해외 바이어가 읽지 못한다).
// TODO(사무국): 실제 대표번호·이메일 확정 시 교체(현재는 프로토타입과 동일한 placeholder).
export const SECRETARIAT_CONTACT = {
  phone: "02-xxxx-xxxx",
  email: "kcevietnam2026@gmail.com",
} as const

// 역할별 글로벌 nav 항목 — 공통 네비게이션 셸(F-NV-001)의 단일 소스.
// AppSidebar가 이 정의를 소비한다. 라벨 키·순서·역할 분기는 여기 한 곳에서만 관리한다.
// 참가사·바이어의 5개는 **전체 메뉴("full")로 설정한 행사**의 목록이다 — 기본("미팅만")에서는
// inMeetingsOnlyMenu 표시가 있는 항목만 나간다(아래 navItemsFor).
export const NAV_ITEMS: Record<UserRole, NavItem[]> = {
  buyer: [
    { labelKey: "dashboard", href: "/", icon: Home },
    { labelKey: "discover", href: "/discover", icon: Search },
    { labelKey: "meetings", href: "/meetings", icon: CalendarDays, inMeetingsOnlyMenu: true },
    { labelKey: "notifications", href: "/notifications", icon: Bell },
    { labelKey: "profile", href: "/profile", icon: User },
  ],
  exhibitor: [
    { labelKey: "dashboard", href: "/", icon: Home },
    { labelKey: "discover", href: "/discover", icon: Search },
    { labelKey: "meetings", href: "/meetings", icon: CalendarDays, inMeetingsOnlyMenu: true },
    { labelKey: "notifications", href: "/notifications", icon: Bell },
    { labelKey: "profile", href: "/exhibitor/profile", icon: User },
  ],
  // 운영자 알림은 미제공 — 운영자 수신 알림 타입이 정의돼 있지 않다.
  // 배정(일괄·강제)은 거버넌스, 관리자 콘솔 교차 링크는 master 콘솔 동선이라 master 전용이다.
  organizer: [
    { labelKey: "opsDashboard", href: "/organizer", icon: LayoutDashboard },
    { labelKey: "members", href: "/organizer/members", icon: Users },
    { labelKey: "forcedMatching", href: "/organizer/forced-matching", icon: FileText, masterOnly: true },
    { labelKey: "adminConsole", href: "/admin", icon: ShieldCheck, masterOnly: true },
  ],
}

// 역할 + (운영자면) 이 행사의 권한등급 + (참가자면) 이 행사의 참가자 메뉴 → 실제로 노출할 nav 항목.
// 등급을 모르면(undefined) master 전용 항목을 숨긴다 — 최소 권한(default-deny). 참가자 역할엔
// masterOnly 항목이 없어 등급과 무관하게 그대로다.
// 참가자 메뉴가 "미팅만"이면 참가사·바이어에게 미팅 한 항목만 낸다(F-NV-001 D15). 값을 생략하면
// 기본값(DEFAULT_PARTICIPANT_MENU = 미팅만)이다 — 5개 전부는 "full"을 명시했을 때만 나간다.
// 운영자 nav는 이 설정과 무관하다.
export function navItemsFor(
  role: UserRole,
  permissionLevel?: PermissionLevel,
  participantMenu: ParticipantMenu = DEFAULT_PARTICIPANT_MENU,
): NavItem[] {
  const items = NAV_ITEMS[role]
  if (role !== "organizer" && participantMenu === "meetings_only") {
    return items.filter((item) => item.inMeetingsOnlyMenu)
  }
  return permissionLevel === "master" ? items : items.filter((item) => !item.masterOnly)
}
