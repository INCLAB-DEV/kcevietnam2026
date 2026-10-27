"use client"

import { usePathname, useRouter } from "next/navigation"
import { useLocale, useTranslations } from "next-intl"
import {
  Building2,
  Mail,
  Phone,
  LogOut,
  Headset,
  ChevronRight,
  KeyRound,
} from "lucide-react"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  SidebarSeparator,
  SidebarTrigger,
} from "@/components/ui/sidebar"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import {
  SECRETARIAT_CONTACT,
  navItemsFor,
  type UserRole,
} from "@/components/layout/nav"
import { LocaleToggle } from "@/components/layout/locale-toggle"
import { ThemeToggle } from "@/components/layout/theme-toggle"
import { BrandMark } from "@/components/brand/brand-mark"
import { ChangePasswordDialog } from "@/components/auth/change-password-dialog"
import { CURRENT_EVENT } from "@/lib/event/current-event"
import { DEFAULT_PARTICIPANT_MENU, type ParticipantMenu } from "@/lib/event/participant-menu"
import { resolveLocale } from "@/lib/i18n/config"
// 세션/뮤테이션 클라이언트(클라 안전) — 읽기 어댑터는 server-only라 클라가 import할 수 없다(ADR-0001).
import { sessionApiClient } from "@/lib/api-client/session"
import { useUnreadCount } from "@/lib/notifications/use-notifications"
import type { PermissionLevel } from "@/lib/mock/session"

// 실 세션(lib/auth/sidebar-user.ts)은 값을 통째로 못 받는 필드가 있을 수 있다(백엔드 롤아웃
// 중·미제공) — null이면 그 줄을 숨긴다(아래 SidebarFooter). mock 세션은 항상 4개 다 채워져 있다.
export interface SidebarUser {
  name: string | null
  affiliation: string | null
  email: string | null
  phone: string | null
}

// 현재 경로가 메뉴 항목에 해당하는지. 대시보드("/")는 정확히 일치할 때만,
// 그 외는 하위 경로(/discover/123 등)도 활성으로 본다.
export function isActiveNav(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/"
  return pathname === href || pathname.startsWith(`${href}/`)
}

interface AppSidebarProps extends React.ComponentProps<typeof Sidebar> {
  role: UserRole
  user: SidebarUser
  orgId?: string // 있으면 알림 항목에 org 안읽음 배지 노출 (NT-001 nav 벨 배지)
  // 실 세션의 실 unread_count(P1-3, app-shell.tsx가 GET /api/notifications로 미리 읽어 내려준다).
  // 있으면 이 값을 그대로 쓰고, 없으면(mock 세션) 기존 클라 mock 스토어(useUnreadCount)를 구독한다.
  unreadOverride?: number
  // 운영자의 이 행사 권한등급(ADR-0012). master가 아니면(sub·미상) 배정·관리자 콘솔 같은 master 전용
  // 항목을 숨긴다(navItemsFor). 참가자 역할은 넘기지 않는다.
  permissionLevel?: PermissionLevel
  // 이 행사의 참가자 메뉴(F-NV-001 D15). "미팅만"이면 참가사·바이어 nav가 미팅 한 항목이 되고
  // (navItemsFor), 프로필 메뉴가 사라진 자리를 메우려고 내 정보 블록에 비밀번호 변경 진입점을 둔다.
  // 생략하면 기본값(DEFAULT_PARTICIPANT_MENU = 미팅만)이다 — 메뉴 5개는 "full"을 넘겼을 때만 나온다.
  // 운영자 역할에는 영향이 없다.
  participantMenu?: ParticipantMenu
}

