// RTL render 드롭인 대체 — NextIntlClientProvider(ko 메시지)로 감싼다. i18n 도입으로 useTranslations를
// 쓰게 된 컴포넌트는 provider 컨텍스트 없이 render()하면 "No intl context found" 에러가 난다.
// 사용법: `import { render, screen } from "@testing-library/react"`를
//        `import { render, screen } from "@/lib/test/render-with-intl"`로 바꾸기만 하면 된다(시그니처 동일).
import type { ReactElement } from "react"
import { render as rtlRender, type RenderOptions } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"

import koMessages from "@/messages/ko.json"
import { DEFAULT_LOCALE } from "@/lib/i18n/config"

export function render(ui: ReactElement, options?: RenderOptions) {
  return rtlRender(ui, {
    wrapper: ({ children }) => (
      <NextIntlClientProvider locale={DEFAULT_LOCALE} messages={koMessages}>
        {children}
      </NextIntlClientProvider>
    ),
    ...options,
  })
}

export * from "@testing-library/react"
