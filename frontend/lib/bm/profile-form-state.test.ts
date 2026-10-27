import { describe, expect, it } from "vitest"
import {
  SAVE_VALIDATED_STEPS,
  STEP1_SAVE_EXCLUDE_KEYS,
  applyStepPatch,
  canSubmit,
  cleanProducts,
  clampStep,
  completedSteps,
  isStepComplete,
  stepFromQuery,
  stepPatch,
  stepSavePayload,
} from "./profile-form-state"
import type { ExhibitorProfileDraft } from "./types"

// 외부 동작만 검증한다(폼 내부 상태 X) — PRD Testing Decisions.
// 단계: 1 기본정보 · 2 회사소개 · 3 전시품목 · 4 타겟.

describe("stepFromQuery / clampStep — ?step=N 진입", () => {
  it("유효 단계는 그대로, 범위 밖/비숫자는 폴백한다", () => {
    expect(stepFromQuery("3")).toBe(3)
    expect(stepFromQuery("5")).toBe(5)
    expect(stepFromQuery("0")).toBe(1)
    expect(stepFromQuery("9")).toBe(5) // TOTAL_STEPS 로 클램프
    expect(stepFromQuery("abc")).toBe(1)
    expect(stepFromQuery(null)).toBe(1)
    expect(stepFromQuery("")).toBe(1)
  })

  it("clampStep 은 1~5 범위로 강제한다", () => {
    expect(clampStep(-2)).toBe(1)
    expect(clampStep(2.9)).toBe(2)
    expect(clampStep(100)).toBe(5)
  })
})

describe("applyStepPatch — 단계별 부분 저장 / 이어쓰기", () => {
  it("그 단계 필드만 병합하고 다른 단계 값은 보존한다", () => {
    let draft: ExhibitorProfileDraft = {}
    draft = applyStepPatch(draft, 1, {
      organizationNameKo: "가상콘텐츠",
      organizationNameEn: "Virtual Content",
    })
    draft = applyStepPatch(draft, 2, { introKo: "소개", introEn: "intro" })
    draft = applyStepPatch(draft, 3, { exhibitionCategories: ["content_production"] })

    // 1~3단계 값이 모두 보존된다(여러 단계 쓰고 나갔다 들어오면 보존).
    expect(draft.organizationNameKo).toBe("가상콘텐츠")
    expect(draft.introKo).toBe("소개")
    expect(draft.exhibitionCategories).toEqual(["content_production"])
  })

  it("단계 밖 키는 무시한다(엉뚱한 단계 필드 누수 방지)", () => {
    const draft = applyStepPatch({}, 1, {
      organizationNameKo: "A",
      introKo: "회사소개(2단계 필드)", // 1단계 PATCH 에 섞여 들어옴 → 무시돼야 함
    })
    expect(draft.organizationNameKo).toBe("A")
    expect(draft.introKo).toBeUndefined()
  })

  it("같은 단계 재저장은 그 단계만 덮어쓴다", () => {
    let draft = applyStepPatch({}, 1, { organizationNameKo: "old", mainTel: "02-1" })
    draft = applyStepPatch(draft, 1, { organizationNameKo: "new" })
    expect(draft.organizationNameKo).toBe("new")
    expect(draft.mainTel).toBe("02-1") // 미제공 키는 보존
  })

  it("기본정보로 이동한 담당자도 1단계 PATCH 로 저장된다", () => {
    const draft = applyStepPatch({}, 1, { attendees: [{ email: "a@example.com" }] })
    expect(draft.attendees).toEqual([{ email: "a@example.com" }])
  })
})

describe("stepPatch — 단계 페이로드 추출", () => {
  it("드래프트에서 해당 단계 키만 골라낸다", () => {
    const draft: ExhibitorProfileDraft = {
      organizationNameKo: "A",
      introKo: "소개",
      products: [{ nameKo: "P" }],
      preferredBuyerCountries: ["uae"],
    }
    expect(stepPatch(draft, 1)).toEqual({ organizationNameKo: "A" })
    expect(stepPatch(draft, 2)).toEqual({ introKo: "소개" })
    expect(stepPatch(draft, 3)).toEqual({ products: [{ nameKo: "P" }] })
    expect(stepPatch(draft, 4)).toEqual({ preferredBuyerCountries: ["uae"] })
  })
})

