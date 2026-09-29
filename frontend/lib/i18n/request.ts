// next-intl 요청 설정 — i18n 라우팅([locale] 세그먼트) 없이 provider 모드로 쓴다. 매 요청마다
// NEXT_LOCALE 쿠키를 읽어 locale을 정하고, 해당 메시지 카탈로그를 로드한다. next.config.ts의
// createNextIntlPlugin이 이 파일 경로를 next-intl/config로 alias해 서버 함수(getTranslations 등)가
// 이 설정을 쓰게 만든다.
import { cookies } from "next/headers"
import { getRequestConfig } from "next-intl/server"

import { LOCALE_COOKIE_NAME, resolveLocale } from "./config"

export default getRequestConfig(async () => {
  const cookieStore = await cookies()
  const locale = resolveLocale(cookieStore.get(LOCALE_COOKIE_NAME)?.value)
  const messages = (await import(`../../messages/${locale}.json`)).default

  return { locale, messages }
})
