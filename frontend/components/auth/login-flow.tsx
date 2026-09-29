"use client"

// F-AU-001 통합 로그인 오케스트레이터.
//
// ── 전체 로직 ─────────────────────────────────────────────────────────────────
// 진입은 두 갈래: 딥링크(/login?token=…)와 토큰 없는 진입(운영사·로그아웃 복귀).
//
//   /login 진입
//   ├─ token 있음 → checkDeeplinkToken(token)  // 마운트 시 useEffect
//   │     ├─ 만료/무효 → deeplink-error 화면(+ "로그인으로" 탈출 버튼)
//   │     └─ 유효(+ 토큰이 준 username)
//   │           ├─ 기존 세션 있음 → resume(계정 선택)
//   │           └─ 기존 세션 없음 → credentials(아이디 프리필 + 비번 포커스)
//   └─ token 없음
//         ├─ 기존 세션 있음 → resume
//         └─ 기존 세션 없음 → credentials(빈 아이디)
//
//   resume       : 최근 로그인 계정 목록(1+개) 중 선택 → 곧바로 도착 분기 / "다른 계정으로 로그인" → credentials(빈 폼)
//   credentials  : startLogin → rejected/not_found=인라인 에러 / succeeded=도착 분기 / consent_required=약관
//   consent      : 필수 약관 모두 동의 → completeLogin(loginTicket) → 세션 발급 → 도착 분기 (티켓 무효면 폼 복귀)
//   도착 분기     : landingHref(role) — 운영사→/organizer, 참가사·바이어→/welcome(입장 전 랜딩)
//
// 로그인은 접힌 트랜잭션 2단계(ADR-0011): startLogin(자격검증+분기) → 최초자면 completeLogin(약관→세션).
//
// ── 경계/원칙 ─────────────────────────────────────────────────────────────────
// · 모든 백엔드 호출(토큰·자격·약관·세션)은 AuthClient seam(=FastAPI 경유, ADR-0008 경계 B)으로만.
//   지금은 mock 구현, BE(#19~#22) 완성 시 동일 인터페이스 HTTP 구현으로 스왑(화면 불변).
// · 신원의 닻은 *링크*가 아니라 *DX Korea 아이디/비번*(D2) — 유효 토큰도 자동 로그인하지 않고 비번을 받는다.
// · 역할 분기는 순수 role-branch(landingHref)가 결정, 이 컴포넌트는 router.push만 수행.
// · 기존 세션 읽기는 페이지가 담당(prod=Cognito 서버 읽기, dev=?session= mock)해 prop으로 주입.

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { Loader2, ShieldAlert, Check, ChevronRight, Eye, EyeOff } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Sheet,
  SheetContent,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { cn } from "@/lib/utils"
// 이 화면 전용 비주얼 상수(핑크 CTA·입력창) — /login에서만 쓰는 값이라 전역 토큰을 건드리지 않는다.
import { LOGIN_CTA_CLASS, LOGIN_INPUT_CLASS } from "@/components/auth/login-visual"
import { defaultAuthClient } from "@/lib/auth/auth-client"
import { canSubmitConsent } from "@/lib/auth/consent"
import { ACCOUNT_HELP_URL } from "@/lib/auth/account-help"
import { landingHref } from "@/lib/auth/role-branch"
import type {
  AuthClient,
  AuthRole,
  ConsentDocument,
  ExistingSession,
  LoginGate,
  StartLoginResult,
} from "@/lib/auth/auth-types"
import type { PermissionLevel } from "@/lib/mock/session"

// useTranslations("login")의 최소 호출 형태 — 순수 함수(rejectionMessage 등)는 훅을 못 쓰므로
// 호출부(LoginFlow)에서 t를 주입받는다.
type Translator = (key: string, values?: Record<string, string | number>) => string

// 자격검증 거부 사유 → 사용자 메시지. invalid_credentials는 기존 문구 유지, 그 외는 사유별 안내.
function rejectionMessage(
  reason: Extract<StartLoginResult, { outcome: "rejected" }>["reason"],
  t: Translator
): string {
  switch (reason) {
    case "account_locked":
      return t("errorAccountLocked")
    case "upstream_unavailable":
      return t("errorUpstreamUnavailable")
    default:
      return t("errorInvalidCredentials")
  }
}

// 빈 자격 폼(프리필 없음) — 토큰 없는 진입·"다른 계정으로 로그인"에서 쓴다.
const EMPTY_CREDENTIALS: Phase = { name: "credentials", prefillUsername: "", prefillName: "" }

