// smartfill-extraction-client — 회사 자료(PDF/PPT/Word)를 올리면 AI가 전시품목·회사소개를
// 추출해 2~3단계 폼을 prefill 하는 추출 클라이언트(F-BM-002 D7~D11, ADR-0008).
//
// seam: NEXT_PUBLIC_BM_API_BASE 가 있으면 FastAPI `/extract`(presigned 업로드 → S3 key → Claude),
// 없으면 mock(데모 캔드 추출). 키(Claude)는 backend 한정 — FE 는 HTTP 경계만 호출한다.
// 추출 결과는 **초안일 뿐** — 빈 칸만 채우고(사용자 입력 보존), 사용자가 검토·수정 후 확정한다(D9).

import type { BusinessFieldCode, ExhibitorProfileDraft, Product } from "./types"

// 추출 산출물 — 2~3단계가 받는 필드만(부분집합). 그대로 폼 드래프트에 매핑된다.
export interface SmartFillDraft {
  products?: Product[]
  exhibitionCategories?: BusinessFieldCode[]
  introKo?: string
  introEn?: string
}

export interface SmartFillClient {
  // 문서 1개를 추출해 구조화 초안을 돌려준다. 실패/빈 응답이면 throw → UI 는 직접 입력으로 이어간다.
  extract(file: File): Promise<SmartFillDraft>
}

// 데모 캔드 추출 — 실제로는 Claude 가 문서에서 추출. K-콘텐츠 셀러 예시(애니메이션/신기술콘텐츠).
const DEMO_EXTRACTION: SmartFillDraft = {
  products: [
    {
      nameKo: "오리지널 애니메이션 시리즈 '스타빔레인저'",
      nameEn: "Original Animation Series 'StarBeam Rangers'",
      businessField: "content_production",
      hsCode: "8523.49",
      spec: "26부작, 4K HDR, 글로벌 OTT 동시 방영",
    },
    {
      nameKo: "AR 캐릭터 체험 부스 '스타빔 AR'",
      nameEn: "AR Character Experience 'StarBeam AR'",
      businessField: "newtech_content",
      hsCode: "8523.49",
      spec: "실시간 안면인식 캐릭터 합성, 모바일·부스 겸용",
    },
  ],
  exhibitionCategories: ["content_production", "newtech_content"],
  introKo:
    "오리지널 애니메이션과 캐릭터 IP를 기획·제작하는 국내 선도 애니메이션 스튜디오로, 신기술 융합 콘텐츠까지 사업 영역을 넓히고 있습니다.",
  introEn:
    "A leading Korean animation studio creating original series and character IP, now expanding into new-tech convergence content.",
}

function delay<T>(value: T, ms = 1200): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms))
}

export const mockSmartFillClient: SmartFillClient = {
  async extract(file: File) {
    // 데모: 문서 바이트는 읽지 않고 추출된 것처럼 캔드 초안을 ~1.2초 뒤 돌려준다.
    void file
    return delay(DEMO_EXTRACTION)
  },
}

// 백엔드 `/extract` 추출 응답(snake_case) → SmartFillDraft. 백엔드 미구현 시점엔 mock 만 동작.
interface ApiExtraction {
  products?: {
    name_ko: string
    name_en?: string | null
    business_field?: BusinessFieldCode | null
    category_ko?: string | null
    category_en?: string | null
    hs_code?: string | null
    hs_description?: string | null
    spec?: string | null
  }[]
  exhibition_categories?: BusinessFieldCode[]
  intro_ko?: string | null
  intro_en?: string | null
}

export function createHttpSmartFillClient(base: string): SmartFillClient {
  const root = base.replace(/\/$/, "")
  return {
    async extract(file: File) {
      const form = new FormData()
      form.append("file", file)
      const res = await fetch(`${root}/api/bm/exhibitor/extract`, {
        method: "POST",
        credentials: "include",
        body: form,
      })
      if (!res.ok) throw new Error(`extract ${res.status}`)
      const d = (await res.json()) as ApiExtraction
      return {
        products: (d.products ?? []).map((p) => ({
          nameKo: p.name_ko,
          nameEn: p.name_en ?? undefined,
          businessField: p.business_field ?? undefined,
          categoryKo: p.category_ko ?? undefined,
          categoryEn: p.category_en ?? undefined,
          hsCode: p.hs_code ?? undefined,
          hsDescription: p.hs_description ?? undefined,
          spec: p.spec ?? undefined,
        })),
        exhibitionCategories: d.exhibition_categories ?? undefined,
        introKo: d.intro_ko ?? undefined,
        introEn: d.intro_en ?? undefined,
      }
    },
  }
}

export function getSmartFillClient(): SmartFillClient {
  const base = process.env.NEXT_PUBLIC_BM_API_BASE
  return base ? createHttpSmartFillClient(base) : mockSmartFillClient
}

// 실 추출 백엔드(FastAPI `/extract`) 연결 여부 — getSmartFillClient와 같은 스위치(NEXT_PUBLIC_BM_API_BASE)로
// 판정한다. prod 빌드는 이 env를 build-arg로 안 받아 항상 false(Dockerfile·standalone-deploy.yml 미배선) —
// 게다가 백엔드에 `/api/bm/exhibitor/extract` 자체가 아직 없다. 참가사 화면(apply-form)이 이 값으로
// SmartFillBanner 렌더 자체를 막아, 남의 데모 추출값(DEMO_EXTRACTION)이 실사용자 신청서에 저장되는
// 사고를 원천 차단한다(2026-09-10). 로컬 dev(.env.local에 값 있음)·테스트(env 미설정 시 mock)는 그대로.
export function hasRealSmartFillClient(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_BM_API_BASE)
}

// 추출 초안을 드래프트에 매핑 — **빈 칸만** 채운다(사용자 입력 보존, D9). 채운 키를 sources 로 돌려
// "AI 초안" 배지 + 수정 시 배지 해제에 쓴다. 목록(products)은 비어 있을 때만 통째로 채운다.
export function applySmartFill(
  draft: ExhibitorProfileDraft,
  extracted: SmartFillDraft,
): { patch: Partial<ExhibitorProfileDraft>; sources: (keyof ExhibitorProfileDraft)[] } {
  const patch: Partial<ExhibitorProfileDraft> = {}
  const sources: (keyof ExhibitorProfileDraft)[] = []

  const isEmptyStr = (v: string | undefined) => !v || v.trim() === ""

  if ((draft.products ?? []).length === 0 && (extracted.products ?? []).length > 0) {
    patch.products = extracted.products
    sources.push("products")
  }
  if (
    (draft.exhibitionCategories ?? []).length === 0 &&
    (extracted.exhibitionCategories ?? []).length > 0
  ) {
    patch.exhibitionCategories = extracted.exhibitionCategories
    sources.push("exhibitionCategories")
  }
  const scalars = ["introKo", "introEn"] as const
  for (const key of scalars) {
    if (isEmptyStr(draft[key]) && !isEmptyStr(extracted[key])) {
      patch[key] = extracted[key]
      sources.push(key)
    }
  }

  return { patch, sources }
}
