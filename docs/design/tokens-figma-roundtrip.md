# 디자인 토큰 ↔ Figma 라운드트립

프로토타입을 **프로덕트 수준**으로 디벨롭하기 위한 토큰 파이프라인. 핵심 원칙:
**토큰 JSON이 단일 소스**, CSS·Tailwind·Figma는 모두 거기서 파생되는 출력물.

```
            ┌──────────────────────────┐
            │  tokens/*.tokens.json     │  ← 단일 소스 (W3C DTCG)
            │  primitive/ + semantic/   │
            └────────────┬─────────────┘
                         │ node tokens/build-css.mjs
          ┌──────────────┼───────────────┬──────────────┐
          ▼              ▼               ▼              ▼
   nabi-ui.css     (Tailwind config)   Figma 변수      (iOS/Android)
   (프로토타입)       (Next.js 제품·추후)  (디자인)         (추후)
```

## 파일 지도

| 경로 | 역할 |
|---|---|
| `tokens/primitive/*.tokens.json` | 원시 팔레트·스케일 (color/space/shape/typography/motion) |
| `tokens/semantic/semantic.tokens.json` | 의미 토큰 — primitive를 alias. 컴포넌트/CSS가 바인딩하는 층 |
| `tokens/build-css.mjs` | JSON → `docs/prototypes/nabi-ui.css` **값만 제자리 치환** (주석·구조 보존) |
| `.component-contracts` | Figma 파일 키 + 토큰 디렉터리 설정 (cc-figma-* 스킬용) |
| Figma: **NABI Design System** | https://www.figma.com/design/Gtwyro3kD9pmBaKjlGnrJ5 — `Primitives`(33) + `Semantic`(24) 변수 컬렉션 |

## 2-tier 구조

- **Primitives** — 원시값. 색 팔레트는 숨김(scope `[]`, 코드 신택스 없음). spacing·radius·border·font는 직접 쓰이므로 실제 scope + `var(--space-4)` 등 코드 신택스 부여.
- **Semantic** — primitive에 alias. 미팅 상태(`meeting/*`)는 `feedback/*`에 **체인 alias**. 각 변수의 WEB 코드 신택스 = **실제 CSS 변수명**(`var(--accent-primary)` 등) → 라운드트립 일대일 매핑의 핵심.

> 색은 현재 **PLACEHOLDER**(8개 시안 거절·보라 금지·RGB 빛 원색 컨셉 승인). Figma에서 확정하기 딱 좋은 단계 — 아래 역방향 흐름으로 코드에 반영한다.

## 정방향 (코드 → Figma)

토큰 JSON을 바꾼 뒤 Figma 변수에 반영할 때. 현재는 수동 스크립트로 생성했으며, 재실행 시 기존 변수는 두지 않고 값만 갱신하도록 `cc-figma-tokens` 스킬(update 모드)을 쓴다.

1. `tokens/**/*.tokens.json` 수정
2. `node tokens/build-css.mjs` → 프로토타입 CSS 갱신
3. `cc-figma-tokens` 스킬로 Figma 변수 동기화 (idempotent — 같은 이름 변수는 값만 업데이트)

## 역방향 (Figma → 코드) — 라운드트립

디자이너가 Figma에서 **변수 값**을 다듬은 뒤 코드로 되돌릴 때. **색 확정**이 대표 시나리오.

1. Figma의 **Primitives 컬렉션**에서 색/스케일 **값**을 수정
   (Semantic은 alias라 자동 전파 — primitive만 고치면 됨)
2. 변수 값을 읽어온다:
   - MCP: `get_variable_defs` 또는 `use_figma`로 `getLocalVariablesAsync()` 덤프
   - 각 변수의 `codeSyntax.WEB`(`var(--xxx)`)이 어느 토큰인지 알려줌 → 역매핑
3. 읽어온 값을 `tokens/primitive/*.tokens.json`의 `$value`에 반영
4. `node tokens/build-css.mjs` → `nabi-ui.css` 재생성 → **모든 프로토타입 자동 반영**
5. `node tokens/build-css.mjs --check`로 동기화 확인 (CI에 넣어 드리프트 방지)

### 라운드트립 규칙 (중요)
- Figma에서 수정은 **변수 값 / alias 단위로만**. 자유 픽셀 편집은 역수입이 안 됨.
- 새 색 시스템 = **primitive 팔레트 값만** 교체. 의미 토큰 이름·구조는 유지.
- 변수 **이름**을 바꾸면 코드 신택스(`var(--...)`)와의 매핑이 깨진다. 이름 변경 시 토큰 JSON의 `com.nabi.css`도 같이 갱신.

## 새 토큰 추가하기

1. 해당 `*.tokens.json`에 토큰 추가. CSS로 나갈 거면 `$extensions["com.nabi.css"]`에 변수명 명시.
2. semantic이면 `$value`를 `{color.blue.600}` 형태로 primitive를 참조.
3. `nabi-ui.css`에 해당 `--변수: 임시값;` 선언을 먼저 추가(빌드는 **기존 선언 값만 치환**하므로 선언이 없으면 경고).
4. `node tokens/build-css.mjs` 실행.

## 진행 현황

- **1단계 토큰** ✅ Primitives(33) + Semantic(25, text/inverse 추가) 변수 컬렉션.
- **2단계 컴포넌트** ✅ 변수 바인딩된 Figma 컴포넌트 4종:
  - **Badge/Chip** (Tone=Accent/Success/Warning/Danger/Neutral) — `node-id=11-2`
  - **Button** (Style=Primary/Secondary/Ghost) — `node-id=14-2`
  - **Card** (Title/Body 슬롯 + Shadow/Card effect style) — `node-id=15-7`
  - **App-bar** (Mode=Mobile/Desktop) — `node-id=17-2`
  - 모든 색/패딩/라디우스/보더가 변수 바인딩 → 토큰 바꾸면 컴포넌트도 자동 갱신.
- **3단계 페이지** (예정): `figma-generate-design`으로 discover/my-meetings/profile 등을 컴포넌트 인스턴스로 조립.

### Code Connect (보류)
디자인→코드를 "실제 컴포넌트 재사용"으로 끌어올리는 Code Connect는 **Organization/Enterprise + Developer 시트**가 필요(서버 확인됨). 현재 파일은 SalesAI(**Pro**)라 불가 → **보류**. 단, 변수마다 WEB 코드 신택스(`var(--…)`)를 박아놨으므로 `get_design_context`는 Code Connect 없이도 **우리 토큰을 참조하는 코드**를 생성한다(부분 충족). NABI가 Org/Enterprise 플랜이 생기면: 코드 컴포넌트 작성 → 라이브러리 게시 → `.figma.ts` 템플릿 → 연결.

### 폰트 주의
Figma 환경에 **Pretendard 미설치** → 컴포넌트 텍스트는 **Inter로 대체** 렌더(웹 출력은 여전히 `--font-sans`=Pretendard 토큰 구동). Figma에 Pretendard 설치 후 텍스트를 재바인딩하면 충실도 100%.
