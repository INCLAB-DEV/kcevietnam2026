# Figma 상세설계서 — 케이스별 프레임 인덱스 / 임포트 URL 맵

> 작성 2026-07-01 · 대상: 현재 `frontend/` 구현 18화면을 Figma로 케이스별 미러링.
> 방식(하이브리드): ① **html.to.design** 플러그인으로 각 URL을 네이티브 편집 레이어로 임포트 → ② Figma에서 케이스별 정리·프레임 네이밍·주석(상세설계서 골격).
> 대상 Figma: https://www.figma.com/design/MjYcqp3GisA2aJF9ju2kyP

> **임포트 범위(2026-07-01 결정): 실구현 12화면(약 96프레임)만 진행.** 아래 ⚠ 표시한 5화면(BM-004·BM-005·OP-001·OP-003·OP-005)은 현재 스텁/미구현이라 **구현 후로 보류** — Figma에선 하단 "구현 후 보류" 존에 회색으로 분리해 둠.

## 임포트 준비 (localhost 캡처)

1. `cd frontend && npm run dev` → `http://localhost:3000` 띄움.
2. Figma에 **html.to.design** 플러그인 설치 + **브라우저 확장(Import via extension)** 설치 — localhost는 외부에서 못 보니 확장으로 현재 탭을 캡처.
3. 아래 URL을 브라우저에서 연다 → (인터랙션 케이스는 표의 "조작"까지 수행) → 확장으로 캡처 → Figma로 전송.
4. 임포트가 쌓이면 내가 Figma에서 프레임명(`AU-001-01` 등)·섹션·주석으로 상세설계서 골격 마감.

## 공통 dev 파라미터 (proxy.ts가 쿼리→쿠키 미러링)

| 파라미터 | 값 | 의미 |
|---|---|---|
| `?as=` | `buyer` `exhibitor` `organizer` `guest` | 역할(guest=미인증 Visitor) |
| `?status=` | `registered` `submitted` `changes_requested` `approved` `rejected` | 비즈매칭 신청상태(참가자만) |
| `?period=` | `open` `closed` | 신청기간 |
| `?step=` | `1`~ | 폼 단계 |
| `?draft=` | `empty` `done` | welcome 신청서 작성 진척 |
| `?now=` | `2026-09-17T11:00` | 가상 현재시각(MY-001) |
| `?tab=` | `ai` `all` `bookmarks` | discover 탭 |
| `?from=` `?org=` | — | 진입 출처/대상org |
| `?session=` (login) | `buyer` / `buyer,organizer` | 재방문 세션 |
| `?token=` (login) | `buyer`(유효) `expired` `invalid` | 딥링크 토큰 |

> organizer 화면(`/organizer/*`)은 `?as` 무관하게 항상 organizer 세션 주입.
> **도달 유형:** `[URL]`=주소만 열면 됨 · `[조작]`=URL 연 뒤 표의 동작 수행 후 캡처.

---

## AU-001 `/login` (11)

| Frame | 케이스 | 도달 | URL / 조작 |
|---|---|---|---|
| AU-001-01 | 링크 확인 스피너 | URL | `/login?token=buyer` (로딩 순간) |
| AU-001-02 | 딥링크 만료 | URL | `/login?token=expired` |
| AU-001-03 | 딥링크 무효 | URL | `/login?token=invalid` |
| AU-001-04 | 재방문·단일 계정 | URL | `/login?session=buyer` |
| AU-001-05 | 재방문·복수 계정 | URL | `/login?session=buyer,organizer` |
| AU-001-06 | 빈 로그인 폼 | URL | `/login` |
| AU-001-07 | 프리필 폼(아이디·이름) | URL | `/login?token=buyer` (확인 후) |
| AU-001-08 | 인라인 에러 | 조작 | `/login` → 잘못된 비번 제출 |
| AU-001-09 | 약관 동의 단계 | 조작 | `/login` → 최초계정 로그인 → consent |
| AU-001-10 | 약관 전문 바텀시트 | 조작 | 위 → "전문 보기" |
| AU-001-11 | 로그인 리다이렉트 스피너 | 조작 | 제출 직후 순간 |

## HM-001 `/` 홈 대시보드 (4)

