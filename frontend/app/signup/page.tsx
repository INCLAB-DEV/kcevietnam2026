// 자체 회원가입 진입점(F-AU-00X, AppShell 밖). 로그인(app/login/page.tsx)과 같은 스플릿 레이아웃을
// 재사용해 인증 화면군의 정체성을 통일한다(좌: 행사 브랜딩 패널, 우: 폼). 가입 가능한 역할은
// 바이어/참가사 둘뿐 — 운영자 계열은 이 화면에 노출되지 않는다(운영자는 별도 내부 경로, D5).

import { EventBrandPanel } from "@/components/auth/event-brand-panel"
import { SignupForm } from "@/components/auth/signup-form"

export const dynamic = "force-dynamic"

export default function SignupPage() {
  return (
    <main className="min-h-svh md:grid md:grid-cols-[1.1fr_1fr] lg:grid-cols-[1.25fr_1fr]">
      {/* 좌(데스크톱)·상(모바일): 행사 브랜드 패널 — 로그인과 동일한 컴포넌트를 재사용하되,
          heroDescription만 가입 맥락 문구(signup.heroDescription)로 갈아낀다(variant). */}
      <EventBrandPanel variant="signup" />
      {/* 우(데스크톱)·하(모바일): 가입 폼. 로그인과 동일한 폭·여백. */}
      <div className="flex items-center justify-center px-6 py-10 md:min-h-svh md:px-10 lg:px-16">
        <div className="w-full max-w-sm">
          <SignupForm />
        </div>
      </div>
    </main>
  )
}
