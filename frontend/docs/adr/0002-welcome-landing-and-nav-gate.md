# /welcome 입장 전 랜딩 + nav 접근 게이트(승인 AND 신청기간 종료)

프론트엔드(표현 레이어) 한정 결정. 참가자 게이트의 **데이터층 진실**(`application_status` 상태머신, "참가자=approved", "매칭 노출=approved만")은 루트 ADR-0009를 따른다 — 이 ADR은 그 게이트를 **로그인 후 라우팅·접근 제어·랜딩 화면**에 어떻게 앉히는지를 정한다.

## 배경

ADR-0009는 `organization_event_roles.application_status`(`registered → submitted → {approved | changes_requested | rejected}`, `changes_requested → submitted`)와 "참가자 판정 = `approved`"를 데이터층에 확립했다. 백엔드·`schema.sql`은 이미 이 머신을 구현·테스트(pytest)했다.

그러나 프론트는 뒤처져 있었다:
- `/exhibitor/apply`가 `AppShellForRequest`(글로벌 nav/사이드바)로 감싸져 있어, **아직 본 서비스에 들어올 자격이 없는 미승인 참가사**에게도 nav가 노출됐다.
- `lib/auth/participant-gate.ts`는 `registered | submitted` 2상태만 알고 **"제출 = 참가자"** 로 판정 — ADR-0009의 "승인 = 참가자"와 충돌.
- 로그인 후 미승인 참가사/바이어가 어디에 착지하는지(랜딩) 정의가 없었다.

핵심 도메인 규칙(2026-06-29 확정): **nav 있는 본 서비스(미팅·기업탐색·프로필)는 비즈매칭 신청기간이 끝나고(8/26~9/11 종료) 운영 승인을 받은 기업만 들어간다.** 승인은 입장권이고, 문은 신청기간이 끝나야 열린다 — **둘 다** 필요하다.

## 결정

### 1. `/welcome` — 입장 전 단일 랜딩(단독, nav 없음)

로그인 후 첫 랜딩을 역할로 분기한다: 운영자 → `/organizer`, **바이어·참가사 → `/welcome`**. `/welcome`은 `/login`과 같이 `AppShellForRequest` **밖**에서 렌더하는 단독 화면이며, 두 부류를 한 곳에서 받는다 — ① 역할만 있고 비즈매칭 미참여, ② 참여했으나 미승인. `application_status` × 신청기간으로 안내·**액션**을 고른다(참가사 기준):

| `application_status` | 신청기간 **중** (안내 + 액션) | 신청기간 **종료** |
|---|---|---|
| `registered`(미제출) | "신청서 작성" 안내 · **작성 전=`신청서 작성하기`** / **작성 완료(필수항목 충족)=`수정하기` + `제출하기`** | "신청 마감" 안내(종단) |
| `changes_requested` | 보완 요청 안내 + `review_note` 배너 · **`수정하기` + `다시 제출하기`** | "신청 마감"(재제출 불가) + 문의 |
| `submitted`(미승인) | "주최국 확인 중"(제출 후 잠금) · **`신청서 보기`(읽기전용)** | "주최국 확인 중"(승인은 기간 종료 후 진행) |
| `approved` | "미팅 신청 대기중"(입장 전) · **`신청서 보기`(읽기전용)** | "비즈니스 미팅 기업 찾기" → 본 서비스 진입(`/`) |
| `rejected` | 반려 안내 + 주최측 문의(종단) · **`신청서 보기`(읽기전용)** | 반려 안내 + 주최측 문의(종단) |

화면 enum 매핑(`status` × {open, closed} → 화면)은 **순수 함수**(`lib/bm/welcome-view.ts`)로 두어 단위 테스트로 가두고, 페이지는 결과만 렌더한다. 상태별 **액션 버튼**은 별도 클라이언트 컴포넌트(`ApplicationActions`)가 status를 보고 고른다. `rejected`(종단·`review_note` 비노출)와 `changes_requested`(재제출 가능·`review_note` 배너)는 **다른 상태**다 — 합치지 않는다.

> **저장 vs 제출 분리(2026-06-30):** 신청서 폼(`/apply`·`/exhibitor/apply`)은 **드래프트 '저장'만** 한다(마지막 버튼 = `저장하고 나가기` → `/welcome`). **제출(`application_status` 전환)은 폼이 아니라 `/welcome`의 액션**에서 일어난다 — 작성·저장과 제출을 사용자에게 명확히 구분한다(§4). `registered`는 **작성 전**(필수 미충족 = 작성하기)과 **작성 완료**(필수 충족 = 수정하기 + 제출하기)로 갈리고, 첫 제출도 `/welcome`에서 한다.

