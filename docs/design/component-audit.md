# NABI Canonical Component System — Audit & Reconciliation

**Date:** 2026-06-06
**Scope:** 10 prototype HTML files in `docs/prototypes/` reconciled against the confirmed NABI design foundations (`/design-consultation` output, moodboard, design-proposals, CONTEXT.md, ADRs).
**Goal:** A single source of truth so a dev team can build the prototypes into a real Next.js + Tailwind product.

> **Color note (read first):** The NABI color system is **UNRESOLVED**. All 8 palette variants (A–H) were rejected. `RGB(light-primary)` concept is approved, **PURPLE IS BANNED**, and both dark & light modes are still open. Every color token below carries the prototype's **current placeholder value** and is flagged `placeholder: true`. **No palette is invented or proposed here.**

---

## 1. Token System (reconciled)

Radius is mapped DOWN to the confirmed scale (sm=4 / md=8 / lg=12). Spacing is normalized to a 4px scale. Typography is expressed as ROLE tokens. Color values are the prototypes' current placeholders.

### 1.1 Radius (reconciled to foundations)

| Token | Confirmed value | Prototype value (drift) | Action |
|---|---|---|---|
| `--radius-sm` | **4px** | 8px | Map down. Pills/borders/badges. |
| `--radius-md` | **8px** | 12px | Map down. Buttons, inputs, cards. |
| `--radius-lg` | **12px** | 16px | Map down. Large cards, sheets. |
| `--radius-xl` | (not in foundations) | 20px | **Resolve**: foundations have no `xl`. Either drop to `lg` (12px) or get explicit approval to extend the scale. Used by bottom-sheet top corners + swipe cards. |
| `--radius-full` | 9999px | 9999px | Keep. Pills, circles. |

### 1.2 Spacing (4px base scale)

| Token | Value |
|---|---|
| `--space-1` | 4px |
| `--space-2` | 8px |
| `--space-3` | 12px |
| `--space-4` | 16px |
| `--space-5` | 20px |
| `--space-6` | 24px |
| `--space-8` | 32px |
| `--space-10` | 40px |

> Prototypes use ad-hoc `6/10/14/18px` in places. Normalize to nearest 4px step.

### 1.3 Typography (ROLE tokens — confirmed foundations)

| Role token | Confirmed family | Prototype currently uses |
|---|---|---|
| `--font-display` | **Satoshi** | Pretendard (drift) |
| `--font-body` | **DM Sans** | Pretendard (drift) |
| `--font-korean` | **Noto Sans KR** | Pretendard (drift) |
| `--font-data` | **Geist** (tabular-nums; scores, %, counts) | Pretendard (drift) |

> Every prototype declares `-apple-system, 'Pretendard', sans-serif`. None import the confirmed stack. This is the single most pervasive divergence.

### 1.4 Color (SEMANTIC PLACEHOLDERS — values are current prototype values, `placeholder: true`)

| Semantic token | Placeholder value | Category | Notes |
|---|---|---|---|
| `--bg-primary` | `#fdfcfb` | bg | Warm off-white. Not foundation-approved. |
| `--bg-secondary` | `#f5f3f0` | bg | |
| `--bg-elevated` | `#ffffff` | surface | Card/sheet surface. |
| `--border-default` | `#e5e2de` | border | |
| `--text-primary` | `#08090a` | text | |
| `--text-secondary` | `#4a4a4a` | text | |
| `--text-tertiary` | `#777169` | text | |
| `--accent-primary` | `#2563eb` | accent | Ad-hoc Tailwind blue. **NOT** an approved accent. |
| `--accent-subtle` | `#eff6ff` | accent | Accent tint background. |
| `--color-success` | `#16a34a` | success | = `--accent-green` / `--status-success` (naming split). |
| `--color-success-subtle` | `#f0fdf4` | success | |
| `--color-danger` | `#dc2626` | danger | = `--accent-red` / `--status-error`. |
| `--color-danger-subtle` | `#fef2f2` | danger | |
| `--color-warning` | `#ea580c` | warning | = `--accent-amber` / `--status-warning`. |
| `--color-warning-subtle` | `#fff7ed` | warning | |
| `--color-gold` | `#f59e0b` | accent-gold | Star ratings (MY-002 only). |

