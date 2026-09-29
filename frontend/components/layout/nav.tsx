import type { ElementType } from "react"
import { Home, Search, CalendarDays, Bell, User, LayoutDashboard, Users, FileText, ShieldCheck } from "lucide-react"
import type { PermissionLevel } from "@/lib/mock/session"

export type UserRole = "buyer" | "exhibitor" | "organizer"

export interface NavItem {
  // messages/*.json의 "nav" 네임스페이스 키 — 소비 측(AppSidebar)이 useTranslations("nav")로 라벨을 뽑는다.
  labelKey: string
  href: string
  icon: ElementType
  // 운영자 중 이 행사의 master에게만 보이는 항목(ADR-0012 거버넌스·관리자 콘솔). sub(무역관)에겐
  // 숨긴다 — 눌러도 master 전용 API 403으로 막히는 화면으로 이끌지 않기 위해서다(2026-09-17).
  masterOnly?: true
}

// 운영사무국 상시 연락처 — 참가사·바이어가 nav 하단에서 언제든 사무국에 문의(F-NV-001).
// 값 단일 소스: 프로토타입(apply/apply-seller)과 동일. 운영자(=사무국 본인)에겐 노출하지 않는다.
// 기관명은 고유명사라 언어와 무관하게 그대로 노출한다(번역 대상 아님).
// TODO(사무국): 실제 대표번호·이메일 확정 시 교체(현재는 프로토타입과 동일한 placeholder).
export const SECRETARIAT_CONTACT = {
  org: "2026 베트남 K-콘텐츠 엑스포 사무국",
  phone: "02-xxxx-xxxx",
  email: "kcevietnam2026@gmail.com",
} as const

// 역할별 글로벌 nav 항목 — 공통 네비게이션 셸(F-NV-001)의 단일 소스.
// AppSidebar가 이 정의를 소비한다. 라벨 키·순서·역할 분기는 여기 한 곳에서만 관리한다.
export const NAV_ITEMS: Record<UserRole, NavItem[]> = {
  buyer: [
    { labelKey: "dashboard", href: "/", icon: Home },
    { labelKey: "discover", href: "/discover", icon: Search },
    { labelKey: "meetings", href: "/meetings", icon: CalendarDays },
    { labelKey: "notifications", href: "/notifications", icon: Bell },
    { labelKey: "profile", href: "/profile", icon: User },
  ],
  exhibitor: [
    { labelKey: "dashboard", href: "/", icon: Home },
    { labelKey: "discover", href: "/discover", icon: Search },
    { labelKey: "meetings", href: "/meetings", icon: CalendarDays },
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

// 역할 + (운영자면) 이 행사의 권한등급 → 실제로 노출할 nav 항목.
// 등급을 모르면(undefined) master 전용 항목을 숨긴다 — 최소 권한(default-deny). 참가자 역할엔
// masterOnly 항목이 없어 등급과 무관하게 그대로다.
export function navItemsFor(role: UserRole, permissionLevel?: PermissionLevel): NavItem[] {
  const items = NAV_ITEMS[role]
  return permissionLevel === "master" ? items : items.filter((item) => !item.masterOnly)
}
