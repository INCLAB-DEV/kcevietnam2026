// 소스 코드 속 "화면에 나갈 수 있는 한글"을 찾는 정적 스캐너 — hangul-guard.test.ts(참가자 화면 EN
// 잔존 방지 가드)의 엔진이다. 정규식으로 줄을 훑지 않고 TypeScript AST를 걷는다: 주석·정규식 리터럴은
// 화면에 나가지 않으므로 건드리지 않고, 문자열 리터럴·템플릿 리터럴·JSX 텍스트만 본다.
//
// 허용 판정은 "파일 + 선언 경로(scope)"로 한다 — 예: lib/bm/fields.ts 의 BUSINESS_FIELD_LABELS 안은
// 허용(운영자 콘솔이 쓰는 국문 사전), 같은 파일의 다른 곳은 불허. 줄 번호로 허용하면 코드가 한 줄만
// 밀려도 깨지고, 파일 통째로 허용하면 그 파일에 새로 들어온 한글 UI 문자열을 놓친다.
import ts from "typescript"

const HANGUL = /[ㄱ-ㆎ가-힣]/

export type HangulHitKind = "string" | "template" | "jsx-text"

export interface HangulHit {
  /** 리터럴이 시작하는 줄(1-base). */
  line: number
  kind: HangulHitKind
  /** 리터럴 원문(공백 정리, 최대 80자) — 실패 메시지에서 사람이 위치를 찾는 용도. */
  text: string
  /**
   * 리터럴을 감싼 선언 경로 — 최상위 선언 이름부터 프로퍼티 이름까지 점으로 잇는다.
   * 예: `CURRENT_EVENT.ko.name`, `BUSINESS_FIELD_LABELS.game_production`, `DemoPanel`(컴포넌트 안 JSX).
   * 어떤 선언에도 속하지 않으면 빈 문자열.
   */
  scope: string
}

function nameOf(node: ts.Node): string | null {
  if (
    (ts.isVariableDeclaration(node) ||
      ts.isFunctionDeclaration(node) ||
      ts.isClassDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isPropertyAssignment(node) ||
      ts.isPropertyDeclaration(node) ||
      ts.isEnumDeclaration(node) ||
      ts.isEnumMember(node) ||
      ts.isTypeAliasDeclaration(node) ||
      ts.isInterfaceDeclaration(node) ||
      ts.isPropertySignature(node)) &&
    node.name
  ) {
    const name = node.name
    if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text
  }
  return null
}

function scopeOf(node: ts.Node): string {
  const parts: string[] = []
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    const name = nameOf(current)
    if (name !== null) parts.unshift(name)
  }
  return parts.join(".")
}

// console.*(…) 인자 — 개발자 콘솔 로그라 화면에 그려지지 않는다(브라우저 devtools/서버 로그 전용).
function isConsoleArgument(node: ts.Node): boolean {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (
      ts.isCallExpression(current) &&
      ts.isPropertyAccessExpression(current.expression) &&
      ts.isIdentifier(current.expression.expression) &&
      current.expression.expression.text === "console"
    ) {
      return true
    }
    // 함수 경계를 넘으면 더 이상 "그 console 호출의 인자"가 아니다.
    if (ts.isFunctionLike(current)) return false
  }
  return false
}

// 객체 리터럴의 **키**로 쓰인 문자열(`{ "한글": 1 }`)과 프로퍼티 접근 키는 값이 아니라 식별자다 —
// 그대로 화면에 나가는지는 값 쪽 리터럴이 판정하므로, 키는 스코프 이름으로만 쓰고 hit로 세지 않는다.
function isPropertyName(node: ts.Node): boolean {
  const parent = node.parent
  return (
    parent !== undefined &&
    (ts.isPropertyAssignment(parent) || ts.isPropertySignature(parent) || ts.isEnumMember(parent)) &&
    parent.name === node
  )
}

function clip(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length > 80 ? `${flat.slice(0, 77)}...` : flat
}

function sourceFileOf(fileName: string, source: string): ts.SourceFile {
  const scriptKind = fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  return ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, scriptKind)
}

/** 파일이 import(정적·동적·re-export)하는 모듈 지정자 목록 — 예: `"@/messages/ko.json"`. */
export function listImportSpecifiers(fileName: string, source: string): string[] {
  const file = sourceFileOf(fileName, source)
  const specifiers: string[] = []
  const visit = (node: ts.Node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text)
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      specifiers.push(node.arguments[0].text)
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return specifiers
}

/** 파일 하나에서 한글이 든 문자열 리터럴·템플릿 조각·JSX 텍스트를 전부 찾는다(주석·정규식·console 인자 제외). */
export function scanSourceForHangul(fileName: string, source: string): HangulHit[] {
  const file = sourceFileOf(fileName, source)
  const hits: HangulHit[] = []

  const push = (node: ts.Node, kind: HangulHitKind, text: string) => {
    if (!HANGUL.test(text)) return
    if (isConsoleArgument(node)) return
    const { line } = file.getLineAndCharacterOfPosition(node.getStart(file))
    hits.push({ line: line + 1, kind, text: clip(text), scope: scopeOf(node) })
  }

  const visit = (node: ts.Node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      if (!isPropertyName(node)) push(node, "string", node.text)
    } else if (ts.isTemplateExpression(node)) {
      // 보간(${…}) 사이의 고정 조각만 본다 — 보간식 안의 리터럴은 아래 재귀가 따로 잡는다.
      push(node.head, "template", node.head.text)
      for (const span of node.templateSpans) push(span.literal, "template", span.literal.text)
    } else if (ts.isJsxText(node)) {
      push(node, "jsx-text", node.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return hits
}