// 안정적 빈 배열 기본값 — 매 렌더 새 []를 만들면 useEffect 의존성이 바뀌어 토큰 검증이 재실행된다.
const NO_EXISTING_SESSIONS: ExistingSession[] = []

// 화면 상태 머신. 한 시점에 한 단계만 렌더된다(상단 흐름도의 각 노드에 대응).
type Phase =
  | { name: "checking" } // 딥링크 토큰 검증 중(스피너)
  | { name: "deeplink-error"; status: "expired" | "invalid" } // 만료/무효 안내
  | { name: "resume"; sessions: ExistingSession[] } // 최근 로그인 이력 — 계정 선택(1개 이상)
  | { name: "credentials"; prefillUsername: string; prefillName: string } // 자격 폼(딥링크면 아이디·이름 프리필)
  | { name: "consent"; loginTicket: string; docs: ConsentDocument[] } // 최초 진입자 약관(티켓으로 2단계 잇는다)
  | { name: "redirecting" } // 도착 분기로 라우팅 중(스피너)

interface LoginFlowProps {
  // 딥링크 토큰. null이면 토큰 게이트 없이 바로 폼(운영사 진입·로그아웃 복귀).
  token: string | null
  // 최근 로그인한 NABI 세션들(재방문자). 1개 이상이면 폼 대신 "계정 선택" 화면을 보여준다.
  existingSessions?: ExistingSession[]
  // 인증 경계 주입(테스트용). 기본은 mock — 실연동 시 FastAPI 구현으로 스왑.
  client?: AuthClient
}

