import { cookies } from "next/headers"
import { REFRESHED_COOKIE, STATUS_COOKIE } from "@/lib/auth/session-cookie"
import { redirect } from "next/navigation"
import { getLocale, getTranslations } from "next-intl/server"
import {
  resolveRequestSession,
  requestPeriodOverride,
} from "@/lib/mock/session-server"
import { resolveHttpSession } from "@/lib/auth/http-session"
import { fetchMe } from "@/lib/auth/me-client"
import { resolveSidebarUser } from "@/lib/auth/sidebar-user"
import { resolveLocale } from "@/lib/i18n/config"
import { APPLICATION_STATUSES } from "@/lib/application-status"
import {
  isApplicationOpen,
  isApplicationClosed,
  resolveApplicationPeriod,
} from "@/lib/bm/application-period"
import { resolveWelcomeView, type WelcomeView } from "@/lib/bm/welcome-view"
import type { ApplicationStatus } from "@/lib/bm/types"
import { EventBrandPanel } from "@/components/auth/event-brand-panel"
import { LogoutButton } from "@/components/auth/logout-button"
import { ApplicationActions } from "@/components/welcome/application-actions"
import { HelpButton } from "@/components/help/help-button"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from "@/components/ui/card"

export const dynamic = "force-dynamic"

// HM-002 입장 전 랜딩(/welcome) — 글로벌 nav 없는 단독 화면(AppShell 밖, /login과 동일 패턴).
// 로그인 후 본 서비스(nav) 진입 자격이 안 되는 참가사·바이어가 착지. 신청기간 × application_status로
// 안내·동선을 분기한다(FE ADR-0002). nav 진입 게이트(approved AND 신청기간 종료)는 route-guard가 강제(#114).
//
// 실 세션(resolveHttpSession)이 있으면 그 role + fetchMe()의 application_status로 화면을 정한다 —
// dev status/period 오버라이드 쿠키는 실 세션엔 적용하지 않는다(잔존 dev 쿠키가 진짜 신청 상태를 덮어쓰면
// 안 됨, app/page.tsx와 동일 실세션 판정 패턴). 신청기간은 env(BM_APPLICATION_OPENS_AT/CLOSES_AT)만 본다.
// 실 세션이 없으면(mock 모드) 기존 그대로 세션 쿠키(resolveRequestSession) + dev ?status/?period 오버라이드를
// 쓴다 — proxy가 ?status/?period를 쿠키로 미러링하므로 이 페이지는 쿼리를 직접 보지 않는다. dev 미리보기
// 패널(status/period 스위처)은 mock 세션 전용이라 실 세션에서는 렌더하지 않는다.
const APP_OPENS_AT = process.env.BM_APPLICATION_OPENS_AT ?? "2000-01-01"
const APP_CLOSES_AT = process.env.BM_APPLICATION_CLOSES_AT ?? "2999-12-31"
const DEV_PREVIEW = process.env.NODE_ENV !== "production"

const ALL_STATUSES: ApplicationStatus[] = [
  "registered",
  "submitted",
  "changes_requested",
  "approved",
  "rejected",
]

function kstToday(): string {
  return new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Seoul" })
}

interface ViewContent {
  badge: string
  tone: "neutral" | "wait" | "go" | "stop"
  title: string
  description: string
  note?: string
  cta?: { label: string; href: string }
  waitingLabel?: string // 비활성 안내 버튼(동선 없음)
}

// welcome 네임스페이스 t — 순수 함수(contentFor)는 훅을 못 쓰므로 호출부(WelcomePage)에서 주입받는다.
type Translator = (key: string) => string

