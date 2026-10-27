"use client"

// 운영자 슬라이드 하단 "비즈매칭 신청서 전체" — 참가사/바이어 프로필 화면과 동일한 컴포넌트를 그대로 재사용한다:
//   참가사 → ProfileView(기본정보·회사소개·전시품목 3탭, 타겟 탭은 숨김) · 바이어 → StepReview(한 장, readOnly).
// 데이터: 회사명·부스·소개·전시품목 키워드처럼 배정 카드(Organization)가 이미 아는 정체성 필드는 거기서,
// 담당자·사업자번호·주소·연매출·직원수·제품 등 신청서 상세는 실제 제출된 신청서(MemberProfile — assignment-hub가
// AssignmentScheduleData.profilesByOrgId로 넘겨준다. organizer read seam getMemberProfiles()/
// fetchOrganizerMemberProfiles와 동일 소스)에서 채운다. 신청서를 제출한 적 없는 기업은 그 키 자체가 없다 —
// 이때는 항목을 빈 값("—")으로 두고 미제출 안내만 보여준다. 데모 값으로 채우지 않는다.

import { NextIntlClientProvider } from "next-intl"

import { ProfileView } from "@/components/exhibitor/apply-form"
import { StepReview } from "@/components/apply/steps/step-review"
import { emptyBuyerProfileDraft, type BuyerProfileDraft } from "@/lib/apply/types"
import type { ExhibitorProfileDraft, Product } from "@/lib/bm/types"
import type { MemberProfile } from "@/lib/organizer/member-profile"
import type { Organization } from "@/lib/types"
import koMessages from "@/messages/ko.json"

// MemberProfile의 연매출·직원수·분야·언어 등은 organizer read seam이 이미 사람이 읽는 라벨 문자열로
// 넘겨주는 반면, ExhibitorProfileDraft/BuyerProfileDraft의 대응 필드는 코드 enum 타입이다(작성 폼이
// 코드로 저장하기 때문). 이 화면은 항상 읽기전용(canEdit=false/readOnly)이라 값이 폼으로 되돌아가지
// 않고, ProfileView·StepReview가 라벨을 뽑을 때 쓰는 labelOf/labelsOf는 코드를 못 찾으면 원문을 그대로
// 보여주는 폴백을 갖고 있다(apply-form.tsx, apply/options.ts) — 그래서 라벨 문자열을 코드 자리에 그대로
// 얹어도(as 캐스트) 화면엔 실제 값이 그대로 보인다.
function exhibitorDraft(org: Organization, profile: MemberProfile | null): ExhibitorProfileDraft {
  const products: Product[] | undefined =
    profile?.products && profile.products.length > 0
      ? profile.products.map((p) => ({
          nameKo: p.nameKo,
          nameEn: p.nameEn,
          businessField: p.category as Product["businessField"],
          hsCode: p.hsCode,
          priceRange: p.priceRange as Product["priceRange"],
        }))
      : org.exhibits && org.exhibits.length > 0
        ? org.exhibits.map((name) => ({ nameKo: name }))
        : undefined

  return {
    organizationNameKo: org.name,
    organizationNameEn: "",
    // 부스는 배정 카드(Organization) 소관 — 신청서 제출 여부와 무관하게 항상 최신값이다.
    hall: org.booth?.hallNo,
    pavilion: org.booth?.hallName,
    boothLocation: org.booth?.code,
    boothType: profile?.boothType,
    boothCount: profile?.boothCount,
    businessRegNo: profile?.businessRegNo,
    representativeNameKo: profile?.representativeNameKo,
    representativeNameEn: profile?.representativeNameEn,
    companyEmail: profile?.companyEmail,
    mainTel: profile?.mainTel,
    fax: profile?.fax,
    addressKo: profile?.address,
    businessType: profile?.businessType,
    businessItem: profile?.businessItem,
    attendees: profile?.attendees?.map((a) => ({
      // ProfileAttendee.name은 이미 "성 명" 형태로 합쳐진 표시용 문자열이라 국/영 분리 필드가 없다 —
      // 국문 이름 칸에 그대로 넣는다(정확한 구조 손실 < 가짜 담당자 표시).
      firstNameKo: a.name,
      divisionKo: a.division,
      titleKo: a.title,
      email: a.email,
      tel: a.tel,
      mobile: a.mobile,
    })),
    introKo: profile?.companyIntroKo ?? org.description ?? undefined,
    introEn: profile?.companyIntroEn,
    website: profile?.website,
    annualSalesRange: profile?.annualSales as ExhibitorProfileDraft["annualSalesRange"],
    employeeRange: profile?.employeeRange as ExhibitorProfileDraft["employeeRange"],
    availableLanguages: profile?.availableLanguages
      ? (profile.availableLanguages
          .split(/,\s*/)
          .filter(Boolean) as ExhibitorProfileDraft["availableLanguages"])
      : undefined,
    products,
    contentCategory: profile?.contentCategory as ExhibitorProfileDraft["contentCategory"],
    exhibitionCategories: profile?.categories?.length
      ? (profile.categories as ExhibitorProfileDraft["exhibitionCategories"])
      : undefined,
  }
}

