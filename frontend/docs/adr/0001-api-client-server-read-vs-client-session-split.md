# api-client seam을 서버 전용 read / 클라 호출 session으로 분리

프론트엔드(표현 레이어) 한정 결정. 시스템 전역 데이터-소유 결정은 루트 ADR-0008(FastAPI가 모든 DB 접근 소유)을 따른다 — 이 ADR은 그 seam을 **Next.js RSC 모듈 그래프 경계**에 어떻게 앉히는지를 정한다.

## 배경

`lib/api-client`는 "데이터가 어디서 오는가"를 한 곳으로 모으는 seam이다(ADR-0008, 단일 변경점 수렴). 초기 구현(#83/#90)은 단일 `apiClient` 값 하나에 read(조회)와 session/mutation(로그아웃·피드백·알림 읽음)을 함께 담고, `index.ts`가 그 값을 내보냈다.

문제는 Next.js의 모듈 그래프 전파다. `discover-tabs.tsx`·`app-sidebar.tsx`는 `"use client"`이면서 피드백 전송·로그아웃을 위해 `apiClient` **값**을 import했다 → 그 단일 객체가 들어있는 `mock.ts`가 **클라이언트 모듈 그래프**에 포함됐다 → `mock.ts`가 read 메서드에서 `await import("./recommendations")` 등으로 끌어오던 픽스처·점수 휴리스틱이 **지연 클라이언트 청크**로 분리돼 `.next/static/chunks` 아래에 다운로드 가능한 상태로 남았다. 동적 import는 "서버에서만 실행"은 보장했지만 "클라 번들에서 도달 불가"는 보장하지 못했다(codex 교차검수, 2026-06-27, #94).

read 메서드 11개(`getRecommendations`·`getOrganizations`·`getMembers`·`getMeetingAvailability` 등)가 모두 같은 구조여서, 한 메서드만 고치면 형제와 불일치가 생긴다. 홀리스틱하게 경계를 옮긴다.

## 결정

`ApiClient`를 구현 레벨에서 **두 표면으로 분리**하고, 각 표면이 서로 다른 모듈 그래프에 살게 한다.

- **`lib/api-client/server.ts` — `serverApiClient: ReadApiClient`.** 모든 read(`get*`). 파일 첫 줄 `import "server-only"`로 봉인 → client component가 import하면 **빌드 타임에 실패**한다. 봉인이 경계를 강제하므로 read 픽스처는 동적 import 트릭 없이 **정적 import**한다. 서버 컴포넌트(`app/*/page.tsx`)에서만 호출.
- **`lib/api-client/session.ts` — `sessionApiClient: SessionApiClient`.** session/mutation(`logout`·`recordRecommendationFeedback`·알림 읽음 계열). 클라 안전 모듈(`notifications/store`·`inbox`)·스텁만 정적 import → client component가 안전하게 import.
- **`lib/api-client/index.ts` — 타입 전용 배럴.** 값을 한 곳에서 내보내면 client가 그걸 import하는 순간 read 그래프가 다시 끌려온다. 그래서 값은 내보내지 않고 타입(`ApiClient`·`ReadApiClient`·`SessionApiClient`·`Viewer`·`MatchResult`)만 내보낸다.

`ApiClient = ReadApiClient & SessionApiClient`는 형상 호환용 타입으로만 남긴다 — **런타임 구현은 절대 합치지 않는다**.

## 검증 (acceptance)

프로덕션 빌드(`next build`) 후 클라 청크를 grep:

```
grep -rc "computeRecommendations" .next/static/chunks/   # → 모든 청크 0
grep -rl "ALL_MOCK_ORGS\|MOCK_MEMBERS\|buildMeetingAvailability" .next/static/chunks/  # → 없음
```

클라 청크에는 `MatchResult`의 **렌더링 필드**(`aiScore`·`aiReasons`)만 남는다 — 이는 `recommendation-card`/`swipe-deck`가 결과를 그리는 정상 투영이며, 점수 **알고리즘**(`computeRecommendations`·`function score`·키워드 유사도)은 클라에서 도달 불가다.

## 실연동 (ADR-0008 유지)

단일 변경점 수렴은 그대로다 — 다만 수렴점이 **두 어댑터 파일**로 갈린다: read는 `server.ts` 1개를 FastAPI read 어댑터로, session/mutation은 `session.ts`를 별도로 교체한다. 호출처(서버 page·클라 컴포넌트)는 그대로다.

## Considered Options

- **단일 `apiClient` 유지 + read에 동적 import (기각):** "서버에서만 실행"은 되지만 클라 그래프 도달 가능 → `.next/static/chunks`로 픽스처·휴리스틱 누출. 본 이슈가 고치려는 상태.
- **`getRecommendations`만 분리 (기각):** 형제 read 10개와 불일치, org/member/schedule 데이터 구멍은 그대로.
- **React `taint` API (보강용, 미채택 단독안):** 런타임 데이터 흐름은 막지만 모듈 그래프 포함(번들 emit) 자체는 못 막는다. `server-only` 봉인이 빌드 타임 경계로 더 강하다.
- **서버 read / 클라 session 분리 + `server-only` 봉인 (채택).**

Status: accepted
