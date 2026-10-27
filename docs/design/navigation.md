# NABI 네비게이션 / 크롬 시스템

> **🧩 이 문서는 새 프로토타입을 만들 때 적용하는 "표준 레이아웃"이다** — 현재 상태 설명이 아니라 *규약*. 새 화면도 이 틀(글로벌 nav + 화면종류별 크롬) 위에서 시작한다. (`/prototype` 스킬로 만들 때도 동일)
> 모든 프로토타입이 공유하는 **글로벌 네비게이션 + 화면 크롬(틀) 규칙**.
> 구현: `docs/prototypes/nabi-ui.css` (디자인 토큰 + 공유 크롬 CSS) + `docs/prototypes/nabi-nav.js` (반응형 글로벌 nav 컴포넌트).
> 관련: [`component-audit.md`](./component-audit.md), [`../page-list.csv`](../page-list.csv)

---

## 1. 왜 이게 있나 (Explanation)

프로토타입을 각각 만들다 보니 화면마다 nav/크롬이 제각각이었다 — 어떤 화면은 백버튼이 좌상단, 어떤 화면은 하단 탭, 데스크톱은 백지인 경우도 있었다. 모바일·데스크톱을 오가며 접근하는 서비스라 **일관성**이 깨지면 바로 제품 개발로 못 넘어간다.

해결: **단일 소스 두 개**로 묶었다.
- `nabi-ui.css` — 디자인 토큰(색·radius·폰트·모션) + 공유 크롬 컴포넌트 CSS
- `nabi-nav.js` — 글로벌 nav를 **주입**하는 컴포넌트 하나. 페이지는 `<script>` 한 줄 + 활성 탭만 지정하면 끝. 메뉴를 바꾸면 이 파일 한 곳만 고치면 전 화면에 반영된다.

---

## 2. 글로벌 네비게이션 (메뉴)

메뉴 항목·순서는 `nabi-nav.js`의 `ITEMS` 배열 한 곳에서만 관리한다.

| key | 라벨 | 목적지 | 비고 |
|-----|------|--------|------|
| `home` | 홈 | `/` | **로고 터치 = 홈** (동일 목적지). 현재 placeholder(alert), **향후 개발 필요** |
| `discover` | 기업 탐색 | `prototype-discover.html` (`/discover`) | DV-001 |
| `meetings` | 내 미팅 | `prototype-my-meetings.html` (`/meetings`) | MY-001 |
| `profile` | 내 정보 | `prototype-profile.html` (`/profile`) | BM-004/005 |

**반응형 패턴 (핵심):** 같은 `.app-bar` 컴포넌트 하나가 **컨테이너 폭**에 따라 전환된다.
- 넓은 컨테이너 (≥600px) → 상단 **인라인 메뉴**
- 좁은 컨테이너 (모바일 프레임 포함) → **햄버거(☰) → 드로어**

컨테이너 쿼리(`@container (min-width: 600px)`) 기반이라, 모바일/데스크톱 구분이 아니라 **실제 폭**으로 전환된다. 데스크톱 창을 좁혀도 자동으로 햄버거가 된다.

---

## 3. 단일 소스 반응형 셸 (레이아웃 체계 — 표준)

> **⚠️ 표준 변경 (2026-06-06):** 기존의 "모바일 `.phone-frame` + 별도 데스크톱 `.dk-card`(480px) 이중 렌더 + `setView` 재배치" 방식은 **폐기**됐다. 데스크톱이 가로 공간을 못 쓰고(모바일 카드가 가운데 박힘), 함수명이 페이지마다 제각각이며, 일부 화면이 데스크톱 백지였다. 이제 **동일 DOM 하나가 폭에 따라 reflow하는 단일 셸**을 쓴다.

**핵심: 페이지는 콘텐츠를 `.app-shell` 안에 단 한 번만 렌더한다.** 모바일↔데스크톱 차이는 JS 재렌더가 아니라 **CSS 컨테이너 쿼리**로 처리한다.