### 1.5 Meeting / Matching STATUS colors (domain enum → UI tokens)

Per CONTEXT.md + ADR-0003. Schedule Table status enum drives MY-001 slot colors. All placeholders.

| Status token | Enum state(s) | Placeholder value | Korean label |
|---|---|---|---|
| `--status-accepted` | `accepted`, `completed` | `#16a34a` (green) | 확정 / 완료 |
| `--status-proposed` | `proposed` (action needed) | `#dc2626` (red) | 대기중 / 응답대기 |
| `--status-noshow` | `noshow` | `#ea580c` (orange) | 불참 |
| `--status-empty` | empty / `rejected` / `cancelled` | `#e5e2de`-ish gray | 거절됨 / 취소됨 / (빈 슬롯) |

---

## 2. Component Catalog (canonical union)

`canonicalSource` = the prototype whose implementation is most complete/correct and should become the reference build.

| Component | Description | Variants | Canonical source | Used in |
|---|---|---|---|---|
| **Phone Frame** | 390×844 dev wrapper, 40px radius, 8px #222 border | mobile / desktop hidden | prototype-discover | all page protos |
| **Desktop Nav (dk-nav)** | Top bar: logo "N", nav links, avatar+name | active item, with badge | prototype-apply-seller | discover, company-detail, meeting, my-meetings, meeting-review, apply, apply-seller |
| **Desktop Card (dk-card)** | Centered desktop wrapper, 560–860px max | — | prototype-apply-seller | discover, company-detail, meeting, my-meetings, apply, apply-seller |
| **Variant/View Toggle Bar** | DEV-ONLY bottom bar: A/B/C + role + mobile/desktop | active/inactive | prototype-apply-seller | most (strip in prod) |
| **Top Bar / Detail Header** | Page title or back+title+action, white, bottom border | with back, with bookmark | prototype-company-detail | company-detail, meeting-review, profile, discover detail |
| **Back Button** | 32–36px circle, secondary bg, chevron | default, hover | prototype-company-detail | company-detail, meeting-review, meeting |
| **Bookmark Button** | Save toggle, hollow ☆ / filled ★ green | unsaved, saved | prototype-discover | discover, company-detail |
| **Segmented Tab Bar** | Text tabs, 2px accent underline indicator | active, with count badge | prototype-discover | discover (AI추천/전체/관심), my-meetings (day tabs) |
| **Tab/Count Badge** | Inline pill count next to tab | blue (default), green (bookmarks), red (pending) | prototype-discover | discover, my-meetings |
| **Company Card (swipe/scroll)** | Recommendation card: name, score, reason, keywords, actions | swipe top/behind/far, scroll, passed | prototype-discover | discover |
| **Company List Item** | Logo + name + meta + tags + bookmark row | default, hover | prototype-discover | discover (전체 기업) |
| **Keyword Chip** | Pill tag, neutral or accent-subtle | neutral, accent, removable, AI(purple — BANNED) | prototype-company-detail | discover, company-detail, apply, apply-seller, biz-matching, profile, meeting |
| **Match Score Banner** | Large % + label + AI reason, accent-subtle bg | — | prototype-company-detail | company-detail, discover detail, meeting |
| **AI Reason Block** | Accent-subtle box, AI matching explanation | — | prototype-company-detail | company-detail, discover |
| **Detail Section** | Title (caps tertiary) + body block | — | prototype-company-detail | company-detail, discover detail |
| **Booth/Venue Info Card** | Icon + label row, secondary bg | — | prototype-company-detail | company-detail, meeting |
| **Action Bar (footer)** | Fixed 2-button footer (secondary + primary) | — | prototype-company-detail | company-detail, discover |
| **Primary Button** | Accent-primary bg, white text | default, hover, disabled | prototype-apply-seller | all |
| **Secondary Button** | Border-default outline, primary text | default, hover | prototype-apply-seller | all |
| **Input Field** | Text/textarea, 1.5px border, accent focus | default, focus, readonly, prefilled, error-highlight | prototype-apply-seller | apply, apply-seller, biz-matching, meeting-review |
| **Input Label / Hint** | Label + accent-subtle hint box | — | prototype-apply-seller | apply, apply-seller, biz-matching |
| **AI Suggestion Box + AI Chip** | Dashed accent box of AI keyword chips | chip default/added | prototype-apply-seller | apply, apply-seller, biz-matching |
| **Inline Alert** | Error banner, danger-subtle bg + icon | error | prototype-apply-seller | apply, apply-seller, biz-matching |
| **Smart-Fill Card** | Input-method selector (upload/web/DART/manual) | recommended, hover | prototype-apply-seller | apply-seller |
| **DART Result/Info Card** | Auto-lookup result, success-subtle bg | — | prototype-apply-seller | apply-seller |
| **Step Progress (dots)** | Variant A dot bar, current = elongated | done, current, default | prototype-apply-seller | apply, apply-seller |
| **Stepper Accordion (Variant B)** | Numbered accordion steps + progress bar | active, done, pending | prototype-apply-seller | apply, apply-seller |
| **Chat/Conversational Flow (Variant C)** | Bot/user bubbles, quick-tags, summary card | bot, user, info | prototype-apply-seller | apply, apply-seller, prototype(leftover) |
| **Completion / Success State** | Green check circle + title + CTA | success, noshow(amber) | prototype-apply-seller | apply, apply-seller, meeting, meeting-review |
| **Meeting Request Modal (Bottom Sheet)** | 3-step: time → venue → confirm+message | step 1/2/3, sheet/full/compact | prototype-meeting | meeting, company-detail, discover |
| **Step Indicator (sheet)** | 3 horizontal progress bars | done, current, empty | prototype-meeting | meeting |
| **Sheet Handle** | 40×4 drag affordance bar | — | prototype-meeting | meeting, company-detail, my-meetings, meeting-review |
| **Step Number Badge** | Numbered accent circle | — | prototype-company-detail | company-detail, meeting, apply, apply-seller |
| **Date Chip Picker** | Horizontal date selector w/ slot count | default, selected | prototype-meeting | meeting |
| **Time Slot Grid** | 30-min slots, consecutive multi-select | available, selected, disabled, range-start/mid/end | prototype-meeting | meeting, company-detail |
| **Venue Card** | Selectable: booth / matching-zone / business-room | selected, unavailable, with availability badge | prototype-meeting | meeting, company-detail |
| **Venue Sub-Selection** | Room/Table chips (T-01.., Room A..) | available, selected, unavailable | prototype-meeting | meeting |
| **Availability Badge** | 가능 / 잔여 N석 / 불가 pill | open, limited, full | prototype-meeting | meeting |
| **Message Textarea + AI Badge** | AI-draft meeting message, editable | — | prototype-meeting | meeting |
| **Confirmation Summary Card** | Label/value rows pre-submit | — | prototype-meeting | meeting |
| **Sent Confirmation Screen** | Full-screen success + summary | — | prototype-meeting | meeting |
| **Timeline (Variant A, MY-001)** | Horizontal scroll, 64px 30-min slots + now-bar | — | prototype-my-meetings | my-meetings |
| **Slot Block (status colored)** | Meeting status block in timeline | accepted, proposed, completed, noshow, rejected/cancelled, empty | prototype-my-meetings | my-meetings |
| **Now Bar** | Current-time bar, pulsing dot | — | prototype-my-meetings | my-meetings |
| **Meeting Card (Variant B, MY-001)** | Card: time + status badge + company + actions | default, hover, selected; buyer/exhibitor body | prototype-my-meetings | my-meetings |
| **Status Badge (domain)** | proposed/accepted/rejected/cancelled/completed/noshow | per STATUS enum | prototype-my-meetings | my-meetings, prototype(leftover) |
| **Day Tabs (MY-001)** | Date tabs + per-day pending badge | active, with badge | prototype-my-meetings | my-meetings |
| **Bottom Navigation** | 3-tab bar (탐색/내 미팅/프로필) + nav badge | active, inactive | prototype-my-meetings | my-meetings, meeting |
| **Action Modal (reason)** | Bottom sheet: reason chips + textarea | reject, cancel | prototype-my-meetings | my-meetings |
| **Reason Chip** | Selectable reason pill | inactive, selected | prototype-my-meetings | my-meetings |
| **Empty State** | Icon circle + title + desc + CTA | bookmarks, meetings, generic | prototype-discover | discover, my-meetings |
| **Toast** | Top-center dark pill, auto-dismiss | hidden, visible | prototype-discover | discover, company-detail |
| **Review Step Indicator (MY-002)** | intake → compose → done tracker | inactive, active, done | prototype-meeting-review | meeting-review |
| **Segmented Control (진행여부)** | 3-button: 진행됨/상대불참/내불참 | default, selected, danger(amber) | prototype-meeting-review | meeting-review |
| **Star Rating (만족도)** | 5-star input, gold fill | empty, filled, hover | prototype-meeting-review | meeting-review |
| **Multi-select Chip (후속의향)** | 있음/검토중/없음 green-select | default, selected | prototype-meeting-review | meeting-review |
| **AI Structured Card (MY-002)** | 핵심논의/합의/후속액션, editable | discussion(blue), agreements(green), actions(amber) | prototype-meeting-review | meeting-review |
| **AI Banner / AI Avatar** | Accent-subtle AI guidance box | AI, info(i) | prototype-meeting-review | meeting-review, apply, meeting |
| **Loading Shimmer / Thinking Dots** | AI processing placeholder | shimmer, dot-pulse | prototype-meeting-review | meeting-review |
| **Completion Card / Progress Bar (profile)** | % complete + gradient fill bar | — | prototype-profile | profile, biz-matching |
| **Nav Hub Card** | 2-col status hub (매칭/미팅 바로가기) | hover | prototype-profile | profile |
| **Section/Accordion/Bento Card (profile)** | Profile field display, 3 layout variants | A section, B accordion, C bento | prototype-profile | profile |
| **Role Badge** | Buyer (blue) / Seller (green) pill | buyer, seller | prototype-profile | profile, apply-seller |
| **CTA Banner** | Gradient accent banner | — | prototype-profile | profile, biz-matching |
| **Role Card (selection)** | Large buyer/exhibitor choice card | default, hover | prototype-biz-matching | biz-matching |
| **Checklist Item** | Hollow→filled-green check + strikethrough | pending, done | prototype-biz-matching | biz-matching |
| **Menu Overlay / Panel** | Slide-in right panel + badges | — | prototype-biz-matching | biz-matching, prototype(leftover) |

