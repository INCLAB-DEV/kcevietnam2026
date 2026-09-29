"use client"

import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { LogOut } from "lucide-react"

import { Button } from "@/components/ui/button"
import { sessionApiClient } from "@/lib/api-client/session"

// 단독 화면(/welcome 등 AppShell 밖)용 로그아웃 버튼. app-sidebar와 같은 동선:
// 세션 폐기(dev 쿠키 클리어 스텁 → 실연동 시 Cognito 사인아웃) 후 /login으로.
export function LogoutButton({ className }: { className?: string }) {
  const router = useRouter()
  const t = useTranslations("common")
  async function handleLogout() {
    await sessionApiClient.logout()
    router.push("/login")
  }
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      aria-label={t("logout")}
      onClick={handleLogout}
      className={className}
    >
      <LogOut className="size-4" />
      <span>{t("logout")}</span>
    </Button>
  )
}