export function LoginFlow({
  token,
  existingSessions = NO_EXISTING_SESSIONS,
  client = defaultAuthClient,
}: LoginFlowProps) {
  const router = useRouter()
  const t = useTranslations("login")
  // 진입 시 초기 화면: 토큰 있으면 검증(checking), 없으면 세션 유무로 resume/credentials.
  const [phase, setPhase] = useState<Phase>(() => {
    if (token !== null) return { name: "checking" }
    // 토큰 없는 진입(운영사·로그아웃 복귀)은 프리필 없는 빈 폼.
    return existingSessions.length > 0
      ? { name: "resume", sessions: existingSessions }
      : EMPTY_CREDENTIALS
  })
  const [busy, setBusy] = useState(false)
  const [credError, setCredError] = useState<string | null>(null)

  // 딥링크 토큰 검증 — 토큰이 있을 때만. 만료/위조면 폼 대신 안내 화면으로.
  // 유효하면 세션 유무로 갈라진다: 세션 있으면 계정 선택(resume), 없으면 자격 폼.
  useEffect(() => {
    if (token === null) return
    let cancelled = false
    client.checkDeeplinkToken(token).then((res) => {
      if (cancelled) return
      if (res.status !== "valid") setPhase({ name: "deeplink-error", status: res.status })
      else if (existingSessions.length > 0) setPhase({ name: "resume", sessions: existingSessions })
      // 유효 딥링크 — 토큰이 준 아이디·이름을 프리필하고 비번만 입력받는다.
      else setPhase({ name: "credentials", prefillUsername: res.username, prefillName: res.name })
    })
    return () => {
      cancelled = true
    }
  }, [token, existingSessions, client])

  // 역할로 도착 분기(운영사→/organizer, 참가사·바이어→/welcome 입장 전 랜딩). 입장 전 화면·동선은
  // /welcome이 세션 application_status로 정한다(책임 분리, FE ADR-0002). 로그인 결과의 status는
  // landingHref가 ?status로 실어 보내 dev 세션 상태에 반영한다(submitted/approved 등 정확히 표시).
  // HTTP 실연동(NEXT_PUBLIC_AUTH_CLIENT==="http") 로그인은 이 dev 시드를 붙이지 않는다 — 로그인
  // BFF가 이미 실 세션 쿠키를 심었고(P1-1), ?as 시드가 남으면 proxy의 "dev 스위처가 실 세션보다
  // 우선" 규칙 때문에 방금 로그인한 실 세션이 가려진다(lib/auth/role-branch.ts 참고).
  async function goToDestination(role: AuthRole, gate: LoginGate, permissionLevel?: PermissionLevel) {
    setPhase({ name: "redirecting" })
    const seedDevSession = process.env.NEXT_PUBLIC_AUTH_CLIENT !== "http"
    let resolvedPermission = permissionLevel
    if (role === "organizer" && resolvedPermission === undefined) {
      try {
        const response = await fetch("/api/admin/me", { credentials: "same-origin" })
        if (response.ok) {
          const me = (await response.json()) as { events?: Array<{ permission_level?: string }> }
          resolvedPermission = me.events?.some((event) => event.permission_level === "master")
            ? "master"
            : "sub"
        }
      } catch {
        // 데모 클라이언트는 운영자 신원 API가 없으므로 기존 master 데모 계정으로 유지한다.
        // 실연동에서는 조회 실패를 sub로 처리해 /admin 권한을 추정하지 않는다.
        resolvedPermission = seedDevSession ? "master" : "sub"
      }
    }
    if (role === "organizer") {
      const path = resolvedPermission === "master" ? "/admin" : "/organizer"
      router.push(seedDevSession ? `${path}?as=${resolvedPermission === "master" ? "organizer" : "organizer-sub"}` : path)
      return
    }
    router.push(landingHref(role, gate.applicationStatus, { seedDevSession }))
  }

  // 1단계: 자격검증 + 명단매핑. 거부/미존재=인라인 에러, 재방문=곧바로 분기, 최초=약관 스텝.
  async function handleCredentials(username: string, password: string) {
    setBusy(true)
    setCredError(null)
    const res = await client.startLogin({ username, password, deeplinkToken: token })
    if (res.outcome === "rejected") {
      setCredError(rejectionMessage(res.reason, t))
      setBusy(false)
      return
    }
    if (res.outcome === "not_found") {
      setCredError(t("errorNotFound"))
      setBusy(false)
      return
    }
    if (res.outcome === "consent_required") {
      setBusy(false)
      setPhase({ name: "consent", loginTicket: res.loginTicket, docs: res.documents })
      return
    }
    // 재방문자(succeeded) — 약관 스텝 스킵, 세션은 BE에서 이미 발급. 곧바로 분기.
    void goToDestination(res.role, res.gate, res.permissionLevel)
  }

  // 2단계: 최초 진입자 약관 동의 → 세션 발급. 티켓 무효(만료/소비/위조)면 처음부터 다시.
  async function handleConsent(loginTicket: string, acceptedDocIds: string[]) {
    setBusy(true)
    const res = await client.completeLogin({ loginTicket, acceptedDocIds })
    if (res.outcome === "succeeded") {
      void goToDestination(res.role, res.gate, res.permissionLevel)
      return
    }
    // ticket_invalid(처음부터) 또는 consent_incomplete(FE가 미리 게이트하므로 정상 흐름엔 없음) → 자격 폼 복귀.
    setBusy(false)
    setCredError(t("errorTicketInvalid"))
    setPhase(EMPTY_CREDENTIALS)
  }

  if (phase.name === "checking") {
    return <Centered>{spinner(t("checking"))}</Centered>
  }

  if (phase.name === "redirecting") {
    return <Centered>{spinner(t("redirecting"))}</Centered>
  }

  if (phase.name === "deeplink-error") {
    return <DeeplinkError status={phase.status} />
  }

  if (phase.name === "resume") {
    return (
      <ResumeSession
        sessions={phase.sessions}
        onPick={(s) => void goToDestination(s.role, s.gate, s.permissionLevel)}
        onSwitch={() => setPhase(EMPTY_CREDENTIALS)}
      />
    )
  }

  if (phase.name === "consent") {
    return (
      <ConsentStep
        docs={phase.docs}
        busy={busy}
        onSubmit={(ids) => handleConsent(phase.loginTicket, ids)}
      />
    )
  }

  return (
    <CredentialsForm
      initialUsername={phase.prefillUsername}
      initialName={phase.prefillName}
      busy={busy}
      error={credError}
      onSubmit={handleCredentials}
    />
  )
}

