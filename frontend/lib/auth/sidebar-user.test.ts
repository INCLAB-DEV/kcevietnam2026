import { describe, expect, it } from "vitest"
import { resolveSidebarUser } from "./sidebar-user"

describe("resolveSidebarUser", () => {
  it("me가 null이면(세션 쿠키 없음·백엔드 미가동) 전 필드를 비운다", () => {
    expect(resolveSidebarUser(null, "ko")).toEqual({
      name: null,
      affiliation: null,
      email: null,
      phone: null,
    })
  })

  it("ko 로케일은 organization_name을 그대로 쓴다", () => {
    const user = resolveSidebarUser(
      {
        organization_name: "한화시스템",
        organization_name_en: "Hanwha Systems",
        member_name: "김바이어",
        member_email: "buyer@hanwha.com",
        member_phone: "010-1234-5678",
      },
      "ko",
    )
    expect(user).toEqual({
      name: "김바이어",
      affiliation: "한화시스템",
      email: "buyer@hanwha.com",
      phone: "010-1234-5678",
    })
  })

  it("en 로케일은 organization_name_en을 우선한다", () => {
    const user = resolveSidebarUser(
      { organization_name: "한화시스템", organization_name_en: "Hanwha Systems" },
      "en",
    )
    expect(user.affiliation).toBe("Hanwha Systems")
  })

  it("en 로케일인데 organization_name_en이 아직 없으면(백엔드 롤아웃 중) organization_name으로 폴백한다", () => {
    const user = resolveSidebarUser({ organization_name: "한화시스템" }, "en")
    expect(user.affiliation).toBe("한화시스템")
  })

  it("백엔드 확장 필드가 없으면(member_* 미제공) 해당 줄은 null — 호출부(app-sidebar)가 숨긴다", () => {
    const user = resolveSidebarUser({ organization_name: "한화시스템" }, "ko")
    expect(user.name).toBeNull()
    expect(user.email).toBeNull()
    expect(user.phone).toBeNull()
    expect(user.affiliation).toBe("한화시스템")
  })
})