---

## 3. Inconsistency Matrix (by severity)

### HIGH

| Area | Description | Affected files | Recommendation |
|---|---|---|---|
| Font stack | All 10 prototypes use `Pretendard`; foundations mandate Satoshi+DM Sans+Noto Sans KR+Geist. No data-font (Geist) for scores/%/counts anywhere. | ALL | Define 4 ROLE tokens; swap at build. Decide adopt-now vs later (see Open Decisions). |
| Status-color naming split | Two incompatible token names for the SAME colors: newer cluster uses `--accent-green/red/amber`; older cluster uses `--status-success/warning/error`. | discover, company-detail, meeting, my-meetings, meeting-review **vs** apply, apply-seller, profile, biz-matching, prototype | Adopt one canonical set: `--color-success/danger/warning` + domain `--status-*` for meeting states. Alias the rest. |
| Color placeholder reality | `--accent-primary:#2563eb` (ad-hoc blue) hardcoded in all 10; foundations say color UNRESOLVED, PURPLE BANNED. `prototype-profile` ships **purple `#7c3aed`** AI chips — violates ban. | ALL (purple: profile) | Keep blue as `placeholder:true` accent token; **remove purple** from profile AI chips before any build. |
| Desktop-mode approach drift | Three different desktop strategies: (a) per-page `dk-nav`+`dk-card` (7 files), (b) monolithic `desktop-frame`+`desktop-sidebar` (leftover prototype.html), (c) phone-only no desktop (profile, biz-matching). | discover, company-detail, meeting, my-meetings, meeting-review, apply, apply-seller **vs** prototype **vs** profile, biz-matching | Standardize on `dk-nav`+`dk-card` as canonical; build true 12-col / 1280px grid per foundations. Profile + biz-matching need desktop layouts added. |