| Frame | 케이스 | 도달 | URL / 조작 |
|---|---|---|---|
| HM-001-01 | 바이어 뷰 | URL | `/?as=buyer` |
| HM-001-02 | 참가사 뷰 | URL | `/?as=exhibitor` |
| HM-001-03 | 오늘 일정 빈 상태 | URL | mock 0건(데이터 의존, 주석) |
| HM-001-04 | 알림 빈 상태 | URL | mock 0건 |

## HM-002 `/welcome` 입장 전 랜딩 (8)

> 하단 dev 미리보기 스위처 내장 — 아래 파라미터가 그걸 그대로 구동.

| Frame | 케이스 | 도달 | URL / 조작 |
|---|---|---|---|
| HM-002-01 | 작성 전(작성하기) | URL | `/welcome?as=buyer&status=registered&period=open&draft=empty` |
| HM-002-02 | 작성 완료(수정+제출) | URL | `/welcome?as=buyer&status=registered&period=open&draft=done` |
| HM-002-03 | 제출 확인 다이얼로그 | 조작 | 위 → "제출하기" |
| HM-002-04 | 보완 요청(재제출) | URL | `/welcome?as=buyer&status=changes_requested&period=open` |
| HM-002-05 | 주최국 확인 중(잠금) | URL | `/welcome?as=buyer&status=submitted` |
| HM-002-06 | 승인·미팅 대기 | URL | `/welcome?as=buyer&status=approved&period=open` |
| HM-002-07 | 반려 | URL | `/welcome?as=buyer&status=rejected` |
| HM-002-08 | 신청 마감 | URL | `/welcome?as=buyer&status=registered&period=closed` |

> `enter-service`(approved+closed)는 `/`로 redirect되어 프레임 없음. 참가사 CTA 확인용은 `?as=exhibitor`로 01·02 반복 가능(선택).

## DV-001 `/discover` 기업 탐색 (9)

| Frame | 케이스 | 도달 | URL / 조작 |
|---|---|---|---|
| DV-001-01 | AI 추천(스와이프) | URL | `/discover?as=buyer&tab=ai` |
| DV-001-02 | AI 추천 빈 | URL | mock 0건(주석) |
| DV-001-03 | AI 부적절 사유 선택 | 조작 | 01 → "아니오" |
| DV-001-04 | 전체기업(바이어 뷰) | URL | `/discover?as=buyer&tab=all` |
| DV-001-05 | 전체기업+세그먼트(참가사 뷰) | URL | `/discover?as=exhibitor&tab=all` |
| DV-001-06 | 검색결과 없음 | 조작 | 04 → 검색어 입력 |
| DV-001-07 | 관심기업(있음) | 조작 | 북마크 후 `?tab=bookmarks` |
| DV-001-08 | 관심기업 빈 | URL | `/discover?as=buyer&tab=bookmarks` |
| DV-001-09 | Visitor(전체만, Lock) | URL | `/discover?as=guest` |

## DV-002 `/discover/[organizationId]` 기업 상세 (4)

| Frame | 케이스 | 도달 | URL / 조작 |
|---|---|---|---|
| DV-002-01 | 참가사 상세 | URL | `/discover/ex-001?as=buyer` |
| DV-002-02 | 바이어 상세 | URL | `/discover/by-001?as=exhibitor` |
| DV-002-03 | AI 추천 진입(적합도 배너) | URL | `/discover/ex-001?as=buyer&from=ai` |
| DV-002-04 | Visitor 상세 | URL | `/discover/ex-001?as=guest` |

## MT-001 미팅 신청 모달 (6) — DV-002 안에서 열림

| Frame | 케이스 | 도달 | URL / 조작 |
|---|---|---|---|
| MT-001-01 | Step1 시간 선택 | 조작 | `/discover/ex-001?as=buyer` → "미팅 신청" |
| MT-001-02 | Step2 장소 선택 | 조작 | → 다음 |
| MT-001-03 | Step3 확인 | 조작 | → 다음 |
| MT-001-04 | 완료·즉시확정 | 조작 | → 제출(immediate) |
| MT-001-05 | 완료·수락대기 | 조작 | → 제출(request) |
| MT-001-06 | Visitor 전환 게이트 | 조작 | `/discover/ex-001?as=guest` → "미팅 신청" |

## MY-001 `/meetings` 내 미팅 (10)

