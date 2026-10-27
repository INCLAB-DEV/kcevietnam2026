// 미팅 장소(zone_table·business_room) 관리의 순수 로직 — CRUD 입력 검증 + 화면 그룹핑.
//
// 라벨 순서가 곧 실제 배정 순서다(백엔드 list_venues 정렬 기준, meetings.service._resolve_venue가
// 후보 중 빈 첫 장소를 고른다) — 그래서 검증은 정렬을 건드리지 않고 라벨 유일성만 지킨다
// (같은 유형 안에서만 충돌시키고, 유형이 다르면 라벨이 같아도 된다 — 백엔드 유니크 제약과 동일).

import { MANAGEABLE_VENUE_TYPES } from "./types"
import type { AdminVenue, ManageableVenueType } from "./types"

export type VenueError = "label-required" | "venue-type-invalid" | "label-duplicate"

export const VENUE_ERROR_MESSAGES: Record<VenueError, string> = {
  "label-required": "장소 이름을 입력해 주세요.",
  "venue-type-invalid": "장소 유형이 올바르지 않습니다.",
  "label-duplicate": "같은 유형에 이미 있는 이름입니다.",
}

export interface VenueFormInput {
  venue_type: string
  label: string
}

export type VenueValidation =
  | { valid: true; venue_type: ManageableVenueType; label: string }
  | { valid: false; errors: VenueError[] }

export function isManageableVenueType(value: string): value is ManageableVenueType {
  return (MANAGEABLE_VENUE_TYPES as readonly string[]).includes(value)
}

// existing = 같은 행사의 기존 장소 목록. excludeId는 수정 중인 자기 자신(자기 라벨과 비교해
// "중복"으로 잘못 걸리지 않게).
export function validateVenue(
  input: VenueFormInput,
  existing: AdminVenue[],
  excludeId?: string,
): VenueValidation {
  if (!isManageableVenueType(input.venue_type)) {
    return { valid: false, errors: ["venue-type-invalid"] }
  }

  const label = input.label.trim()
  const errors: VenueError[] = []
  if (!label) errors.push("label-required")

  const duplicate = existing.some(
    (v) => v.id !== excludeId && v.venue_type === input.venue_type && v.label === label,
  )
  if (label && duplicate) errors.push("label-duplicate")

  if (errors.length > 0) return { valid: false, errors }
  return { valid: true, venue_type: input.venue_type, label }
}

// 유형별로 묶어 그룹 테이블에 뿌린다. 정렬은 하지 않는다 — 받은 순서(백엔드가 이미 라벨 순으로
// 내려준다, mock도 그 순서로 채워둠)를 그대로 유지해야 화면 순서가 실제 배정 순서와 같다.
export function groupByVenueType(venues: AdminVenue[]): Record<ManageableVenueType, AdminVenue[]> {
  const groups: Record<ManageableVenueType, AdminVenue[]> = { zone_table: [], business_room: [] }
  for (const v of venues) groups[v.venue_type].push(v)
  return groups
}
