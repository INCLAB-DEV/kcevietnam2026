// 참가자 화면 EN 잔존 방지 가드 — 참가기업·바이어가 닿는 소스에 한글 문자열 리터럴/JSX 텍스트가
// 새로 생기면 실패한다. 화면 문구는 messages/{ko,en}.json(next-intl)으로만 내보낸다는 규칙을 코드로
// 강제하는 것: 리터럴로 박힌 한글은 EN 전환 시 그대로 남는다(2026-10 해외 바이어 대응).
//
// 범위와 예외는 아래 세 표가 전부다 — 새 예외가 필요하면 사유를 적어 이 표에 추가한다(조용한 우회 금지).
//   1. OPERATOR_ONLY  : 운영자·관리자 콘솔 전용(의도적으로 한국어 고정)
//   2. NOT_RENDERED   : 테스트·목업 픽스처처럼 실연동(http) 경로의 참가자 화면에 닿지 않는 파일
//   3. ALLOWED_SCOPES : 참가자 화면 파일 안에서 한글이 정당한 선언(국문 사전·법적 원문·데이터 매칭 키)
//
// 이 가드는 "소스에 한글 문구가 없다"만 본다. 백엔드가 내려주는 값(기업명·알림 payload 등)과 실제
// 렌더 결과는 런타임 스캔(ops/i18n-residue-scan/, 로컬 전용 — 그쪽 README 참고)이 따로 본다.
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

import { listImportSpecifiers, scanSourceForHangul, type HangulHit } from "./hangul-scan"

const FRONTEND_ROOT = path.resolve(__dirname, "../..")
const SCAN_ROOTS = ["app", "components", "lib", "hooks", "proxy.ts"]

// 1) 운영자·관리자 콘솔 전용 — 참가자는 접근할 수 없고, 화면은 한국어로 고정한다(발주사 내부 도구).
//    디렉터리(끝이 "/")는 하위 전체, 파일은 그 파일 하나.
const OPERATOR_ONLY: readonly string[] = [
  "app/admin/",
  "app/organizer/",
  "app/api/admin/",
  "app/api/organizer/",
  "components/admin/",
  "components/organizer/",
  "components/operator/",
  "components/roster/", // 명단 업로드 — /admin·/organizer 에서만 쓴다
  "components/layout/operator-state-panel.tsx", // 운영자 콘솔의 권한 없음·오류 패널
  "components/review-decision-actions.tsx", // 신청서 승인·반려 버튼(운영자 심사)
  "lib/admin/",
  "lib/organizer/",
  "lib/roster/",
  "lib/auth/operator-identity.ts", // 운영자 신원 폴백 표기
]

// 2) 실연동 경로의 참가자 화면에 그려지지 않는 파일.
//    목업 픽스처는 NEXT_PUBLIC_AUTH_CLIENT=http(운영 빌드)의 실 세션에서는 읽히지 않는다 —
//    lib/api-client/server.ts 가 실 세션이면 FastAPI로, 아니면(개발·데모) 이 픽스처로 분기한다.
//    파일명 패턴이 아니라 **명시 목록**이다: "mock"이 이름에 들어갔다는 이유만으로 새 파일이 가드를
//    비껴가지 않게 한다.
const NOT_RENDERED: readonly string[] = [
  "lib/test/", // 테스트 헬퍼
  "lib/mock/", // dev 계정 스위처·목업 세션·초기 seam 픽스처
  "lib/mock-orgs.ts", // 목업 기업 디렉터리
  "lib/home/home-mock.ts",
  "lib/meeting/my-meetings-mock.ts",
  "lib/meeting/mock-availability.ts",
  "lib/notifications/mock.ts",
  "lib/review/mock-review-client.ts",
  "lib/bm/demo-profile.ts", // 목업 세션용 신청서·등록정보 데모값
  "lib/apply/demo-profile.ts",
]
const TEST_FILE = /\.test\.tsx?$/

interface AllowedScope {
  file: string
  /** 허용하는 선언 경로 접두사(hangul-scan의 scope). 빈 문자열이면 파일 전체. */
  scope: string
  reason: string
}

