"use client"

// 미팅 불가 시간 격자 — 운영자 콘솔 세 곳이 함께 쓰는 **유일한** 격자 UI다:
//   · /admin/settings "미팅 불가 시간대"(기업을 골라 지정)
//   · /admin/organizations 대리작성 다이얼로그의 "비즈니스 미팅" 탭
//   · 신청서 편집 패널(components/operator/application-panel)의 "미팅 불가 시간"
// 예전엔 앞의 두 곳에 같은 표가 인라인으로 두 벌 있어 모양·라벨이 갈렸다(components/roster·
// contact-password와 같은 이유로 공용 모듈로 둔다).
//
// 이 컴포넌트는 그리기만 한다 — 저장(전체 치환 PATCH)과 실패 시 되돌리기는 호출부 소유다. 칸 id는
// `${YYYY-MM-DD}T${HH:MM}`(lib/organizer/schedule.slotId)로, 백엔드가 저장하는 키와 같다.
// 격자 밖의 불가 시간(행사 설정이 바뀌어 어긋난 칸)은 표에 보이지 않지만 호출부의 목록에는 남는다 —
// 토글은 전체 목록을 다시 보내므로 사라지지 않는다.

import { formatEventDate } from "@/lib/admin/events"
import type { UnavailableSlotGrid as SlotGridAxes } from "@/lib/operator/slot-grid"
import { slotId } from "@/lib/organizer/schedule"
import { cn } from "@/lib/utils"

export function UnavailableSlotGrid({
  grid,
  blocked,
  onToggle,
  readOnly = false,
}: {
  // 격자의 축. null이면(행사 기간·운영시간을 못 읽음) 지어낸 격자 대신 안내문을 그린다.
  grid: SlotGridAxes | null
  blocked: readonly string[]
  onToggle: (slot: string) => void
  // 편집 권한이 없거나 저장 중이면 true — 칸은 보이되 눌리지 않는다.
  readOnly?: boolean
}) {
  if (!grid || grid.dateIds.length === 0 || grid.times.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        슬롯 격자를 만들 수 없습니다. 행사 기간과 미팅 시간 단위를 먼저 확인해 주세요.
      </p>
    )
  }
  const blockedSet = new Set(blocked)
  return (
    <div className="overflow-x-auto rounded-lg border">
      <table className="w-full border-collapse text-xs">
        <thead>
          <tr className="bg-muted/40">
            <th className="sticky left-0 z-10 bg-muted/40 px-3 py-2 text-left font-medium text-muted-foreground">
              날짜
            </th>
            {grid.times.map((t) => (
              <th
                key={t}
                className="px-1 py-2 text-center font-medium tabular-nums text-muted-foreground"
              >
                {t}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {grid.dateIds.map((dateId) => (
            <tr key={dateId} className="border-t">
              <td className="sticky left-0 z-10 whitespace-nowrap bg-background px-3 py-1.5 font-medium">
                {formatEventDate(dateId)}
              </td>
              {grid.times.map((t) => {
                const id = slotId(dateId, t)
                const on = blockedSet.has(id)
                return (
                  <td key={id} className="p-0.5">
                    <button
                      type="button"
                      disabled={readOnly}
                      aria-pressed={on}
                      aria-label={`${formatEventDate(dateId)} ${t} ${on ? "불가 해제" : "불가 지정"}`}
                      onClick={() => onToggle(id)}
                      className={cn(
                        "h-7 w-full min-w-10 rounded transition-colors disabled:cursor-not-allowed",
                        on ? "bg-foreground text-background" : "bg-muted/50 hover:bg-muted",
                      )}
                    >
                      {on ? "×" : ""}
                    </button>
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