```html
<div class="app-shell">                         <!-- nabi-nav.js 가 app-bar 주입 -->
  <main class="app-main">
    <div class="app-content [content-narrow|content-form]" id="페이지RENDER_ID">
      … 콘텐츠 (한 번만 렌더) …
    </div>
  </main>
</div>
```

- `.app-shell` = inline-size **쿼리 컨테이너** (전체폭). 콘텐츠는 "셸 폭"에 반응 → 실제 데스크톱/모바일 뷰포트 + 개발용 폰 프리뷰가 **동일 CSS**로 reflow.
- 모든 레이아웃 분기는 `@media`가 아니라 **`@container shell (min-width: …)`** 로 작성.
- `.app-content` 폭(`nabi-ui.css`): 기본 1040px(리스트/대시보드/타임라인) · `.content-form` 720px(폼/위저드) · `.content-narrow` 560px(상세/리뷰).

**화면 종류별 폭/레이아웃:**

| 종류 | 해당 화면 | 폭 클래스 | 데스크톱 처리 |
|------|-----------|-----------|---------------|
| **루트 탭** | discover · my-meetings · profile | discover=기본(그리드) · my-meetings=기본(풀폭 타임라인) · profile=`content-form` | 가로 공간 활용(그리드/풀폭) |
| **상세** | company-detail | 모달=중앙 다이얼로그(`sm:max-w-xl`) · 폴백=`content-form` | 기본=여러 페이지 공유 모달(`useOrgDetail` — 기업 탐색·내 미팅 등) · 딥링크 폴백=720px 중앙 컬럼+백버튼(F-DV-001 D8) |
| **리뷰** | meeting-review | `content-narrow` | 560px 중앙 카드 |
| **폼/위저드** | apply · apply-seller | `content-form` | 720px 중앙 폼 |
| **모달** | meeting · company-detail | 기본 | 좁음=바텀시트 / 넓음(`@container ≥720`)=중앙 다이얼로그. meeting은 공유 호스트(`useMeetingRequest`)로 상세·AI 카드 등 "미팅 신청" 전 지점에서 열림 |

**규칙 3개 (불변):**
1. **단일 렌더** — 콘텐츠는 `.app-content` 한 곳에 한 번만 렌더. `dk-card`/`desktop-mode`/뷰별 재렌더 금지.
2. **컨테이너 쿼리로 reflow** — 모바일/데스크톱 분기는 `@container shell (min-width:…)`. 뷰포트 `@media`는 셸 바깥(예: index.html 사이드바)에서만.
3. **글로벌 nav 단일성** — 글로벌 nav는 `nabi-nav.js`가 `.app-shell` 상단에 주입하는 app-bar 하나. 로컬 `dk-nav`/`bottom-nav` 금지.

> ⚠️ **폐기된 클래스(신규 금지):** `.phone-frame`(프로덕션) · `.dk-nav`/`.dk-container`/`.dk-card` · `body.desktop-mode` · `.bottom-nav` · 페이지별 `switchView`/`setView`. (nabi-ui.css에 레거시 정의는 남아있으나 미전환 외부 파일 호환용일 뿐.)

> **개발용 'Mobile/Desktop' 프리뷰:** 별도 DOM이 아니라 `body.preview-mobile` 토글이 셸 폭을 390px 폰 베젤로 제약할 뿐. 동일 콘텐츠가 동일 컨테이너 쿼리로 모바일 레이아웃으로 reflow한다. 토글 함수는 `setPreview('mobile'|'desktop')` 로 통일.

---

## 4. 새 페이지에 nav/셸 붙이기 (How-to)

1. `<head>`에 토큰/크롬 링크 (캐시 무력화 위해 `?v=날짜` 버전 쿼리 필수):
   ```html
   <link rel="stylesheet" href="nabi-ui.css?v=20260607">
   ```
