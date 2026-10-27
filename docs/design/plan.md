# NABI 디자인 시스템 — 구축 계획 (plan.md)

> 작성 2026-06-08. 토큰↔Figma 라운드트립 파이프라인 + 컴포넌트 1차 구축 완료 후, **남은 디자인 시스템 작업**을 모은 로드맵.
> 동작 방식·파일 지도는 [`tokens-figma-roundtrip.md`](./tokens-figma-roundtrip.md) 참조.

## 현재 상태 (완료)

- **토큰 파이프라인**: `tokens/*.tokens.json`(DTCG 단일 소스) → `tokens/build-css.mjs` → `docs/prototypes/nabi-ui.css`. `--check`로 동기화 검증.
- **Figma 변수**: "NABI Design System" (SalesAI/Pro, fileKey `Gtwyro3kD9pmBaKjlGnrJ5`). `Primitives`(33) + `Semantic`(25). 변수마다 `var(--…)` WEB 코드 신택스.
- **컴포넌트 4종** (변수 바인딩): Badge(`11-2`) / Button(`14-2`) / Card(`15-7`) / App-bar(`17-2`).
- **디자인→코드**: `get_design_context`가 토큰 참조 코드 생성(Code Connect 없이도).
- **토큰 스와치 보드**: 캔버스 `5-2`.

---

## 남은 작업

### 1. 색 시스템 확정 (최우선 — 현재 PLACEHOLDER)
- [ ] Figma `Primitives`에서 NABI 팔레트 확정 — "RGB 빛 원색" 컨셉, **보라 금지** (메모리: project_design_direction = near-monochrome + sharp, Helsing register)
- [ ] `blue/600`(accent strong) ↔ `blue/50`(accent subtle) **짝 맞추기** (데모 때 strong만 바꿔 subtle이 안 맞았던 이슈)
- [ ] `gold-subtle` 프리미티브/시맨틱 추가 (badge-all 등 amber 배지용 — 현재 Gold tone 배지 보류 상태)
- [ ] 확정 후 라운드트립: Figma 값 → `tokens/` → `build-css.mjs` → 프로토타입+컴포넌트 일괄 반영

### 2. 폰트 / 타이포그래피
- [ ] Figma에 **Pretendard 설치** → 컴포넌트 텍스트 Inter→Pretendard 재바인딩 (현재 Inter 대체)
- [ ] (또는) 확정 디자인 시스템 폰트(Satoshi 등) 결정
- [ ] **타입 스케일 토큰화**: font-size/line-height/weight (현재 토큰엔 패밀리만) → Figma **Text Styles** 생성
- [ ] letter-spacing은 Text Style로만 (Figma 변수 불가)

### 3. 토큰 확장
- [ ] **Elevation/그림자** 토큰 + effect styles 정식화 (현재 `Shadow/Card` 하나뿐)
- [ ] z-index, breakpoint(@container 분기값) 토큰화 검토
- [ ] 상태 레이어/opacity 토큰 (hover/pressed)

### 4. 컴포넌트 라이브러리 확장
- [ ] Icon set (INSTANCE_SWAP용 컴포넌트 페이지 — 아이콘 먼저)
- [ ] Input / Select, Toggle / Checkbox, Tabs / Segmented
- [ ] Avatar(단독), Score/별점, Empty state
- [ ] **미팅/기업 카드** (company card — 도메인 핵심), Status timeline
- [ ] bottom-nav, nav-drawer(햄버거 메뉴), Sheet/Modal
- [ ] Badge에 **Gold tone** 추가(토큰 생기면), Button에 State(hover/disabled) 축 검토
- [ ] 각 컴포넌트 페이지 문서 + variant grid 행/열 라벨

### 5. 3단계 — 페이지 조립 (`figma-generate-design`)
**화면 컨벤션 (discover에서 확립):**
- 화면당 **Mobile + Desktop 한 쌍** 프레임.
  - Mobile `390×844` 디바이스 아트보드, **4컬럼 그리드**(margin 16, gutter 16), 콘텐츠 padding 16 + FILL.
  - Desktop `1440`, **12컬럼 그리드**(margin 80, gutter 24), 콘텐츠 FILL+padding 80, 카드 등은 그리드폭 **FILL(반응형)** — 프레임 늘리면 함께 reflow.
