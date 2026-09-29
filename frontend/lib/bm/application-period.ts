// 비즈니스 매칭 신청기간(KST, YYYY-MM-DD) — 이 기간 동안만 프로필 작성/수정을 허용한다.
// ⚠ 권위 출처는 **Event DB(events.application_start / application_end — 이미 존재)** — 행사 단위
//   설정이라 하드코딩/env가 아니라 행사 레코드에서 와야 한다. 실연동 시 FastAPI가 Event에서 내려주고
//   제출/수정 게이트는 **서버에서도** 강제한다(현재는 프론트 env 임시, prod는 fail-closed). 데모만 항상 열림.
// 날짜 비교는 YYYY-MM-DD 문자열 사전순으로 충분(route-guard와 동일 방식).

export interface ApplicationPeriod {
  opensAt: string // YYYY-MM-DD (KST)
  closesAt: string // YYYY-MM-DD (KST)
}

export function isApplicationOpen(now: string, period: ApplicationPeriod): boolean {
  return now >= period.opensAt && now <= period.closesAt
}

// 신청기간 종료 = now가 종료일을 지났다(경계일 당일은 아직 '중'). route-guard·welcome이 같은 규칙을 쓴다.
export function isApplicationClosed(now: string, period: ApplicationPeriod): boolean {
  return now > period.closesAt
}

// dev 신청기간 오버라이드 → 실제 기간(YYYY-MM-DD). proxy·welcome·apply가 같은 규칙으로 기간을 보게 한다.
// 권위 출처는 Event DB지만 데모는 env(opensAt/closesAt)와 ?period 스위처로 시뮬레이션한다.
//  - "open"   → 항상 열림(now가 기간 안)        - "closed" → 항상 종료(now가 기간 뒤)
//  - 그 외/미설정 → 주입된 opensAt/closesAt(env) 사용. 실연동 시 이 dev 오버라이드만 제거.
const FAR_PAST = "2000-01-01"
const FAR_FUTURE = "2999-12-31"
export function resolveApplicationPeriod(opts: {
  override?: string | null
  opensAt?: string
  closesAt?: string
}): ApplicationPeriod {
  if (opts.override === "open") return { opensAt: FAR_PAST, closesAt: FAR_FUTURE }
  if (opts.override === "closed") return { opensAt: FAR_PAST, closesAt: "2000-01-02" }
  return { opensAt: opts.opensAt ?? FAR_PAST, closesAt: opts.closesAt ?? FAR_FUTURE }
}
