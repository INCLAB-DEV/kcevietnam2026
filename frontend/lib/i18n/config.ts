// i18n 기반 설정 — 지원 locale·기본값·쿠키 키의 단일 소스. 순수 함수만 두어(부수효과 없음)
// 서버(cookies() 읽기)·클라(LocaleToggle) 양쪽에서 그대로 재사용하고 단위 테스트한다.
// 라우트 프리픽스(/en) 방식이 아니라 쿠키(NEXT_LOCALE) 기반 토글이다(방침 확정, 라우트 구조 불변).

export const SUPPORTED_LOCALES = ["ko", "en"] as const
export type Locale = (typeof SUPPORTED_LOCALES)[number]

export const DEFAULT_LOCALE: Locale = "ko"
export const LOCALE_COOKIE_NAME = "NEXT_LOCALE"

export function isSupportedLocale(value: string | null | undefined): value is Locale {
  return value != null && (SUPPORTED_LOCALES as readonly string[]).includes(value)
}

// 쿠키 값 → locale 해석. 쿠키 없음·미지원 값은 전부 기본 locale(ko)로 폴백한다.
export function resolveLocale(cookieValue: string | null | undefined): Locale {
  return isSupportedLocale(cookieValue) ? cookieValue : DEFAULT_LOCALE
}
