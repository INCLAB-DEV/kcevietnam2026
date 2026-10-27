// OP-001 "전체 포화배정 현황" 위젯의 순수 현황 도출 (F-OP-001 / ADR-0006).
// 전체 포화배정은 1회성이 아니라 반복 실행 가능(추가 전용·비파괴)이라, 대시보드는
// saturation_batch_runs 의 최근 회차(run_number)·실행 시각·status(draft/confirmed/discarded)를
// 현황으로 가시화하고, 최근 회차가 Draft 면 "검토 대기"로 표시한다(확정 게이트는 OP-005).
// 데이터 출처는 v1 mock. 실연동 시 FastAPI 집계 결과로 스왑(ADR-0008). 읽기 전용.

// saturation_batch_runs.status 정본(schema.sql): Draft 생성 → 운영자 검토 → 확정/폐기.
export type SaturationRunStatus = "draft" | "confirmed" | "discarded"

// 실행 1회차 — 회차·시각·상태·이번 실행에 적용된 최소 보장 슬롯 N(ADR-0006).
export interface SaturationRun {
  runNumber: number // 이벤트 내 1부터 증가
  status: SaturationRunStatus
  createdAt: string // ISO8601 실행 시각
  minGuaranteedSlots: number // 이 실행에 적용된 N
}

export interface SaturationStatus {
  hasRun: boolean // 한 번이라도 실행됐는지(미실행=0회차)
  latestRunNumber: number | null // 최근 회차
  latestRunAt: string | null // 최근 실행 시각
  latestStatus: SaturationRunStatus | null
  reviewPending: boolean // 최근 회차가 draft → 확정 게이트에서 멈춘 검토 대기
  latestMinGuaranteedSlots: number | null // 최근 실행 N
  confirmedRuns: number // 확정된 회차 수(누적 임팩트 가늠)
}

const NOT_RUN: SaturationStatus = {
  hasRun: false,
  latestRunNumber: null,
  latestRunAt: null,
  latestStatus: null,
  reviewPending: false,
  latestMinGuaranteedSlots: null,
  confirmedRuns: 0,
}

// 최근 회차(run_number 최대)를 골라 현황을 도출한다. discarded 회차도 회차 자체는 존재하므로
// "최근"은 status 와 무관하게 run_number 로 정한다 — 폐기 직후 재실행 타이밍 판단을 위해.
export function saturationRunStatus(runs: SaturationRun[]): SaturationStatus {
  if (runs.length === 0) return NOT_RUN
  const latest = runs.reduce((a, b) => (b.runNumber > a.runNumber ? b : a))
  return {
    hasRun: true,
    latestRunNumber: latest.runNumber,
    latestRunAt: latest.createdAt,
    latestStatus: latest.status,
    reviewPending: latest.status === "draft",
    latestMinGuaranteedSlots: latest.minGuaranteedSlots,
    confirmedRuns: runs.filter((r) => r.status === "confirmed").length,
  }
}
