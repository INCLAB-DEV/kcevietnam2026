// api-client seam — 타입 전용 배럴. 런타임 구현은 컨텍스트별로 분리해 import한다(frontend ADR-0001):
//   • 서버 컴포넌트(읽기): `@/lib/api-client/server`의 serverApiClient (server-only로 봉인)
//   • 클라 컴포넌트(세션/뮤테이션): `@/lib/api-client/session`의 sessionApiClient
// 값(apiClient)을 한 곳에서 내보내면 client component가 그것을 import하는 순간 read 어댑터의
// mock 픽스처·점수 휴리스틱까지 클라 모듈 그래프로 끌려온다 — 그래서 여기선 타입만 내보낸다.
// 실연동 시 변경점은 두 어댑터 파일(server/session)로 수렴한다(ADR-0008).
export type {
  ApiClient,
  ReadApiClient,
  SessionApiClient,
  Viewer,
  MatchResult,
} from "./types"