function buyerDraft(org: Organization, profile: MemberProfile | null): BuyerProfileDraft {
  return {
    ...emptyBuyerProfileDraft(),
    organizationNameKo: org.name,
    businessRegNo: profile?.businessRegNo ?? "",
    website: profile?.website ?? "",
    contactNameKo: profile?.contactNameKo ?? "",
    contactNameEn: profile?.contactNameEn ?? "",
    contactTitleKo: profile?.contactTitleKo ?? "",
    contactTitleEn: profile?.contactTitleEn ?? "",
    contactEmail: profile?.contactEmail ?? "",
    contactLanguage: (profile?.contactLanguage as BuyerProfileDraft["contactLanguage"]) ?? "",
    contactInterpreterNeed: profile?.interpreterNeed ?? null,
    country: profile?.country ?? "",
    tel: profile?.mainTel ?? profile?.contactPhone ?? "",
    orgTypes: (profile?.orgTypes as BuyerProfileDraft["orgTypes"]) ?? [],
    annualSalesRange: (profile?.annualSales as BuyerProfileDraft["annualSalesRange"]) ?? "",
    employeeRange: (profile?.employeeRange as BuyerProfileDraft["employeeRange"]) ?? "",
    interestCategories: (profile?.categories as BuyerProfileDraft["interestCategories"]) ?? [],
    companyIntroKo: profile?.companyIntroKo ?? org.description ?? "",
    companyIntroEn: profile?.companyIntroEn ?? "",
    budgetRange: (profile?.budgetRange as BuyerProfileDraft["budgetRange"]) ?? "",
    adoptionTimeline: (profile?.adoptionTimeline as BuyerProfileDraft["adoptionTimeline"]) ?? "",
  }
}

export function CompanyApplication({
  org,
  profile,
}: {
  org: Organization
  // 신청서 미제출(hasApplication=false) 또는 seam 미배선 컨텍스트에선 없다 — 그때는 정체성 필드만
  // 채운 빈 draft를 보여준다(데모 값 금지).
  profile?: MemberProfile | null
}) {
  const submitted = profile != null
  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-[11px] font-bold uppercase tracking-wide text-muted-foreground">
        비즈매칭 신청서
      </h3>
      {!submitted && (
        <p className="text-xs text-muted-foreground">
          아직 제출된 신청서가 없어요 — 등록된 기본 정보만 표시됩니다.
        </p>
      )}
      {/* ProfileView 루트가 mx-auto max-w-3xl이라 flex 컨테이너 안에선 폭이 콘텐츠 크기로 줄어든다(탭 전환 시
          쪼그라듦). w-full 블록으로 감싸 항상 전체 폭을 채우게 한다(mx-auto는 블록 안에서 정상 동작). */}
      {/* ProfileView·StepReview는 참가자 화면과 공유하는 컴포넌트라 useTranslations/useLocale로 전역
          locale(NEXT_LOCALE 쿠키)을 그대로 따른다. 운영자 콘솔은 언제나 한국어여야 하므로(CLAUDE.md)
          이 서브트리를 ko로 고정한 NextIntlClientProvider로 감싸 쿠키의 영향을 차단한다(이슈 #7).
          지금은 콘솔 레이아웃 전체가 ko 고정 provider 안이라(components/operator/console-intl-provider)
          이 provider는 겹친다 — 이 컴포넌트가 그 레이아웃 밖에서 쓰여도 한국어로 남게 그대로 둔다. */}
      <NextIntlClientProvider locale="ko" messages={koMessages}>
        <div className="w-full min-w-0">
          {org.role === "exhibitor" ? (
            <ProfileView
              draft={exhibitorDraft(org, profile ?? null)}
              canEdit={false}
              onEdit={() => {}}
              showHeader={false}
              hideTargetTab
            />
          ) : (
            <StepReview draft={buyerDraft(org, profile ?? null)} onEditStep={() => {}} readOnly />
          )}
        </div>
      </NextIntlClientProvider>
    </section>
  )
}
