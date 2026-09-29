// 현재 시각(KST) 헬퍼 — "지금" 기준 판정(과거 슬롯 제외 등)에 쓴다. 모듈에서 Date.now()를 직접 쓰는
// 화면이 늘지 않도록 한 곳으로 모은다. force-dynamic 서버 컴포넌트에서 요청 시점에 평가한다.
// 데모/검증용 오버라이드: ?now=2026-09-17T11:00 (KST). 전부 표시용 투영이라 쓰기·보안 영향 없음.
// (MY-001 /meetings의 kstNow와 동일 규칙 — 운영자 배정 화면도 같은 기준을 쓰도록 공유한다.)

export interface KstNow {
  date: string // "2026-09-16" (YYYY-MM-DD, KST)
  time: string // "13:00" (HH:MM, 24h)
}

export function kstNow(override?: string): KstNow {
  if (override) {
    const m = override.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/)
    if (m) return { date: m[1], time: m[2] }
  }
  const d = new Date()
  return {
    date: d.toLocaleDateString("sv-SE", { timeZone: "Asia/Seoul" }),
    time: d.toLocaleTimeString("en-GB", {
      timeZone: "Asia/Seoul",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }),
  }
}