2. 본문을 단일 셸로 감싼다(콘텐츠는 `#RENDER_ID` 한 곳에 한 번만 렌더):
   ```html
   <div class="app-shell">
     <main class="app-main">
       <div class="app-content content-form" id="myPage"> … </div>
     </main>
   </div>
   ```
3. `</body>` 바로 앞에 nav 설정 + 컴포넌트:
   ```html
   <script>
     window.NABI_NAV_ACTIVE = 'profile';            // home | discover | meetings | profile
     window.NABI_NAV_USER   = { name: '김도현', avatar: '김' };
   </script>
   <script src="nabi-nav.js?v=20260607"></script>
   ```
   nabi-nav.js는 `.app-shell`을 감지해 app-bar 하나만 주입한다(`.app-shell`이 없으면 레거시 이중 주입으로 폴백). 또한 모바일 프리뷰 상태(`?view=mobile`)를 `sessionStorage`로 유지해 nav/버튼으로 이동해도 데스크톱으로 튀지 않게 한다.

> **⚠️ 공유 에셋 캐시:** `nabi-ui.css`/`nabi-nav.js`를 수정하면 **모든 페이지의 `?v=` 값을 갱신**해야 한다(브라우저 캐시로 옛 스타일이 박히는 것 방지 — 폰 프리뷰에서 드로어/모달이 프레임 밖으로 새는 증상이 대표적). `docs/prototypes`에서 한 번에:
> `perl -i -pe 's/(nabi-ui\.css|nabi-nav\.js)\?v=\d+/$1?v=새날짜/g' prototype-*.html`
4. 모바일/데스크톱 차이는 `@container shell (min-width: 720px) { … }` 로. 역할/유저 런타임 변경은 `window.__nabiSetUser('한화에어로스페이스', '한')`.
5. (선택) 개발용 프리뷰 토글:
   ```js
   function setPreview(mode){ document.body.classList.toggle('preview-mobile', mode==='mobile');
     document.querySelectorAll('.view-toggle-btn').forEach(b=>b.classList.toggle('active', b.textContent.trim().toLowerCase().indexOf(mode)!==-1)); }
   ```

**검증:** 데스크톱(전체폭)에서 가로 공간 활용(좌우 거대 여백·480 락 없음). `setPreview('mobile')` 또는 브라우저 폭 축소 시 **동일 DOM**이 햄버거 + 모바일 레이아웃으로 reflow. 데스크톱 백지 금지.

> **⚠️ 컨테이너 쿼리 함정:** 같은 셀렉터의 `display`를 base(쿼리 밖)와 `@container` 양쪽에 두면 소스 순서에 따라 base가 이겨 분기가 깨질 수 있다. **display 분기는 base에 두지 말고** narrow/wide 쿼리가 전 구간을 분할하게 하거나, `@container` 규칙을 base 정의 **뒤에** 배치할 것. (discover 덱/그리드, meeting 모달 중앙정렬에서 실제로 겪음.)

---

## 5. `nabi-nav.js` 레퍼런스

| 전역 | 타입 | 설명 |
|------|------|------|
| `window.NABI_NAV_ACTIVE` | string | 활성 탭 key (`home`/`discover`/`meetings`/`profile`). 없으면 활성 표시 없음 |
| `window.NABI_NAV_USER` | `{name, avatar}` | 앱바 우측 유저 표시. 기본 `{name:'', avatar:'·'}` |
| `window.__nabiSetUser(name, avatar)` | fn | 주입된 모든 앱바/드로어의 유저 표시 갱신 (역할 전환용) |
| `window.__nabiHome()` | fn | 홈 이동(현재 placeholder alert) |

**주입 동작:** 로드 시 `.app-shell`이 있으면(표준) 그 안 최상단에 app-bar 1개 + 드로어 1개만 주입한다. `.app-shell`이 없으면(레거시 미전환 파일) 폴백으로 (1) `.phone-frame` 안에 모바일 앱바, (2) `<body>` 최상단에 데스크톱 앱바(`.app-bar.dk-only`)를 이중 주입한다.