// 3) 참가자 화면 파일 안의 정당한 한글.
const ALLOWED_SCOPES: readonly AllowedScope[] = [
  {
    file: "lib/bm/fields.ts",
    scope: "",
    reason:
      "코드→라벨 사전 모듈(국문/영문 쌍). 국문 쪽은 ko 로케일과 운영자 콘솔(한국어 고정)의 표시 원천이다. " +
      "참가자 화면은 *OptionsFor(locale) 게터로만 읽고, 영문 쪽에 한글이 없다는 건 lib/bm/fields.test.ts가 검증한다.",
  },
  {
    file: "lib/apply/options.ts",
    scope: "",
    reason: "위와 같은 사전 모듈(바이어 신청서용). 영문 쪽 무결성은 lib/apply/options.test.ts가 검증한다.",
  },
  {
    file: "lib/event/current-event.ts",
    scope: "CURRENT_EVENT.ko",
    reason: "행사 표기의 ko 로케일 값(en 값이 쌍으로 있고, 화면은 로케일로 골라 쓴다).",
  },
  {
    file: "lib/auth/mock-auth-client.ts",
    scope: "CONSENT_DOCUMENTS",
    reason:
      "약관 원문(법적 문서). 영문본이 없어 번역 범위 밖이다 — 가입 화면이 이 원문을 그대로 보여준다(법무 확인 후 영문본 추가 예정).",
  },
  {
    file: "lib/auth/mock-auth-client.ts",
    scope: "DEMO_ACCOUNTS",
    reason: "목업 로그인 계정의 가상 인물 이름(실연동 로그인에서는 쓰이지 않는 데이터).",
  },
  {
    file: "lib/bm/smartfill-client.ts",
    scope: "DEMO_EXTRACTION",
    reason: "Smart Fill 목업 추출 결과(가상 데이터). 실 추출 백엔드가 없으면 화면이 배너 자체를 그리지 않는다.",
  },
  {
    file: "lib/discover/filters.ts",
    scope: "TIMELINE_ORDER",
    reason: "목업 기업 디렉터리의 도입 시기 **데이터 값**과 맞추는 정렬 키(화면 문구 아님). 실연동 응답에는 이 필드가 없다.",
  },
  {
    file: "lib/api-client/recommendations.ts",
    scope: "getUrgencyBonus",
    reason: "위와 같은 목업 데이터 값과의 비교 키(점수 가산 조건) — 화면에 그려지지 않는다.",
  },
]

// 한국어 고정 문구의 원천(ko 카탈로그)을 직접 읽어도 되는 유일한 참가자 표면 밖 통로.
// 참가자 화면 소스가 이 둘을 import하면 로케일이 ko로 고정된다(그리고 ko.json이 번들에 통째로 실린다).
const KO_ONLY_MODULES: readonly string[] = ["@/messages/ko.json", "@/lib/i18n/ko-translator"]
const KO_TRANSLATOR_FILE = "lib/i18n/ko-translator.ts"

function listSourceFiles(relative: string): string[] {
  const absolute = path.join(FRONTEND_ROOT, relative)
  if (statSync(absolute).isFile()) return [relative]
  return readdirSync(absolute).flatMap((entry) => {
    const child = path.posix.join(relative, entry)
    if (statSync(path.join(FRONTEND_ROOT, child)).isDirectory()) return listSourceFiles(child)
    return /\.tsx?$/.test(entry) ? [child] : []
  })
}

function matchesPathList(file: string, list: readonly string[]): boolean {
  return list.some((entry) => (entry.endsWith("/") ? file.startsWith(entry) : file === entry))
}

function isExcluded(file: string): boolean {
  return TEST_FILE.test(file) || matchesPathList(file, OPERATOR_ONLY) || matchesPathList(file, NOT_RENDERED)
}

function scopeMatches(entry: AllowedScope, hit: HangulHit): boolean {
  return entry.scope === "" || hit.scope === entry.scope || hit.scope.startsWith(`${entry.scope}.`)
}

function isAllowed(file: string, hit: HangulHit): boolean {
  return ALLOWED_SCOPES.some((entry) => entry.file === file && scopeMatches(entry, hit))
}

function read(file: string): string {
  return readFileSync(path.join(FRONTEND_ROOT, file), "utf8")
}

const allFiles = SCAN_ROOTS.flatMap(listSourceFiles)
const participantFiles = allFiles.filter((file) => !isExcluded(file))

