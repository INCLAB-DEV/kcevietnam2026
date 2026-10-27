// 미팅 회의록(F-MY-002) BFF — 같은 출처 /api/reviews/* 를 FastAPI /meetings/{id}/review... 로
// 통과시키는 프록시(app/api/admin/[...path]/route.ts와 동일 패턴). ⚠ 백엔드 리뷰 라우터는
// **무접두사**다(prefix="/meetings/{meeting_id}", backend/app/api/reviews.py — /api/meetings가 아니다).
// 예전엔 X-Org-Id 헤더를 그대로 믿는 자기신고 방식(deps.current_org_id, 누구나 위조 가능)을 썼는데
// 백엔드가 이미 제거·금지했다("다시 만들지 말 것", backend/app/api/deps.py) — 이제 주체는 서명된
// 세션(Bearer)에서만 나온다.
//
// 클라 리뷰 클라이언트(lib/review/http-review-client)는 토큰을 만지지 않는다 — 로그인 BFF가
// 심어둔 httpOnly 세션 쿠키를 이 라우트가 서버 측에서 읽어 Authorization: Bearer로 붙인다
// (lib/auth/session-cookie.ts). 참석자 검사(403)는 FastAPI(_require_participant)가 내린다.
//
// 본문(녹음 multipart 업로드 포함)은 **모으지 않고 스트림 그대로** 백엔드로 흘려보낸다 — content-type
// (boundary 포함)은 그대로 넘긴다. 녹음 상한이 200MB라, 예전처럼 arrayBuffer()로 다 모으면 업로드마다 Next
// 프로세스 메모리에 파일이 통째로 올라왔다(동시 업로드 수만큼 곱해진다). 상한(MAX_BODY_BYTES)은 두 번 본다:
// content-length가 넘으면 읽기 전에 413, content-length가 없으면(청크 전송) 흘려보내며 누적 크기를 재다가
// 넘는 순간 스트림을 끊고 413을 돌려준다(백엔드는 끊긴 업로드를 접수하지 않는다).

import { NextResponse } from "next/server"
import { cookies } from "next/headers"
import { SESSION_COOKIE } from "@/lib/auth/session-cookie"
import { noSessionResponse } from "@/lib/auth/no-session-response"

const BACKEND_URL = process.env.NABI_BACKEND_URL ?? "http://localhost:8000"

// 녹음 상한 — 백엔드 TRANSCRIPTION_MAX_UPLOAD_BYTES 기본값(200MB)과 같다(화면 사전 검사 lib/review/recording-limit
// 도 같은 값). 본문 상한은 여기에 multipart 경계·다른 필드 여유 1MB를 더한다. ⚠ Caddy 본문 상한(210MB)은 이보다 커야
// 한다 — 작으면 Caddy가 먼저 끊어 화면이 413 대신 연결 오류를 본다. (route 파일은 HTTP 핸들러·세그먼트 설정
// 외의 export를 허용하지 않아 상수는 내보내지 않는다 — 테스트는 같은 값을 따로 적는다.)
const MAX_AUDIO_MB = 200
const MAX_BODY_BYTES = (MAX_AUDIO_MB + 1) * 1024 * 1024

export const dynamic = "force-dynamic"

type Ctx = { params: Promise<{ path: string[] }> }

// 백엔드가 녹음 상한 초과에 내는 것과 같은 모양(detail.code) — 화면(lib/review/api-error)이 code로 같은
// 안내(review.toast.audioTooLarge, 화면 로케일)를 띄운다. message는 화면에 쓰이지 않는 로그용 설명이다.
function tooLarge(): NextResponse {
  return NextResponse.json(
    { detail: { code: "audio_too_large", message: `Recording exceeds the ${MAX_AUDIO_MB}MB upload limit` } },
    { status: 413 },
  )
}

class BodyTooLargeError extends Error {
  constructor() {
    super("request body exceeded MAX_BODY_BYTES")
    this.name = "BodyTooLargeError"
  }
}

// 본문 스트림을 그대로 넘기면서 누적 크기를 잰다 — 상한을 넘는 덩어리가 오면 그 덩어리는 넘기지 않고 스트림을
// 오류로 끊는다(원본 요청 스트림도 함께 취소된다). 넘쳤는지는 state로 알린다 — 백엔드 fetch가 실패한 이유가
// 상한 초과인지(413), 다른 네트워크 오류인지 가르기 위해서다.
function cappedBody(
  body: ReadableStream<Uint8Array>,
  limit: number,
  state: { exceeded: boolean },
): ReadableStream<Uint8Array> {
  let total = 0
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        total += chunk.byteLength
        if (total > limit) {
          state.exceeded = true
          controller.error(new BodyTooLargeError())
          return
        }
        controller.enqueue(chunk)
      },
    }),
  )
}

async function proxy(method: string, request: Request, { params }: Ctx): Promise<NextResponse> {
  const jar = await cookies()
  const token = jar.get(SESSION_COOKIE)?.value
  if (!token) return noSessionResponse()

  const { path } = await params
  const target = `${BACKEND_URL}/meetings/${path.join("/")}${new URL(request.url).search}`

  const headers: Record<string, string> = { authorization: `Bearer ${token}` }
  const contentType = request.headers.get("content-type")
  if (contentType) headers["content-type"] = contentType

  const hasBody = method !== "GET" && method !== "HEAD"
  if (hasBody) {
    const declared = request.headers.get("content-length")
    if (declared !== null && Number(declared) > MAX_BODY_BYTES) return tooLarge()
  }

  const capState = { exceeded: false }
  const init: RequestInit & { duplex?: "half" } = { method, headers }
  if (hasBody && request.body) {
    init.body = cappedBody(request.body, MAX_BODY_BYTES, capState)
    // 스트림 본문으로 보내려면 Node fetch(undici)가 duplex: "half"를 요구한다(요청을 다 보낸 뒤 응답을 읽는다).
    init.duplex = "half"
  }

  let upstream: Response
  try {
    upstream = await fetch(target, init)
  } catch (error) {
    // 흘려보내던 중 상한을 넘겨 우리가 끊은 경우만 413 — 그 밖의 실패(백엔드 다운 등)는 예전처럼 그대로 올린다.
    if (capState.exceeded) return tooLarge()
    throw error
  }

  const data = await upstream.arrayBuffer()
  const response = new NextResponse(data, { status: upstream.status })
  const upstreamType = upstream.headers.get("content-type")
  if (upstreamType) response.headers.set("content-type", upstreamType)
  return response
}

export async function GET(request: Request, ctx: Ctx) {
  return proxy("GET", request, ctx)
}

export async function POST(request: Request, ctx: Ctx) {
  return proxy("POST", request, ctx)
}