function CredentialsForm({
  initialUsername,
  initialName,
  busy,
  error,
  onSubmit,
}: {
  initialUsername: string
  initialName: string
  busy: boolean
  error: string | null
  onSubmit: (username: string, password: string) => void
}) {
  const t = useTranslations("login")
  const [username, setUsername] = useState(initialUsername)
  const [password, setPassword] = useState("")
  // 비밀번호 가림 — 기본은 네이티브 type="password"로 가리고, 토글 버튼으로만 평문 확인을 허용한다.
  const [showPassword, setShowPassword] = useState(false)
  const prefilled = initialUsername.length > 0
  const canSubmit = username.trim().length > 0 && password.length > 0 && !busy

  return (
    <div className="flex flex-col gap-5">
      {/* 행사·브랜드 각인은 좌측 패널(EventBrandPanel)이 담당. 여기선 인증 맥락만 간결하게. */}
      <div className="flex flex-col gap-1.5">
        <h1 className="text-lg font-bold tracking-tight">{t("title")}</h1>
        <p className="text-sm text-muted-foreground">
          {prefilled ? t("subtitlePrefilled", { name: initialName }) : t("subtitleDefault")}
        </p>
      </div>

      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault()
          if (canSubmit) onSubmit(username.trim(), password)
        }}
      >
        <div className="flex flex-col gap-2">
          <Label htmlFor="login-username">{t("usernameLabel")}</Label>
          <Input
            id="login-username"
            value={username}
            autoComplete="username"
            autoCapitalize="none"
            autoFocus={!prefilled}
            aria-invalid={Boolean(error)}
            className={LOGIN_INPUT_CLASS}
            onChange={(e) => setUsername(e.target.value)}
          />
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="login-password">{t("passwordLabel")}</Label>
          <div className="relative">
            <Input
              id="login-password"
              type={showPassword ? "text" : "password"}
              value={password}
              autoComplete="current-password"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              autoFocus={prefilled}
              aria-invalid={Boolean(error)}
              className={cn("pr-8", LOGIN_INPUT_CLASS)}
              onChange={(e) => setPassword(e.target.value)}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="absolute inset-y-0 right-0 h-full w-8 text-muted-foreground hover:bg-transparent hover:text-foreground"
              aria-label={showPassword ? t("hidePasswordAria") : t("showPasswordAria")}
              onClick={() => setShowPassword((v) => !v)}
            >
              {showPassword ? <EyeOff /> : <Eye />}
            </Button>
          </div>
        </div>

        {error && (
          <p role="alert" className="text-sm font-medium text-destructive">
            {error}
          </p>
        )}

        <Button
          type="submit"
          size="lg"
          className={cn("mt-1 h-11 w-full text-sm font-semibold", LOGIN_CTA_CLASS)}
          disabled={!canSubmit}
        >
          {busy && <Loader2 className="animate-spin" data-icon="inline-start" />}
          {t("submit")}
        </Button>

        {/* 자격 분실·로그인 문의는 운영사무국이 받는다(자체 가입 계정, lib/auth/account-help.ts). */}
        <a
          href={ACCOUNT_HELP_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="self-center text-xs font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
        >
          {prefilled ? t("forgotPrefilled") : t("forgotDefault")}
        </a>
      </form>

      {/* 계정 코드(buyer/exhibitor/organizer/trade-office)는 데이터라 번역 대상이 아니다 — 계정별
          한 줄 설명만 번역한다. 2그룹(참가자/운영자)으로 나눠 "역할이 뭐가 다른지 헷갈린다"는
          피드백에 대응(F-AU-001). prod 배포 차단 P0: 데모 계정 안내는 dev 전용 — 실사용자에게
          계정 목록·공용 비밀번호를 노출하지 않는다(i18n 키는 dev에서 계속 쓰므로 삭제하지 않는다). */}
      {process.env.NODE_ENV !== "production" && (
        <div className="rounded-lg border bg-muted/40 px-3 py-2.5 text-xs leading-relaxed text-muted-foreground">
          <p className="mb-1.5 font-semibold text-foreground/70">
            {t("demoAccountsLabel")} <code className="font-mono">demo1234</code>
          </p>

          <p className="mt-2 text-[10px] font-semibold uppercase tracking-wide text-foreground/50">
            {t("demoGroupParticipant")}
          </p>
          <ul className="mt-1 flex flex-col gap-0.5">
            <li>
              <code className="font-mono">buyer-old</code> — {t("demoAccountBuyerOld")}
            </li>
            <li>
              <code className="font-mono">buyer</code> — {t("demoAccountBuyer")}
            </li>
            <li>
              <code className="font-mono">buyer-wip</code> — {t("demoAccountBuyerWip")}
            </li>
            <li>
              <code className="font-mono">exhibitor</code> — {t("demoAccountExhibitor")}
            </li>
            <li>
              <code className="font-mono">exhibitor-old</code> — {t("demoAccountExhibitorOld")}
            </li>
          </ul>

          <p className="mt-2 border-t pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-foreground/50">
            {t("demoGroupOperator")}
          </p>
          <ul className="mt-1 flex flex-col gap-0.5">
            <li>
              <code className="font-mono">organizer</code> — {t("demoAccountOrganizer")}
            </li>
            <li>
              <code className="font-mono">trade-office</code> — {t("demoAccountTradeOffice")}
            </li>
          </ul>

          <p className="mt-1.5 border-t pt-1.5 text-[11px]">{t("demoAdminHint")}</p>
        </div>
      )}
    </div>
  )
}