| Frame | 케이스 | 도달 | URL / 조작 |
|---|---|---|---|
| MY-001-01 | 타임라인 인라인 2컬럼(데스크톱) | URL | `/meetings?as=buyer&now=2026-09-17T11:00` (넓은 뷰포트) |
| MY-001-02 | compact+바텀시트(모바일) | 조작 | 위 + 좁은 뷰포트 → 슬롯 클릭 |
| MY-001-03 | 상단 액션 스트립 | URL | 받은요청 존재 mock |
| MY-001-04 | 슬롯 상태 5색(틱) | URL | 상태별 mock(한 화면에 공존) |
| MY-001-05 | "지금" 진행 마커 | URL | `?now=` 진행중 시각 |
| MY-001-06 | 상세패널·받은요청(수락/거부) | 조작 | received proposed 슬롯 클릭 |
| MY-001-07 | 상세패널·확정(취소) | 조작 | accepted 슬롯 클릭 |
| MY-001-08 | 상세패널·회의록 | 조작 | completed 슬롯 클릭 |
| MY-001-09 | 빈 시간대 선택 패널 | 조작 | 빈 슬롯 클릭 |
| MY-001-10 | 미팅 0건 빈상태 | URL | 0건 mock × `?as=buyer/exhibitor/guest` |

## MY-002 `/meetings/[meetingId]` 미팅 리뷰 (12)

> 이 페이지는 `?as=`를 직접 파싱. mode: intake→compose→done은 인터랙션 진행.

| Frame | 케이스 | 도달 | URL / 조작 |
|---|---|---|---|
| MY-002-01 | 로딩 | URL | `/meetings/mtg-1?as=buyer` (순간) |
| MY-002-02 | 로드 실패 | URL | 에러 mock(주석) |
| MY-002-03 | intake·진행됨(평가3종) | URL | `/meetings/mtg-1?as=buyer` |
| MY-002-04 | intake·노쇼 | 조작 | → "상대불참/내불참" |
| MY-002-05 | compose·녹음 빈 드롭존 | 조작 | → 진행됨 → 다음 |
| MY-002-06 | compose·파일 선택됨 | 조작 | → 파일 첨부 |
| MY-002-07 | compose·전사중 스켈레톤 | 조작 | → 업로드 후 |
| MY-002-08 | compose·직접입력(텍스트) | 조작 | → "직접 입력" 탭 |
| MY-002-09 | compose·초안 검수(3섹션+적합도) | 조작 | → AI 정리 완료 |
| MY-002-10 | 전사 원문 시트 | 조작 | → "원문 보기" |
| MY-002-11 | done·완료(보고서+내보내기) | 조작 | → 저장 |
| MY-002-12 | done·노쇼 기록 | 조작 | 04 → 저장 |

## BM-001 `/apply` 바이어 프로필 작성 (9)

| Frame | 케이스 | 도달 | URL / 조작 |
|---|---|---|---|
| BM-001-01 | 하이드레이트 스피너 | URL | `/apply?as=buyer` (순간) |
| BM-001-02 | Step1 기본정보 | URL | `/apply?as=buyer&step=1` |
| BM-001-03 | Step2 관심분야·소개 | URL | `/apply?as=buyer&step=2` |
| BM-001-04 | Step3 확인·제출 | URL | `/apply?as=buyer&step=3` |
| BM-001-05 | 필수 오류 표시 | 조작 | step1 빈 필드 "다음" |
| BM-001-06 | 로그인 바이어(저장하고 나가기) | URL | `/apply?as=buyer&step=3` |
| BM-001-07 | Visitor 전환(제출하기) | URL | `/apply?as=guest&from=meeting&org=ex-001` |
| BM-001-08 | 제출 후 잠금(보기) | URL | `/apply?as=buyer&status=submitted` |
| BM-001-09 | 완료 화면 | 조작 | 제출 후 |

## BM-002 `/exhibitor/apply` 참가사 프로필 작성 (10)

| Frame | 케이스 | 도달 | URL / 조작 |
|---|---|---|---|
| BM-002-01 | 로딩 스켈레톤 | URL | `/exhibitor/apply?as=exhibitor` (순간) |
| BM-002-02 | Step1 기본정보(잠금) | URL | `/exhibitor/apply?as=exhibitor&step=1` |
| BM-002-03 | Step2 회사소개(+SmartFill) | URL | `...&step=2` |
| BM-002-04 | Step3 전시품목 | URL | `...&step=3` |
| BM-002-05 | Step4 타겟+미팅슬롯 | URL | `...&step=4` |
| BM-002-06 | Step5 요약·제출 | URL | `...&step=5` |
| BM-002-07 | SmartFill 분석 중 | 조작 | step2 회사자료 업로드 |
| BM-002-08 | 보완 요청 배너 | URL | `/exhibitor/apply?as=exhibitor&status=changes_requested` |
| BM-002-09 | 완료 화면 | 조작 | 저장하고 나가기 후 |
| BM-002-10 | 프로필 읽기전용(4탭) | URL | `/exhibitor/apply?as=exhibitor&status=submitted` |

