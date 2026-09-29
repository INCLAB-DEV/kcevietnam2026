import { describe, expect, test } from "vitest"
import { toFormState, toProfilePatch, type ProfileFormState } from "./profile-editor"
import type { AdminOrgProfile } from "@/lib/admin/types"

const baseForm: ProfileFormState = {
  business_reg_no: "",
  website: "",
  representative_name: "",
  company_email: "",
  main_tel: "",
  address: "",
  country: "",
  org_type: "",
  annual_sales: "",
  employee_range: "",
  categories: [],
  company_intro_ko: "",
  company_intro_en: "",
  contact_name: "",
  contact_title: "",
  contact_email: "",
  contact_phone: "",
  contact_language: "",
  interpreter_need: false,
  budget_range: "",
  adoption_timeline: "",
  booth_label: "",
  products: [],
  available_languages: [],
  preferred_buyer_countries: [],
  preferred_buyer_types: [],
}

describe("admin profile product editor", () => {
  test("loads the complete exhibitor product rows into the form", () => {
    const profile = {
      exhibitor_products: [
        {
          name_ko: "지휘통제 시스템",
          name_en: "Command System",
          business_field: "content_production",
          hs_code: "8517.62",
          price_range: "krw_70_100m",
          spec: "주요 사양",
        },
      ],
    } as AdminOrgProfile

    expect(toFormState(profile).products).toEqual(profile.exhibitor_products)
  })

  test("preserves product fields when building an exhibitor patch", () => {
    const form: ProfileFormState = {
      ...baseForm,
      products: [
        {
          name_ko: "수정된 제품명",
          name_en: "Updated Product",
          business_field: "game_production",
          hs_code: "8523.49",
          price_range: "krw_50_70m",
          spec: "변경된 사양",
        },
      ],
    }

    expect(toProfilePatch(form, "exhibitor")).toMatchObject({
      products: form.products,
    })
  })
})
