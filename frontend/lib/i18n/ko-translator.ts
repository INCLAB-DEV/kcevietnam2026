// 한국어 고정 번역기 — 운영자·관리자 콘솔(쿠키 로케일과 무관하게 한국어로 고정)과 단위 테스트가 쓴다.
//
// 참가자 화면과 공유하는 투영 함수(lib/meeting/* 의 labelFor·buildTimeline, lib/api-client/
// recommendations 등)는 번역기(t)를 **필수 인자**로 받는다. 예전엔 t를 생략하면 각 모듈 안의 한국어
// 사전으로 조용히 폴백했는데, 그 구조에서는 참가자 화면 호출부가 t를 한 번 빠뜨리면 EN 화면에 한국어가
// 그대로 남는다(타입이 못 잡는다). 그래서 폴백을 없애고, 한국어가 필요한 호출부가 이 번역기를
// **명시적으로** 넘기게 했다 — 문구의 원천은 messages/ko.json 하나다(모듈마다 복사해 두지 않는다).
//
// ⚠ 참가자 화면 소스는 이 모듈을 import하지 않는다(lib/i18n/hangul-guard.test.ts가 강제). 참가자
//   화면은 next-intl의 useTranslations/getTranslations로 현재 로케일 번역기를 얻는다 — 여기서 얻으면
//   로케일이 ko로 고정되고, ko.json이 참가자 번들에 통째로 실린다.
import { createTranslator } from "next-intl"

import koMessages from "@/messages/ko.json"

export type KoTranslator = (key: string, values?: Record<string, string | number>) => string

// next-intl의 createTranslator는 네임스페이스·키를 메시지 카탈로그의 리터럴 타입에 묶는다. 여기서는
// 호출부가 문자열 네임스페이스를 넘기므로 경계 한 곳에서만 넓혀 캐스팅한다 — 키가 실제로 있는지는
// messages 키 무결성 테스트(lib/i18n/messages.test.ts)와 각 호출부 테스트가 잡는다.
type LooseTranslator = (key: string, values?: Record<string, string | number>) => string

/** `messages/ko.json`의 한 네임스페이스에 물린 한국어 번역기(예: `koTranslator("meeting.status")`). */
export function koTranslator(namespace: string): KoTranslator {
  const translate = createTranslator({
    locale: "ko",
    messages: koMessages,
    namespace: namespace as never,
  }) as unknown as LooseTranslator
  return (key, values) => translate(key, values)
}
