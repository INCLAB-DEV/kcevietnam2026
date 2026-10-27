// 명단 업로드 템플릿 — 두 콘솔(/admin/organizations·/organizer/members)이 **같은 파일**을 내려준다.
//
// 헤더는 회원가입 필드 키(name_ko·name_en·contact_name·contact_email·contact_phone)에 id·role·country·
// content_category를 더한 것이다. 백엔드 파서(backend/app/roster/parser.py HEADER_ALIASES)가 이 키와
// 옛 헤더(name·tab·담당자·이메일·category …)를 모두 받는다.
//   · id — 행마다 고유한 값(재업로드 시 같은 id면 갱신). 적재의 멱등 키다(registrants(event_id,
//     organizer_member_id) 유일키 + 담당자 계정이 이 키로 묶인다). 비우면 파서가 담당자 이메일(로그인
//     아이디, 소문자)로 채운다 — 발주사 행사 양식은 아이디 칸이 비어 온다.
//   · role — 비우면 업로드 화면에서 고른 명단 구분(참가기업/바이어)을 따른다.
//   · contact_email — 로그인 아이디. 공통 비밀번호는 파일이 아니라 업로드 화면에서만 입력한다
//     (파일에 비밀번호 컬럼이 있으면 서버가 거부한다 — 원본 파일이 보관되기 때문).
//
// 맨 앞 UTF-8 BOM은 Excel에서 한글이 깨지지 않게 하는 용도다. 편집 도구가 보이지 않는 문자를 지우는
// 경우가 있어 리터럴 대신 코드포인트로 만든다.

const BOM = String.fromCharCode(0xfeff)

export const ROSTER_TEMPLATE_FILENAME = "sales-ai-roster-template.csv"

export const ROSTER_TEMPLATE_HEADERS = [
  "id",
  "role",
  "name_ko",
  "name_en",
  "country",
  "contact_name",
  "contact_email",
  "contact_phone",
  "content_category",
] as const

// 예시 행은 누가 봐도 가짜여야 한다(example.com 예약 도메인). 지우지 않고 올리면 미리보기가 경고한다.
export const TEMPLATE_EXAMPLE_EMAIL_DOMAIN = "example.com"

const EXAMPLE_ROWS: readonly (readonly string[])[] = [
  ["example-ex-001", "참가기업", "예시콘텐츠(주)", "Example Contents Inc.", "대한민국", "홍길동", "exhibitor@example.com", "010-0000-0000", "방송"],
  ["example-by-001", "바이어", "Example Buyer Co.", "Example Buyer Co.", "베트남", "Nguyen Van A", "buyer@example.com", "+84-00-0000-0000", ""],
]

// RFC4180: 쉼표·따옴표·개행 포함 시 따옴표로 감싸고 내부 따옴표는 이중화.
function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

export function rosterTemplateCsv(): string {
  const lines = [ROSTER_TEMPLATE_HEADERS.join(","), ...EXAMPLE_ROWS.map((row) => row.map(csvCell).join(","))]
  return BOM + lines.join("\r\n") + "\r\n"
}

export function isTemplateExampleEmail(email: string | null | undefined): boolean {
  return !!email && email.trim().toLowerCase().endsWith(`@${TEMPLATE_EXAMPLE_EMAIL_DOMAIN}`)
}