describe("전시품목 복수 입력", () => {
  it("제품명(국문) 없는 빈 줄은 저장에서 제거한다", () => {
    const cleaned = cleanProducts([
      { nameKo: "웹툰 A", spec: "주간 연재" },
      { nameKo: "  " }, // 빈 줄
      { nameKo: "음원 B" },
    ])
    expect(cleaned).toHaveLength(2)
    expect(cleaned.map((p) => p.nameKo)).toEqual(["웹툰 A", "음원 B"])
  })
})

describe("단계 완료 / 제출 게이트 — 사업자등록번호는 게이트 아님(D4)", () => {
  const complete: ExhibitorProfileDraft = {
    // 1 기본정보
    organizationNameKo: "가상콘텐츠",
    organizationNameEn: "Virtual Content",
    attendees: [{ firstNameKo: "김담당", email: "lead@example.com" }],
    // 2 회사소개
    introKo: "회사 소개",
    introEn: "Company intro",
    // 3 전시품목 (제품명 국/영 + 사업분야(분야 선택) + HS코드 필수)
    products: [
      {
        nameKo: "웹툰 시리즈",
        nameEn: "Webtoon Series",
        businessField: "webtoon_production",
        hsCode: "4911.91",
      },
    ],
    exhibitionCategories: ["webtoon_production"],
    // 4 타겟은 모두 선택 — 게이트 없음
  }

  it("모든 편집 단계가 채워지면 제출 가능", () => {
    expect(completedSteps(complete)).toEqual([1, 2, 3, 4])
    expect(canSubmit(complete)).toBe(true)
  })

  it("사업자등록번호가 비어 있어도 제출 가능하다(미입력 비차단)", () => {
    const noBizNo = { ...complete, businessRegNo: undefined }
    expect(canSubmit(noBizNo)).toBe(true)
    expect(isStepComplete(noBizNo, 1)).toBe(true)
  })

  it("기업명 영문이 없으면 1단계 미완 → 제출 불가", () => {
    expect(isStepComplete({ ...complete, organizationNameEn: undefined }, 1)).toBe(false)
    expect(canSubmit({ ...complete, organizationNameEn: undefined })).toBe(false)
  })

  it("담당자가 없어도 1단계 완료·제출 가능(2026-09-09 ADR-0012 개정: 셀프가입 0명 제출 허용)", () => {
    // 담당자는 제출 게이트가 아니다 — 백엔드 _validate_submit도 참가사 담당자를 요구하지 않는다.
    expect(isStepComplete({ ...complete, attendees: [] }, 1)).toBe(true)
    expect(isStepComplete({ ...complete, attendees: undefined }, 1)).toBe(true)
    expect(canSubmit({ ...complete, attendees: [] })).toBe(true)
  })

  it("기업소개 국/영이 없으면 2단계(회사소개) 미완", () => {
    expect(isStepComplete({ ...complete, introEn: undefined }, 2)).toBe(false)
  })

  it("전시품목/분야가 비면 3단계 미완", () => {
    expect(isStepComplete({ ...complete, products: [] }, 3)).toBe(false)
    expect(isStepComplete({ ...complete, exhibitionCategories: [] }, 3)).toBe(false)
  })

  it("제품의 제품명 국/영·사업분야가 비면 3단계 미완(HS코드는 게이트 아님, 2026-09-12: K-콘텐츠 판권 거래엔 HS코드 개념이 없다)", () => {
    const full = complete.products![0]
    // 국문명만 있는 제품 → 미완
    expect(isStepComplete({ ...complete, products: [{ nameKo: "제품" }] }, 3)).toBe(false)
    // 항목별 누락도 각각 미완
    expect(isStepComplete({ ...complete, products: [{ ...full, nameEn: undefined }] }, 3)).toBe(false)
    expect(isStepComplete({ ...complete, products: [{ ...full, businessField: undefined }] }, 3)).toBe(false)
    // HS코드는 선택 입력(실물 상품인 경우만) — 없어도 완료로 본다.
    expect(isStepComplete({ ...complete, products: [{ ...full, hsCode: undefined }] }, 3)).toBe(true)
    // 여러 제품 중 하나라도 미완이면 미완
    expect(isStepComplete({ ...complete, products: [full, { nameKo: "B" }] }, 3)).toBe(false)
  })

  it("타겟(4단계)은 모두 선택이라 항상 완료로 본다", () => {
    expect(isStepComplete({}, 4)).toBe(true)
  })
})