describe("참가자 화면 소스 — 한글 리터럴 잔존 가드", () => {
  it("스캔 대상이 비어 있지 않다(경로가 바뀌어 가드가 조용히 무력화되는 것을 막는다)", () => {
    expect(participantFiles.length).toBeGreaterThan(150)
    expect(participantFiles).toContain("components/meeting/meeting-request-modal.tsx")
    expect(participantFiles).toContain("components/review/review-flow.tsx")
    expect(participantFiles).toContain("app/page.tsx")
  })

  it("허용 목록 밖의 한글 문자열 리터럴·JSX 텍스트가 없다", () => {
    const offenders: string[] = []
    for (const file of participantFiles) {
      for (const hit of scanSourceForHangul(file, read(file))) {
        if (!isAllowed(file, hit)) offenders.push(`${file}:${hit.line} [${hit.scope || "-"}] ${hit.text}`)
      }
    }
    // 로컬 조사용 — 전체 위반 목록을 파일로 떨군다(평소·CI에서는 쓰지 않는다).
    if (process.env.HANGUL_GUARD_DUMP) writeFileSync(process.env.HANGUL_GUARD_DUMP, offenders.join("\n"))
    expect(
      offenders,
      `참가자 화면 소스에 한글 리터럴 ${offenders.length}건 — messages/{ko,en}.json 키로 옮기거나, ` +
        `정당한 예외면 ALLOWED_SCOPES에 사유와 함께 추가하세요:\n${offenders.join("\n")}`,
    ).toEqual([])
  })

  it("참가자 화면 소스는 ko 카탈로그·한국어 고정 번역기를 직접 import하지 않는다", () => {
    const offenders: string[] = []
    for (const file of participantFiles) {
      if (file === KO_TRANSLATOR_FILE) continue // 한국어 고정 번역기 자신(운영자 콘솔·테스트가 쓴다)
      for (const specifier of listImportSpecifiers(file, read(file))) {
        if (KO_ONLY_MODULES.includes(specifier)) offenders.push(`${file} → ${specifier}`)
      }
    }
    expect(
      offenders,
      "참가자 화면은 useTranslations/getTranslations로 현재 로케일 번역기를 얻어야 한다(ko 고정 금지)",
    ).toEqual([])
  })

  it("예외 표에 죽은 항목이 없다(대상이 사라졌는데 예외만 남으면 가드가 헐거워진다)", () => {
    const deadPaths = [...OPERATOR_ONLY, ...NOT_RENDERED].filter(
      (entry) => !allFiles.some((file) => matchesPathList(file, [entry])),
    )
    expect(deadPaths, "더 이상 없는 경로").toEqual([])

    const deadScopes = ALLOWED_SCOPES.filter(
      (entry) =>
        !participantFiles.includes(entry.file) ||
        !scanSourceForHangul(entry.file, read(entry.file)).some((hit) => scopeMatches(entry, hit)),
    )
    expect(
      deadScopes.map((entry) => `${entry.file} [${entry.scope}]`),
      "한글이 더 이상 없는 허용 범위",
    ).toEqual([])
  })

  it("예외 표의 모든 항목에 사유가 적혀 있다", () => {
    for (const entry of ALLOWED_SCOPES) {
      expect(entry.reason.length, `${entry.file} [${entry.scope}]`).toBeGreaterThan(20)
    }
  })
})

describe("scanSourceForHangul — 무엇을 화면 문구 후보로 보는가", () => {
  const scan = (source: string) => scanSourceForHangul("sample.tsx", source)

  it("문자열·템플릿 조각·JSX 텍스트의 한글을 잡는다", () => {
    const hits = scan(
      [
        'const LABEL = "저장"',
        "const greet = (name: string) => `안녕하세요, ${name}님`",
        "export function Box() { return <p>필수 항목이에요.</p> }",
      ].join("\n"),
    )
    expect(hits.map((hit) => [hit.kind, hit.scope])).toEqual([
      ["string", "LABEL"],
      ["template", "greet"],
      ["template", "greet"],
      ["jsx-text", "Box"],
    ])
  })

  it("주석·정규식·console 인자·객체 키는 잡지 않는다(화면에 그려지지 않는다)", () => {
    const hits = scan(
      [
        "// 한글 주석",
        "/* 블록 주석 */",
        "const HANGUL = /[가-힣]/",
        'console.error("[store] 로드 실패", 1)',
        'const KEYS: Record<string, string> = { "예산": "budget" }',
        "export function Box() { return <p>{/* JSX 주석 */}ok</p> }",
      ].join("\n"),
    )
    expect(hits).toEqual([])
  })

  it("선언 경로(scope)는 최상위 선언부터 프로퍼티까지 점으로 잇는다", () => {
    const [hit] = scan('export const EVENT = { ko: { name: "엑스포" }, en: { name: "Expo" } }')
    expect(hit.scope).toBe("EVENT.ko.name")
  })
})
