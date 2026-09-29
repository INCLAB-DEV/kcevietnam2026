// OP-005 QA B4 — "배정하면 바이어·참가사 화면과 참가기업 관리까지 상태가 같이 바뀌어야 한다".
//
// 배정 한 건은 여러 화면의 서버 데이터를 동시에 낡게 만든다. 그 목록을 여기 한 곳에 적어두고
// 서버 액션(assignment-refresh.ts)이 그대로 무효화한다 — 화면이 늘면 이 배열만 고친다.
//
// 왜 revalidatePath인가: 이 화면들은 전부 `export const dynamic = "force-dynamic"`이라 **서버**
// 캐시는 없다. 낡는 건 브라우저의 Client Cache(방문·프리페치한 라우트의 RSC 페이로드)다 —
// 배정하고 "참가기업 관리"로 이동하면 프리페치해 둔 옛 페이로드가 그대로 그려진다. revalidatePath는
// 서버 캐시와 함께 이 Client Cache도 무효화한다(Next 16 glossary "Client Cache" 참고).
//
// 참가자(바이어·참가사) 화면이 목록에 있는 이유: 데모·개발은 같은 브라우저에서 dev 스위처(?as=)로
// 역할을 갈아타므로 그쪽 Client Cache도 같이 비워야 한다. 다른 사람의 브라우저까지 즉시 밀어주는
// 것은 아니다 — 그건 폴링/웹소켓의 몫이고, 그 화면들도 force-dynamic이라 다음 진입에 새로 그려진다.
export interface AssignmentRefreshPath {
  path: string
  // 동적 세그먼트가 있는 라우트는 원본 경로 + type을 넘겨야 한다(revalidatePath 계약).
  type?: "page" | "layout"
}

export const ASSIGNMENT_REFRESH_PATHS: readonly AssignmentRefreshPath[] = [
  { path: "/organizer/forced-matching" }, // 배정 그리드(이 화면)
  { path: "/organizer/members" }, // 참가기업 관리 — 매칭 건수·상태 열
  { path: "/organizer/members/[organizationId]", type: "page" }, // 기업 상세의 미팅 일정
  { path: "/organizer" }, // 운영 대시보드(OP-001 배정 지표)
  { path: "/meetings" }, // 참가자 내 미팅
  { path: "/" }, // 참가자 홈 — 오늘 일정·미팅 상태 카드
  { path: "/notifications" }, // 배정 알림(B3)
]
