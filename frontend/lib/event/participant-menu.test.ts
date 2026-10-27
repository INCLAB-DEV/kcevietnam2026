import { describe, expect, it } from "vitest"

import {
  DEFAULT_PARTICIPANT_MENU,
  PARTICIPANT_MENUS,
  parseParticipantMenu,
  participantHomePath,
  resolveParticipantMenu,
} from "./participant-menu"

// 참가자 메뉴(F-NV-001 D15) — 행사 설정값 해석과 도착 화면 결정.
// 핵심 불변식 둘: ① 기본값은 미팅만이다(발주사 결정 — 설정을 켜지 않아도 미팅 전용 화면),
// ② 값을 알 수 없는 모든 경우가 그 기본값 하나로 떨어진다(폴백마다 값이 갈리지 않는다).

describe("기본값", () => {
  it("미팅만(meetings_only)이다", () => {
    expect(DEFAULT_PARTICIPANT_MENU).toBe("meetings_only")
  })

  it("어휘는 두 값뿐이다", () => {
    expect([...PARTICIPANT_MENUS].sort()).toEqual(["full", "meetings_only"])
  })
})

describe("parseParticipantMenu", () => {
  it("아는 두 값은 그대로 통과한다", () => {
    expect(parseParticipantMenu("full")).toBe("full")
    expect(parseParticipantMenu("meetings_only")).toBe("meetings_only")
  })

  it.each([undefined, null, "", "FULL", "Full", "meetings-only", "none", 0, true, {}, ["full"]])(
    "필드가 없거나 모르는 값(%j)이면 기본값이다 — 구 백엔드·미래 어휘 대비",
    (value) => {
      expect(parseParticipantMenu(value)).toBe(DEFAULT_PARTICIPANT_MENU)
    },
  )
})

describe("resolveParticipantMenu", () => {
  const exhibitorRow = { is_exhibitor: true, is_buyer: false }
  const buyerRow = { is_exhibitor: false, is_buyer: true }

  it("me를 못 읽었으면(null·roles 없음) 기본값이다", () => {
    expect(resolveParticipantMenu(null, "buyer")).toBe(DEFAULT_PARTICIPANT_MENU)
    expect(resolveParticipantMenu(undefined, "exhibitor")).toBe(DEFAULT_PARTICIPANT_MENU)
    expect(resolveParticipantMenu({}, "buyer")).toBe(DEFAULT_PARTICIPANT_MENU)
    expect(resolveParticipantMenu({ roles: null }, "buyer")).toBe(DEFAULT_PARTICIPANT_MENU)
    expect(resolveParticipantMenu({ roles: [] }, "exhibitor")).toBe(DEFAULT_PARTICIPANT_MENU)
  })

  it("구 백엔드 응답(필드 없음·null)은 기본값이다", () => {
    expect(resolveParticipantMenu({ roles: [buyerRow] }, "buyer")).toBe(DEFAULT_PARTICIPANT_MENU)
    expect(resolveParticipantMenu({ roles: [{ ...buyerRow, participant_menu: null }] }, "buyer")).toBe(
      DEFAULT_PARTICIPANT_MENU,
    )
  })

  it("행사 설정이 '전체 메뉴'면 참가사·바이어 모두 전체 메뉴다", () => {
    expect(resolveParticipantMenu({ roles: [{ ...buyerRow, participant_menu: "full" }] }, "buyer")).toBe("full")
    expect(
      resolveParticipantMenu({ roles: [{ ...exhibitorRow, participant_menu: "full" }] }, "exhibitor"),
    ).toBe("full")
  })

  it("행사 설정이 '미팅만'이면 그대로 미팅만이다", () => {
    expect(
      resolveParticipantMenu({ roles: [{ ...buyerRow, participant_menu: "meetings_only" }] }, "buyer"),
    ).toBe("meetings_only")
  })

  it("여러 행사에 참가 중이면 로그인한 역할로 참가한 행사의 값을 쓴다", () => {
    const me = {
      roles: [
        { ...exhibitorRow, participant_menu: "full" },
        { ...buyerRow, participant_menu: "meetings_only" },
      ],
    }
    expect(resolveParticipantMenu(me, "exhibitor")).toBe("full")
    expect(resolveParticipantMenu(me, "buyer")).toBe("meetings_only")
  })

  it("참가사 겸 바이어(같은 행사 한 행)는 어느 역할로 들어와도 같은 값이다", () => {
    const me = { roles: [{ is_exhibitor: true, is_buyer: true, participant_menu: "full" }] }
    expect(resolveParticipantMenu(me, "exhibitor")).toBe("full")
    expect(resolveParticipantMenu(me, "buyer")).toBe("full")
  })

  it("로그인한 역할의 행이 없으면 첫 행의 값으로 떨어진다(값은 행사 단위라 역할과 무관하다)", () => {
    const me = { roles: [{ ...exhibitorRow, participant_menu: "full" }] }
    expect(resolveParticipantMenu(me, "buyer")).toBe("full")
  })

  it("모르는 값이 실린 행은 기본값으로 읽는다", () => {
    expect(resolveParticipantMenu({ roles: [{ ...buyerRow, participant_menu: "everything" }] }, "buyer")).toBe(
      DEFAULT_PARTICIPANT_MENU,
    )
  })
})

describe("participantHomePath — 승인된 참가자의 도착 화면", () => {
  it("미팅만이면 미팅(/meetings) — 대시보드가 메뉴에 없다", () => {
    expect(participantHomePath("meetings_only")).toBe("/meetings")
  })

  it("전체 메뉴는 대시보드(/)", () => {
    expect(participantHomePath("full")).toBe("/")
  })

  it("기본값으로는 미팅에 닿는다", () => {
    expect(participantHomePath(DEFAULT_PARTICIPANT_MENU)).toBe("/meetings")
  })
})