function ConsentStep({
  docs,
  busy,
  onSubmit,
}: {
  docs: ConsentDocument[]
  busy: boolean
  onSubmit: (acceptedDocIds: string[]) => void
}) {
  const t = useTranslations("login")
  const [accepted, setAccepted] = useState<Set<string>>(new Set())
  const canProceed = canSubmitConsent(docs, accepted) && !busy

  function toggle(id: string) {
    setAccepted((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  // 전문 시트의 '동의합니다'용 — 토글이 아니라 멱등하게 동의 추가만 한다(이미 동의면 그대로).
  function agree(id: string) {
    setAccepted((prev) => {
      if (prev.has(id)) return prev
      const next = new Set(prev)
      next.add(id)
      return next
    })
  }

  function toggleAll() {
    setAccepted((prev) =>
      prev.size === docs.length ? new Set() : new Set(docs.map((d) => d.id))
    )
  }

  const allChecked = accepted.size === docs.length

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1.5">
        <h1 className="text-lg font-bold tracking-tight">{t("consentTitle")}</h1>
        <p className="text-sm text-muted-foreground">{t("consentSubtitle")}</p>
      </div>

      <button
        type="button"
        onClick={toggleAll}
        aria-pressed={allChecked}
        className={cn(
          "flex items-center gap-3 rounded-lg border p-3 text-left text-sm font-semibold transition-colors",
          allChecked ? "border-primary bg-accent/50" : "bg-background hover:bg-muted"
        )}
      >
        <CheckBox checked={allChecked} />
        {t("agreeAll")}
      </button>

      {/* 읽기(전문 보기)와 동의(체크박스)를 분리 — 한 행에서 오터치로 동의되지 않게 한다. */}
      <ul className="flex flex-col gap-2">
        {docs.map((doc) => {
          const checked = accepted.has(doc.id)
          return (
            <li key={doc.id}>
              {/* 한 줄: 체크박스+제목(=동의 토글) 좌측, 전문 보기 우측. 읽기/동의는 별도 버튼이라 오터치 없음. */}
              <div
                className={cn(
                  "flex items-center gap-2 rounded-lg border px-3 py-2.5 transition-colors",
                  checked ? "border-primary bg-accent/40" : "bg-background"
                )}
              >
                <button
                  type="button"
                  onClick={() => toggle(doc.id)}
                  aria-pressed={checked}
                  aria-label={t("consentAria", { title: doc.title })}
                  className="flex min-w-0 flex-1 items-center gap-3 text-left"
                >
                  <CheckBox checked={checked} />
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span
                      className={cn(
                        "shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold",
                        doc.required
                          ? "bg-primary/10 text-primary"
                          : "bg-muted text-muted-foreground"
                      )}
                    >
                      {doc.required ? t("requiredBadge") : t("optionalBadge")}
                    </span>
                    <span className="truncate text-sm font-semibold">{doc.title}</span>
                  </span>
                </button>
                <ConsentDocSheet doc={doc} onAgree={() => agree(doc.id)} />
              </div>
            </li>
          )
        })}
      </ul>

      <Button
        type="button"
        size="lg"
        className={cn("h-11 w-full text-sm font-semibold", LOGIN_CTA_CLASS)}
        disabled={!canProceed}
        onClick={() => onSubmit([...accepted])}
      >
        {busy && <Loader2 className="animate-spin" data-icon="inline-start" />}
        {t("submitConsent")}
      </Button>
    </div>
  )
}

// 약관 전문 — 하단 바텀시트로 노출(모바일 우선). 전문을 읽고 '동의합니다'를 누르면 시트를 닫고
// 해당 약관에 동의 체크된다(onAgree). 동의 없이 그냥 닫으려면 ✕(SheetContent 기본 버튼)로 닫는다.
function ConsentDocSheet({ doc, onAgree }: { doc: ConsentDocument; onAgree: () => void }) {
  const t = useTranslations("login")
  const [open, setOpen] = useState(false)
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex shrink-0 items-center gap-0.5 text-xs font-medium text-foreground underline-offset-4 hover:underline"
      >
        {t("viewFull")}
        <ChevronRight className="size-3.5" />
      </button>
      <SheetContent side="bottom" className="max-h-[85svh] gap-0 p-0">
        <SheetHeader className="border-b">
          <SheetTitle className="flex items-center gap-2">
            <span
              className={cn(
                "rounded px-1.5 py-0.5 text-[10px] font-bold",
                doc.required ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"
              )}
            >
              {doc.required ? t("requiredBadge") : t("optionalBadge")}
            </span>
            {doc.title}
          </SheetTitle>
        </SheetHeader>
        <div className="flex-1 overflow-y-auto whitespace-pre-wrap px-4 py-4 text-sm leading-relaxed text-muted-foreground">
          {doc.content}
        </div>
        <SheetFooter className="border-t">
          <Button
            type="button"
            size="lg"
            className={cn("h-11 w-full text-sm font-semibold", LOGIN_CTA_CLASS)}
            onClick={() => {
              onAgree()
              setOpen(false)
            }}
          >
            {t("agreeSheetButton")}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}

function CheckBox({ checked }: { checked: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "mt-px flex size-5 shrink-0 items-center justify-center rounded-md border transition-colors",
        checked ? "border-primary bg-primary text-primary-foreground" : "border-input bg-background"
      )}
    >
      {checked && <Check className="size-3.5" />}
    </span>
  )
}

