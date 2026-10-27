import { AdminConsoleLayout } from "@/components/admin/admin-shell"
import { ConsoleIntlProvider } from "@/components/operator/console-intl-provider"

// 관리자 콘솔(/admin/*) 공용 크롬 — 사이드바·헤더·도움말을 레이아웃이 소유한다(components/admin/admin-shell
// 참고). 페이지 읽기가 던지면 같은 세그먼트의 error.tsx가 본문만 대체하므로 nav·로그아웃이 남는다.
// 접근·행사 해석(resolveAdminContext)의 리다이렉트(행사 없음·비운영자)는 레이아웃에서도 그대로 일어난다.
//
// 콘솔은 한국어 전용이다 — 크롬과 본문 전체를 ko 고정 provider로 감싼다(ConsoleIntlProvider). 본문은
// 하드코딩 한국어지만 도움말 패널·명단 업로드 다이얼로그·다이얼로그 닫기 라벨·테마 토글 같은 공용 조각은
// next-intl을 쓴다. 그 조각들이 NEXT_LOCALE 쿠키(en)를 따라 영어로 바뀌어 섞이던 것을 막는다.
export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <ConsoleIntlProvider>
      <AdminConsoleLayout>{children}</AdminConsoleLayout>
    </ConsoleIntlProvider>
  )
}
