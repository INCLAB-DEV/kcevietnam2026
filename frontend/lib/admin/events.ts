// 행사 스코프 해석 — 슈퍼어드민 콘솔은 멀티 행사 운영 콘솔이라, 모든 데이터 뷰(기업·미팅·알림·
// 설정·통역사)가 "지금 선택된 행사" 하나로 스코프된다. 선택은 헤더 스위처가 쿠키에 박고,
// 서버 컴포넌트가 그 쿠키를 읽어 같은 행사를 본다(dev 세션 쿠키와 동일한 패턴 — 셸과 페이지가
// 한 소스를 보게 해 divergence를 구조적으로 막는다).
//
// 클라이언트 안전 모듈(server-only 아님) — 스위처(client)와 서버 read seam이 함께 쓴다.

import type { AdminEvent } from "./types"

// 선택된 행사 id를 담는 쿠키. 실연동에서도 그대로 쓴다(행사 선택은 세션 스코프의 UI 상태이지
// 권한이 아니다 — 권한은 백엔드가 event 단위로 다시 검사한다, ADR-0012).
export const ADMIN_EVENT_COOKIE = "nabi_admin_event"

// 선택을 쿠키에 기록한다(브라우저 전용). 컴포넌트 밖 모듈에 두는 이유는 두 가지다 —
// ① document.cookie 쓰기는 렌더 바깥의 부수효과라 컴포넌트 본문에 두면 React 규칙(immutability)에
//    걸린다. ② 쿠키 이름·수명 같은 저장 형식을 읽기(resolveSelectedEvent)와 같은 파일에 모아
//    한쪽만 바뀌는 일을 막는다.
const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365

export function writeSelectedEvent(eventId: string): void {
  if (typeof document === "undefined") return // SSR 안전장치
  document.cookie = `${ADMIN_EVENT_COOKIE}=${encodeURIComponent(eventId)}; path=/; max-age=${ONE_YEAR_SECONDS}; samesite=lax`
}

// 쿠키 값(또는 미지정)에서 현재 행사를 고른다. 알 수 없는 id·빈 값은 첫 행사로 폴백해
// 콘솔이 "행사 없음" 상태로 빈 화면이 되는 일이 없게 한다.
export function resolveSelectedEvent(
  events: AdminEvent[],
  cookieValue?: string | null,
): AdminEvent | null {
  if (events.length === 0) return null
  if (cookieValue) {
    const found = events.find((e) => e.id === cookieValue)
    if (found) return found
  }
  return events[0]
}

// 전시 기간(exhibition_start ~ exhibition_end, 양끝 포함)을 날짜 목록으로 편다.
// 슬롯 그리드(미팅 불가 시간대)의 세로축이 된다. 역전된 기간은 빈 목록.
export function eventDateIds(
  event: Pick<AdminEvent, "exhibition_start" | "exhibition_end">,
): string[] {
  const start = new Date(`${event.exhibition_start}T00:00:00Z`)
  const end = new Date(`${event.exhibition_end}T00:00:00Z`)
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) return []
  const out: string[] = []
  for (let d = start; d <= end; d = new Date(d.getTime() + 86_400_000)) {
    out.push(d.toISOString().slice(0, 10))
  }
  return out
}

// "9/16 (수)" 형태의 짧은 날짜 라벨. 그리드 헤더용.
const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"] as const

export function formatEventDate(dateId: string): string {
  const d = new Date(`${dateId}T00:00:00Z`)
  if (Number.isNaN(d.getTime())) return dateId
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()} (${WEEKDAYS[d.getUTCDay()]})`
}

// 행사 표시명 — 백엔드 계약상 name이 정본이고 name_en은 FE 보조 병기다.
export function eventLabel(event: AdminEvent): string {
  return event.name
}