---

## 6. `nabi-ui.css` 레퍼런스 (요약)

**디자인 토큰** (색은 전부 placeholder — 컬러 시스템 미확정):
- 색/표면/텍스트: `--bg-primary/secondary/elevated`, `--border-default`, `--text-primary/secondary/tertiary`
- 액센트/시맨틱: `--accent-primary`(임시 블루), `--color-success/danger/warning`(+`-subtle`), `--color-gold`
- 미팅 상태(도메인 enum): `--status-accepted/proposed/noshow/empty`
- radius: `--radius-sm`(4) `--radius-md`(8) `--radius-lg`(12) `--radius-full`
- 간격: `--space-1..10` (4px 스케일) · 폰트: `--font-sans`(Pretendard) · 모션/보더 토큰
- **구버전 별칭**: `--accent-green/red/amber` → success/danger/warning, `--status-success/warning/error` → 동일, `--radius-xl` → lg, `--font-stack` → sans. (기존 프로토타입의 `var()` 참조 호환)

**반응형 셸 클래스(표준):** `.app-shell`(쿼리 컨테이너) · `.app-main`(스크롤 영역) · `.app-content`(+`.content-narrow` 560 / `.content-form` 720, 기본 1040) · `body.preview-mobile`(개발용 폰 베젤). 레이아웃 분기는 `@container shell (min-width:…)`.

**공유 크롬 클래스:** `.app-bar` `.app-bar-logo` `.app-bar-menu` `.app-bar-link` `.app-bar-user/-avatar` `.hamburger` · `.nav-drawer(.fixed)` `.nav-drawer-scrim` `.nav-drawer-item`

**레거시(신규 금지):** `.phone-frame(.has-app-bar)` · `.dk-only`/`.dk-nav`/`.dk-container`/`.dk-card` · `body.desktop-mode` · `.bottom-nav` — 미전환 외부 파일 호환용으로만 존재.

전체 컴포넌트 카탈로그·정렬 이력은 [`component-audit.md`](./component-audit.md) 참고.

---

## 7. 검토 필요 (Open Decisions)

| # | 항목 | 현재 | 검토 내용 |
|---|------|------|-----------|
| N-1 | **입력 플로우의 글로벌 nav 표시 여부** | 표시 중 (apply/apply-seller에 글로벌 nav 노출) | 프로필 작성 폼(BM-001/BM-002) 같은 입력/위저드 플로우에서는 글로벌 nav를 **숨기고 최소 헤더(닫기 + 스텝)만** 두는 패턴도 흔하다(작성 중 이탈 방지). 어느 쪽으로 갈지 결정 필요. |
| N-2 | **홈(`/`) 목적지** | placeholder(alert) | "홈" = 로고 = 동일 목적지. 향후 홈 화면을 개발해 실제 라우트 연결 필요. |
| N-3 | ~~discover 데스크톱 레이아웃 백지~~ | **해결됨 (2026-06-06)** | 단일 셸 전환으로 좁음=스와이프 덱 / 넓음=추천 카드 그리드(`@container shell`). 백지/480 락 제거. |
| N-4 | **색 시스템 확정 반영** | 토큰 placeholder(블루 등) | 디자인 방향 니어 모노크롬 확정 시 `nabi-ui.css` 색 토큰만 그레이스케일로 교체 → 전 화면 반영. |
| N-5 | **단일 셸 마이그레이션 현황** | **전 활성 페이지 완료 (2026-06-06)** | discover·company-detail·my-meetings·profile·apply·apply-seller·meeting-review·meeting + index.html(허브) 모두 단일 셸 반응형 전환 완료. `prototype-biz-matching.html`·`prototype.html`은 `docs/archive/`로 이관(미전환). |

> 결정 시 `/grill-with-docs` 로 따져가며 이 문서를 갱신하는 흐름 권장.
