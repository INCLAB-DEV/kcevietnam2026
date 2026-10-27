"use client"

// 화면을 열 때 서버에서 한 번 읽어 오는 값 — 신청서 편집 패널과 두 대리작성 다이얼로그가 함께 쓴다.
// "목록 화면에 실려 온 값을 편집 초깃값으로 쓰지 않는다"는 규칙의 공통 구현이다: 마운트할 때마다(= 열 때
// 마다) load를 부르고, 읽는 동안·실패했을 때의 상태를 그대로 돌려준다(실패를 빈 값으로 바꾸지 않는다 —
// 모르는 채로 편집·저장하게 두면 서버 값을 덮는다).
//
// load는 마운트 동안 같은 함수여야 한다(바뀌면 다시 읽는다). 다른 대상으로 바꿀 때는 호출부가 key로
// 다시 마운트한다.

import { useEffect, useState } from "react"

export type ServerValueState<T> =
  | { status: "loading" }
  | { status: "ready"; value: T }
  | { status: "error"; error: unknown }

export function useServerValue<T>(load: () => Promise<T>) {
  const [state, setState] = useState<ServerValueState<T>>({ status: "loading" })
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let alive = true
    load().then(
      (value) => {
        if (alive) setState({ status: "ready", value })
      },
      (error: unknown) => {
        if (alive) setState({ status: "error", error })
      },
    )
    return () => {
      alive = false
    }
  }, [load, attempt])

  return {
    state,
    setValue: (value: T) => setState({ status: "ready", value }),
    retry: () => {
      setState({ status: "loading" })
      setAttempt((n) => n + 1)
    },
  }
}
