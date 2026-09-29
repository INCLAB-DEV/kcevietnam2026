import { describe, expect, it } from "vitest"
import {
  ROSTER_TEMPLATE_HEADERS,
  isTemplateExampleEmail,
  rosterTemplateCsv,
} from "./template"

describe("명단 업로드 템플릿(두 콘솔 공용)", () => {
  it("UTF-8 BOM으로 시작한다 — Excel에서 한글이 깨지지 않게", () => {
    const bytes = new TextEncoder().encode(rosterTemplateCsv())
    expect(Array.from(bytes.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf])
  })

  it("헤더는 회원가입 필드 키 + id·role·country·content_category이고 비밀번호 컬럼은 없다", () => {
    const [header] = rosterTemplateCsv().slice(1).split("\r\n")
    expect(header).toBe(
      "id,role,name_ko,name_en,country,contact_name,contact_email,contact_phone,content_category"
    )
    expect(ROSTER_TEMPLATE_HEADERS.join(",")).toBe(header)
    expect(header.toLowerCase()).not.toContain("password")
  })

  it("예시 행은 example.com 이메일이라 누가 봐도 가짜다", () => {
    const rows = rosterTemplateCsv().slice(1).trimEnd().split("\r\n").slice(1)
    expect(rows).toHaveLength(2)
    const emailIndex = ROSTER_TEMPLATE_HEADERS.indexOf("contact_email")
    for (const row of rows) {
      const cells = row.split(",")
      expect(cells).toHaveLength(ROSTER_TEMPLATE_HEADERS.length)
      expect(isTemplateExampleEmail(cells[emailIndex])).toBe(true)
    }
    expect(isTemplateExampleEmail("buyer@hanoi-media.vn")).toBe(false)
    expect(isTemplateExampleEmail(null)).toBe(false)
  })
})