// ── 저장 페이로드(작성 폼·프로필 섹션 편집 공용) ───────────────────────────────
describe("stepSavePayload — 한 단계의 저장용 PATCH 바디", () => {
  it("1단계는 부스 스냅샷을 빼고 나머지 기본정보만 담는다(운영자 배정값 덮어쓰기 방지)", () => {
    const draft: ExhibitorProfileDraft = {
      organizationNameKo: "가상콘텐츠",
      businessRegNo: "123-45-67890",
      companyEmail: "hello@vc.com",
      hall: "7",
      pavilion: "대한민국관",
      boothLocation: "A-101",
      boothType: "독립부스",
      boothCount: 2,
      // 다른 단계 필드는 애초에 담기지 않는다.
      introKo: "국문 소개",
    }
    const payload = stepSavePayload(draft, 1)
    expect(payload.businessRegNo).toBe("123-45-67890")
    expect(payload.companyEmail).toBe("hello@vc.com")
    for (const key of STEP1_SAVE_EXCLUDE_KEYS) {
      expect(payload).not.toHaveProperty(key)
    }
    expect(payload).not.toHaveProperty("introKo")
  })

  it("3단계는 빈 제품 줄을 떨어뜨린 제품 목록으로 전체 교체한다", () => {
    const payload = stepSavePayload(
      {
        products: [{ nameKo: "웹툰" }, { nameKo: "   " }, { nameKo: "" }],
        exhibitionCategories: ["webtoon_production"],
      },
      3
    )
    expect(payload.products).toEqual([{ nameKo: "웹툰" }])
    expect(payload.exhibitionCategories).toEqual(["webtoon_production"])
  })

  it("제품이 아예 없으면 빈 목록을 보내 서버의 목록을 비운다(전체 교체 단위)", () => {
    expect(stepSavePayload({}, 3).products).toEqual([])
  })

  it("2·4단계는 그 단계가 소유한 필드를 그대로 담는다", () => {
    expect(stepSavePayload({ introKo: "국문", introEn: "EN", website: "https://x" }, 2)).toEqual({
      introKo: "국문",
      introEn: "EN",
      website: "https://x",
    })
    expect(
      stepSavePayload({ preferredBuyerTypes: ["media"], introKo: "국문" }, 4)
    ).toEqual({ preferredBuyerTypes: ["media"] })
  })

  it("미팅 불가 시간대는 4단계 소유 필드지만 운영자 전용이라 경계 매핑에서 빠진다(payload엔 남아도 API 바디로 안 나간다)", () => {
    // 이 모듈은 드래프트 단위 계약만 책임진다 — snake_case 경계에서 제외되는 건
    // lib/bm/http-exhibitor-client(CAMEL_TO_SNAKE)가 보장하고, 백엔드가 422로 막는다.
    expect(stepSavePayload({ unavailableMeetingSlots: ["2026-09-16T09:00"] }, 4)).toEqual({
      unavailableMeetingSlots: ["2026-09-16T09:00"],
    })
  })

  it("저장 전 필수 검사는 2·3단계만 — 1단계 필수(회사명)는 UI에서 읽기전용이라 게이트가 아니다", () => {
    expect([...SAVE_VALIDATED_STEPS]).toEqual([2, 3])
  })
})
