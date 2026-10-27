# 운영자 권한은 계정×행사 단위 master/sub — 행사별 조직 역할은 데이터, sub 관할은 바이어 소유권으로 정의한다

운영자(Organizer) 권한을 모델링할 때, "주최사 / KOTRA 본부 / KOTRA 해외무역관" 같은 **이번 행사의 조직
역할을 스키마(enum·테이블 유형)로 굳히지 않는다.** 대신 운영자는 NABI가 발급하는 **내부 계정**이고,
권한등급(master/sub)은 **계정×행사(event) 단위**로 부여하며, sub의 데이터 관할은 **바이어 소유권 링크**로
정의한다. 권한검사는 FastAPI 단일 지점에서 **capability + scope**로 수행한다(ADR-0008 경계 B).

## 배경

KOTRA "통합 상담주선 시스템 기능 요구사항"이 운영자 측 행위자를 셋으로 나눈다 — **주최사/KOTRA 본부
관리자**(전체 국내기업·바이어 CRUD + 승인 + 주선 관리), **KOTRA 해외무역관**(자기 등록 바이어만 관리 +
바이어 **대리신청** + 체류정보 입력, 국내기업은 열람만). 그동안 모든 OP PRD(F-OP-001~005)는 "Organizer(master)
O · Organizer(sub) 추후 정의(KOTRA 역할 확인 후)"로 sub를 비워뒀는데, 이 문서가 그 sub의 정체(=무역관)를
확정했다.

첫 모델링 시도는 운영자에 `operator_type`(host / kotra_hq / trade_office) enum을 박는 것이었다(codex 교차검수
포함). 그러나 이는 **이번 행사(DX Korea 2026)의 조직도를 스키마에 새기는 과설계**다 — 다음 행사에서 운영
주체 구성이 바뀌면 enum·마이그레이션을 손대야 한다. 또 무역관을 "Organizer(sub)=약한 master"로 같은 우산에
두면, 코드가 `is organizer?`로 묻다가 admin 권한을 실수로 부여하는 권한상승 버그를 부르기 쉽다(codex Q-D).

현재 스키마는 `organizers.permission_level`(master/sub)을 **계정 전역**에 둔다. 하지만 운영 주체의 권한은
행사마다 다를 수 있다(같은 KOTRA 계정이 행사 A에선 전권, 행사 B에선 제한). 전역 권한등급은 이를 표현하지
못한다. `event_organizers`(행사×운영자 조인)는 이미 존재한다.

## 결정

1. **운영자 = NABI 발급 내부 계정**(주관사 roster 밖 — ADR-0007). 개수 제한 없이 발급한다. 행사별 조직
   역할(주최사·KOTRA 본부·무역관)은 **스키마가 아니라 데이터**로 표현된다: 그 행사에서 어떤 계정이
   master/sub냐 + 어떤 바이어를 소유하냐.

2. **권한등급(master/sub)은 계정×행사 단위.** `permission_level`을 `organizers`(전역)에서
   **`event_organizers`(행사×계정 조인)로 이동**한다. 같은 계정이 행사마다 master/sub/없음을 가질 수 있다.
   - **master** — 그 행사 전역 권한: 전 국내기업·바이어·주선 CRUD, **승인**, 전체 포화배정·삭제. 한 행사에
     master가 여럿일 수 있다(예: 주최사 계정 + KOTRA 본부 계정).
   - **sub** — 자기 관할로 한정된 운영자: 자기 소유 바이어 등록·관리·**대리신청**·체류정보 입력. 국내기업은
     **열람만**. 승인·전체삭제·포화배정 **불가**. 한 행사에 sub가 여럿일 수 있다(예: 무역관별 계정).

3. **sub 관할 = 바이어 소유권 링크(가변).** 해외 바이어는 **현재 관리 운영자 최대 하나**를 갖는다
   (nullable·재배정 가능). 최초 등록 계정은 별도로 기록한다(`created_by`). sub는 자기가 **현재 관리하는**
   바이어에 대해서만 관리 행위가 가능하다. "정확히 한 무역관이 영구 소유"로 굳히지 않는다 — HQ/주최사가
   배정 전 먼저 등록한 바이어, 무역관 간 재배정을 허용해야 하기 때문(codex Q-B).

4. **권한검사는 capability + scope, FastAPI 단일 지점(경계 B).** admin 행위는 **master-for-this-event**로만
   게이트한다. scope 행위(특정 바이어 관리)는 **그 바이어를 관리하는 계정(또는 master)**만 허용한다. 맨
   "운영자임"으로는 어떤 admin도 열지 않는다. 가드 네이밍도 capability를 표현한다(`require_event_master`
   등) — `permission_level in ('master','sub')` 같은 등급 하드코딩·`require_organizer` 광역 통과 금지.

## Considered Options

- **`operator_type` enum(host/kotra_hq/trade_office)을 운영자에 박기 (기각).** 이번 행사 조직도를 스키마에
  새겨, 행사 구성이 바뀔 때마다 enum·마이그레이션을 건드린다. 행사별 역할은 본질적으로 데이터다.