// 최근 로그인 이력이 있는 재방문자 — 비번 재입력 없이 계정을 골라 진입. 여러 계정(공용 기기 등)이면
// 목록에서 선택한다. 내 계정이 없으면 "다른 계정으로 로그인"으로 자격 폼으로 빠진다.
function ResumeSession({
  sessions,
  onPick,
  onSwitch,
}: {
  sessions: ExistingSession[]
  onPick: (session: ExistingSession) => void
  onSwitch: () => void
}) {
  const t = useTranslations("login")
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1.5">
        <h1 className="text-lg font-bold tracking-tight">{t("resumeTitle")}</h1>
        <p className="text-sm text-muted-foreground">{t("resumeSubtitle")}</p>
      </div>

      <ul className="flex flex-col gap-2">
        {sessions.map((session) => (
          <li key={`${session.role}:${session.name}`}>
            <button
              type="button"
              onClick={() => onPick(session)}
              className="flex w-full items-center gap-3 rounded-lg border bg-background p-3 text-left transition-colors hover:border-foreground/30 hover:bg-muted"
            >
              <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-bold text-primary">
                {session.name.slice(0, 1)}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold">
                  {t("resumeAccountName", { name: session.name })}
                </p>
                <p className="text-xs text-muted-foreground">{t("loggedInAs")}</p>
              </div>
            </button>
          </li>
        ))}
      </ul>

      <Button variant="ghost" size="lg" className="w-full" onClick={onSwitch}>
        {t("switchAccount")}
      </Button>
    </div>
  )
}

function DeeplinkError({ status }: { status: "expired" | "invalid" }) {
  const t = useTranslations("login")
  const copy =
    status === "expired"
      ? { title: t("deeplinkExpiredTitle"), body: t("deeplinkExpiredBody") }
      : { title: t("deeplinkInvalidTitle"), body: t("deeplinkInvalidBody") }
  return (
    <div className="flex flex-col items-center gap-4 py-6 text-center">
      <span className="flex size-14 items-center justify-center rounded-full bg-destructive/10 text-destructive">
        <ShieldAlert className="size-7" />
      </span>
      <div className="flex flex-col gap-1.5">
        <h1 className="text-lg font-bold tracking-tight">{copy.title}</h1>
        <p className="text-sm leading-relaxed text-muted-foreground">{copy.body}</p>
      </div>
      {/* 막다른 길 방지 — 토큰 없는 일반 로그인 폼으로 빠져나갈 경로. */}
      <Button asChild variant="outline" size="lg" className="mt-1 w-full">
        <a href="/login">{t("backToLogin")}</a>
      </Button>
    </div>
  )
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-col items-center gap-3 py-10">{children}</div>
}

function spinner(label: string) {
  return (
    <>
      <Loader2 className="size-6 animate-spin text-muted-foreground" />
      <p className="text-sm text-muted-foreground">{label}</p>
    </>
  )
}
