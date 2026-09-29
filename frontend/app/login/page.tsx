// 통합 로그인 진입점 (F-AU-001, AppShell 밖). 딥링크(/login?token=…)로 진입하면 토큰을 검증한 뒤
// 아이디/비번 폼 → (최초)약관 → 세션 발급 → 역할 자동 분기까지 LoginFlow가 이어간다.
// 토큰 없는 진입(운영사·로그아웃 복귀)은 곧바로 폼을 노출한다.
//
// ── 2026-09 비주얼 리뉴얼(발주사 시안: references/login-renewal-spec.md) ──────────────────
// 화면 전체를 핑크 그라디언트로 깔고, 그 위에 흰 카드를 띄운 뒤 카드 안을 [포스터 | 폼] 두 컬럼으로
// 나눈다. 카드 아래에는 행사·신청 일정 2행이 붙는다. md 미만에선 한 컬럼으로 접히고 포스터가 폼
// 위로 쌓인다(발주자 요구: 모바일에서도 포스터가 보여야 한다).
//
// ⚠ 이 리뉴얼은 /login 한 화면만 대상이다. 그래서 /signup·/welcome과 공유하는 EventBrandPanel은
// 손대지 않고 로그인 전용 컴포넌트(LoginPosterPanel·LoginEventDates)로 갈아끼웠다 — 두 화면은 무변경.
// 브랜드 패널이 갖고 있던 언어·화면 밝기 토글은 이 화면에서 갈 곳이 없어져 카드 바깥 우상단으로 옮겼다.

import { getTranslations } from "next-intl/server"

import { LoginEventDates } from "@/components/auth/login-event-dates"
import { LoginFlow } from "@/components/auth/login-flow"
import { LoginPosterPanel } from "@/components/auth/login-poster-panel"
import { LOGIN_CARD_CLASS, LOGIN_SURFACE_CLASS } from "@/components/auth/login-visual"
import { LocaleToggle } from "@/components/layout/locale-toggle"
import { ThemeToggle } from "@/components/layout/theme-toggle"
import { resolveExistingSessions } from "@/lib/mock/session"
import { cn } from "@/lib/utils"

export const dynamic = "force-dynamic"

// 최근 로그인 세션은 프로덕션에선 서버에서 Cognito 세션을 읽어 구성한다(슬라이스 2+).
// dev에선 ?session=buyer|exhibitor|organizer (쉼표로 여러 계정)로 "이미 로그인됨"을 시뮬레이션한다.
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string; session?: string }>
}) {
  const { token, session } = await searchParams
  // prod 배포 차단 P0: ?session=은 "이미 로그인된 계정" 재진입을 시뮬레이션하는 dev 전용 장치다.
  // NODE_ENV 게이트가 없으면 누구나 쿼리로 임의 역할(예: ?session=organizer)의 재방문 카드를
  // 프로덕션 로그인 화면에 띄울 수 있다 — prod에서는 무시(빈 배열)하고, dev는 기존대로 둔다.
  const existingSessions =
    process.env.NODE_ENV === "production" ? [] : resolveExistingSessions(session)
  const t = await getTranslations("login")

  return (
    // min-h-svh(h-svh 아님) — 내용이 뷰포트보다 길어지면 main이 함께 늘어나 위쪽이 잘리지 않는다.
    <main
      className={cn(
        "flex min-h-svh flex-col items-center justify-center px-4 py-8 sm:px-6 md:py-12",
        LOGIN_SURFACE_CLASS
      )}
    >
      <div className="flex w-full max-w-[60rem] flex-col gap-3">
        {/* 언어·화면 밝기 토글 — 시안에는 없지만 리뉴얼 전 브랜드 패널이 갖고 있던 기능이라 유지한다.
            카드 안에 넣으면 로그인 동선(제목→입력→버튼)에 끼어들어서, 카드 바깥 우상단에 둔다. */}
        <div className="flex items-center justify-end gap-1.5">
          <LocaleToggle />
          <ThemeToggle />
        </div>

        <div className={cn(LOGIN_CARD_CLASS, "p-4 sm:p-5 md:p-6")}>
          {/* 컬럼 비율은 시안의 카드 대비 폭(포스터 431/1005 ≈ 43%, 폼 입력 474/1005 ≈ 47%)에 맞췄다. */}
          <div className="grid gap-6 md:grid-cols-[minmax(0,0.85fr)_minmax(0,1fr)] md:items-center md:gap-8 lg:gap-10">
            {/* 좌(데스크톱)·상(모바일): 행사 포스터 키비주얼. */}
            <LoginPosterPanel />
            {/* 우(데스크톱)·하(모바일): 인증 흐름. 넓은 카드에서도 폼 자체는 읽기 좋은 폭으로 묶는다. */}
            <div className="mx-auto flex w-full max-w-md flex-col gap-5">
              <LoginFlow token={token ?? null} existingSessions={existingSessions} />
              {/* 자체 회원가입(F-AU-00X) 진입 — 딥링크 없는 신규 바이어/참가사용. 폼과 섞이지 않게
                  얇은 구분선 아래로 내린다. */}
              <div className="flex flex-col gap-4">
                <div className="h-px bg-border" />
                <p className="text-center text-sm text-muted-foreground">
                  {t("signupPrompt")}{" "}
                  <a
                    href="/signup"
                    className="font-medium text-foreground underline-offset-4 hover:underline"
                  >
                    {t("signupLink")}
                  </a>
                </p>
              </div>
            </div>
          </div>
        </div>

        {/* 카드 밖 하단: 전시회 기간 / 비즈매칭 신청 안내(시안 하단 2행). */}
        <LoginEventDates />
      </div>
    </main>
  )
}
