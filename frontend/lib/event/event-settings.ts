// 행사별로 뒤집을 수 있는 운영 정책값. "베트남 전시는 부스만/참가사 상호열람 금지" 같은 규칙을
// 화면·데이터 계층에 하드코딩하지 않고 이 mock 설정 하나로 몰아, 다음 행사(다른 나라·다른 운영
// 방식)에서 값만 바꾸면 정책이 뒤집히게 한다. 어드민 콘솔(별도 작업)이 같은 스키마(venue_types,
// allow_same_role_discovery)로 토글 UI를 만들 예정이므로 필드 이름을 여기 타입에 맞춘다.
// mock→실연동 교체 시 이 모듈만 FastAPI 행사 설정 API 호출로 바꾸면 된다(ADR-0008과 동일 패턴).

// 미팅 장소 유형(F-MT-001). booth=참가사 부스, matching_zone=비즈매칭존 테이블, business_room=비즈니스 룸.
export type VenueType = "booth" | "matching_zone" | "business_room"

export interface EventSettings {
  // 미팅 신청 모달(F-MT-001)에서 선택 가능한 장소 유형. 베트남 전시 기본값은 부스뿐이다
  // (비즈매칭존 테이블·비즈니스 룸·바이어석이 없다). 값이 1개면 화면은 자동 선택 요약으로 단순화한다.
  venueTypes: VenueType[]
  // 기업 탐색(F-DV-001)에서 같은 역할(참가사↔참가사, 바이어↔바이어) 상호 열람을 허용할지.
  // 베트남 전시 기본값은 false — 참가기업은 다른 참가기업을 볼 수 없다.
  allowSameRoleDiscovery: boolean
}

// mock 값 — 베트남 전시 확정 정책(2026-08-28). 실연동 시 FastAPI 행사 설정 API 응답으로 교체.
export const MOCK_EVENT_SETTINGS: EventSettings = {
  venueTypes: ["booth"],
  allowSameRoleDiscovery: false,
}

export function getEventSettings(): EventSettings {
  return MOCK_EVENT_SETTINGS
}
