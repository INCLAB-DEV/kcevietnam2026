import { TriangleAlert } from "lucide-react"
import { AppShellForRequest } from "@/components/layout/app-shell"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { ConsoleIntlProvider } from "@/components/operator/console-intl-provider"
import { resolveOrganizerConsoleAccess } from "@/lib/organizer/console-access"

// 행사 운영 콘솔(/organizer/*) 공용 크롬 — 사이드바(nav·신원·로그아웃)를 레이아웃이 소유한다.
//
// 예전엔 페이지마다 <AppShellForRequest>로 스스로를 감쌌다. 그 구조에선 페이지의 데이터 읽기가 던지면
// 크롬까지 통째로 사라져, sub 운영자가 사이드바도 로그아웃도 없는 서버 오류 화면에 갇혔다(2026-09-17).
// 레이아웃으로 올리면 같은 세그먼트의 error.tsx가 **페이지만** 대체하므로 nav·로그아웃이 남는다
// (Next error.js: 같은 세그먼트의 layout은 에러 경계 바깥).
//
// ⚠ 이 레이아웃 안에서 던지면 error.tsx가 못 잡는다 — 권한 해석(resolveOrganizerConsoleAccess)과 셸의
//   신원 조회(fetchOperatorMe)는 실패를 값(null·최소 권한)으로 흡수하도록 짜여 있다.
// 운영자 라우트는 ?as와 무관하게 항상 organizer 세션(목업 sub 스위처만 등급을 가른다).
//
// 콘솔은 한국어 전용이다 — 크롬과 본문 전체를 ko 고정 provider로 감싼다(ConsoleIntlProvider). 사이드바
// 라벨·도움말·명단 업로드 다이얼로그처럼 참가자 화면과 함께 쓰는 조각이 NEXT_LOCALE 쿠키(en)를 따라
// 영어로 바뀌어 한국어 본문과 섞이던 것을 막는다. error.tsx도 이 레이아웃 안에서 그려지므로 함께 고정된다.
export default async function OrganizerLayout({ children }: { children: React.ReactNode }) {
  const access = await resolveOrganizerConsoleAccess()
  return (
    <ConsoleIntlProvider>
      <AppShellForRequest session={access.session} permissionLevel={access.permissionLevel}>
        {/* 권한 조회 실패(unknown)를 "확인된 sub"와 구분 없이 조용히 최소권한으로 내려버리면
            진짜 슈퍼관리자가 승인 버튼이 왜 없는지 모른 채 방치된다(2026-09-21, 3dba2d2 회귀) —
            최소 권한은 그대로 유지하되 배너로 알린다. */}
        {access.permissionUnknown && (
          <Alert variant="destructive" className="mb-4">
            <TriangleAlert />
            <AlertTitle>권한 정보를 확인하지 못했습니다</AlertTitle>
            <AlertDescription>
              일부 기능이 숨겨질 수 있어요. 새로고침하거나 다시 로그인해 주세요.
            </AlertDescription>
          </Alert>
        )}
        {children}
      </AppShellForRequest>
    </ConsoleIntlProvider>
  )
}