- **무역관을 별도 actor 테이블/엔티티로 분리 (기각).** 권한상승 우려(codex Q-D)는 해결하나, 운영자 계정·
  인증·세션을 이원화해 복잡도가 커진다. capability+scope 가드로 같은 우려를 더 싸게 막을 수 있다.
- **`permission_level`을 계정 전역에 유지 (기각).** 행사마다 권한이 다른 현실(같은 계정의 행사별 차등)을
  표현하지 못한다.
- **계정×행사 master/sub + 바이어 소유권 scope + capability 가드 (채택).** 행사 조직을 데이터로 표현해
  스키마가 안정적이고, 권한상승은 "admin=master-for-event" 게이트로 막으며, 무역관이 늘어도 sub 계정 +
  소유 바이어 행만 추가하면 된다.

## Consequences

- **스키마(파생 — db-schema-keeper로 동기화):** `permission_level`을 `organizers` → `event_organizers`로
  이동. 해외 바이어 측에 `managing_organizer_id`(nullable, FK organizers, 재배정 가능) + 최초 등록자
  `created_by_operator_id`를 추가. (체류정보(항공·숙박·통역) 엔티티는 무역관 콘솔 슬라이스에서 별도 추가.)
- **#47(운영자 셸·라우트·가드):** `/organizer/*`(OP-001/002/005)는 **master 콘솔 전용**으로 확정하고,
  가드는 **master-for-this-event** 의미로 짓는다. 무역관(sub) 콘솔은 별도 라우트 네임스페이스의 후속
  슬라이스로 분리한다(#47 범위 밖). #47은 이 모델로 독립 출하 가능하며 rework가 없다.
- **별도로 해소할 충돌(이 ADR 범위 밖, 후속 결정) → ADR-0013에서 해소:** ① 자가등록+승인 vs 명단 스냅샷
  업로드(ADR-0007) → **운영자 직접입력 + 스냅샷 공존, master 승인 게이트**. ② 대리신청을 매칭 상태흐름
  (ADR-0005)에 어떻게 잇는지 → **신청자=바이어 + 대행 운영자 도장, 참가사 수신이라 `proposed`**. ③ 체류정보
  엔티티 설계 → **참석자(사람)별, 통역은 기존 `buyer_attendees` 재사용**.
- **데모/테스트:** 데모 운영자(`mbr-org-01`)를 데모 행사의 master로 시드한다. 로그인 분기·세션은 불변.

## 개정 (2026-09-09) — 기업 신청서 편집·대리작성을 sub에 개방(관할 한정)

발주자 확정으로 **기업 신청서 편집 + 대리작성(담당자 attendee 추가/편집 포함)을 모든 운영자
(master+sub)에게 개방**한다. 이는 원 결정의 "국내기업은 sub 열람만" 규칙을 이 영역(=기업 신청서
데이터 입력)에 한해 의도적으로 완화하는 것이다. 배경: 셀프가입 참가사는 신청서에 담당자 추가 UI가
없어 담당자 0명으로 제출되고, 이후 담당자 보강을 master 한 명에게만 몰면 병목이 된다 — 관할
운영자(sub)가 자기 담당 기업의 신청서를 대신 채울 수 있어야 한다.

**범위(개정되는 것):** `PATCH /api/admin/events/{event}/organizations/{org}/profile`(직접수정)과
`POST .../proxy-profile`(대리작성) 두 경로만. 가드를 `require_event_master` → `require_event_operator`
(master+sub)로 바꾸고, **sub는 관할 기업만 쓸 수 있게 서비스 계층에서 읽기 관할 필터
(`check_jurisdiction`)를 그대로 미러**한다(master는 전역 통과, sub는 관할 밖이면 403, fail-closed).
관할 규칙은 읽기와 동일 — 국내기업(exhibitor)은 공유 풀이라 모든 sub가 쓸 수 있고, 해외 바이어는
`managing_organizer_id == 자기 organizer_id`인 건만. 담당자(attendee)는 프로필 바디의 `attendees`
필드로 추가된다(별도 경로 아님). 대리작성 시 상태 게이트(`registered`만)와 감사 도장
(`proxy_written_by_organizer_id`)은 불변이며, 관할 검사를 상태(409) 검사보다 **먼저** 돌려 관할 밖
기업의 신청 상태를 sub에게 노출하지 않는다.

**불변(개정되지 않는 것 — 거버넌스는 그대로 master 전용):** 운영자 부여/회수(grant/remove organizer),
참가기업 역할 전환(exhibitor↔buyer), 행사 생성, 신청서 검토(승인/반려/수정요청), 행사 설정, 통역사
배정, 명단 임포트. sub는 (1)관할 밖 기업 편집 불가, (2)자기를 master로 승격 불가, (3)거버넌스 액션
불가 — 이 셋은 백엔드 가드로 강제하고 테스트로 고정한다(default-deny).

**FE:** `/admin` 콘솔의 권한 게이트를 두 축으로 분리한다 — `canEditOrgProfiles`(신청서 편집,
master+sub) vs `canWrite`(거버넌스, master만). 참가사 신청서 제출 게이트(`profile-form-state`)는
담당자 필수 조건을 제거해 백엔드 `_validate_submit`(참가사 담당자 비요구)와 정렬한다 — 셀프가입
0명 제출 허용.
