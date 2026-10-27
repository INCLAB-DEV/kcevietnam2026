# tokens/ — NABI 디자인 토큰 (단일 소스)

W3C DTCG 포맷. **이 JSON이 단일 소스**, `docs/prototypes/nabi-ui.css`는 생성물.

```bash
node tokens/build-css.mjs          # JSON → nabi-ui.css 동기화
node tokens/build-css.mjs --check  # 동기화 여부만 확인 (CI용)
```

- `primitive/` — 원시 팔레트·스케일
- `semantic/` — primitive를 alias한 의미 토큰 (컴포넌트/CSS가 바인딩)

전체 워크플로(Figma 라운드트립 포함): [`docs/design/tokens-figma-roundtrip.md`](../docs/design/tokens-figma-roundtrip.md)
