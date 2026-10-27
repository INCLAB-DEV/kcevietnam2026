import { describe, expect, it } from "vitest"
import {
  assignInterpreter,
  assignedOrgIds,
  languageLabel,
  parseLanguages,
  toLangCodes,
  validateInterpreter,
} from "./interpreters"
import type { AdminInterpreter } from "./types"

function itp(id: string, orgId: string | null = null): AdminInterpreter {
  return {
    id,
    event_id: "evt-test",
    name: `통역사 ${id}`,
    languages: ["영어"],
    phone: "010-0000-0000",
    email: null,
    assigned_org_id: orgId,
    assigned_org_name: orgId ? `기업 ${orgId}` : null,
  }
}

describe("통역사 입력 검증", () => {
  const valid = { name: "정하윤", languages: "영어, 베트남어", phone: "010-1111-2222", email: "" }

  it("이름·언어·연락처가 갖춰지면 통과", () => {
    const result = validateInterpreter(valid)
    expect(result.valid).toBe(true)
    if (!result.valid) return
    expect(result.name).toBe("정하윤")
    expect(result.languages).toEqual(["영어", "베트남어"])
    expect(result.phone).toBe("010-1111-2222")
    expect(result.email).toBeNull()
  })

  it("이름이 비면 막는다", () => {
    const result = validateInterpreter({ ...valid, name: "   " })
    expect(result.valid).toBe(false)
    if (!result.valid) expect(result.errors).toContain("name-required")
  })

  it("언어가 하나도 없으면 막는다", () => {
    const result = validateInterpreter({ ...valid, languages: " , , " })
    expect(result.valid).toBe(false)
    if (!result.valid) expect(result.errors).toContain("languages-required")
  })

  it("전화·이메일 둘 다 비면 막는다 (현장 연락 불가)", () => {
    const result = validateInterpreter({ ...valid, phone: "", email: "" })
    expect(result.valid).toBe(false)
    if (!result.valid) expect(result.errors).toContain("contact-required")
  })

  it("이메일만 있어도 통과한다", () => {
    const result = validateInterpreter({ ...valid, phone: "", email: "a@b.example" })
    expect(result.valid).toBe(true)
  })

  it("언어 입력은 공백·중복을 정리한다", () => {
    expect(parseLanguages(" 영어 , 베트남어 , 영어 ,")).toEqual(["영어", "베트남어"])
  })
})

describe("통역사 배정 — 기업당 1명", () => {
  it("배정하면 해당 통역사에 기업이 붙는다", () => {
    const next = assignInterpreter([itp("a"), itp("b")], "a", "org-1", "한울디펜스")
    expect(next[0].assigned_org_id).toBe("org-1")
    expect(next[0].assigned_org_name).toBe("한울디펜스")
    expect(next[1].assigned_org_id).toBeNull()
  })

  it("같은 기업을 맡고 있던 다른 통역사는 자동 해제된다 (기업당 1명 불변식)", () => {
    const next = assignInterpreter([itp("a", "org-1"), itp("b")], "b", "org-1", "한울디펜스")
    expect(next[0].assigned_org_id).toBeNull()
    expect(next[0].assigned_org_name).toBeNull()
    expect(next[1].assigned_org_id).toBe("org-1")
  })

  it("null 배정은 해제다 — 다른 통역사에는 영향이 없다", () => {
    const next = assignInterpreter([itp("a", "org-1"), itp("b", "org-2")], "a", null, null)
    expect(next[0].assigned_org_id).toBeNull()
    expect(next[1].assigned_org_id).toBe("org-2")
  })

  it("배정된 기업 id 집합을 돌려준다", () => {
    expect(assignedOrgIds([itp("a", "org-1"), itp("b"), itp("c", "org-2")])).toEqual(
      new Set(["org-1", "org-2"]),
    )
  })

  it("원본 배열을 변형하지 않는다", () => {
    const list = [itp("a", "org-1"), itp("b")]
    assignInterpreter(list, "b", "org-1", "한울디펜스")
    expect(list[0].assigned_org_id).toBe("org-1")
    expect(list[1].assigned_org_id).toBeNull()
  })
})

describe("언어 코드 변환 — 왕복 안전(H6)", () => {
  it("한글 라벨은 코드로 매핑한다", () => {
    expect(toLangCodes(["영어", "베트남어"])).toEqual(["en", "vi"])
  })

  it("이미 코드값이면 그대로 통과한다 — 수정 후 재저장해도 깨지지 않는다", () => {
    // backend InterpreterOut.languages는 코드로 내려온다("vi, en") — 수정 다이얼로그를 열고
    // 그대로 저장만 해도 이 코드값들이 다시 서버로 나간다. 예전엔 매핑에 없어 "other"로 깨졌다.
    expect(toLangCodes(["vi", "en"])).toEqual(["vi", "en"])
    expect(toLangCodes(["ko", "zh", "ja", "ru", "other"])).toEqual([
      "ko",
      "zh",
      "ja",
      "ru",
      "other",
    ])
  })

  it("코드값으로 저장 → 다시 읽기를 반복해도 값이 유지된다", () => {
    const original = ["vi", "en"]
    const roundTripped = toLangCodes(toLangCodes(toLangCodes(original)))
    expect(roundTripped).toEqual(original)
  })

  it("매핑에 없는 오탈자만 other로 떨어진다", () => {
    expect(toLangCodes(["불어"])).toEqual(["other"])
  })
})

describe("언어 코드 → 표시 라벨(#16②, 표시 전용)", () => {
  it("코드값을 한글 라벨로 바꾼다", () => {
    expect(languageLabel("en")).toBe("영어")
    expect(languageLabel("vi")).toBe("베트남어")
    expect(languageLabel("other")).toBe("기타")
    expect(languageLabel("ko")).toBe("한국어")
    expect(languageLabel("zh")).toBe("중국어")
    expect(languageLabel("ja")).toBe("일본어")
    expect(languageLabel("ru")).toBe("러시아어")
  })

  it("이미 한글 라벨이면 그대로 돌려준다(저장 직후 낙관적 상태)", () => {
    expect(languageLabel("영어")).toBe("영어")
  })

  it("코드로 저장 → 라벨로 표시해도 toLangCodes 왕복 안전은 그대로 유지된다", () => {
    // 표시 계층(languageLabel)은 저장 계층(toLangCodes)에 영향을 주지 않는다 — 라벨을 다시
    // toLangCodes에 넣으면 원래 코드로 돌아온다.
    const code = "vi"
    const label = languageLabel(code)
    expect(toLangCodes([label])).toEqual(["vi"])
  })
})
