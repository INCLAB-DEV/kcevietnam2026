import { useTranslations } from "next-intl"
import { MapPin, Sparkles } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { boothLabel, BUYER_TYPE_LABELS } from "@/lib/types"
import type { Organization } from "@/lib/types"

// AI 추천 탭·미팅 등 매칭 맥락으로 진입했을 때만 전달되는 적합도 정보
// (F-DV-001 D6: 이유는 상세/AI탭 한정). 상세를 여는 모든 화면이 공유한다.
export interface DetailMatch {
  score: number
  reasons: string[]
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-xs font-bold uppercase tracking-wide text-muted-foreground">{title}</h2>
      {children}
    </section>
  )
}

// 기업 상세(DV-002)의 본문 — 카드에 없던 필드까지 드러내는 정보 밀도(F-DV-001 D5)를 만드는
// 유일한 소스. 헤더/하단 액션 같은 "껍데기"는 caller(모달·풀페이지·미팅)가 각자 두르고,
// 이 컴포넌트는 오직 필드만 그린다 → 기업 탐색·내 미팅 어디서 열든 같은 본문을 재사용한다.
// 개인명·직급 등 PII는 여기 두지 않는다(F-DV-001 D7, 미팅 수락 후 공개) — caller 슬롯 담당.
export function OrgDetailBody({ org, match }: { org: Organization; match?: DetailMatch }) {
  const t = useTranslations("discover.detail")
  const isExhibitor = org.role === "exhibitor"

  return (
    <div className="flex flex-col gap-6">
      {/* ① 적합도 배너 — 매칭 맥락(AI 추천/미팅) 진입 시만 */}
      {match && (
        <div className="flex items-center gap-4 rounded-lg border bg-accent/40 p-4">
          <div className="flex shrink-0 items-baseline gap-0.5 text-primary">
            <span className="text-4xl font-extrabold leading-none tabular-nums">{match.score}</span>
            <span className="text-lg font-bold">%</span>
          </div>
          <div className="min-w-0">
            <p className="flex items-center gap-1 text-xs font-semibold text-primary">
              <Sparkles className="size-3" />
              {t("aiMatchTitle")}
            </p>
            {match.reasons[0] && (
              <p className="mt-0.5 text-sm leading-snug text-muted-foreground">{match.reasons[0]}</p>
            )}
          </div>
        </div>
      )}

      {/* 기업 유형(바이어) */}
      {!isExhibitor && org.buyerType && (
        <Badge variant="secondary" className="w-fit font-normal">
          {BUYER_TYPE_LABELS[org.buyerType]}
        </Badge>
      )}

      {/* ② AI 추천 이유 전문 — 매칭 맥락 진입 시만 */}
      {match && match.reasons.length > 0 && (
        <Section title={t("aiReasonTitle")}>
          <ul className="flex flex-col gap-2 rounded-lg bg-accent/40 p-4">
            {match.reasons.map((reason) => (
              <li key={reason} className="text-sm leading-relaxed text-foreground/80">
                · {reason}
              </li>
            ))}
          </ul>
        </Section>
      )}

      {/* ③ 부스 위치 (참가사) */}
      {isExhibitor && org.booth && (
        <Section title={t("boothTitle")}>
          <div className="flex items-center gap-3 rounded-lg border bg-muted/40 p-3">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-md border bg-background">
              <MapPin className="size-4 text-muted-foreground" />
            </div>
            <span className="font-semibold">{boothLabel(org.booth)}</span>
          </div>
        </Section>
      )}

      {/* ④ 전시 제품 (참가사) */}
      {isExhibitor && org.exhibits && org.exhibits.length > 0 && (
        <Section title={t("exhibitsTitle")}>
          <ul className="flex flex-col gap-2">
            {org.exhibits.map((item) => (
              <li
                key={item}
                className="flex items-center gap-3 rounded-lg border bg-muted/40 px-4 py-3"
              >
                <span className="size-1.5 shrink-0 rounded-full bg-primary" />
                <span className="text-sm font-medium">{item}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {/* ⑤ 분야 키워드 */}
      {org.keywords.length > 0 && (
        <Section title={isExhibitor ? t("keywordsExhibitor") : t("keywordsBuyer")}>
          <div className="flex flex-wrap gap-1.5">
            {org.keywords.map((kw) => (
              <Badge key={kw} variant="secondary" className="font-normal">
                {kw}
              </Badge>
            ))}
          </div>
        </Section>
      )}

      {/* 관심정보 (바이어) — 예산·도입시기 */}
      {!isExhibitor && (org.budgetRange || org.adoptionTimeline) && (
        <Section title={t("adoptionPlanTitle")}>
          <div className="flex flex-wrap gap-2">
            {org.budgetRange && (
              <span className="rounded-md border bg-muted/40 px-3 py-1.5 text-sm">
                {t("budgetPrefix", { value: org.budgetRange })}
              </span>
            )}
            {org.adoptionTimeline && (
              <span className="rounded-md border bg-muted/40 px-3 py-1.5 text-sm">
                {t("adoptionPrefix", { value: org.adoptionTimeline })}
              </span>
            )}
          </div>
        </Section>
      )}

      {/* ⑥ 강점 (참가사) */}
      {isExhibitor && org.strength && (
        <Section title={t("strengthTitle")}>
          <p className="text-sm leading-relaxed text-foreground/80">{org.strength}</p>
        </Section>
      )}

      {/* ⑦ 주요 실적 */}
      {org.achievements && org.achievements.length > 0 && (
        <Section title={t("achievementsTitle")}>
          <ul className="flex flex-col gap-2.5">
            {org.achievements.map((a) => (
              <li key={a} className="border-l-2 pl-3 text-sm leading-relaxed text-muted-foreground">
                {a}
              </li>
            ))}
          </ul>
        </Section>
      )}

      {/* ⑧ 기업 정보 */}
      {(org.description || org.founded || org.employees) && (
        <Section title={t("companyInfoTitle")}>
          {org.description && (
            <p className="text-sm leading-relaxed text-foreground/80">{org.description}</p>
          )}
          {(org.founded || org.employees) && (
            <div className="flex gap-6 text-sm">
              {org.founded && (
                <div className="flex flex-col">
                  <span className="text-xs text-muted-foreground">{t("founded")}</span>
                  <span className="font-medium">{org.founded}</span>
                </div>
              )}
              {org.employees && (
                <div className="flex flex-col">
                  <span className="text-xs text-muted-foreground">{t("employees")}</span>
                  <span className="font-medium">{org.employees}</span>
                </div>
              )}
            </div>
          )}
        </Section>
      )}
    </div>
  )
}
