import { describe, it, expect } from "vitest"
import { mockReviewClient as api } from "./mock-review-client"

// #97 — 화자별 전사(turns)가 구조화 초안 → Step2 저장 → 본인 열람까지 보존되는지(라운드트립) 검증.
describe("mock review client — transcript turns round-trip", () => {
  it("structureText returns speaker-labeled turns", async () => {
    const draft = await api.structureText("m-turns-1", "사거리 연장 논의\n기술제안서 송부 합의")
    expect(draft.transcriptTurns.length).toBeGreaterThan(0)
    for (const t of draft.transcriptTurns) {
      expect(["us", "them"]).toContain(t.who)
      expect(t.text).toBeTruthy()
    }
  })

  it("turns persist through saveStep2 and surface on getReview", async () => {
    const id = "m-turns-2"
    await api.saveStep1(id, {
      proceeded: "proceeded",
      satisfaction: 4,
      followUpIntent: "yes",
    })
    const draft = await api.structureText(id, "우리 요구사항\n상대 답변")
    await api.saveStep2(id, {
      report: draft.report,
      fitRating: draft.fitSuggestion,
      fitReason: draft.fitReasonSeed,
      fitReasonTags: draft.fitReasonTags,
      transcript: draft.transcript,
      transcriptTurns: draft.transcriptTurns,
      finalize: true,
    })
    const stored = await api.getReview(id)
    expect(stored?.transcriptTurns).toEqual(draft.transcriptTurns)
  })
})
