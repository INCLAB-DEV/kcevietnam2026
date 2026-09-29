"use client"

import { usePathname } from "next/navigation"
import Link from "next/link"
import { ArrowLeftRight, Building2, Eye, Mail, ShieldAlert } from "lucide-react"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  SidebarSeparator,
  SidebarTrigger,
} from "@/components/ui/sidebar"
import { Badge } from "@/components/ui/badge"
import { ThemeToggle } from "@/components/layout/theme-toggle"
import { LogoutButton } from "@/components/auth/logout-button"
import { adminNavItemsFor, isActiveAdminNav } from "./admin-nav"
import { EventSwitcher } from "./event-switcher"
import type { AdminEvent } from "@/lib/admin/types"

export interface AdminSidebarUser {
  name: string
  affiliation: string
  email: string
}

// 슈퍼어드민 콘솔 전용 사이드바. 서비스 화면의 AppSidebar와 같은 shadcn 프리미티브·토큰을 쓰되
// 별도 컴포넌트로 둔다 — 항목 구성(7섹션)·행사 스위처·권한 배지가 서비스 nav와 성격이 다르고,
// 기존 nav를 건드리지 않기 위해서다.
//
// readOnly(서브어드민 = sub)면 master 전용 화면(미팅 배정·운영자 관리)과 "행사 운영" 교차 링크를 숨긴다
// (2026-09-17). 교차 링크는 master의 두 콘솔 왕복 동선이고, sub의 착지점은 로그인 분기가 정한다.
export function AdminSidebar({
  user,
  events,
  selectedEvent,
  readOnly,
}: {
  user: AdminSidebarUser
  events: AdminEvent[]
  selectedEvent: AdminEvent
  readOnly: boolean
}) {
  const pathname = usePathname()

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="gap-3 px-3 py-3 group-data-[collapsible=icon]:px-2">
        <div className="flex items-center justify-between gap-2 group-data-[collapsible=icon]:justify-center">
          <span className="flex min-w-0 items-center gap-2 group-data-[collapsible=icon]:hidden">
            <span className="text-base font-semibold tracking-tight">NABI</span>
            <Badge variant="outline" className="shrink-0 text-[10px]">
              Admin
            </Badge>
          </span>
          <SidebarTrigger />
        </div>
        {/* 행사 스위처 — 접힘(아이콘 레일)에선 폭이 안 나오므로 숨긴다. 헤더에도 같은 스위처가 있어
            접은 상태에서도 행사를 바꿀 수 있다. */}
        <div className="group-data-[collapsible=icon]:hidden">
          <EventSwitcher events={events} selected={selectedEvent} />
        </div>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>시스템 관리</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {adminNavItemsFor(!readOnly).map((item) => {
                const active = isActiveAdminNav(pathname, item.href)
                return (
                  <SidebarMenuItem key={item.href}>
                    <SidebarMenuButton asChild isActive={active} tooltip={item.label}>
                      <a href={item.href} aria-current={active ? "page" : undefined}>
                        <item.icon />
                        <span>{item.label}</span>
                      </a>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                )
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

      </SidebarContent>

      <SidebarSeparator />
      <SidebarFooter className="gap-2">
        {!readOnly && (
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton asChild tooltip="행사 운영">
                <Link href="/organizer">
                  <ArrowLeftRight />
                  <span>행사 운영</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        )}
        <div className="space-y-1 px-2 py-1 group-data-[collapsible=icon]:hidden">
          <p className="flex items-center gap-1.5 text-xs font-medium text-sidebar-foreground">
            {readOnly ? <Eye className="size-3 shrink-0" /> : <ShieldAlert className="size-3 shrink-0" />}
            <span className="truncate">{user.name}</span>
            <Badge variant={readOnly ? "outline" : "secondary"} className="ml-auto text-[10px]">
              {readOnly ? "서브어드민" : "슈퍼어드민"}
            </Badge>
          </p>
          {/* 실세션에서 백엔드가 소속·이메일을 못 주면 그 줄을 통째로 숨긴다 — 아이콘만 남은 빈
              줄을 그리거나 목업 값으로 채우지 않는다(app-sidebar의 신원 블록과 같은 규칙). */}
          {user.affiliation && (
            <div className="flex items-center gap-1.5 text-xs text-sidebar-foreground/60">
              <Building2 className="size-3 shrink-0" />
              <span className="truncate">{user.affiliation}</span>
            </div>
          )}
          {user.email && (
            <div className="flex items-center gap-1.5 text-xs text-sidebar-foreground/60">
              <Mail className="size-3 shrink-0" />
              <span className="truncate">{user.email}</span>
            </div>
          )}
        </div>
        {/* 화면 밝기 토글 — 서비스 nav(AppSidebar)와 같은 자리·같은 컨트롤. 언어 토글은 여기 두지
            않는다: 어드민 콘솔 문구는 아직 i18n 카탈로그가 아니라 하드코딩 한국어라, 토글을 노출하면
            눌러도 아무것도 안 바뀌는 죽은 컨트롤이 된다. 접힘(아이콘 레일)에선 폭이 부족해 숨긴다. */}
        <div className="flex flex-wrap items-center justify-center gap-1.5 px-2 py-1 group-data-[collapsible=icon]:hidden">
          <ThemeToggle />
        </div>
        <LogoutButton className="w-full justify-start gap-2 group-data-[collapsible=icon]:size-8 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-2 group-data-[collapsible=icon]:[&>span]:hidden" />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}
