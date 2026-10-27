"use client"

import {
  useEffect,
  useMemo,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react"
import { useLocale, useTranslations } from "next-intl"
import { ArrowDownUp, ChevronDown, Search, Star } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  budgetOptions,
  categoryOptions,
  scoreThresholds,
  timelineOptions,
  type FacetOption,
} from "@/lib/discover/filters"
import { OrganizationCard } from "./organization-card"
import type { Organization, ViewerRole } from "@/lib/types"

// 검색 입력 → 필터 적용 사이의 debounce(ms). 입력 중 매 키마다 재필터링하지 않는다.
const SEARCH_DEBOUNCE_MS = 300

type SortKey = "score" | "name" | "booth"

interface OrgListProps {
  orgs: Organization[]
  viewerRole: ViewerRole
  showFilters?: boolean
  emptyLabel?: string
  bookmarkedIds?: Set<string>
  onBookmark?: (orgId: string) => void
  onSelect?: (orgId: string) => void
  // 적합도 정렬·필터용 점수맵(orgId→aiScore). 없으면 적합도순은 입력 순서 유지.
  scores?: Map<string, number>
}

// 같은 set 토글을 여러 패싯에서 재사용하기 위한 헬퍼.
function toggleIn(
  setter: Dispatch<SetStateAction<Set<string>>>,
  value: string
) {
  setter((prev) => {
    const next = new Set(prev)
    if (next.has(value)) next.delete(value)
    else next.add(value)
    return next
  })
}

