import { describe, it, expect, beforeEach } from "vitest"
import {
  __resetProfilesForTest,
  __setStatusForTest,
  loadProfile,
  saveStep,
  submitProfile,
  SubmitBlockedError,
} from "./buyer-profile-store"

const KEY = "role-1"

beforeEach(() => {
  __resetProfilesForTest()
})

describe("이어쓰기 — 단계별 저장 후 재개 시 이전 단계 값 보존", () => {
  it("3단계까지 저장하고 다시 조회하면 1~3단계 값이 남아 있다", () => {
    saveStep(KEY, 1, { country: "Korea", tel: "02-1234" })
    saveStep(KEY, 2, { interestCategories: ["game_production"], companyIntroEn: "We buy." })
    saveStep(KEY, 3, {
      attendees: [
        {
          firstName: "Jin",
          lastName: "Lee",
          division: "",
          jobTitle: "",
          email: "jin@x.com",
          tel: "",
          mobile: "",
          whatsappId: "",
          messengerId: "",
          languages: [],
          interpreterNeed: false,
          interpreterLanguages: [],
        },
      ],
    })

    const reopened = loadProfile(KEY)
    expect(reopened.draft.country).toBe("Korea") // 1단계
    expect(reopened.draft.interestCategories).toEqual(["game_production"]) // 2단계
    expect(reopened.draft.attendees[0].email).toBe("jin@x.com") // 3단계
    expect(reopened.status).toBe("registered")
  })

  it("한 단계 PATCH는 그 단계 필드만 바꾸고 다른 단계는 건드리지 않는다", () => {
    saveStep(KEY, 1, { country: "Korea" })
    saveStep(KEY, 2, { companyIntroEn: "Intro" })
    // 1단계 재저장(country 수정) — 2단계 값은 그대로여야 한다.
    saveStep(KEY, 1, { country: "Japan" })

    const p = loadProfile(KEY)
    expect(p.draft.country).toBe("Japan")
    expect(p.draft.companyIntroEn).toBe("Intro")
  })
})

describe("Registrant prefill 시드", () => {
  it("신규 draft는 시드된 조직명으로 시작한다", () => {
    const p = loadProfile("new-role", { organizationNameKo: "한화에어로스페이스" })
    expect(p.draft.organizationNameKo).toBe("한화에어로스페이스")
    expect(p.status).toBe("registered")
  })
})

describe("submitProfile — 원자적 제출 + 상태 전환", () => {
  it("제출하면 최종 patch 저장과 submitted 전환이 함께 반영된다", () => {
    saveStep(KEY, 1, { country: "Korea" })
    const result = submitProfile(KEY, { kstAvailableTime: "10:00-12:00" })
    expect(result.status).toBe("submitted")
    expect(result.draft.country).toBe("Korea") // 기존 저장 보존
    expect(result.draft.kstAvailableTime).toBe("10:00-12:00") // 최종 patch 반영
  })

  it("이미 submitted인 프로필을 수정 저장해도 status는 submitted 유지", () => {
    saveStep(KEY, 1, { country: "Korea" })
    submitProfile(KEY)
    const after = saveStep(KEY, 1, { country: "Japan" })
    expect(after.status).toBe("submitted")
    // 재제출도 submitted 유지(멱등).
    expect(submitProfile(KEY).status).toBe("submitted")
  })

  it("approved 상태는 재제출해도 approved 유지(멱등)", () => {
    saveStep(KEY, 1, { country: "Korea" })
    __setStatusForTest(KEY, "approved")
    expect(submitProfile(KEY).status).toBe("approved")
  })

  it("changes_requested 상태는 재제출 시 다시 submitted로 전이", () => {
    saveStep(KEY, 1, { country: "Korea" })
    __setStatusForTest(KEY, "changes_requested")
    expect(submitProfile(KEY).status).toBe("submitted")
  })

  it("rejected 상태는 재제출이 차단된다(SubmitBlockedError)", () => {
    saveStep(KEY, 1, { country: "Korea" })
    __setStatusForTest(KEY, "rejected")
    expect(() => submitProfile(KEY)).toThrow(SubmitBlockedError)
  })
})
