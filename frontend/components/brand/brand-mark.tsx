// 공용 브랜드 마크 — "K 로고 + Sales AI 워드마크". 사이드바 헤더 2곳(AppSidebar·AdminSidebar)과
// 브랜드 패널(EventBrandPanel), 로그인 카드 상단까지 총 4곳이 같은 마크업을 반복해 쓰므로 한 곳에
// 모았다(2026-09-30 NABI→Sales AI 리브랜딩).
//
// src로 2x(431x537) 렌디션을 쓰는 이유: next/image 기본 로더는 sizes에 맞춰 여러 배율의 렌디션을
// 만들어 내지만, 소스 자체가 좁으면 그 이상으로 키울 수 없다(업스케일 금지). 1x(215x268)를 넣으면
// 사이드바·로그인 카드처럼 로고가 상대적으로 크게 배치되는 자리에서 2x 디스플레이 물리 픽셀이
// 모자라 흐려진다. 2x를 src로 두면 1x 디스플레이에서도, 2x 디스플레이에서도 선명하게 나온다.
// (1x 원본 k-logo.png도 발주사 지시대로 브랜드 에셋 보관 목적으로 public/brand에 함께 둔다.)
import Image from "next/image"

import { cn } from "@/lib/utils"

export interface BrandMarkProps {
  className?: string
  logoClassName?: string
  wordmarkClassName?: string
  /**
   * next/image 가 srcSet 후보 중 무엇을 받을지 고르는 기준 폭.
   * 기본값 "24px": 네 호출처 모두 로고를 h-6(24px 높이)로 고정해 쓰고, 종횡비 431:537상
   * CSS 폭은 ≈19px 이므로 2x 디스플레이 기준 48px 안팎 후보면 충분하다.
   * sizes를 생략하면 next/image가 기본값 "100vw"로 떨어져, 24px짜리 로고 하나 때문에
   * 폭 1000px대 렌디션을 요청하게 된다. 호출 쪽에서 로고를 h-6보다 크게 키운다면
   * 그 실제 렌더 폭에 맞춰 이 sizes도 함께 넘겨야 한다.
   */
  sizes?: string
  /**
   * "Sales AI" 워드마크 표시 여부(기본 true). 로그인 후 사이드바 헤더는 발주사 요청(2026-10-01)으로
   * 로고만 보인다 — 이때는 워드마크가 없으니 로고 이미지가 접근성 이름을 맡는다.
   */
  showWordmark?: boolean
}

export function BrandMark({
  className,
  logoClassName,
  wordmarkClassName,
  sizes = "24px",
  showWordmark = true,
}: BrandMarkProps) {
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      {/* 워드마크가 있으면 로고는 장식적 — 접근성 이름은 옆 워드마크 <span>이 담당한다(alt="" +
          aria-hidden으로 스크린리더가 "Sales AI"를 두 번 읽지 않게 한다). 워드마크를 숨기면 로고가
          유일한 브랜드 표시라 alt로 이름을 준다. 종횡비 431:537 ≈ 0.80(세로가 김)이라 폭을 고정하면
          왜곡되므로 높이만 고정하고 w-auto로 비율을 지킨다. */}
      <Image
        src="/brand/k-logo@2x.png"
        alt={showWordmark ? "" : "Sales AI"}
        aria-hidden={showWordmark ? "true" : undefined}
        width={431}
        height={537}
        sizes={sizes}
        className={cn("h-6 w-auto", logoClassName)}
      />
      {showWordmark && (
        <span className={cn("text-base font-semibold tracking-tight", wordmarkClassName)}>
          Sales AI
        </span>
      )}
    </span>
  )
}