// 멀티셀렉트 패싯 드롭다운(도입 시기·예산·카테고리). 옵션이 없으면 렌더하지 않는다.
// 선택 상태는 option.value(매칭 키)로 들고, 화면에는 option.label(로케일 라벨)을 그린다.
function FacetMenu({
  label,
  options,
  selected,
  onToggle,
}: {
  label: string
  options: FacetOption[]
  selected: Set<string>
  onToggle: (value: string) => void
}) {
  if (options.length === 0) return null
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" aria-label={label}>
          {label}
          {selected.size > 0 && (
            <Badge variant="secondary" className="ml-1 px-1.5">
              {selected.size}
            </Badge>
          )}
          <ChevronDown data-icon="inline-end" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {options.map((opt) => (
          <DropdownMenuCheckboxItem
            key={opt.value}
            checked={selected.has(opt.value)}
            onCheckedChange={() => onToggle(opt.value)}
            onSelect={(e) => e.preventDefault()}
          >
            {opt.label}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function OrgList({
  orgs,
  viewerRole,
  showFilters = true,
  emptyLabel,
  bookmarkedIds,
  onBookmark,
  onSelect,
  scores,
}: OrgListProps) {
  const t = useTranslations("discover")
  // 카테고리 라벨·이름 정렬 기준 로케일 — 지원 로케일(ko/en) 밖의 값은 ko로 접는다.
  const locale = useLocale() === "en" ? "en" : "ko"
  // 입력값(즉시) ↔ 적용 검색어(debounce). 적용값만 필터링에 쓴다.
  const [queryInput, setQueryInput] = useState("")
  const [query, setQuery] = useState("")
  // 비키워드 패싯 상태 (역할/데이터에 따라 일부만 노출).
  const [categories, setCategories] = useState<Set<string>>(new Set())
  const [timelines, setTimelines] = useState<Set<string>>(new Set())
  const [budgets, setBudgets] = useState<Set<string>>(new Set())
  const [minScore, setMinScore] = useState(0)
  const [bookmarkedOnly, setBookmarkedOnly] = useState(false)
  const [sortBy, setSortBy] = useState<SortKey>("score")

  useEffect(() => {
    const id = setTimeout(() => setQuery(queryInput), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(id)
  }, [queryInput])

  // 노출 가능한 패싯 옵션(목록에 해당 데이터가 있을 때만 채워진다).
  const categoryOpts = useMemo(() => categoryOptions(orgs, locale), [orgs, locale])
  const timelineOpts = useMemo(() => timelineOptions(orgs), [orgs])
  const budgetOpts = useMemo(() => budgetOptions(orgs), [orgs])
  // 적합도는 상대(매칭 대상)에만 존재 — 점수 가진 기업이 하나라도 있을 때만 노출.
  const canScoreFilter = useMemo(
    () => orgs.some((o) => (scores?.get(o.id) ?? 0) > 0),
    [orgs, scores]
  )
  const canBookmarkFilter = !!bookmarkedIds && !!onBookmark

  const activeCount =
    categories.size +
    timelines.size +
    budgets.size +
    (minScore > 0 ? 1 : 0) +
    (bookmarkedOnly ? 1 : 0)

  function resetFilters() {
    setCategories(new Set())
    setTimelines(new Set())
    setBudgets(new Set())
    setMinScore(0)
    setBookmarkedOnly(false)
  }

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return orgs.filter((o) => {
      const matchesQuery =
        !q ||
        o.name.toLowerCase().includes(q) ||
        o.keywords.some((k) => k.toLowerCase().includes(q)) ||
        (o.strength?.toLowerCase().includes(q) ?? false)
      // 카테고리는 코드로 매칭한다(라벨은 로케일마다 달라 매칭 키로 쓰지 않는다).
      const matchesCategory =
        categories.size === 0 ||
        (o.contentCategory ? categories.has(o.contentCategory) : false)
      const matchesTimeline =
        timelines.size === 0 ||
        (o.adoptionTimeline ? timelines.has(o.adoptionTimeline) : false)
      const matchesBudget =
        budgets.size === 0 ||
        (o.budgetRange ? budgets.has(o.budgetRange) : false)
      const matchesScore =
        minScore === 0 || (scores?.get(o.id) ?? 0) >= minScore
      const matchesBookmark =
        !bookmarkedOnly || (bookmarkedIds?.has(o.id) ?? false)
      return (
        matchesQuery &&
        matchesCategory &&
        matchesTimeline &&
        matchesBudget &&
        matchesScore &&
        matchesBookmark
      )
    })
  }, [
    orgs,
    query,
    categories,
    timelines,
    budgets,
    minScore,
    bookmarkedOnly,
    scores,
    bookmarkedIds,
  ])

  // 부스 정보가 있는 목록(참가사)에서만 전시장 위치순 정렬을 제공
  const hasBooth = useMemo(() => orgs.some((o) => !!o.booth), [orgs])

  const sorted = useMemo(() => {
    const arr = [...filtered]
    if (sortBy === "name") {
      // 이름순은 화면 로케일의 정렬 규칙을 따른다(en 화면의 영문 기업명은 영문 사전순).
      arr.sort((a, b) => a.name.localeCompare(b.name, locale))
    } else if (sortBy === "booth") {
      // 홀 → 부스코드 순. "A-2" < "A-12"가 맞도록 numeric 정렬, 부스 없는 항목은 뒤로
      arr.sort((a, b) => {
        if (!a.booth) return 1
        if (!b.booth) return -1
        const byHall = a.booth.hallNo.localeCompare(b.booth.hallNo, "en", {
          numeric: true,
        })
        if (byHall !== 0) return byHall
        return a.booth.code.localeCompare(b.booth.code, "en", { numeric: true })
      })
    } else {
      arr.sort((a, b) => (scores?.get(b.id) ?? 0) - (scores?.get(a.id) ?? 0))
    }
    return arr
  }, [filtered, sortBy, scores, locale])

  // 필터 없는 모드(관심기업)에서 목록이 비면 전용 안내
  if (!showFilters && orgs.length === 0) {
    return (
      <Empty className="border">
        <EmptyHeader>
          <EmptyTitle>{emptyLabel ?? t("list.emptyOrgs")}</EmptyTitle>
        </EmptyHeader>
      </Empty>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      {showFilters && (
        <div className="flex flex-col gap-3" data-tour="discover-filters">
          <div className="relative">
            <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="search"
              placeholder={t("search.placeholder")}
              value={queryInput}
              onChange={(e) => setQueryInput(e.target.value)}
              className="pl-9"
            />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {/* 바이어 카드 패싯 */}
            <FacetMenu
              label={t("facets.timeline")}
              options={timelineOpts}
              selected={timelines}
              onToggle={(v) => toggleIn(setTimelines, v)}
            />
            <FacetMenu
              label={t("facets.budget")}
              options={budgetOpts}
              selected={budgets}
              onToggle={(v) => toggleIn(setBudgets, v)}
            />
            {/* 참가사 카드 패싯 — 카테고리(3종, kct001tax01). 물리적 Hall 필터를 대체 — Hall/부스
                자체는 정렬(전시장 위치순)에서 계속 쓰인다. */}
            <FacetMenu
              label={t("facets.category")}
              options={categoryOpts}
              selected={categories}
              onToggle={(v) => toggleIn(setCategories, v)}
            />
            {/* 공통: 매칭율 구간 */}
            {canScoreFilter && (
              <DropdownMenu modal={false}>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    aria-label={t("facets.matchRate")}
                  >
                    {t("facets.matchRate")}
                    {minScore > 0 ? ` ${minScore}%+` : ""}
                    <ChevronDown data-icon="inline-end" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  <DropdownMenuRadioGroup
                    value={String(minScore)}
                    onValueChange={(v) => setMinScore(Number(v))}
                  >
                    {scoreThresholds(t).map((opt) => (
                      <DropdownMenuRadioItem
                        key={opt.value}
                        value={String(opt.value)}
                      >
                        {opt.label}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            {/* 공통: 관심기업만 */}
            {canBookmarkFilter && (
              <Button
                type="button"
                size="sm"
                variant={bookmarkedOnly ? "default" : "outline"}
                aria-pressed={bookmarkedOnly}
                onClick={() => setBookmarkedOnly((v) => !v)}
              >
                <Star data-icon="inline-start" />
                {t("facets.bookmarkedOnly")}
              </Button>
            )}
            {activeCount > 0 && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="text-muted-foreground"
                onClick={resetFilters}
              >
                {t("facets.reset")}
              </Button>
            )}
          </div>
        </div>
      )}

      {sorted.length === 0 ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyTitle>{emptyLabel ?? t("list.emptyResults")}</EmptyTitle>
            <EmptyDescription>{t("list.emptyResultsHint")}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <>
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">
              {t("list.count", { count: sorted.length })}
            </span>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm">
                  <ArrowDownUp data-icon="inline-start" />
                  {t(`sort.${sortBy}`)}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuRadioGroup
                  value={sortBy}
                  onValueChange={(v) => setSortBy(v as SortKey)}
                >
                  <DropdownMenuRadioItem value="score">
                    {t("sort.score")}
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="name">
                    {t("sort.name")}
                  </DropdownMenuRadioItem>
                  {hasBooth && (
                    <DropdownMenuRadioItem value="booth">
                      {t("sort.booth")}
                    </DropdownMenuRadioItem>
                  )}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          <div className="flex flex-col gap-2">
            {sorted.map((org) => (
              <OrganizationCard
                key={org.id}
                org={org}
                viewerRole={viewerRole}
                score={scores?.get(org.id)}
                bookmarked={bookmarkedIds?.has(org.id)}
                onBookmark={onBookmark ? () => onBookmark(org.id) : undefined}
                onClick={onSelect ? () => onSelect(org.id) : undefined}
              />
            ))}
          </div>
        </>
      )}
    </div>
  )
}
