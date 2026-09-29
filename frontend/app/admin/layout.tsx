import { AdminConsoleLayout } from "@/components/admin/admin-shell"

// 관리자 콘솔(/admin/*) 공용 크롬 — 사이드바·헤더·도움말을 레이아웃이 소유한다(components/admin/admin-shell
// 참고). 페이지 읽기가 던지면 같은 세그먼트의 error.tsx가 본문만 대체하므로 nav·로그아웃이 남는다.
// 접근·행사 해석(resolveAdminContext)의 리다이렉트(행사 없음·비운영자)는 레이아웃에서도 그대로 일어난다.
export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return <AdminConsoleLayout>{children}</AdminConsoleLayout>
}
