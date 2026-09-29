// 로그인 자격(이메일·비밀번호) 분실 시 안내 경로.
//
// 예전엔 인증을 DX Korea에 위임해 복구도 dxkorea.org로 보냈지만(옛 방산 전시 시절), 지금은 NABI에서
// 직접 가입하는 자체 계정이라 그 링크는 이 행사와 무관하다 — 복구·문의는 운영사무국이 받는다
// (2026-09-10 교체). 값은 components/layout/nav.tsx의 SECRETARIAT_CONTACT.email과 같은 주소이며,
// 사무국 대표 메일이 바뀌면 두 곳을 함께 고친다(또는 아래 env로 덮어쓴다).
export const ACCOUNT_HELP_URL =
  process.env.NEXT_PUBLIC_ACCOUNT_HELP_URL ?? "mailto:kcevietnam2026@gmail.com"