### MEDIUM

| Area | Description | Affected files | Recommendation |
|---|---|---|---|
| Radius scale | All use 8/12/16/20; foundations are 4/8/12. Every component is one step too round. `--radius-xl:20px` has no foundation equivalent. | ALL | Map sm→4, md→8, lg→12. Resolve `xl` (drop to lg or approve extension) — bottom sheets + swipe cards depend on it. |
| Status colors absent in some files | `--accent-amber` defined only in my-meetings, meeting-review, meeting, discover; missing from company-detail. `--accent-gold` only in meeting-review. | company-detail, others | Include the full semantic + status set in the shared token layer so every file inherits consistently. |
| Buyer/Exhibitor symmetry not encoded | MY-001 is shared (role toggle) but routes split (`/meetings` vs `/exhibitor/meetings`, MY-001 vs EX-003). Prototypes simulate via dev role-toggle, not real route branching. | my-meetings, meeting-review, profile, apply-seller | Build role-aware components driven by route, per ADR role-based namespace contract. |
| Variant proliferation | apply, apply-seller, meeting, my-meetings, profile, meeting-review each ship 2–3 interaction variants (A/B/C) with no decision recorded. | apply, apply-seller, meeting, my-meetings, profile, meeting-review | Pick ONE variant per page before build (ADR-0003 already chose Card over Chat globally). |
| Duplicate Meeting Modal | Meeting request modal exists in prototype-meeting (richest: date picker, consecutive slots, venue sub-select) AND simpler copies in company-detail + discover. | meeting, company-detail, discover | Canonical = prototype-meeting. De-dupe the lighter copies. |