export function AppSidebar({
  role,
  user,
  orgId,
  unreadOverride,
  permissionLevel,
  participantMenu = DEFAULT_PARTICIPANT_MENU,
  ...props
}: AppSidebarProps) {
  const pathname = usePathname()
  const router = useRouter()
  const items = navItemsFor(role, permissionLevel, participantMenu)
  const t = useTranslations("nav")
  const tc = useTranslations("common")
  const tPassword = useTranslations("changePassword")
  // 비밀번호 변경 진입점은 원래 프로필 화면에만 있다. 프로필 메뉴가 없는 "미팅만" 행사에서는 명단
  // 업로드로 공통 비밀번호를 받은 계정이 그걸 바꿀 길이 없어지므로, 그때만 여기서 같은 다이얼로그를 연다
  // (전체 메뉴 행사는 프로필 화면에 진입점이 있으므로 여기 두지 않는다 — 그 행사의 사이드바는 예전 그대로다).
  const showPasswordChange = role !== "organizer" && participantMenu === "meetings_only"
  // 사무국 기관명 — 행사명(로케일별) + "사무국"/"Secretariat". 문의 버튼의 aria 라벨과 팝오버 머리글이 함께 쓴다.
  const secretariatOrg = t("secretariatOrg", { event: CURRENT_EVENT[resolveLocale(useLocale())].name })

  // dev 계정 컨텍스트는 nabi_dev_as 쿠키로 유지되므로(proxy가 ?as→쿠키 미러) nav 링크는 bare href다.
  // 풀 페이지 이동 후에도 쿠키가 세션을 유지해 운영자가 목록에서 튕기지 않는다.

  // org 안읽음 개수 — nav 벨 배지(count만, 드롭다운 v1 컷).
  // mock 세션은 반응형 스토어 구독(인박스에서 읽음 처리하면 배지가 실시간으로 줄어든다), 실 세션은
  // 서버에서 미리 읽은 unreadOverride를 그대로 쓴다(훅은 규칙상 항상 호출하고 값만 override로 대체).
  const storeUnread = useUnreadCount(orgId)
  const unread = unreadOverride ?? storeUnread

  async function handleLogout() {
    await sessionApiClient.logout()
    router.push("/login")
  }

  // collapsible="icon" — 접으면 사라지지 않고 아이콘 레일로 축소되어, 라벨은 숨되 아이콘으로
  // 계속 이동할 수 있다(F-NV-001 D3). 접힘 시 라벨은 SidebarMenuButton 의 tooltip 으로 호버 노출.
  // 헤더 워드마크·푸터 사용자 상세는 아이콘 레일 폭(3rem)을 넘치므로 접힘에서 숨긴다(모바일 sheet 는 영향 없음).
  return (
    <Sidebar collapsible="icon" {...props}>
      <SidebarHeader className="px-4 py-4 group-data-[collapsible=icon]:px-2">
        {/* 여닫기 토글은 nav(사이드바) 소속 — 접힘 시 브랜드 마크는 숨고 토글만 아이콘 레일에 남는다.
            로고까지 함께 숨기는 이유(산술): 아이콘 레일 SIDEBAR_WIDTH_ICON=3rem(48px)에서 접힘 시
            padding(px-2, 좌우 8px씩=16px)을 빼면 콘텐츠 폭은 32px. 로고(h-6≈24px 높이, 종횡비
            431:537 기준 폭≈19px) + gap-2(8px) + SidebarTrigger(size="icon-sm"=28px) = 55px로
            32px를 넘친다. 그래서 리브랜딩 이전과 동일하게 로고를 포함한 BrandMark 전체를 접힘 시
            숨기고 토글만 남긴다. */}
        <div className="flex items-center justify-between gap-2 group-data-[collapsible=icon]:justify-center">
          <BrandMark
            showWordmark={false}
            logoClassName="h-8"
            sizes="32px"
            className="group-data-[collapsible=icon]:hidden"
          />
          <SidebarTrigger />
        </div>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            {/* data-tour="app-nav": 운영자 대시보드 투어가 관리 메뉴 이동 동선을 가리키는 앵커(스타일 무관). */}
            <SidebarMenu data-tour="app-nav">
              {items.map((item) => (
                <SidebarMenuItem key={item.href}>
                  <SidebarMenuButton
                    asChild
                    isActive={isActiveNav(pathname, item.href)}
                    tooltip={t(item.labelKey)}
                  >
                    <a
                      href={item.href}
                      aria-current={
                        isActiveNav(pathname, item.href) ? "page" : undefined
                      }
                    >
                      <item.icon />
                      <span>{t(item.labelKey)}</span>
                    </a>
                  </SidebarMenuButton>
                  {item.href === "/notifications" && unread > 0 && (
                    <>
                      <SidebarMenuBadge
                        aria-label={t("unreadAria", { count: unread })}
                      >
                        {t("unreadCount", { count: unread })}
                      </SidebarMenuBadge>
                      {/* 접힘(아이콘 레일)에선 숫자 배지가 숨으므로, 아이콘 우상단에 점으로 안읽음을 표시 */}
                      <span
                        aria-hidden
                        className="pointer-events-none absolute top-1.5 right-1.5 hidden size-2 rounded-full bg-primary ring-2 ring-sidebar group-data-[collapsible=icon]:block"
                      />
                    </>
                  )}
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarSeparator />
      <SidebarFooter className="gap-2">
        {/* 사용자 상세 — 접힘(아이콘 레일)에선 숨김, 펼침·모바일 sheet 에선 노출.
            실 세션은 필드별로 null일 수 있다(백엔드 롤아웃 중) — 없는 줄은 통째로 숨긴다. */}
        <div className="space-y-1 px-2 py-1 group-data-[collapsible=icon]:hidden">
          {user.name && (
            <p className="truncate text-xs font-medium text-sidebar-foreground">
              {user.name}
            </p>
          )}
          {user.affiliation && (
            <div className="flex items-center gap-1.5 text-xs text-sidebar-foreground/60">
              <Building2 className="h-3 w-3 shrink-0" />
              <span className="truncate">{user.affiliation}</span>
            </div>
          )}
          {user.email && (
            <div className="flex items-center gap-1.5 text-xs text-sidebar-foreground/60">
              <Mail className="h-3 w-3 shrink-0" />
              <span className="truncate">{user.email}</span>
            </div>
          )}
          {user.phone && (
            <div className="flex items-center gap-1.5 text-xs text-sidebar-foreground/60">
              <Phone className="h-3 w-3 shrink-0" />
              <span className="truncate">{user.phone}</span>
            </div>
          )}
          {/* 비밀번호 변경("미팅만" 행사 한정) — 위 연락처 줄과 같은 크기·색의 텍스트 버튼이라 블록의
              인상을 바꾸지 않는다. 글자는 작아도 누르는 영역은 24px를 확보한다(-my-1 py-1: 줄 간격은
              그대로 두고 위아래로만 넓힌다). 이 블록째로 접힘(아이콘 레일)에서 숨는다. */}
          {showPasswordChange && (
            <ChangePasswordDialog
              trigger={
                <button
                  type="button"
                  className="-my-1 flex w-fit max-w-full items-center gap-1.5 rounded-sm py-1 text-xs text-sidebar-foreground/60 underline-offset-2 outline-none hover:text-sidebar-foreground hover:underline focus-visible:ring-2 focus-visible:ring-sidebar-ring"
                >
                  <KeyRound className="h-3 w-3 shrink-0" />
                  <span className="truncate">{tPassword("trigger")}</span>
                </button>
              }
            />
          )}
        </div>
        {/* 운영사무국 상시 문의 — 참가사·바이어가 어느 화면에서든 사무국에 연락(F-NV-001).
            내 연락처와 나란히 두 블록이 겹쳐 지저분해지지 않도록 한 줄 '문의하기'로 접고,
            누르면 전화·메일을 팝오버로 편다(tel:/mailto:). 운영자(=사무국 본인)에겐 숨긴다.
            접힘(아이콘 레일)에선 헤드셋 아이콘만 남고, 클릭하면 동일 팝오버가 뜬다. */}
        {role !== "organizer" && (
          <>
            <SidebarSeparator className="group-data-[collapsible=icon]:hidden" />
            <SidebarMenu>
              <SidebarMenuItem>
                <Popover>
                  <PopoverTrigger asChild>
                    <SidebarMenuButton
                      aria-label={t("contactSecretariatAria", { org: secretariatOrg })}
                    >
                      <Headset />
                      <span>{t("contactSecretariat")}</span>
                      <ChevronRight className="ml-auto group-data-[collapsible=icon]:hidden" />
                    </SidebarMenuButton>
                  </PopoverTrigger>
                  <PopoverContent side="top" align="start" className="w-64">
                    <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                      <Headset className="h-3.5 w-3.5 shrink-0" />
                      {secretariatOrg}
                    </p>
                    <div className="mt-3 space-y-2">
                      <a
                        href={`tel:${SECRETARIAT_CONTACT.phone}`}
                        className="flex items-center gap-2 text-sm hover:underline"
                      >
                        <Phone className="h-4 w-4 shrink-0 text-muted-foreground" />
                        {SECRETARIAT_CONTACT.phone}
                      </a>
                      <a
                        href={`mailto:${SECRETARIAT_CONTACT.email}`}
                        className="flex items-center gap-2 text-sm hover:underline"
                      >
                        <Mail className="h-4 w-4 shrink-0 text-muted-foreground" />
                        {SECRETARIAT_CONTACT.email}
                      </a>
                    </div>
                  </PopoverContent>
                </Popover>
              </SidebarMenuItem>
            </SidebarMenu>
          </>
        )}
        {/* 언어(KO/EN)·화면 밝기(라이트/다크/시스템) 토글 — 사무국 문의 바로 아래.
            둘은 같은 세그먼트 컨트롤 룩이라 한 줄에 나란히 둔다(폭이 모자라면 flex-wrap으로 접힌다).
            접힘(아이콘 레일)에선 폭이 부족해 숨긴다(펼침·모바일 sheet에서만).
            언어 토글은 참가사·바이어에게만 낸다. 운영자 콘솔은 한국어 고정이라(app/organizer/layout.tsx의
            ConsoleIntlProvider) 눌러도 화면이 바뀌지 않는 죽은 컨트롤이 된다 — 관리자 콘솔 사이드바
            (components/admin/admin-sidebar.tsx)와 같은 규칙이다. 화면 밝기 토글은 모든 역할에 낸다. */}
        <div className="flex flex-wrap items-center justify-center gap-1.5 px-2 py-1 group-data-[collapsible=icon]:hidden">
          {role !== "organizer" && <LocaleToggle />}
          <ThemeToggle />
        </div>
        {/* 로그아웃 — 접힘에선 아이콘만 + 호버 툴팁 */}
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              type="button"
              onClick={handleLogout}
              tooltip={tc("logout")}
            >
              <LogOut />
              <span>{tc("logout")}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}
