// 참가자 BFF(app/api/{bm,meetings,notifications,reviews,discover/bookmarks,me/change-password})가
// 세션 쿠키 없이 불렸을 때의 공용 401 응답.
//
// 화면은 `detail.code`("NO_SESSION")로만 분기하고 문구는 화면 로케일의 카탈로그에서 뽑는다 —
// 여기 message는 로그·디버깅용 설명이다. 예전엔 여섯 라우트가 한국어 문장을 각자 실어 보냈고,
// 서버 문구를 그대로 띄우는 화면(미팅 수락·거절 토스트)에서는 EN 사용자에게도 그 한국어가 보였다.
import { NextResponse } from "next/server"

export const NO_SESSION_CODE = "NO_SESSION"

export function noSessionResponse(): NextResponse {
  return NextResponse.json(
    { detail: { code: NO_SESSION_CODE, message: "No session — sign-in required" } },
    { status: 401 },
  )
}
