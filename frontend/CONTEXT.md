# Frontend Context (Next.js 표현 레이어)

> **먼저 루트 `CONTEXT.md`(공유 커널)를 읽을 것.** 사용자 유형·매칭·프로세스 등 도메인 용어는 전부 거기서 정의된다. 이 파일은 프론트엔드 표현 레이어 *고유* 용어만 보완한다.

프론트엔드는 **DB에 직접 접속하지 않는다.** 모든 데이터는 FastAPI API 호출로 받는다(ADR-0008, `backend/CONTEXT.md`). 따라서 이 컨텍스트의 언어는 *표현·라우팅·디자인 시스템*에 한정된다.

## Language

**Role-based Route (역할별 라우트)**:
동일 기능이라도 바이어와 참가사는 대체로 별도 라우트를 갖는다. 프로필은 바이어 `/profile`(BM-004), 참가사 `/exhibitor/profile`(BM-005); 신청은 `/apply`(BM-001) vs `/exhibitor/apply`(BM-002). **예외 — 미팅 타임라인(MY-001 `/meetings`)은 전원 공용 단일 라우트**이며 화면 안에서 역할별 뷰로 분기. **로그인 후 첫 랜딩**은 역할로 분기한다: 운영자 → `/organizer`, 바이어·참가사 → **`/welcome`**(아래).
_Avoid_: 통합 라우트, 공유 경로

**Pre-service Landing (`/welcome`, 비즈매칭 모집)**:
nav 있는 본 서비스에 **아직 들어가지 못한** 바이어·참가사가 사는 단독 랜딩(글로벌 nav 없음). `AppShellForRequest` 밖에서 렌더한다(`/login`과 동일 패턴 — "AppShell 밖"). 두 부류를 한 화면에서 분기한다 — ① 역할만 있고 비즈매칭 미참여, ② 참여했으나 미승인. **신청기간(`events.application_start/end`) × `application_status`(ADR-0009)** 조합으로 안내·동선을 고른다: 신청서 작성 → 폼 / 주최국 확인 중(`submitted`, 폼 잠금) / 보완 후 재제출(`changes_requested`) / 반려 문의(`rejected`, 종단) / 미팅 신청 대기중(`approved`·신청기간 중) / 입장하기(`approved`·신청기간 종료) / 신청 마감(미제출·기간 종료). **nav 접근 = `approved` AND 신청기간 종료**(둘 다 필요), **apply 폼 진입 = 신청기간 중 AND status ∈ {registered, changes_requested}**. 게이트 규칙은 `frontend/docs/adr/0002`.
_Avoid_: 대기실(중의적), 홈(/와 혼동), 인트로

**Nav/Chrome System (공유 크롬)**:
모든 페이지의 글로벌 내비게이션·헤더·하단탭은 단일 시스템으로 통일한다. 표준은 `docs/design/navigation.md`. `<head>`에 `nabi-ui.css`, `</body>` 앞에 `window.NABI_NAV_ACTIVE`/`NABI_NAV_USER` + `nabi-nav.js`. **로컬 dk-nav/하단탭 중복 금지.**
_Avoid_: 로컬 nav, 페이지별 헤더

**Design Token Pipeline (디자인 토큰)**:
시각 값의 계통이 **둘로 분리**돼 있다 — 어느 쪽을 만지는지 먼저 가릴 것.
- **제품(`frontend/`) = `frontend/app/globals.css`**(Tailwind v4 `@theme`)가 스타일의 진실원천이다. Next.js 제품 코드는 `tokens/`도 `nabi-ui.css`도 **import하지 않는다** — 제품의 색·타이포·간격 수정은 **`globals.css`에서** 한다.
- **프로토타입(`docs/prototypes/` 정적 HTML) = `tokens/`(W3C DTCG JSON) → `node tokens/build-css.mjs` → `nabi-ui.css`** 파이프라인. Figma "NABI Design System" 변수와 라운드트립한다. **`nabi-ui.css`의 토큰값을 손으로 고치지 말 것** — `tokens/` 수정 후 빌드.

즉 `tokens/`는 *프로토타입 계통의* 단일 소스이지 제품 스타일의 소스가 아니다. 둘의 값이 어긋나면 각자의 소스에서 따로 고친다(자동 동기화 없음).
_Avoid_: 하드코딩 색상값, nabi-ui.css 직접 수정, 제품 스타일을 `tokens/`에서 찾기(제품은 globals.css)

**Prototype (프로토타입)**:
구현 전 UI를 확정하는 정적 HTML. `docs/prototypes/prototype-{페이지명}.html`. 데모용 5개 기업은 완성도 우선, 나머지는 카드만.
_Avoid_: 목업(임의 사용), 데모 페이지

## 참조

- 페이지 목록: `docs/page-list.csv` (기능 ID ↔ `docs/prd/F-*.md` 1:1)
- 디자인 시스템: `docs/design/` (navigation.md, component-audit.md, tokens-figma-roundtrip.md)
- 프론트 한정 아키텍처 결정: `frontend/docs/adr/` (0001 API client/server 분리, 0002 welcome 랜딩·nav 게이트)