### 2. nav 접근 게이트 = `approved` AND 신청기간 종료

route-guard(`lib/auth/route-guard` + `proxy.ts`)의 nav 접근 판정을 **승인 상태로 확장**한다:

- **nav 화면 진입(`/`, `/meetings`, `/discover`, `/profile`, `/exhibitor/profile`, `/notifications`) = `approved` AND 신청기간 종료.** 미충족 참가자 → `/welcome`로 redirect. (기존 `SERVICE_OPENS_AT` 단독 타이밍 게이트를 이 합성 게이트가 대체. **미인증 사용자에게는 nav 화면 진입 경로가 없다** — 라우트 가드가 `/login`으로 redirect(게스트 탐색·`/discover`·`/meetings` 미인증 둘러보기 폐지, 2026-07-02). 이 합성 게이트는 인증 참가자에만 적용.)
- **apply 폼 진입(`/exhibitor/apply`·`/apply`) = 신청기간 중**(전 status 허용). 폼이 `application_status`로 편집/읽기전용을 정한다 — `registered`/`changes_requested`=편집, `submitted`/`approved`/`rejected`=읽기전용("신청서 보기", 수정 동선 차단). **신청기간 종료 후에는 status와 무관하게 잠금**(→ `/welcome`). (종전 "registered/changes_requested만 진입, 나머지 → /welcome"을, 읽기전용 '신청서 보기'를 폼이 지원하면서 **진입은 허용하되 폼이 잠그는** 방식으로 갱신 — 2026-06-30. 제출 후 잠금의 결과는 동일.)
- **`approved` 참가자가 `/welcome` 진입** → 신청기간 종료면 본 서비스 home(`/`)로 redirect, 신청기간 중이면 "미팅 신청 대기중" 표시. (route-guard의 nav 허용 조건 `approved AND 종료`와 정확히 일치시켜 `/`↔`/welcome` 리다이렉트 루프 방지 — `enter-service`는 '종료'에서만 나오고 '시작 전' approved는 대기로 둔다.)
- **운영자(organizer)는 이 게이트와 무관하게 항상 통과**(자기 대시보드 `/organizer`).

게이트가 `application_status`를 보려면 세션에 status가 실려야 한다 — dev mock(`?as` / `toGuardSession`)에 status를 주입한다. 실연동 시 Cognito 세션 + FastAPI가 내려준 status로 교체(ADR-0009 승인 워크플로 산출물).

### 3. 제출 후 잠금 — BM-005 정책 반전

종전(체크포인트/BM-005)은 "신청기간이면 제출 후에도 수정 가능"이었다. **본 ADR로 반전한다: 제출(`submitted`)하면 폼 잠금.** 제출 후 내용을 바꾸는 유일한 경로는 운영자가 `changes_requested`로 돌려보내는 것뿐(→ 다시 `submitted`로 재제출). 이는 ADR-0009의 "제출=원자적 트랜잭션, 승인 워크플로는 운영 소관"과 정합하며, `submitted`(검토 대기 중 내용 변경)로 인한 검토-대상 표류를 막는다.

**읽기전용 렌더(2026-06-30):** 잠금 status(`submitted`/`approved`/`rejected`)로 폼에 들어오면 편집 폼 대신 **읽기전용 "신청서 보기"** 를 렌더한다 — 참가사=`ProfileView`(수정 버튼 없음), 바이어=`StepReview readOnly`(단계별 수정 버튼 숨김). 단독 화면이라 nav가 없으니 **"돌아가기"(→ `/welcome`)** 버튼을 둔다. 편집/읽기전용 판단의 단일 소스는 **세션 `application_status`(페이지가 prop으로 주입)** 다 — mock 드래프트 스토어의 status가 아니라(dev `?status`는 세션 쿠키에만 반영돼 스토어와 어긋나므로).

### 4. 저장 vs 제출 분리 — 폼은 저장, 제출은 `/welcome` (2026-06-30)

