import { describe, expect, it } from "vitest"
import { organizationsToCsv, organizationsToXls } from "./export"
import { toAdminOrganization } from "./http-client"

describe("admin organization export", () => {
  it("contains real meeting count, proxy flag, and separate category and field labels", () => {
    const row = toAdminOrganization(
      {
        id: "org",
        name_ko: "합성참가사",
        is_exhibitor: true,
        is_buyer: false,
        application_status: "registered",
        match_count: 7,
        proxy_written_by_organizer_id: "audit-id",
        content_category: "broadcasting",
        exhibition_categories: ["game_production"],
      },
      "event"
    )
    for (const output of [
      organizationsToCsv([row]),
      organizationsToXls([row]),
    ]) {
      expect(output).toContain("카테고리")
      expect(output).toContain("사업분야/관심분야")
      expect(output).toContain("방송")
      expect(output).toContain("게임 제작")
      expect(output).toContain("7")
      expect(output).toContain("예")
      expect(output).not.toContain("audit-id")
    }
  })
})