## BM-004 `/profile` · BM-005 `/exhibitor/profile` (2) — 현재 스텁

| Frame | 케이스 | 도달 | URL / 조작 |
|---|---|---|---|
| BM-004-01 | 바이어 프로필 허브(스텁) | URL | `/profile?as=buyer` |
| BM-005-01 | 참가사 프로필 허브(스텁) | URL | `/exhibitor/profile?as=exhibitor` |

## NT-001 `/notifications` 알림 (5)

| Frame | 케이스 | 도달 | URL / 조작 |
|---|---|---|---|
| NT-001-01 | 인박스(안읽음/읽음 혼재) | URL | `/notifications?as=buyer` |
| NT-001-02 | 타입 필터 선택 | 조작 | → 필터 칩 클릭 |
| NT-001-03 | 빈 상태 | URL | 0건 mock(주석) |
| NT-001-04 | 모바일 임박 리마인더 버블업 | 조작 | 좁은 뷰포트 |
| NT-001-05 | 모두읽음 비활성 | URL | 안읽음 0건 mock |

## OP-001 `/organizer` 매칭 대시보드 (1) — 스텁

| Frame | 케이스 | 도달 | URL / 조작 |
|---|---|---|---|
| OP-001-01 | 대시보드(스텁) | URL | `/organizer` |

## OP-002 `/organizer/members` 참가기업 목록 (8)

| Frame | 케이스 | 도달 | URL / 조작 |
|---|---|---|---|
| OP-002-01 | 참가사 탭 | URL | `/organizer/members` |
| OP-002-02 | 바이어 탭 | 조작 | → 바이어 탭 |
| OP-002-03 | 상태 배지(등록자/참가자) | URL | (행 내 공존, 주석) |
| OP-002-04 | 검색결과 없음 | 조작 | 검색어 입력 |
| OP-002-05 | 페이지네이션 | URL | (다건 mock) |
| OP-002-06 | 빠른 정정 다이얼로그 | 조작 | 행 → 정정 |
| OP-002-07 | 삭제 확인 다이얼로그 | 조작 | 행 → 삭제 |
| OP-002-08 | 명단 업로드 다이얼로그 | 조작 | → 업로드 |

## OP-003 `/organizer/members/[id]` 기업 디테일 (2) — 스텁

| Frame | 케이스 | 도달 | URL / 조작 |
|---|---|---|---|
| OP-003-01 | 디테일·member 있음 | URL | `/organizer/members/ex-001` |
| OP-003-02 | 디테일·member 없음 | URL | `/organizer/members/none` |

> 요청한 "AI 재트리거 vs Forced 수동지정"은 **현재 코드 미구현**(TODO #54). PRD F-OP-003 기준 별도 설계 필요.

## OP-005 `/organizer/forced-matching` 배정 허브 (1) — 스텁

| Frame | 케이스 | 도달 | URL / 조작 |
|---|---|---|---|
| OP-005-01 | 배정 허브(스텁) | URL | `/organizer/forced-matching` |

> "AI 포화배정 vs Forced" 분기 **미구현**(TODO). PRD F-OP-005 기준 별도 설계 필요.

---

## 합계 & 메모

- **약 107 프레임**(스텁·로딩 포함). 핵심 인터랙션 데모(5사 우선)부터 1개 화면을 레퍼런스로 임포트→내가 Figma 정리 포맷 확정→나머지 확산 권장.
- **미구현 분기**: OP-003(AI재트리거/Forced), OP-005(AI포화/Forced) — 코드 근거 없음. 그릴 거면 PRD에서 별도 설계.
- **데이터 의존 케이스**(빈상태·에러·슬롯색 등)는 mock 조정이 필요 → 해당 프레임은 주석으로 표시. 필요 시 mock 시드를 케이스별로 임시 조정해 드릴 수 있음.
- **폰트**: Figma에 Pretendard 없으면 대체됨 — 임포트 후 Pretendard 추가 또는 대체 표기.
