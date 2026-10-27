"use client"

// 운영자 콘솔(/organizer·/admin) 안에서 쓰는 "열 수 없음" 안내 패널 — 권한 없음·찾을 수 없음·일시 오류.
//
// 이 패널은 **콘솔 크롬(사이드바·로그아웃) 안에** 그려진다(레이아웃이 크롬을 소유하고 페이지·error.tsx가
// 이 패널을 본문 자리에 둔다). 그래서 사용자는 오류를 만나도 nav로 다른 화면에 가거나 로그아웃할 수
// 있다 — 2026-09-17 결함(서브 운영자가 사이드바도 로그아웃도 없는 서버 오류 화면에 갇힘)의 재발 방지.
//
// 서버 페이지에서도 그대로 쓴다(권한으로 막힌 화면). 그때는 onRetry(함수)를 넘기지 않는다 — 함수는
// 서버→클라 props로 직렬화되지 않는다. 재시도 버튼은 error.tsx(클라)만 단다.

import Link from "next/link"
import { RotateCw, SearchX, ShieldAlert, TriangleAlert } from "lucide-react"

import { LogoutButton } from "@/components/auth/logout-button"
import { Button } from "@/components/ui/button"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"

export type OperatorStateKind = "forbidden" | "not_found" | "error"

const DEFAULT_COPY: Record<OperatorStateKind, { title: string; description: string }> = {
  forbidden: {
    title: "이 화면을 볼 권한이 없습니다",
    description:
      "현재 계정의 운영자 권한으로는 열 수 없는 화면입니다. 권한이 필요하면 슈퍼 운영자에게 문의해 주세요.",
  },
  not_found: {
    title: "찾을 수 없습니다",
    description: "요청한 정보를 찾을 수 없거나 열람 권한이 없습니다. 목록에서 다시 선택해 주세요.",
  },
  error: {
    title: "화면을 불러오지 못했습니다",
    description: "일시적인 문제일 수 있어요. 잠시 후 다시 시도하거나 다른 메뉴로 이동해 주세요.",
  },
}

const ICON: Record<OperatorStateKind, typeof ShieldAlert> = {
  forbidden: ShieldAlert,
  not_found: SearchX,
  error: TriangleAlert,
}

export interface OperatorStatePanelProps {
  kind: OperatorStateKind
  title?: string
  description?: string
  // 콘솔 안의 안전한 착지점(예: /organizer 매칭 현황). 없으면 링크를 그리지 않는다.
  homeHref?: string
  homeLabel?: string
  // error.tsx 전용 — 세그먼트 재요청·재렌더(unstable_retry). 서버 페이지는 넘기지 않는다.
  onRetry?: () => void
  // 크롬(사이드바)이 없을 수도 있는 자리(레이아웃 자체 실패 등)에서 로그아웃 동선을 보장한다.
  showLogout?: boolean
}

export function OperatorStatePanel({
  kind,
  title,
  description,
  homeHref,
  homeLabel = "처음 화면으로",
  onRetry,
  showLogout = false,
}: OperatorStatePanelProps) {
  const copy = DEFAULT_COPY[kind]
  const Icon = ICON[kind]
  return (
    <Empty className="border" data-operator-state={kind}>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Icon />
        </EmptyMedia>
        <EmptyTitle role="heading" aria-level={2} className="text-base">
          {title ?? copy.title}
        </EmptyTitle>
        <EmptyDescription>{description ?? copy.description}</EmptyDescription>
      </EmptyHeader>
      {(onRetry || homeHref || showLogout) && (
        <EmptyContent>
          <div className="flex flex-wrap items-center justify-center gap-2">
            {onRetry && (
              <Button type="button" size="sm" onClick={onRetry}>
                <RotateCw data-icon="inline-start" />
                다시 시도
              </Button>
            )}
            {homeHref && (
              <Button size="sm" variant="outline" asChild>
                <Link href={homeHref}>{homeLabel}</Link>
              </Button>
            )}
            {showLogout && <LogoutButton />}
          </div>
        </EmptyContent>
      )}
    </Empty>
  )
}
