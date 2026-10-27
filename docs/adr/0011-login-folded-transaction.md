# 로그인은 folded 트랜잭션 — 백엔드가 검증된 신원을 소유한 뒤 세션을 발급한다 (Login Ticket)

F-AU-001 로그인을 FastAPI HTTP 계약으로 노출할 때, 프론트의 `AuthClient` seam이 화면 흐름상 쪼개 둔
`verifyCredentials → submitConsent → issueSession` 세 메서드를 **그대로 세 개의 공개 엔드포인트로
빼지 않는다.** 대신 백엔드가 검증된 신원을 소유하는 **2단계 folded 트랜잭션**으로 노출한다.

## 배경

`AuthClient` seam(`frontend/lib/auth/auth-types.ts`)은 **UI 워크플로 경계**다 — 로그인 화면을
자격입력 → 약관 → 진입 세 단계로 나누기 위한 분할이지, 안전한 백엔드 인증 계약이 아니다. 이 분할을
HTTP로 직역하면 `issueSession({ memberId, role })`이 공개 엔드포인트가 되는데, 이는 **클라이언트가
"이 회원ID·역할로 세션을 발급하라"고 시키는 것을 신뢰**하는 꼴이라 인증 우회 구멍이다(검증을 안 거친
임의 신원으로 세션을 받을 수 있다). 신원의 닻이 DX Korea 아이디/비번이라는 D2 결정(ADR-0007)과
정면으로 어긋난다. (codex 장기검수, 2026-06-28.)

백엔드 오케스트레이터 `app/auth/login.py`(`authenticate_and_issue_session`)는 이미 검증 → 적재
레코드 매핑 → 역할 분기 → 세션 발급을 **한 번에 묶어** 신원을 서버가 소유한다 — 더 건강한 보안 경계다.
다만 이 함수는 어떤 라우터에도 붙어 있지 않아 HTTP로는 닿지 않는다(#22까지는 모듈만 머지).

## 결정

로그인을 **2단계 트랜잭션**으로 노출한다. 회원ID·역할은 절대 클라이언트로 나가지 않고, 약관 게이트를
넘는 동안 백엔드가 **Login Ticket** 뒤에 보관한다.

- **`POST /api/auth/login/start`** — 아이디/비번(+ 딥링크 컨텍스트)을 받아 검증·매핑하고 다음 중
  하나를 돌려준다:
  - `rejected(reason)` — 자격 불일치/잠김/업스트림 장애.
  - `not_found` — 검증은 통과했으나 적재 레코드 없음(인증 실패와 구분).
  - `succeeded(route, roles, gate)` — **재방문자(NABI 계정 존재)**: 약관을 다시 묻지 않고 그 자리에서
    세션을 발급한다(fast-path).
  - `consent_required(login_ticket, documents)` — **최초 진입자**: 세션을 아직 내지 않고, 불투명
    **Login Ticket**과 동의할 약관 문서를 함께 돌려준다. 문서는 라운드트립 절감을 위해 응답에 인라인한다.
- **`POST /api/auth/login/complete`** — `login_ticket` + 동의한 약관 항목을 받아, ticket을 소진하고
  동의를 기록한 뒤 게이트된 NABI 계정(Cognito) 세션을 발급하고 `succeeded(route, roles, gate)`를
  돌려준다. 필수 약관 미충족이면 거부한다.

**Login Ticket**은 불투명 랜덤 값 + 서버 저장 + **1회용** + 짧은 TTL(~10분)이며, 검증된 회원ID·역할·
딥링크 컨텍스트를 묶어 보관한다. 기존 `app/auth/deeplink_token.py`의 `TokenStore` 프로토콜 패턴을
재사용한다(인메모리 기본, DB 교체는 의존성만 교체).

FE의 `AuthClient` 구현(`httpAuthClient`)은 이 folded 계약에 **적응**한다 — `startLogin` / `completeLogin`
두 메서드로 재편하고, 화면 컴포넌트(자격 폼·약관 스텝)는 그대로 둔다. **백엔드가 mock seam 모양에
맞추지 않는다.** 모든 호출은 브라우저 → Next 라우트 핸들러(BFF) → FastAPI 경로로 가 ADR-0008 경계 B와
frontend ADR-0001(서버 전용/클라 호출 seam 분리)을 지킨다.

## Considered Options

- **FE 5메서드 seam을 5개 공개 엔드포인트로 직역 (기각).** `issueSession(memberId, role)`이 인증
  우회. 클라이언트가 검증을 안 거친 신원으로 세션을 받을 수 있다. UI 편의 분할을 보안 계약으로 오용.
- **상태 없는 서명 ticket (기각).** 백엔드가 회원ID를 서명해 JWT-형으로 발급(클라 불투명). 저장소가
  불필요해 보이지만 **1회용 보장**에 결국 별도 소진-집합 저장소가 필요해 이점이 사라지고, 만료 전
  취소가 불가능하며, 기존 딥링크 토큰 패턴과 불일치.
- **불투명 + 서버저장 + 1회용 Login Ticket (채택).** 1회용이 자명하고, 즉시 취소 가능, 딥링크 토큰과
  동일 패턴 재사용.

## Consequences

- FE `AuthClient` seam이 `verifyCredentials`/`submitConsent`/`issueSession` → `startLogin`/
  `completeLogin`로 재편된다. `login-flow.tsx` 오케스트레이터의 분기와 그 테스트가 갱신된다(화면
  컴포넌트는 불변).
- 시스템에 **세 종류의 토큰**이 공존한다: Deeplink Token(진입) → Login Ticket(약관 게이트 전
  진행중 로그인) → Session JWT(완료 후). 발급 주체·수명·소비 지점이 모두 다르다 — CONTEXT.md 글로서리가
  이를 구분한다.
- DX Korea 인증·Cognito는 여전히 포트(어댑터) 뒤 stub다. 이 ADR은 **HTTP 계약 모양**을 고정할 뿐
  실연동을 끌어오지 않는다 — 규격 확정 시 stub만 실구현으로 교체하고 계약·테스트는 불변.
- 로그인 성공 후 **세션 쿠키 + route-guard 실연결은 이 슬라이스 범위 밖**(슬라이스 2+, Cognito 실구현과
  함께). 지금은 `start`/`complete`가 돌려준 `route`/`gate`로 라우팅한다.
- 데모 자격증명은 **dev/test 전용**으로만 stub에 시드한다(프로덕션 플러밍에 굳히지 않는다).

Status: accepted