- **카드 반응형 규칙**: 카드 = FILL + `minWidth 300` / `maxWidth 460`, 그리드 컨테이너 = **WRAP**.
  - 넓을수록 카드가 max(460)까지 커지고 멈춤. 좁아지면 min(300)까지 줄다가 닿으면 줄바꿈: **3업(≥1440) → 2업(~820) → 1업(~520)**.
  - 검증됨: 820px에서 2업+1 wrap, 1440px에서 3업(411px).
- App-bar Mobile/Desktop variant 인스턴스를 셸로. 본문은 Button/Badge/Card 인스턴스 + 토큰 바인딩.
- 데모 5개 기업 우선 (CLAUDE.md 규칙).

**⚠ 충실 미러 재작업 필요:** 1차로 만든 화면들이 실제 프로토타입과 차이남(디자인시스템 컴포넌트로 재해석함). 사용자 요청 = **실제 프로토타입과 똑같이(충실 미러)**.
- App-bar 컴포넌트는 프로토타입 nav에 맞게 수정 완료(홈/기업탐색/내미팅/내정보, active 알약, 김재현/KJ). Button Secondary=회색 채움으로 수정. → 모든 인스턴스 자동 반영.
- 남은 차이: App-bar **active 상태가 화면별로 달라야** 함(컴포넌트에 Active 변형/프로퍼티 추가 필요). 유저 avatar/name 순서(프로토타입=avatar 먼저). 폰트 Pretendard는 Figma 환경에 없어 Inter 유지(불가피).
- 충실 미러 시 실제 프로토타입을 playwright로 렌더해 대조할 것(`python3 -m http.server --directory docs/prototypes`). discover는 변형 A(Quiet Paper)가 기본.

**진행:**
- [x] **discover Desktop**(node 28-20) — 충실 미러 완료(컨테이너 카드/탭 배지/평문 reason/플랫 카드).
- [ ] **discover Mobile**(node 23-3) — 실제는 스와이프 덱(큰 카드+관심없음/있음+카운터). 재작업 필요.
- [ ] **company-detail** Mobile(33-50)+Desktop(35-55) — 프로토타입 대조 재작업.
- [ ] **my-meetings** Mobile(37-75)+Desktop(38-94) — 재작업 + active='내 미팅'.
- [ ] **meeting-review** Mobile(40-115) — 재작업.
- [ ] my-meetings
- [ ] meeting-review
- [ ] profile
- [ ] meeting / apply / apply-seller

### 6. Tailwind 출력 (Next.js 제품용)
- [ ] `build-css.mjs`에 **Tailwind config(또는 v4 `@theme`) 생성 타겟** 추가 → 같은 JSON에서 Tailwind 토큰 파생
- [ ] `frontend/` 스캐폴드 시 연결 (프로토타입과 제품이 동일 토큰 공유)

### 7. Code Connect (NABI Org/Enterprise 플랜 생기면)
- [ ] 현재 **Pro 플랜이라 불가**(서버 확인). Org/Enterprise + Developer 시트 필요.
- [ ] 절차: `frontend/components/ui` React 컴포넌트(토큰 사용) 작성 → 팀 라이브러리 게시 → `.figma.ts` 템플릿 → 연결
- [ ] `figma-code-connect` 스킬 이미 설치됨 (`~/.claude/skills/figma-code-connect`)
- [ ] 대안: 디자인 시스템 파일을 hanacard(Org) 팀으로 이동 (단 타 조직)

### 8. CI / 거버넌스
- [ ] `node tokens/build-css.mjs --check`를 CI에 추가 → 토큰 드리프트 방지
- [ ] 토큰 변경 PR 리뷰 규칙
- [ ] `.component-contracts` 비밀 추가 시 gitignore (현재 비밀 없음)

### 9. 기존 프로토타입 정렬
- [ ] 프로토타입 로컬 스타일을 공유 컴포넌트 패턴으로 점진 정렬 (`docs/design/component-audit.md` 참조)

---

## 참고
- Figma 파일: https://www.figma.com/design/Gtwyro3kD9pmBaKjlGnrJ5
- 설치된 figma MCP 스킬: figma-use, figma-generate-library, figma-generate-design, figma-create-new-file, figma-code-connect (+ 프로젝트 cc-figma-tokens/component)
- 메모리: `project_design_token_pipeline`, `project_design_direction`, `feedback_prototype_pagelist`
