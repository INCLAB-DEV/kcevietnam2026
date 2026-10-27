"use server"

// LocaleToggle(클라)이 호출하는 Server Function — NEXT_LOCALE 쿠키를 갱신한다. 쿠키 쓰기는
// Server Function/Route Handler에서만 가능하므로(next/headers cookies() 제약) 여기 분리한다.
// 호출 측이 router.refresh()까지 이어서 Server Component(nav·페이지 텍스트)를 새 locale로 다시 그린다.
import { cookies } from "next/headers"

import { LOCALE_COOKIE_NAME, type Locale } from "./config"

const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365

export async function setLocaleCookie(locale: Locale): Promise<void> {
  const cookieStore = await cookies()
  cookieStore.set(LOCALE_COOKIE_NAME, locale, {
    path: "/",
    maxAge: ONE_YEAR_SECONDS,
    sameSite: "lax",
  })
}
