# NOTES — DV-001 기업 탐색 (prototype-discover.html)

**상태:** 디자인 변주 탐색본이 캐노니컬 `prototype-discover.html`로 승격됨 (기존 파일 교체, 2026-06-06).
**Shape:** 한 route + 하단 바 A/B/C(디자인 변주) + Mobile/Desktop. 공유: `nabi-ui.css` + `nabi-nav.js`.

## 카드 디자인 변주 (인터랙션 C 고정 · 색 warm placeholder)
- **A · Quiet Paper** — 적합도 우상단 큰 숫자, 추천이유 히어로
- **B · Precision** — 적합도 가로 매치 바, 밀도↑
- **C · Bold Stat** — 상단 스탯 밴드 94% 앵커 + 큰 헤드라인

## 이번 세션 추가/수정
- 카드 디자인 1종 → A/B/C 3종 스왑
- 우스와이프 = 관심있음 추가 (좌=관심없음 대칭)
- 데스크톱 카드 버그 2종 수정(ID 중복 빈 덱 / 가로 욱여넣기) — ⚠️ 다른 프로토타입에 같은 패턴 있으면 동일 수정 필요
- 인라인 nav → nabi-nav.js 공유 nav

## Verdict (최종 디자인 — 채워질 예정)
- 선택: _____ / 이유: _____ / 리믹스: _____

## 정리 대기
- `prototype-discover-v2.html` (warm Quiet Paper 단독) = 변주 A로 흡수됨 → 중복, 승자 확정 후 삭제 가능
- 색은 nabi-ui.css 토큰 기반 → 니어모노크롬 확정 시 토큰 교체로 자동 반영
