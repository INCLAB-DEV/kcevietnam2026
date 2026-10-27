// 엑셀 내보내기 직렬화 — 의존성 없이 Excel이 바로 여는 형식으로 만든다(운영자 콘솔의
// lib/organizer/members-export와 같은 기법: .xls = HTML 테이블, .csv = BOM + RFC4180).
//
// "현재 필터 결과 반영"은 호출부가 필터·정렬된 rows를 그대로 넘기는 것으로 보장한다 —
// 이 함수들은 받은 rows만 직렬화한다.
//
// 실연동: GET /api/admin/export/{kind}.xlsx 가 서버에서 진짜 xlsx를 만들어 내려준다
// (admin-actions.exportUrl). 그때 이 모듈은 목업 폴백으로만 남거나 제거된다.

import { ADMIN_MEETING_STATUS_LABELS, ADMIN_ORG_ROLE_LABELS, VENUE_TYPE_LABELS } from "./types"
import type { AdminMeeting, AdminOrganization } from "./types"
import { ADMIN_STATUS_LABELS } from "./proxy-profile"
import { CONTENT_CATEGORY_LABELS, labelFor } from "@/lib/bm/fields"

interface Column<T> {
  header: string
  value: (row: T) => string
}

const dash = (v: string | null | undefined): string => (v == null || v === "" ? "-" : v)

const ORG_COLUMNS: Column<AdminOrganization>[] = [
  { header: "기업명(국문)", value: (r) => r.name_ko },
  { header: "기업명(영문)", value: (r) => dash(r.name_en) },
  { header: "구분", value: (r) => ADMIN_ORG_ROLE_LABELS[r.role] },
  { header: "국가", value: (r) => dash(r.country) },
  { header: "신청 상태", value: (r) => ADMIN_STATUS_LABELS[r.application_status] },
  { header: "대리작성", value: (r) => (r.proxy_written ? "예" : "아니오") },
  { header: "대리작성자", value: (r) => dash(r.proxy_written_by) },
  { header: "담당자", value: (r) => dash(r.contact_name) },
  { header: "이메일", value: (r) => dash(r.contact_email) },
  { header: "전화번호", value: (r) => dash(r.contact_phone) },
  { header: "카테고리", value: (r) => dash(labelFor(CONTENT_CATEGORY_LABELS, r.content_category)) },
  { header: "사업분야/관심분야", value: (r) => dash(r.category) },
  { header: "부스", value: (r) => dash(r.booth_label) },
  { header: "등록주체", value: (r) => dash(r.registered_by) },
  { header: "미팅 건수", value: (r) => String(r.meeting_count) },
  { header: "불가 시간대 수", value: (r) => String(r.unavailable_slots.length) },
  { header: "최근 수정", value: (r) => r.updated_at.slice(0, 10) },
]

const MEETING_COLUMNS: Column<AdminMeeting>[] = [
  { header: "날짜", value: (r) => r.date },
  { header: "시작", value: (r) => r.start_time },
  { header: "소요(분)", value: (r) => String(r.slot_minutes) },
  { header: "참가사", value: (r) => r.exhibitor_name },
  { header: "바이어", value: (r) => r.buyer_name },
  { header: "상태", value: (r) => ADMIN_MEETING_STATUS_LABELS[r.status] },
  { header: "장소 유형", value: (r) => VENUE_TYPE_LABELS[r.venue_type] },
  { header: "장소", value: (r) => dash(r.venue_label) },
  { header: "취소 주체", value: (r) => dash(r.cancelled_by) },
  { header: "취소 사유", value: (r) => dash(r.cancelled_reason) },
]

export const ORG_EXPORT_HEADERS = ORG_COLUMNS.map((c) => c.header)
export const MEETING_EXPORT_HEADERS = MEETING_COLUMNS.map((c) => c.header)

// RFC4180: 쉼표·따옴표·개행 포함 시 따옴표로 감싸고 내부 따옴표는 이중화.
function csvCell(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

function toCsv<T>(rows: T[], columns: Column<T>[]): string {
  const lines = [columns.map((c) => c.header).join(",")]
  for (const r of rows) lines.push(columns.map((c) => csvCell(c.value(r))).join(","))
  // 맨 앞 UTF-8 BOM — Excel에서 한글이 깨지지 않게.
  return "﻿" + lines.join("\r\n")
}

function xmlEscape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

function toXls<T>(rows: T[], columns: Column<T>[]): string {
  const head = `<tr>${columns.map((c) => `<th>${xmlEscape(c.header)}</th>`).join("")}</tr>`
  const body = rows
    .map((r) => `<tr>${columns.map((c) => `<td>${xmlEscape(c.value(r))}</td>`).join("")}</tr>`)
    .join("")
  return `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel"><head><meta charset="utf-8"></head><body><table>${head}${body}</table></body></html>`
}

export function organizationsToCsv(rows: AdminOrganization[]): string {
  return toCsv(rows, ORG_COLUMNS)
}

export function organizationsToXls(rows: AdminOrganization[]): string {
  return toXls(rows, ORG_COLUMNS)
}

export function meetingsToCsv(rows: AdminMeeting[]): string {
  return toCsv(rows, MEETING_COLUMNS)
}

export function meetingsToXls(rows: AdminMeeting[]): string {
  return toXls(rows, MEETING_COLUMNS)
}
