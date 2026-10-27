import { describe, it, expect } from "vitest"
import {
  viewerSideOrgId,
  filterViewerMeetings,
  kstDate,
  kstTime,
  toneFor,
  labelFor,
  resolveDirection,
} from "./meeting-projection"
import koMessages from "@/messages/ko.json"

const m = (buyerOrgId: string, exhibitorOrgId: string) => ({ buyerOrgId, exhibitorOrgId })

// labelFor는 messages/{ko,en}.json의 meeting.status 네임스페이스에서 문구를 조립한다(호출부가 t를
// 주입) — 이 순수 로직 테스트는 실제 ko 카탈로그를 최소 Translator로 감싸 실제 문구와 어긋나지 않게 한다.
const statusMessages = koMessages.meeting.status as Record<string, string>
const t = (key: string) => statusMessages[key]

describe("viewerSideOrgId", () => {
  it("exhibitor는 exhibitorOrgId, 그 외(buyer)는 buyerOrgId", () => {
    expect(viewerSideOrgId(m("b-1", "e-1"), "exhibitor")).toBe("e-1")
    expect(viewerSideOrgId(m("b-1", "e-1"), "buyer")).toBe("b-1")
  })
})

describe("filterViewerMeetings", () => {
  const meetings = [m("b-1", "e-1"), m("b-2", "e-1"), m("b-1", "e-9")]

  it("내 기업이 당사자인 미팅만 남긴다 (buyer 관점)", () => {
    expect(filterViewerMeetings(meetings, "buyer", "b-1")).toEqual([m("b-1", "e-1"), m("b-1", "e-9")])
  })

  it("exhibitor 관점", () => {
    expect(filterViewerMeetings(meetings, "exhibitor", "e-1")).toEqual([m("b-1", "e-1"), m("b-2", "e-1")])
  })
})

describe("KST 투영", () => {
  it("kstDate는 KST offset 기준 날짜를 뽑는다", () => {
    expect(kstDate("2026-09-16T10:00:00+09:00")).toBe("2026-09-16")
    // UTC 자정 직전이라도 KST로는 다음 날
    expect(kstDate("2026-09-15T23:30:00+00:00")).toBe("2026-09-16")
  })

  it("kstTime은 24h HH:MM", () => {
    expect(kstTime("2026-09-16T14:05:00+09:00")).toBe("14:05")
  })
})

describe("toneFor / labelFor", () => {
  it("상태별 tone", () => {
    // 색=끝난 미팅의 "다음 할 일"(ADR-0010 + F-MY-001 재정의). noshow는 상태 아님(completed+attended=false).
    expect(toneFor("accepted")).toBe("green")
    expect(toneFor("proposed")).toBe("red")
    expect(toneFor("cancelled")).toBe("gray")
    expect(toneFor("accepted", { ended: true })).toBe("orange") // 종료경과 → 회의록 필요
    expect(toneFor("completed", { attended: true, hasReview: false })).toBe("orange") // 회의록 작성 필요
    expect(toneFor("completed", { attended: true, hasReview: true })).toBe("blue") // 회의록 완료
    expect(toneFor("completed", { attended: false })).toBe("gray") // 노쇼
  })

  it("라벨도 '다음 할 일': 수락 필요/대기중, 미팅 예정/회의록 작성, 불참", () => {
    expect(labelFor("proposed", "received", {}, t)).toBe("수락 필요")
    expect(labelFor("proposed", "sent", {}, t)).toBe("수락 대기중")
    expect(labelFor("accepted", "sent", {}, t)).toBe("미팅 예정")
    expect(labelFor("accepted", "sent", { ended: true }, t)).toBe("회의록 작성")
    expect(labelFor("completed", "sent", { attended: true, hasReview: false }, t)).toBe("회의록 작성")
    expect(labelFor("completed", "sent", { attended: true, hasReview: true }, t)).toBe("회의록 보기")
    expect(labelFor("completed", "sent", { attended: false }, t)).toBe("불참")
  })
})

describe("resolveDirection — requestedByOrgId(null=운영자 배정) → viewer 기준 방향", () => {
  it("내가 보낸 요청이면 sent", () => {
    expect(resolveDirection("me", "me")).toBe("sent")
  })

  it("상대가 보낸 요청이면 received", () => {
    expect(resolveDirection("counterpart", "me")).toBe("received")
  })

  it("null(운영자 배정)이면 organizer — home/timeline/action-strip/meeting-panel 네 곳이 이 규칙을 공유한다", () => {
    expect(resolveDirection(null, "me")).toBe("organizer")
  })
})