// 화면 enum → 표시 콘텐츠. CTA href는 역할(role)에 따라 신청 폼이 갈린다.
function contentFor(
  view: WelcomeView,
  role: "buyer" | "exhibitor",
  t: Translator
): ViewContent {
  const applyHref = role === "buyer" ? "/apply" : "/exhibitor/apply"
  switch (view) {
    case "write-form":
      return {
        badge: t("writeForm.badge"),
        tone: "go",
        title: t("writeForm.title"),
        // 참가사·바이어는 신청서가 묻는 항목이 달라 안내 문구도 role별로 갈린다(바이어 신청서에는
        // 전시품목·강점 같은 항목이 없다 — E2E에서 참가사용 문구가 바이어에게 노출된 결함 수정).
        description: t(role === "buyer" ? "writeForm.descriptionBuyer" : "writeForm.description"),
        cta: { label: t("writeForm.cta"), href: applyHref },
      }
    case "changes-requested":
      return {
        badge: t("changesRequested.badge"),
        tone: "wait",
        title: t("changesRequested.title"),
        description: t("changesRequested.description"),
        note: t("changesRequested.note"),
        cta: { label: t("changesRequested.cta"), href: applyHref },
      }
    case "under-review":
      return {
        badge: t("underReview.badge"),
        tone: "wait",
        title: t("underReview.title"),
        description: t("underReview.description"),
      }
    case "meeting-waiting":
      return {
        badge: t("meetingWaiting.badge"),
        tone: "wait",
        title: t("meetingWaiting.title"),
        description: t("meetingWaiting.description"),
        waitingLabel: t("meetingWaiting.waitingLabel"),
      }
    case "enter-service":
      return {
        badge: t("enterService.badge"),
        tone: "go",
        title: t("enterService.title"),
        description: t("enterService.description"),
        cta: { label: t("enterService.cta"), href: "/" },
      }
    case "rejected":
      return {
        badge: t("rejected.badge"),
        tone: "stop",
        title: t("rejected.title"),
        description: t("rejected.description"),
      }
    case "closed":
      return {
        badge: t("closed.badge"),
        tone: "stop",
        title: t("closed.title"),
        description: t("closed.description"),
      }
  }
}

const TONE_BADGE: Record<ViewContent["tone"], string> = {
  neutral: "",
  wait: "border-amber-300 text-amber-700 dark:border-amber-800 dark:text-amber-400",
  go: "border-emerald-300 text-emerald-700 dark:border-emerald-800 dark:text-emerald-400",
  stop: "border-muted-foreground/30 text-muted-foreground",
}

