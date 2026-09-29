// /login 전용 비주얼 상수 — 발주사 로그인 리뉴얼 시안(references/login-renewal-spec.md)의 색/면을
// 한 곳에 모은다. 이 화면에서만 쓰는 값이라 globals.css의 전역 토큰(@theme/:root/.dark)은 건드리지
// 않는다 — 다른 화면은 무변경이고, 나중에 시안이 바뀌어도 여기만 고치면 된다.
//
// 라이트는 시안 값 그대로, 다크는 "같은 색상(hue)에 명도만 낮춘" 대응값을 쓴다(시안은 라이트 only).
// 텍스트·카드 면은 여기서 정하지 않고 기존 시맨틱 토큰(bg-card/text-foreground/…)에 맡긴다.

// 페이지 배경: 상단 중앙이 가장 밝은 방사형 핑크. 정지점은 시안 스펙(§6)의 근사식이 아니라 플랫
// 시안 PNG에서 직접 찍은 값이다 — 상단중앙 #FFFBFC, 가장자리/하단 #F8E7F0(스펙의 #F5E8EF보다 살짝
// 마젠타 쪽). 다크는 같은 형태를 유지한 저명도 플럼.
export const LOGIN_SURFACE_CLASS =
  "bg-[radial-gradient(ellipse_120%_95%_at_50%_0%,#FFFBFC_0%,#FCF3F9_45%,#F8E7F0_100%)] dark:bg-[radial-gradient(ellipse_120%_95%_at_50%_0%,#2A1B22_0%,#1F1519_45%,#150F11_100%)]"

// 배경 위에 떠 있는 카드(시안: 1005x617, r≈24).
// 시안 PNG를 찍어 보면 카드는 불투명 흰색이 아니라 배경 핑크가 비치는 반투명 패널이다
// (카드 안 #FFEAF6 vs 카드 옆 배경 #FBD9ED → 흰색 약 45~50% 알파). 여기선 70%로 절제해
// 유리 같은 질감은 살리되 본문 대비는 넉넉히 남긴다(muted-foreground 기준으로도 AA 유지).
// 섀도는 방향성 있는 드롭섀도보다 카드 둘레에 도는 핑크 글로우에 가깝다 — 두 겹으로 쌓는다.
export const LOGIN_CARD_CLASS =
  "rounded-3xl border border-black/5 bg-card/70 text-card-foreground shadow-[0_0_90px_0_rgba(230,125,185,0.35),0_30px_60px_-30px_rgba(147,0,6,0.20)] dark:border-white/10 dark:shadow-[0_30px_70px_-30px_rgba(0,0,0,0.8)]"

// 주 CTA(로그인·동의하고 시작하기) 핑크.
// ⚠ 시안의 버튼 배경 #D88490은 흰 글자 대비가 2.75:1 — WCAG AA(본문 4.5:1) 미달이라 그대로 못 쓴다.
// 색상(hue≈350°)은 유지한 채 명도만 낮춰 #BE3B52로 잡았다: 흰 글자 5.33:1(AA 통과), 다크 카드
// (#171717) 대비 3.4:1이라 면 경계도 읽힌다. hover는 같은 색상의 한 단계 진한 값.
export const LOGIN_CTA_CLASS =
  "bg-[#BE3B52] text-white hover:bg-[#A73448] focus-visible:border-[#BE3B52] focus-visible:ring-[#BE3B52]/35 dark:hover:bg-[#D14E63]"

// 아이디·비밀번호 입력창. 시안의 40px 높이 + "아이디 칸 빨간 테두리"를 :focus 스타일로 매핑한다
// (시안 §8-1: 플랫 PSD에 포커스 상태가 박혀 있던 것 — 항상 빨간 테두리가 아니라 포커스 표현으로 해석).
export const LOGIN_INPUT_CLASS =
  "h-10 focus-visible:border-[#BE3B52] focus-visible:ring-[#BE3B52]/25"

// 카드 아래 날짜 안내의 라벨 색(시안 #930006). 다크는 어두운 배경에서 읽히는 같은 계열 로즈.
export const LOGIN_ACCENT_TEXT_CLASS = "text-[#930006] dark:text-[#F0A3AC]"
