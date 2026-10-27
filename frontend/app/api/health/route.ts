// ALB(로드밸런서) 헬스체크 엔드포인트. 타깃그룹이 이 경로로 주기적 GET을 보내 200이면
// 정상, 아니면 그 태스크를 트래픽에서 제외한다. 인증 불필요(proxy.ts matcher가 /api/* 제외)이며
// 백엔드에 의존하지 않는다 — Next.js 서버 프로세스 자체의 생존만 알린다(FE/BE는 ALB에서 각각 체크).
import { NextResponse } from "next/server"

export const dynamic = "force-dynamic"

export function GET() {
  return NextResponse.json({ status: "ok" }, { status: 200 })
}
