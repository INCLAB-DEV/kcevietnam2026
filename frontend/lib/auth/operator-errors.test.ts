import { describe, expect, it } from "vitest"
import {
  OPERATOR_FORBIDDEN_DIGEST,
  OPERATOR_NOT_FOUND_DIGEST,
  OperatorHttpError,
  operatorErrorKind,
} from "./operator-errors"

// 운영자 콘솔 읽기 실패의 상태 전달(2026-09-17) — 프로덕션에선 서버 에러 message가 가려져 오므로
// error.tsx는 digest로만 403/404를 구분할 수 있다.
describe("OperatorHttpError / operatorErrorKind", () => {
  it("403·404만 digest를 싣고, 그 외 상태는 Next가 digest를 만들게 비워 둔다", () => {
    expect(new OperatorHttpError(403, "x").digest).toBe(OPERATOR_FORBIDDEN_DIGEST)
    expect(new OperatorHttpError(404, "x").digest).toBe(OPERATOR_NOT_FOUND_DIGEST)
    expect(new OperatorHttpError(500, "x").digest).toBeUndefined()
  })

  it("서버에서 잡은 에러 인스턴스와 클라로 넘어온 digest를 같은 종류로 읽는다", () => {
    expect(operatorErrorKind(new OperatorHttpError(403, "x"))).toBe("forbidden")
    expect(operatorErrorKind({ digest: OPERATOR_FORBIDDEN_DIGEST })).toBe("forbidden")
    expect(operatorErrorKind({ digest: OPERATOR_NOT_FOUND_DIGEST })).toBe("not_found")
    expect(operatorErrorKind(new OperatorHttpError(502, "x"))).toBe("unknown")
    expect(operatorErrorKind(Object.assign(new Error("redirect"), { digest: "NEXT_REDIRECT;replace;/login;307;" }))).toBe(
      "unknown",
    )
    expect(operatorErrorKind(null)).toBe("unknown")
  })
})
