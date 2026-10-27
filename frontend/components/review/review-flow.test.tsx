// QA C1/C3 회귀 잠금 — 회의록 화면(mock 클라이언트, realSession=false).
// C1: AI 정리(구조화/전사)를 한 번도 부르지 않고, 직접 입력만으로 저장·완료까지 갈 수 있어야 한다.
// C3: 화면 순서가 1.AI 보고서+적합도(compose) → 2.미팅 후기(intake) → 3.완료(done) 여야 한다.
import { render, screen, fireEvent } from "@/lib/test/render-with-intl"
import userEvent from "@testing-library/user-event"
import { describe, it, expect } from "vitest"
import { ReviewFlow } from "./review-flow"

// mock-review-client의 STORE는 모듈 전역(Map)이라 테스트끼리 meetingId를 겹치지 않게 발급한다.
let seq = 0
function freshMeetingId() {
  seq += 1
  return `qa-review-flow-${seq}`
}

describe("ReviewFlow — 단계 순서(C3) + AI 없이 저장(C1)", () => {
  it("1단계는 'AI 보고서 + 적합도'(compose)로 시작하고, 2단계는 '미팅 후기'(intake)다", async () => {
    render(
      <ReviewFlow meetingId={freshMeetingId()} counterpartOrg="풍산" orgId="org-exhibitor" />,
    )

    // 로딩이 끝나면 1단계(보고서 작성) 화면부터 보인다 — 녹음/직접입력 탭이 바로 보임.
    expect(await screen.findByText("녹음 업로드")).toBeInTheDocument()
    expect(screen.getByText("직접 입력")).toBeInTheDocument()
    // 아직 '미팅이 진행되었나요?'(후기 질문)는 화면에 없다 — 순서가 뒤로 밀렸다.
    expect(screen.queryByText("미팅이 진행되었나요?")).not.toBeInTheDocument()

    // 스텝 인디케이터: "1. AI 보고서 + 적합도"가 "2. 미팅 후기"보다 먼저(DOM 순서) 나온다.
    const compose = screen.getByText(/1\. AI 보고서 \+ 적합도/)
    const intake = screen.getByText(/2\. 미팅 후기/)
    expect(
      compose.compareDocumentPosition(intake) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
  })

  it("AI로 정리하기를 한 번도 누르지 않아도 직접 입력만으로 저장·완료된다(C1)", async () => {
    const user = userEvent.setup()
    const meetingId = freshMeetingId()
    render(<ReviewFlow meetingId={meetingId} counterpartOrg="풍산" orgId="org-exhibitor" />)

    // 1단계(보고서) — AI 버튼을 누르지 않고 핵심 논의사항 칸에 바로 입력한다.
    await screen.findByText("녹음 업로드")
    const discussionLabel = screen.getByText("핵심 논의사항")
    const discussionField = discussionLabel.closest("div")!.querySelector("textarea")!
    fireEvent.change(discussionField, { target: { value: "155mm 사거리 연장 요구" } })

    // '다음' 버튼은 AI 결과 없이도 처음부터 활성 상태다(구 버전은 hasDraft 없인 비활성이었음).
    const nextButton = screen.getByRole("button", { name: "다음: 미팅 후기 작성" })
    expect(nextButton).toBeEnabled()
    await user.click(nextButton)

    // 2단계(후기) — 진행됨 선택 + 만족도 + 후속의향을 채우고 최종 제출.
    expect(await screen.findByText("미팅이 진행되었나요?")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "진행됨" }))
    await user.click(screen.getByLabelText("5점"))
    await user.click(screen.getByRole("button", { name: "있음" }))

    const submitButton = screen.getByRole("button", { name: "저장하고 완료" })
    expect(submitButton).toBeEnabled()
    await user.click(submitButton)

    // 3단계(완료) 화면 도달 — AI 구조화/전사 엔드포인트를 한 번도 호출하지 않고도 끝났다.
    expect(await screen.findByText("회의록 완료")).toBeInTheDocument()
    expect(screen.getByText("155mm 사거리 연장 요구")).toBeInTheDocument()
  })

  it("보고서 내용이 하나도 없이 후기를 제출하면 막히고 보고서 화면으로 되돌아간다", async () => {
    const user = userEvent.setup()
    const meetingId = freshMeetingId()
    render(<ReviewFlow meetingId={meetingId} counterpartOrg="풍산" orgId="org-exhibitor" />)

    await screen.findByText("녹음 업로드")
    await user.click(screen.getByRole("button", { name: "다음: 미팅 후기 작성" }))

    await screen.findByText("미팅이 진행되었나요?")
    await user.click(screen.getByRole("button", { name: "진행됨" }))
    await user.click(screen.getByLabelText("3점"))
    await user.click(screen.getByRole("button", { name: "없음" }))
    await user.click(screen.getByRole("button", { name: "저장하고 완료" }))

    // 보고서가 비어 있으니 완료로 못 가고, 다시 1단계(보고서 작성)로 돌아간다.
    expect(await screen.findByText("녹음 업로드")).toBeInTheDocument()
    expect(screen.queryByText("회의록 완료")).not.toBeInTheDocument()
  })

  it("상대방 불참(노쇼)은 여전히 후기 한 화면만으로 바로 완료된다", async () => {
    const user = userEvent.setup()
    const meetingId = freshMeetingId()
    render(<ReviewFlow meetingId={meetingId} counterpartOrg="풍산" orgId="org-exhibitor" />)

    await screen.findByText("녹음 업로드")
    await user.click(screen.getByRole("button", { name: "다음: 미팅 후기 작성" }))

    await screen.findByText("미팅이 진행되었나요?")
    await user.click(screen.getByRole("button", { name: "상대방 불참" }))
    await user.click(screen.getByRole("button", { name: "이대로 저장" }))

    expect(await screen.findByText("상대방 불참으로 기록됨")).toBeInTheDocument()
  })

  it("'내가 불참'도 회의록 내용 없이 바로 완료된다(QA: 예전엔 reportEmpty로 막혔었다)", async () => {
    const user = userEvent.setup()
    const meetingId = freshMeetingId()
    render(<ReviewFlow meetingId={meetingId} counterpartOrg="풍산" orgId="org-exhibitor" />)

    await screen.findByText("녹음 업로드")
    await user.click(screen.getByRole("button", { name: "다음: 미팅 후기 작성" }))

    await screen.findByText("미팅이 진행되었나요?")
    await user.click(screen.getByRole("button", { name: "내가 불참" }))
    await user.click(screen.getByRole("button", { name: "이대로 저장" }))

    // reportEmpty 에러로 보고서 화면(compose)으로 되돌아가지 않고, "상대방 불참"과는 다른
    // 본인 불참 전용 라벨과 함께 바로 완료로 간다.
    expect(await screen.findByText("내가 불참한 미팅으로 기록됨")).toBeInTheDocument()
    expect(screen.queryByText("녹음 업로드")).not.toBeInTheDocument()
  })

  it("껍데기 Love Call 토글은 더 이상 후기 화면에 없다", async () => {
    const user = userEvent.setup()
    const meetingId = freshMeetingId()
    render(<ReviewFlow meetingId={meetingId} counterpartOrg="풍산" orgId="org-exhibitor" />)

    await screen.findByText("녹음 업로드")
    await user.click(screen.getByRole("button", { name: "다음: 미팅 후기 작성" }))

    await screen.findByText("미팅이 진행되었나요?")
    await user.click(screen.getByRole("button", { name: "진행됨" }))
    expect(screen.queryByText("Love Call 보내기 (공개)")).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "보내기" })).not.toBeInTheDocument()
  })
})
