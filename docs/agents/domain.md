# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Layout: Multi-context (shared-kernel hybrid)

모노레포(`frontend/` + `backend/`)지만, 도메인 유비쿼터스 언어는 **루트 `CONTEXT.md`(공유 커널)** 에 한 덩어리로 모은다. 레이어 고유 용어만 컨텍스트별로 분리한다.

```
/
├── CONTEXT-MAP.md                     ← 읽는 순서 인덱스
├── CONTEXT.md                         ← 공유 커널 (도메인 글로서리, 항상 읽음)
├── docs/adr/                          ← 시스템 전역 결정 (ADR-0001~0013)
├── frontend/
│   ├── CONTEXT.md                     ← 표현 레이어 고유 용어 (라우팅·nav·토큰)
│   └── docs/adr/                      ← 프론트 한정 결정 (FE ADR-0001·0002)
└── backend/
    ├── CONTEXT.md                     ← 도메인·데이터 레이어 고유 용어 (DB·인증·AI)
    └── docs/adr/                      ← 백엔드 한정 결정 (현재 없음 — README만)
```

## Before exploring, read these

1. **루트 `CONTEXT.md`(공유 커널) — 항상 먼저.** 사용자 유형·매칭·프로세스·미팅 후 평가 등 도메인 용어가 전부 여기 정의돼 있다. 어떤 영역을 만지든 이 글로서리의 어휘를 따른다.
2. **`CONTEXT-MAP.md`** — 읽는 순서와 컨텍스트별 파일 위치를 가리킨다.
3. **작업 영역의 컨텍스트 파일** — `frontend/CONTEXT.md` 또는 `backend/CONTEXT.md`. 루트 커널을 *보완*할 뿐 대체하지 않는다.
4. **`docs/adr/`(루트)** — 작업 영역에 닿는 시스템 전역 ADR. 레이어 한정이면 `frontend/docs/adr/`·`backend/docs/adr/`도 확인.

컨텍스트 파일이나 컨텍스트별 ADR이 없으면 **조용히 넘어간다.** 부재를 지적하거나 선제 생성을 권하지 않는다 — 용어/결정이 실제로 확정될 때 `/grill-with-docs`가 lazily 만든다. 단, **루트 `CONTEXT.md`는 항상 존재하며 항상 읽는다.**

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in the **shared kernel** (`CONTEXT.md`). Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal — either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/grill-with-docs`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (주관사 데이터 연동·인증) — but worth reopening because…_
