"use client"

// 운영자·관리자 콘솔(/organizer/*, /admin/*)을 한국어로 고정하는 next-intl provider.
//
// 두 콘솔의 본문은 한국어 하드코딩이다(발주사 내부 도구 — 의도적으로 한국어 전용). 그런데 참가자 화면과
// 함께 쓰는 조각들은 useTranslations로 문구를 뽑는다 — 사이드바 메뉴 라벨·로그아웃, 도움말 패널과 투어,
// help.hints 툴팁, 명단 업로드 다이얼로그, 다이얼로그·시트의 닫기 라벨, 테마 토글. 이 조각들은 전역
// locale(NEXT_LOCALE 쿠키)을 따르므로, 쿠키가 en이면 그것들만 영어가 되고 본문은 한국어로 남아 화면이
// 반쪽씩 섞였다(쿠키는 로그인 화면의 언어 토글로도 en이 된다).
//
// 콘솔 레이아웃(app/organizer/layout.tsx, app/admin/layout.tsx)이 화면 전체를 이 provider로 감싼다 —
// 안쪽의 useTranslations·useLocale은 쿠키와 무관하게 ko를 본다. 쿠키 값은 건드리지 않는다(무시할 뿐):
// 같은 브라우저로 참가자 화면에 가면 고른 언어가 그대로 살아 있다. 언어 토글도 콘솔에는 그리지 않는다
// (components/app-sidebar.tsx — 눌러도 화면이 바뀌지 않는 죽은 컨트롤이 된다).
//
// 클라이언트 컴포넌트로 두는 이유: ko 카탈로그를 서버 레이아웃에서 prop으로 넘기면 콘솔 페이지를 열 때마다
// 카탈로그 전체가 RSC 페이로드에 실린다. 여기서 정적으로 import하면 콘솔 번들에 한 번 실리고 브라우저가
// 캐시한다(components/organizer/company-application.tsx의 ko 고정 provider와 같은 방식).
// 중첩 provider는 timeZone·formats 같은 나머지 설정을 바깥(루트) provider에서 물려받는다.
//
// ⚠ 이 provider는 클라이언트 컴포넌트의 문구만 고정한다. 콘솔 경로의 **서버** 컴포넌트가
//   getTranslations/getLocale을 쓰면 요청 설정(쿠키)을 그대로 읽는다 — 지금은 그런 곳이 없다. 새로
//   생기면 lib/i18n/ko-translator.ts(한국어 고정 번역기)를 쓴다.

import { NextIntlClientProvider } from "next-intl"

import koMessages from "@/messages/ko.json"

export const CONSOLE_LOCALE = "ko"

export function ConsoleIntlProvider({ children }: { children: React.ReactNode }) {
  return (
    <NextIntlClientProvider locale={CONSOLE_LOCALE} messages={koMessages}>
      {children}
    </NextIntlClientProvider>
  )
}