export default async function WelcomePage({
  searchParams,
}: {
  // dev 드래프트 미리보기(?draft=empty|started|done) — proxy가 안 떼므로 URL에 남는다. 활성 표시용.
  searchParams: Promise<{ draft?: string }>
}) {
  const { draft: draftParam } = await searchParams
  const session = await resolveRequestSession()
  // 실 세션이면 그 role/org를, 아니면 기존 mock/dev 세션(?as=)을 쓴다(app/page.tsx와 동일 패턴).
  const realSession = await resolveHttpSession()
  // 운영자는 입장 전 게이트 대상이 아니다 — 자기 대시보드로. realSession.role은 buyer/exhibitor만
  // 오므로(lib/auth/http-session.ts) 이 분기는 mock 세션(session.role)에만 해당한다.
  if (!realSession && session.role === "organizer") redirect("/organizer")
  const role: "buyer" | "exhibitor" = realSession
    ? realSession.role
    : session.role === "buyer"
      ? "buyer"
      : "exhibitor"
  const t = await getTranslations("welcome")
  const tc = await getTranslations("common")
  const locale = resolveLocale(await getLocale())

  // 실 세션 신원 — /api/me(fetchMe, 요청당 1회 캐시)로 상태·표시 정보를 채운다. 실패·필드 미제공은
  // 안전 폴백(mock 인물로 대체하지 않는다, lib/auth/sidebar-user.ts 원칙).
  const me = realSession ? await fetchMe() : null
  const meRole =
    me?.roles.find((r) => (role === "buyer" ? r.is_buyer : r.is_exhibitor)) ??
    null
  const rawStatus = meRole?.application_status
  const isValidStatus =
    rawStatus != null &&
    (APPLICATION_STATUSES as readonly string[]).includes(rawStatus)

  // status는 실 세션이면 /api/me(유효값만, 아니면 registered 폴백) — dev status 쿠키 오버라이드는 무시한다.
  // mock 세션은 기존 그대로 세션에서(참가자는 항상 존재, 폴백 registered).
  const status: ApplicationStatus = realSession
    ? isValidStatus
      ? (rawStatus as ApplicationStatus)
      : "registered"
    : (session.applicationStatus ?? "registered")
  // 신청기간은 실 세션이면 env만(dev ?period 오버라이드 무시), mock 세션은 기존 dev ?period 쿠키 오버라이드.
  const periodOverride =
    !realSession && DEV_PREVIEW ? await requestPeriodOverride() : null
  const period = resolveApplicationPeriod({
    override: periodOverride,
    opensAt: APP_OPENS_AT,
    closesAt: APP_CLOSES_AT,
  })
  const today = kstToday()
  const applicationOpen = isApplicationOpen(today, period)
  const applicationClosed = isApplicationClosed(today, period)

  const view = resolveWelcomeView(status, {
    open: applicationOpen,
    closed: applicationClosed,
  })
  // 입장 자격(approved)이면 입장 전 랜딩에 머물지 않고 홈(/)으로 보낸다(ADR-0002).
  //
  // ⚠ 루프 주의: 이 페이지는 실시간 /api/me로 상태를 보지만, 라우트 게이트(proxy.ts)는 로그인 때 심은
  // STATUS_COOKIE로 판단한다. 운영자가 나중에 승인하면 그 쿠키만 옛 값(submitted)으로 남아 게이트가
  // /를 막고, 여기선 approved라 다시 /로 보내 무한 리다이렉트가 됐다(2026-09-10 실사용자 보고).
  // → 쿠키가 아직 approved가 아니면 곧장 /로 보내지 말고 쿠키 재동기화 라우트를 한 번 거친다.
  //   그마저 실패하면(마커 존재) 리다이렉트를 포기하고 아래 안내 카드를 그린다(루프 대신 degrade).
  if (view === "enter-service") {
    const jar = await cookies()
    const cookieStatus = jar.get(STATUS_COOKIE)?.value
    if (cookieStatus === "approved") redirect("/")
    if (!jar.get(REFRESHED_COOKIE)?.value) redirect("/api/auth/refresh?next=/")
  }
  const c = contentFor(view, role, t)
  // 신청기간 중에는 상태별 신청서 액션(작성/수정/제출/보기)을 카드 푸터에 띄운다(폼=저장, 제출은 여기서).
  // 종료 후에는 기존 안내 콘텐츠(마감·반려 등)를 그대로 쓴다.
  const showActions = applicationOpen
  // 하단 신원 블록 — 실 세션은 fetchMe 결과(resolveSidebarUser, 필드별 null이면 그 줄 숨김·mock 대체 금지),
  // mock 세션은 기존 세션 유저 그대로(app-shell.tsx의 사이드바 신원과 동일 원천 판정).
  const identity = realSession
    ? resolveSidebarUser(me, locale)
    : {
        name: session.user.name,
        affiliation: session.user.affiliation,
        email: session.user.email,
        phone: session.user.phone,
      }
  // 신청서 액션의 프로필 키 — 참가사·바이어 공통으로 getExhibitorClient/getBuyerClient가
  // org_event_role_id를 경로 파라미터로 쓴다(lib/bm/http-exhibitor-client.ts,
  // lib/bm/http-buyer-client.ts). meRole(위에서 이미 role에 맞게 조회)의 org_event_role_id를
  // 써야 한다(realSession.orgId는 organization_id라 다른 값 — 잘못 넘기면 실배선 대상이 400/404).
  const profileKey = realSession
    ? (meRole?.org_event_role_id ?? session.orgId)
    : session.orgId
  // 실 세션이고 실 org_event_role_id를 확보했을 때만 true(역할 공통) — ApplicationActions가
  // getExhibitorClient/getBuyerClient(isReal)로 실 백엔드를 쓸지 결정한다(mock 경로는 기존과 동일하게 false).
  const isRealParticipant = !!meRole?.org_event_role_id
  // dev 미리보기 패널(status/period 스위처)은 mock 세션 전용 — 실 세션에서는 렌더하지 않는다.
  const showDevPreview = !realSession && DEV_PREVIEW

  return (
    <main className="min-h-svh md:grid md:grid-cols-[1.1fr_1fr] lg:grid-cols-[1.25fr_1fr]">
      {/* 좌(데스크톱)·상(모바일): 행사 브랜드 패널 — 로그인과 동일 쉘로 화면을 채운다(EventBrandPanel 재사용,
          NABI·행사 로고 포함). 좁은 카드가 빈 화면에 떠 있는 옹졸함을 없앤다. */}
      <EventBrandPanel />
      {/* 우(데스크톱)·하(모바일): 입장 전 상태 카드 + 계정/로그아웃. 자기 영역에서 중앙 배치. */}
      <div className="flex items-center justify-center px-6 py-10 md:min-h-svh md:px-10 lg:px-16">
        <div className="w-full max-w-md">
          <Card className="border-border/80 shadow-sm" data-tour="welcome-card">
            <CardHeader>
              <Badge
                variant="outline"
                className={`w-fit ${TONE_BADGE[c.tone]}`}
              >
                {c.badge}
              </Badge>
              <CardTitle className="text-xl leading-snug">{c.title}</CardTitle>
              <CardDescription className="leading-relaxed">
                {c.description}
              </CardDescription>
            </CardHeader>
            {c.note ? (
              <CardContent>
                <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200">
                  {c.note}
                </p>
              </CardContent>
            ) : null}
            {(showActions || c.cta || c.waitingLabel) && (
              <CardFooter>
                {showActions ? (
                  // 폼=저장, 제출은 여기서 — 상태별 작성/수정/제출/보기로 분리(ApplicationActions).
                  <ApplicationActions
                    role={role}
                    profileKey={profileKey}
                    status={status}
                    isReal={isRealParticipant}
                  />
                ) : (
                  <>
                    {c.cta ? (
                      <Button asChild className="w-full">
                        <a href={c.cta.href}>{c.cta.label}</a>
                      </Button>
                    ) : null}
                    {c.waitingLabel ? (
                      <Button disabled className="w-full">
                        {c.waitingLabel}
                      </Button>
                    ) : null}
                  </>
                )}
              </CardFooter>
            )}
          </Card>

          {/* 로그인 정보 노출 + 로그아웃 — 단독 화면이라 nav가 없으니 여기서 계정 컨텍스트·탈출 경로를 준다.
              실 세션은 필드별로 null일 수 있다(백엔드 롤아웃 중) — 없는 줄은 통째로 숨긴다(mock 대체 금지). */}
          <div
            className="mt-6 flex flex-col items-center gap-3 border-t border-border/60 pt-5"
            data-tour="welcome-account"
          >
            <div className="text-center">
              {identity.name ? (
                <p className="text-sm font-medium">
                  {identity.name}
                  <span className="text-muted-foreground">
                    {" "}
                    · {role === "buyer" ? tc("roleBuyer") : tc("roleExhibitor")}
                  </span>
                </p>
              ) : null}
              {identity.affiliation || identity.email ? (
                <p className="text-xs text-muted-foreground">
                  {[identity.affiliation, identity.email]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              ) : null}
            </div>
            <LogoutButton />
          </div>

          {showDevPreview ? (
            <div className="mt-8 rounded-md border border-dashed border-border p-3">
              <p className="mb-2 text-xs font-medium text-muted-foreground">
                dev 미리보기 — status / period (실연동 시 제거)
              </p>
              <div className="mb-2 flex flex-wrap gap-1.5">
                {ALL_STATUSES.map((s) => (
                  <a
                    key={s}
                    href={`/welcome?status=${s}&period=${applicationOpen ? "open" : "closed"}`}
                    className={`rounded border px-2 py-0.5 text-xs ${
                      s === status
                        ? "border-foreground bg-foreground text-background"
                        : "border-border text-muted-foreground hover:bg-muted"
                    }`}
                  >
                    {s}
                  </a>
                ))}
              </div>
              <div className="flex gap-1.5">
                {(["open", "closed"] as const).map((p) => (
                  <a
                    key={p}
                    href={`/welcome?status=${status}&period=${p}`}
                    className={`rounded border px-2 py-0.5 text-xs ${
                      (p === "open") === applicationOpen
                        ? "border-foreground bg-foreground text-background"
                        : "border-border text-muted-foreground hover:bg-muted"
                    }`}
                  >
                    신청기간 {p === "open" ? "중" : "종료"}
                  </a>
                ))}
              </div>
              {/* 드래프트 상태(작성 전/중/완료) — registered·changes_requested에서 작성하기↔수정하기·제출 노출 확인용. */}
              {status === "registered" || status === "changes_requested" ? (
                <div className="mt-1.5 flex gap-1.5">
                  {(
                    [
                      ["empty", "작성 전"],
                      ["done", "작성 완료"],
                    ] as const
                  ).map(([d, label]) => (
                    <a
                      key={d}
                      href={`/welcome?status=${status}&period=${applicationOpen ? "open" : "closed"}&draft=${d}`}
                      className={`rounded border px-2 py-0.5 text-xs ${
                        draftParam === d
                          ? "border-foreground bg-foreground text-background"
                          : "border-border text-muted-foreground hover:bg-muted"
                      }`}
                    >
                      {label}
                    </a>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
      {/* 단독 화면(AppShell 밖)이라 셸 도움말이 없다 — 입장 전 안내 도움말을 역할에 맞춰 얹는다(F-HELP). */}
      <HelpButton role={role} />
    </main>
  )
}
