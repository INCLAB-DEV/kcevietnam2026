// OP-002 명단 내보내기 — CSV/Excel 직렬화 순수 함수 (F-OP-002 / 이슈 #51).
// "현재 필터 결과 반영"은 호출부가 필터·정렬된 rows를 그대로 넘기는 것으로 보장한다(이 함수는 받은 rows만 직렬화).
// 컬럼은 화면 표시값 상위집합(A층 + 운영지표) — 보고·외부검토용이라 탭 무관 superset으로 내보낸다.

import { CONTENT_CATEGORY_LABELS, labelFor } from "@/lib/bm/fields"
import {
  MEMBER_TAB_LABELS,
  ORGANIZER_STATUS_LABELS,
  type MemberRow,
} from "./members"

// 내보내기 컬럼 정의 — 사람이 읽는 라벨로 푼다. 탭 전용 필드(부스 / 유형·언어·체류·등록주체)는
// 해당 없는 행에서 "-"로 비며, 보고용이라 한 시트에 superset으로 둔다.
const COLUMNS: { header: string; value: (r: MemberRow) => string }[] = [
  { header: "기업명(국문)", value: (r) => r.name },
  { header: "기업명(영문)", value: (r) => r.nameEn ?? "-" },
  { header: "구분", value: (r) => MEMBER_TAB_LABELS[r.tab] },
  { header: "비즈매칭 상태", value: (r) => ORGANIZER_STATUS_LABELS[r.applicationStatus] },
  { header: "담당자", value: (r) => r.primaryContact ?? "-" },
  { header: "담당자(영문)", value: (r) => r.primaryContactEn ?? "-" },
  { header: "직위", value: (r) => r.contactTitle ?? "-" },
  { header: "직위(영문)", value: (r) => r.contactTitleEn ?? "-" },
  { header: "전화번호", value: (r) => r.contactPhone ?? "-" },
  { header: "대표 전화번호", value: (r) => r.mainTel ?? "-" },
  { header: "이메일", value: (r) => r.contactEmail ?? "-" },
  { header: "사업자등록번호", value: (r) => r.businessRegNo ?? "-" },
  { header: "웹사이트", value: (r) => r.website ?? "-" },
  { header: "카테고리", value: (r) => labelFor(CONTENT_CATEGORY_LABELS, r.contentCategory) || "미입력" },
  { header: "사업분야/관심분야", value: (r) => r.productCategory ?? "-" },
  { header: "HS코드", value: (r) => r.hsCode ?? "-" },
  { header: "부스", value: (r) => r.boothLabel ?? "-" },
  { header: "바이어유형", value: (r) => r.buyerTypeLabel ?? "-" },
  { header: "언어", value: (r) => r.language ?? "-" },
  { header: "KST 상담시간", value: (r) => r.kstAvailableTime ?? "-" },
  { header: "주소", value: (r) => r.address ?? "-" },
  { header: "체류정보", value: (r) => r.stayInfo ?? "-" },
  { header: "에이전트(무역관)", value: (r) => r.agentName ?? "-" },
  { header: "무역관 담당자", value: (r) => r.agentContact ?? "-" },
  { header: "무역관 전화", value: (r) => r.agentPhone ?? "-" },
  { header: "무역관 이메일", value: (r) => r.agentEmail ?? "-" },
  { header: "등록주체", value: (r) => r.registeredBy ?? "-" },
  { header: "매칭 건수", value: (r) => String(r.matchCount) },
  { header: "적재일", value: (r) => formatActivity(r.importedAt) },
]

export const EXPORT_HEADERS = COLUMNS.map((c) => c.header)

// 날짜(YYYY-MM-DD)만. 없으면 "-".
export function formatActivity(iso: string | null): string {
  if (!iso) return "-"
  return iso.slice(0, 10)
}

// RFC4180: 쉼표·따옴표·개행 포함 시 따옴표로 감싸고 내부 따옴표는 이중화.
function csvCell(value: string): string {
  if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`
  return value
}

// CSV. 맨 앞 UTF-8 BOM을 붙여 Excel에서 한글이 깨지지 않게 한다.
export function toMembersCsv(rows: MemberRow[]): string {
  const lines = [EXPORT_HEADERS.join(",")]
  for (const r of rows) lines.push(COLUMNS.map((c) => csvCell(c.value(r))).join(","))
  return "﻿" + lines.join("\r\n")
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
}

// Excel(.xls) — 의존성 없이 Excel이 바로 여는 HTML 테이블 마크업.
export function toMembersXls(rows: MemberRow[]): string {
  const head = `<tr>${EXPORT_HEADERS.map((h) => `<th>${xmlEscape(h)}</th>`).join("")}</tr>`
  const body = rows
    .map(
      (r) => `<tr>${COLUMNS.map((c) => `<td>${xmlEscape(c.value(r))}</td>`).join("")}</tr>`,
    )
    .join("")
  return `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel"><head><meta charset="utf-8"></head><body><table>${head}${body}</table></body></html>`
}
