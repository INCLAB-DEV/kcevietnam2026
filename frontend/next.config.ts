import type { NextConfig } from "next"
import createNextIntlPlugin from "next-intl/plugin"

const nextConfig: NextConfig = {
  // ECS 배포용 — node_modules 없이 .next/standalone만으로 뜨는 최소 런타임 산출물.
  // Dockerfile(frontend/Dockerfile)이 이 산출물을 그대로 실행한다.
  output: "standalone",
}

// next-intl 요청 설정(lib/i18n/request.ts) 위치를 알려준다 — i18n 라우팅([locale] 세그먼트)은
// 쓰지 않는 provider 모드라 미들웨어는 없다(라우트 구조 불변, 방침 확정).
const withNextIntl = createNextIntlPlugin("./lib/i18n/request.ts")

export default withNextIntl(nextConfig)