### LOW

| Area | Description | Affected files | Recommendation |
|---|---|---|---|
| Phone-frame chrome | 390×844, 40px radius, 8px `#222` border is a dev simulation, not product. | ALL | Strip at build; it is not a component. |
| Dev scaffolding colors | Variant bar uses hardcoded `#1a1a1a/#333/#888/#d9d6d1` outside token system. | ALL with variant-bar | Remove variant bar + toggles from production entirely. |
| Spacing off-grid | Ad-hoc 6/10/14/18px alongside 4px multiples. | ALL | Normalize to 4px scale tokens. |
| Bespoke feature colors | Smart-fill/DART tints (`#ede9fe`,`#e0f2fe`,`#dcfce7`,`#bbf7d0`), social-proof (`#fff8f0`), ranking gold/silver/bronze — outside token system. | apply-seller, prototype(leftover) | Fold into success/accent-subtle tokens or formalize as named placeholders. |
| Motion unaligned | Ad-hoc transitions (0.15–0.4s, cubic-beziers, shimmer). Physique 5 patterns (등장/연결/변환/파급) not implemented anywhere. | ALL | Define 4 named motion tokens; map existing transitions to them. |
| Border-weight ad-hoc | 1px / 1.5px / 2px used without a system. | ALL | Define `--border-thin/default/strong` tokens. |

---

## 4. Open Decisions (human required before alignment)

