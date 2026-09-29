# Frontend ADRs

프론트엔드(표현 레이어)에 **한정된** 아키텍처 결정만 여기 둔다.

- 시스템 전역·도메인·교차 레이어 결정 → 루트 `docs/adr/`
- 프론트 고유 결정(예: 상태관리 선택, 라우팅 전략, 컴포넌트 경계)이 실제로 확정될 때 `0001-*.md`부터 추가
- 작성 포맷은 루트 `docs/adr/`의 기존 ADR을 따른다

## 등록된 ADR

- [0001](0001-api-client-server-read-vs-client-session-split.md) — api-client seam을 서버 전용 read(`server-only` 봉인) / 클라 호출 session으로 분리. read 픽스처·점수 휴리스틱이 클라 번들로 누출되지 않게 함(루트 ADR-0008의 seam을 RSC 모듈 그래프 경계에 매핑).
