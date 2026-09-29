import type { ElementType } from "react"
import {
  Bell,
  Building2,
  CalendarCog,
  CalendarDays,
  LayoutDashboard,
  Languages,
  MapPin,
  Settings,
  ShieldCheck,
} from "lucide-react"

// 슈퍼어드민 콘솔의 nav 정의 — 이 콘솔 전용 단일 소스.
// 기존 글로벌 nav(components/layout/nav.tsx)는 참가자·운영자 서비스 화면용이고 손대지 않는다.
// /admin 은 별도 셸(AdminShell)을 쓰므로 항목도 여기서 따로 관리한다.

export interface AdminNavItem {
  label: string
  href: string
  icon: ElementType
  description: string // 사이드바 접힘 시 tooltip · 대시보드 바로가기 설명
  // 거버넌스 화면 — 이 행사의 master(슈퍼어드민)에게만 노출(ADR-0012). 서브어드민(sub)에겐 숨긴다:
  // 화면 데이터 자체가 master 전용 API(배정 그리드·운영자 목록)라 열면 403이다(2026-09-17).
  masterOnly?: true
}

export const ADMIN_NAV_ITEMS: AdminNavItem[] = [
  {
    label: "대시보드",
    href: "/admin",
    icon: LayoutDashboard,
    description: "선택한 행사의 규모·진행 현황 요약",
  },
  {
    label: "기업 관리",
    href: "/admin/organizations",
    icon: Building2,
    description: "참가사·바이어 조회, 신청서 편집·대리작성",
  },
  {
    label: "미팅 관리",
    href: "/admin/meetings",
    icon: CalendarDays,
    description: "전체 미팅 조회와 운영자 취소",
  },
  {
    label: "미팅 배정",
    href: "/admin/forced-matching",
    icon: CalendarDays,
    description: "기업별 슬롯 확인과 미팅 배정",
    masterOnly: true,
  },
  {
    label: "알림 관리",
    href: "/admin/notifications",
    icon: Bell,
    description: "발송 이력 조회와 수동 재발송",
  },
  {
    label: "행사 관리",
    href: "/admin/events",
    icon: CalendarCog,
    description: "행사 생성·수정 (멀티 행사 운영)",
  },
  {
    label: "운영자 관리",
    href: "/admin/organizers",
    icon: ShieldCheck,
    description: "관리자 계정과 권한등급 (서브어드민 부여·회수)",
    masterOnly: true,
  },
  {
    label: "행사 설정",
    href: "/admin/settings",
    icon: Settings,
    description: "미팅 시간 단위·신청기간·정책·불가 시간대",
  },
  {
    label: "통역사 관리",
    href: "/admin/interpreters",
    icon: Languages,
    description: "통역사 등록과 참가기업 배정",
  },
  {
    label: "미팅 장소",
    href: "/admin/venues",
    icon: MapPin,
    description: "매칭존 테이블·비즈니스 룸 등록과 이름 관리",
  },
]

// 권한에 맞춰 노출할 항목 — 거버넌스 쓰기 권한(canWrite = master)이 없으면 masterOnly를 뺀다.
export function adminNavItemsFor(canWrite: boolean): AdminNavItem[] {
  return canWrite ? ADMIN_NAV_ITEMS : ADMIN_NAV_ITEMS.filter((item) => !item.masterOnly)
}

// 현재 경로가 항목에 해당하는지. "/admin"(대시보드)은 정확히 일치할 때만 활성 —
// 하위 경로까지 활성으로 보면 모든 화면에서 대시보드가 켜져 보인다.
export function isActiveAdminNav(pathname: string, href: string): boolean {
  if (href === "/admin") return pathname === "/admin"
  return pathname === href || pathname.startsWith(`${href}/`)
}