신청서 폼은 **드래프트 '저장'만** 책임진다(각 단계 자동 저장 + 마지막 버튼 `저장하고 나가기` → `/welcome`). status를 `submitted`로 올리는 **제출은 `/welcome`의 `ApplicationActions`** 가 수행한다(§1 표). 이유: 작성·저장(언제든 이어쓰기)과 제출(되돌릴 수 없는 검토 제출)을 사용자에게 명확히 구분한다. `registered`의 첫 제출도 폼이 아니라 `/welcome`에서(필수항목 충족 시 `제출하기` 노출).

- **(구) 예외 — Visitor 전환 진입 폐지(2026-07-02):** 종전엔 미팅 게이트 경유로 들어온 미인증 Visitor(바이어 전환)가 `/welcome` 없이 폼에서 직접 제출·전환했다. 미인증 사용자의 서비스 페이지 진입 자체가 폐지되면서 이 예외도 사라졌다 — 모든 제출은 `/welcome`에서만 일어난다(예외 없음).
- **로그인 후 status 주입:** 로그인 결과의 `application_status`를 `landingHref`가 `?status`로 실어 보내 dev 세션 상태(쿠키)에 반영한다 → `/welcome`이 제출 상태를 정확히 보여준다.

### 5. 제출 확인 — 되돌릴 수 없음 안내

`제출하기`/`다시 제출하기`는 **확인 다이얼로그(shadcn `AlertDialog`)** 를 거친다: "제출하면 수정할 수 없어요 — 신청서가 잠기고, 주최 측 보완 요청 때만 다시 수정 가능. 지금 제출할까요?" (취소 / 제출). 되돌릴 수 없는 동작이라 일반 Dialog가 아닌 확인 전용 AlertDialog를 쓴다.

## 검증 (acceptance)

- `lib/bm/welcome-view.ts` 순수 함수 단위 테스트: 5 status × {신청기간 중·종료·시작 전} 전 칸(시작 전 `approved`는 `meeting-waiting` — 루프 방지).
- `lib/auth/route-guard` 테스트 확장: 미승인 참가사가 nav 경로 → `/welcome` redirect, `approved`+기간종료 → 허용, 운영자 면제, 신청기간 중 apply는 전 status 진입 허용·종료 후 잠금, `/api/*` 게이트 제외.
- `/welcome`·`/exhibitor/apply`·`/apply`(인증 분기) 모두 `AppShellForRequest`를 import하지 않는다(단독 렌더). (구 Visitor 전환 `/apply`의 `VisitorShell` 경로는 폐지 — 2026-07-02.)
- 읽기전용("신청서 보기")·돌아가기·제출 확인(AlertDialog)·저장하고 나가기 동선은 Playwright(MCP) 라이브로 참가사·바이어 양쪽 검증.

## Considered Options

- **승인 게이트가 타이밍 게이트를 완전 대체(`approved`만으로 nav, 기각):** 신청기간 중 승인된 기업이 본 서비스에 조기 입장 → "신청기간이 끝나야 매칭 시작"(ADR-0006) 위배. 타이밍 차원이 필요.
- **6상태를 `/exhibitor/apply` 한 페이지에 욱여넣기(기각):** apply가 폼+상태안내+라우팅을 다 짊어져 복잡. 안내·라우팅은 `/welcome`, 폼은 `/exhibitor/apply`로 책임 분리가 더 단순.
- **`rejected`/`changes_requested`를 하나로 합치기(기각):** 재제출 가능 여부가 정반대 — 사용자 동선이 갈린다.
- **`/welcome` + 합성 nav 게이트 + 제출 후 잠금(채택).**

## 미해결 / 후속

- **dev 드래프트 미리보기:** 완성도(`submittable`)는 클라 스토어에서 읽는데, 참가사 in-memory 스토어는 리로드 시 비어 항상 '작성하기'로 보인다 → `/welcome` 스위처에 dev `?draft=empty|done` 토글을 둬 작성전/완료를 검증한다. prod·실연동(FastAPI status·완성도) 시 제거.
- 운영자 승인/반려 **행위** UI(운영자 슬라이스)는 본 ADR 범위 밖 — 이 게이트는 status를 **읽기만** 한다.
- **읽기전용 "신청서 보기" 데이터:** dev 직접진입 시 스토어에 드래프트가 없어 "미입력"으로 보인다(렌더는 정상). 실연동 시 FastAPI가 status·드래프트를 함께 내려주면 해소.
- **바이어 BM-001 폼**은 별도 워크트리에서 진행 — `/welcome`·게이트·읽기전용은 역할 공용으로 적용했고, 폼 본체 통합은 머지 시 정합.

Status: accepted
