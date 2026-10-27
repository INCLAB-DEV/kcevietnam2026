// /login 전용 행사 포스터 패널. 발주사 시안에서 카드 왼쪽 컬럼을 차지하는 키비주얼이다.
//
// ⚠ 공용 브랜드 패널(EventBrandPanel)을 쓰지 않는 이유: 그 컴포넌트는 /signup·/welcome도 함께
// 쓰는데, 이번 리뉴얼은 /login 한 화면만 바꾸기로 했다. 그래서 공용 패널은 손대지 않고 로그인
// 전용 대체 컴포넌트를 따로 둔다(다른 두 화면은 무변경).
//
// 이미지는 시안 PSD에서 뽑은 래스터 한 장(public/login/key-visual.png, 431x596)뿐이다. 벡터도 2x
// 원본도 없어서, 데스크톱 최대 표시폭을 소스보다 작게(≈404px, 0.94x) 잡아 확대로 뭉개지는 건 막았다.
// 다만 2x 디스플레이에선 여전히 물리 픽셀이 모자라 살짝 무를 수 있다 — 고해상도 원본 필요(발주사 확인).
// 모바일에서도 포스터를 보여달라는 요구가 있어(발주자), md 미만에선 폼 위로 쌓되 폭을 줄여
// 전체가 잘리지 않게 한다 — 크롭 대신 축소라 비율 왜곡도 없고 폼이 접힘 아래로 밀리지도 않는다.
import Image from "next/image"
import { getLocale, getTranslations } from "next-intl/server"

import { CURRENT_EVENT } from "@/lib/event/current-event"
import { resolveLocale } from "@/lib/i18n/config"

export async function LoginPosterPanel() {
  const t = await getTranslations("login")
  const event = CURRENT_EVENT[resolveLocale(await getLocale())]
  return (
    // 모바일: 카드 폭의 절반 남짓으로 가운데 정렬 / md+: 왼쪽 컬럼을 그대로 채운다.
    <div className="mx-auto w-48 sm:w-64 md:mx-0 md:w-full">
      <Image
        src="/login/key-visual.png"
        alt={t("posterAlt", { event: event.name })}
        width={431}
        height={596}
        // 화면 최상단·최대 요소(LCP)라 lazy로 두면 첫 인상이 비어 보인다.
        loading="eager"
        fetchPriority="high"
        sizes="(min-width: 1024px) 404px, (min-width: 768px) 42vw, 256px"
        className="h-auto w-full rounded-2xl"
      />
    </div>
  )
}
