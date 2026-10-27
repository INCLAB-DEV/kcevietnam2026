// 리다이렉트용 공개 origin 계산 — standalone Next 서버에서 request.url의 origin은
// **바인드 주소**(Dockerfile HOSTNAME=0.0.0.0)를 쓴다. 그 값을 그대로 리다이렉트 Location에
// 실으면 브라우저가 http://0.0.0.0:3000으로 튕긴다(ERR_CONNECTION_REFUSED, GH #1).
//
// 프록시(또는 브라우저)가 보낸 Host 헤더가 "진짜 바깥 주소"이므로 그걸 우선 신뢰한다.
// 헤더가 없는 환경(테스트, 직접 fetch)에서는 request.url의 origin으로 안전하게 폴백한다.
export function resolvePublicOrigin(request: Request, url: URL): string {
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host")
  if (!host) return url.origin
  const proto = request.headers.get("x-forwarded-proto") ?? url.protocol.replace(/:$/, "")
  return `${proto}://${host}`
}