| # | Question | Options | Recommendation |
|---|---|---|---|
| 1 | Adopt design-system fonts now, or keep Pretendard for the June 17 demo? | (a) Swap to Satoshi/DM Sans/Noto KR/Geist now (b) Keep Pretendard, swap post-demo (c) ROLE tokens now, families later | **(c)** Define `--font-display/body/korean/data` role tokens immediately; point all four at Pretendard for the demo, flip families later. Zero rework. |
| 2 | Shared CSS/token file vs spec-only handoff? | (a) Ship `tokens.css` + component CSS the team consumes (b) Markdown spec only (c) Tailwind theme config (`tailwind.config` tokens) | **(c)+(a)** Encode tokens in `tailwind.config.ts` (matches stack) + a thin `tokens.css` for the placeholder color layer so the eventual palette swap is one file. |
| 3 | Scope of the 2 leftover prototypes (`prototype.html`, `prototype-biz-matching.html`)? | (a) Delete (b) Archive `docs/prototypes/_archive/` (c) Keep as reference | **(b)** Archive. Neither is in page-list.csv; both predate the per-page split. Mine prototype.html ONLY for organizer/EX desktop patterns (OP-* pages) not yet prototyped. |
| 4 | Confirm color-placeholder approach (no palette invented)? | (a) Keep current blue as placeholder until system resolves (b) Pause builds until palette decided | **(a)** Build on semantic placeholder tokens (`placeholder:true`). One swap when palette lands. **Block:** remove banned purple from profile first. |
| 5 | `--radius-xl` (20px) — drop or extend the scale? | (a) Collapse to lg=12px (b) Officially extend foundations to add xl | **(a)** Collapse to lg unless designer wants the softer bottom-sheet corner; then extend foundations explicitly rather than leaving it undocumented. |
| 6 | Pick the single interaction variant per multi-variant page? | (a) A (b) B (c) C, per page | Decide per page in design review. ADR-0003 already mandates Card (not Chat) globally — that eliminates the chat variants for discovery. |

---

## 5. Leftover / Deprecated Prototypes

| File | Verdict | Why |
|---|---|---|
| `docs/prototypes/prototype.html` | **Leftover — archive** | Original all-in-one monolith (138KB, all roles + buyer/exhibitor/organizer in one file via `user-type-tabs`). Uses the old `desktop-frame`/`desktop-sidebar` desktop approach the per-page prototypes abandoned for `dk-nav`/`dk-card`. **Not referenced in page-list.csv.** Superseded by the page-split prototypes. Still useful only as a reference for organizer (OP-*) and split-view (EX-004) desktop layouts that have no dedicated prototype yet. |
| `docs/prototypes/prototype-biz-matching.html` | **Leftover — archive** | Early combined application/matching flow (role select → profile → matching → venue). Uses `--status-*` naming and phone-only layout. **Not referenced in page-list.csv.** Its content split into the canonical `prototype-apply.html` (BM-001) and `prototype-apply-seller.html` (BM-002). The standalone "매칭 제안 (BM-003)" page it implies is itself marked **deprecated** in page-list ("DV-001 AI 추천 탭으로 통합됨"). |

> All 8 other prototypes are **active** and map 1:1 to page-list IDs (DV-001, DV-002, MY-001, MY-002, BM-001, BM-002, BM-004/005, MT-001).

---

## 6. Executive Summary

The eight active prototypes share a coherent visual language and a near-identical token block, so a single source of truth is well within reach — but they were all built on **Pretendard, radius 8/12/16/20, and an ad-hoc blue `#2563eb`**, none of which match the confirmed "Quiet Catalyst" foundations (Satoshi/DM Sans/Noto KR/Geist, radius 4/8/12, color UNRESOLVED). The most damaging cross-file drift is a **status-color naming split** (`--accent-green/red/amber` vs `--status-success/warning/error`) and **three different desktop strategies**, which would fork the codebase if built as-is. Two files (`prototype.html`, `prototype-biz-matching.html`) are leftover monoliths not in page-list.csv and should be archived. The recommended path: lock **ROLE-based typography tokens** (pointed at Pretendard for the June 17 demo, families flipped later), **map radius down** to the foundation scale, **unify status tokens** to the domain STATUS enum from CONTEXT/ADR, and keep all colors as **`placeholder:true` semantic tokens** (after removing the one banned purple in profile) so the eventual palette decision is a single-file swap.
