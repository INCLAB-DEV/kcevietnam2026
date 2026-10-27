# NABI Biz-Matching Platform

MICE 방산 전시회(KADEX with DX Korea 2026)의 AI 기반 바이어-셀러 비즈매칭 플랫폼. 참가사와 바이어의 정보를 최대한 수집하여 매칭 정확도를 극대화하고 그 효과를 입증하는 것이 핵심 목표.

## Language

### 사용자 유형

**Organizer (운영사)**:
전시회를 운영하는 **계정**(우산 용어). NABI가 직접 발급하는 내부 계정으로, 행사마다 개수 제한 없이 만든다(주관사 roster 밖 — ADR-0007). 두 축으로 권한이 갈린다 — **권한등급(master/sub)** 과 **관할(Jurisdiction)**. ⚠ **권한등급은 계정 전역이 아니라 계정×행사(event) 단위**다(ADR-0012): 같은 계정이 행사 A에선 master, 행사 B에선 sub, 행사 C엔 없을 수 있다. 따라서 "주최사·KOTRA 본부·KOTRA 무역관" 같은 **행사별 조직 역할은 스키마가 아니라 데이터**(어떤 계정이 그 행사에서 master/sub냐 + 어떤 바이어를 소유하냐)로 표현된다.
_Avoid_: 관리자, admin / 운영자 유형을 스키마 enum으로 굳히지 말 것 — 역할은 계정×행사 권한 + 소유 데이터로 표현된다

**master / sub (권한등급)**:
한 행사에서 운영자 계정이 갖는 **capability 등급**. **master** = 그 행사 전역 권한(전 국내기업·바이어·주선 CRUD + **승인** + 전체 포화배정·삭제). **sub** = **자기 관할로 한정된 운영자**(자기 소유 바이어 등록·관리·대리신청·체류정보 입력, 국내기업은 **열람만**, 승인·전체삭제·포화배정 **불가**). 한 행사에 master 여러 개(예: 주최사 계정 + KOTRA 본부 계정), sub 여러 개(예: 무역관별 계정)가 공존할 수 있다.
_Avoid_: sub를 "약한 master"로 코딩하지 말 것 — admin은 항상 **master-for-this-event**로만 게이트하고 맨 "운영자임"으론 열지 않는다(경계 B, capability+scope 검사)

**관할 (Jurisdiction)**:
한 **sub** 운영자가 권한을 갖는 **데이터 경계**. master는 그 행사 전역 관할. sub의 관할은 **자기가 현재 관리하는 해외 바이어 집합**으로 좁혀진다(바이어 소유권 링크 — 아래 Relationships). 같은 행사에 sub가 둘이면 권한등급("둘 다 sub")만으론 서로의 바이어를 못 가르므로 **관할이 그 경계를 정한다**. 관할 밖 바이어 관리 행위는 거부된다(FastAPI 단일 지점 — ADR-0008 경계 B).
_Avoid_: 관할(scope, 누구 데이터냐)과 권한등급(capability, 뭘 하냐)을 섞지 말 것 — 둘은 독립 축

**대리신청 (Proxy Application)**:
sub(무역관 같은) 운영자가 **자기 관할 바이어를 대신해** 국내기업(참가사)에 상담을 신청하는 행위. **신청자는 바이어로 기록**되고(바이어 자가신청과 동일 취급), **대행한 무역관은 별도로 도장 찍어** 출처를 남긴다. 수락 규칙도 일반 매칭과 같다 — 받는 쪽이 참가사이므로 **참가사가 수락해야 성사**(`proposed`, ADR-0005). 참가측의 대칭 자가신청(BM-001)과 구분되는 운영자 측 경로(ADR-0013).
_Avoid_: 대리신청을 Forced 배정과 혼동하지 말 것 — 대리신청은 바이어 측 신청을 운영자가 대행(참가사 수락 필요), Forced는 운영자가 양측을 지정

**체류정보 (Stay Info)**:
방한하는 해외 바이어의 **항공(도착/출발 편명·일시)·숙박(호텔·체크인/아웃)** 정보. **참석자(사람) 단위**로 단다 — 일행이 서로 다른 항공편·호텔일 수 있으므로. **통역 정보(필요 여부·언어)는 바이어 참석자 정보에 이미 있어 재사용**하고 중복으로 만들지 않는다. 입력은 관할대로 — sub(무역관)는 자기 관리 바이어, master는 전체(ADR-0012/0013). 매칭과 무관한 운영 로지스틱스 데이터.
_Avoid_: 통역 정보를 체류정보에 다시 만들지 말 것(참석자에 이미 있음); 회사 단위로 묶지 말 것(사람별)

**Organization (기업)**:
전시회에 참여하는 법인 단위. 하나의 기업이 Exhibitor, Buyer, 또는 양쪽 역할을 동시에 가질 수 있음. 참가 양측을 묶어 부를 땐 페르소나 표기 `참가사/바이어`를 쓴다.
_Avoid_: 회사, 업체, company, 참가기관, 참가기업

**Exhibitor (참가사)**:
Organization이 이번 전시회에서 제품/서비스를 전시하는 역할. (KOTRA 통합 상담주선 요구사항 문서는 셀러 측 국내 방산기업을 **국내기업**으로 칭한다 — NABI 정본은 참가사. "참가기업"은 Organization과 혼동되는 avoid-term이므로 역할 지칭에 쓰지 않는다.)
_Avoid_: 셀러, 판매자, vendor, 참가기업(=Organization avoid-term)

**Buyer (바이어)**:
Organization이 이번 전시회에서 제품/서비스를 탐색·구매하는 역할. (KOTRA 통합 상담주선 요구사항 문서 용어로는 **해외바이어**.) 세 가지 하위 유형이 있다. 대부분의 경험은 동일하나, **Open Matching을 받을 때의 동작만 초청(Hosted) vs 일반(Pre-registered+On-site)으로 갈린다** — 초청 바이어는 거부 단계 없이 즉시 확정, 일반 바이어는 본인 수락이 필요. (그 외에는 데이터 라벨로만 구분)
- **Hosted Buyer (초청 바이어)**: 주최측이 비용(항공/숙박 등)을 부담하여 초청. 의무 미팅 참여가 있음.
- **Pre-registered Buyer (사전등록 바이어)**: 비즈매칭 신청기간(8/26~9/11)에 직접 등록한 바이어. 구체적 도입 니즈가 있는 경우가 많음.
- **On-site Buyer (현장 바이어)**: 데이터 subtype(`on_site`)으로만 존재하고, **현재 정책에서는 생성하지 않는다** — 유일 생성 경로였던 'Visitor→BM-001 자기전환'이 폐지됐고(정책 변경 2026-07-02), 별도 정책 변경이 없는 한 현장 바이어를 새로 만들지 않는다. (subtype 값은 스키마에 유지 — 향후 정책에서 쓸 수 있게. 그 외 경험은 사전등록 바이어와 동일.)
_Avoid_: 구매자, 참관객(일반인과 혼동), 자발적 바이어

**Visitor (미인증 참관객)**:
전시회 당일 현장에 있는 비등록·미인증 사용자. NABI의 nav/서비스 페이지(기업 탐색·미팅 등)에는 **진입할 수 없다** — 이용하려면 딥링크 로그인으로 인증해야 한다(라우트 가드가 미인증 접근을 `/login`으로 보냄). 게스트 탐색 없음, 자기전환(Visitor→On-site Buyer) 없음(정책 변경 2026-07-02).
_Avoid_: 게스트, 비회원

**Member (멤버)**:
Organization 하위의 개별 사용자 계정. 같은 기업 내 멤버는 동일 권한(플랫).
_Avoid_: 담당자, 직원, user

**Registrant (등록자)**:
주관사 전체 신청자 명단에서 NABI DB로 적재(import)된 기업·사용자. 비즈매칭 신청 여부와 무관하게 **전원** 들어온다. 등록자는 **아직 매칭 대상이 아니며**, 비즈매칭 프로필(BM-001/002)을 작성·제출(`submitted`)한 뒤 운영자(master)의 **승인(`approved`)** 을 받아야 매칭 엔진에 들어가는 **비즈매칭 참가자**로 승격된다. **작성·제출만으론 부족하다** — 승격 트리거는 승인이다. 명단은 라이브 API가 아니라 주관사가 주는 **전체 스냅샷 파일을 운영자가 업로드 → 주관사 회원ID 키로 멱등 upsert** 하여 동기화한다(ADR-0007). 키는 해외업체·개인 바이어도 커버하도록 **사업자등록번호가 아니라 전 레코드에 존재하는 회원ID**를 쓴다. 단 **무역관이 현지 모집한 해외 바이어**는 주관사 스냅샷에 없고 회원ID도 없으므로 이 적재층을 거치지 않고 운영자가 NABI에서 **직접 Buyer로 등록**한다 — 스냅샷 경로와 운영자 직접입력 경로가 **공존**하며, 직접 등록분도 총괄(master) **승인**을 거쳐 매칭에 합류한다(ADR-0013).
_Avoid_: 가입자, 회원(Member와 혼동)

**비즈매칭 참가자 (Biz-matching Participant)**:
**등록자(Registrant)**가 BM 프로필을 제출하고 운영 **승인(`approved`)** 까지 받아 매칭 엔진·본 서비스(nav 있는 화면)에 들어간 상태. 승인 상태머신은 `registered → submitted → {approved | changes_requested | rejected}`, `changes_requested → submitted`(재제출)이며 **매칭 노출·nav 접근은 `approved`부터**다(권위 출처: `organization_event_roles.application_status`, ADR-0009 / bm-profile-fields §6). `submitted`(제출·검토 대기)는 아직 참가자가 아니다.
_Avoid_: 신청자(제출만 한 상태와 혼동), 승인=제출

### 인증

**Login Ticket (로그인 티켓)**:
DX Korea 신원검증은 통과했으나 아직 약관 동의를 마치지 않은 **진행 중 로그인**을 가리키는, 백엔드가 보관하는 증표. 클라이언트는 불투명 값만 쥐고 회원ID·역할은 백엔드가 들고 있어, 약관 게이트를 넘기 전엔 세션이 나지 않는다(ADR-0011).
_Avoid_: 세션, 토큰(딥링크 토큰·세션 JWT와 혼동), 쿠키

### 매칭

**Open Matching (자율 매칭)**:
Exhibitor↔Buyer 쌍방이 자유롭게 미팅을 신청하는 매칭 방식. 개념상 가장 이상적인 형태(쌍방이 원하는 매칭)이나, **운영 흐름상으로는 사후 보정 채널**이다: 신청기간(8/26~9/11)엔 비활성(프로필만 수집), 9/11 후 AI 전체 포화배정이 1차, 이후 **취소로 빈 슬롯이 생기면** 사용자가 AI 추천/검색으로 능동적으로 채우는 경로. 수락 규칙은 다른 출처와 동일하게 받는 쪽 유형 따라 — **일반 바이어/Exhibitor가 받으면 수락대기(`proposed → accepted`), 초청 바이어가 받으면 즉시 확정**.
_Avoid_: 오픈 매칭, 자유 매칭

**AI Matching (AI 매칭)**:
AI가 적합도 기반으로 양측 빈 슬롯에 미팅을 배정하는 방식. 누구나 사후 **취소** 가능. **두 가지 액션으로 동작하며 수락 규칙이 채널에 따라 다르다**:
- **전체 포화배정** (전체 참가사 대상, **반복 실행 가능**, 참가사 우선 포화, 최소 N슬롯 운영자 설정): 운영자가 참가사 캘린더를 대신 채우는 구조라 **참가사 측은 자동확정**, **바이어 측은 유형별**(초청=즉시 확정 / 일반=수락대기). 따라서 수락대기는 일반 바이어 수신 건에만 발생. (운영자 Draft 검토 후 확정 — 게이트 유지) 1회성 아님, 9/11 후 1차 실행이 가장 임팩트 크나 이후 재실행으로 취소분·지각합류분 흡수.
- **단일 기업 빈슬롯 보충(재트리거)** (한 기업만 골라 보충, 추가 전용·비파괴): 받는 쪽 유형 따라 — **초청 바이어=즉시 확정 / 일반 바이어·Exhibitor=수락대기(proposed)** (Open Matching과 동일 수락 규칙).
두 액션 모두 provenance는 'AI 매칭'으로 기록(성과측정). 즉 **provenance(누가 만들었나)와 수락 규칙(받는 쪽이 누구·언제냐)은 별개 축**이다.
_Avoid_: 자동 매칭, 알고리즘 매칭

**Forced Matching (강제 매칭)**:
Organizer가 운영사 대시보드에서 **AI 추천/검색으로 대상을 골라** 바이어+참가사+슬롯을 지정해 배정하는 매칭. 업계에서 실제로 "강제 매칭"이라 부름. **수락 규칙은 받는 쪽 유형 따라** — 초청 바이어=즉시 확정 / 일반 바이어·Exhibitor=수락대기(proposed). 운영자가 confirmed/proposed를 수동으로 고르지 않으며, **일반 바이어 강제 확정 권한은 없다**. provenance만 'Forced'로 구분.
_Avoid_: 수동 매칭, 어레인지

**On-site Matching (현장 즉석 매칭)**:
전시회 당일 노쇼 또는 부스 방문 시 자율적으로 발생하는 즉석 미팅.
_Avoid_: 워크인, 즉석 미팅

### 프로세스

**Biz-Matching Application (비즈매칭 신청)**:
전시회 전(8/26~9/11) 참가사와 바이어가 **프로필을 작성**하는 사전 단계. 이 기간엔 프로필 수집만 하며 **미팅 배정은 일어나지 않는다** — 미팅은 마감(9/11) 후 AI 전체 포화배정부터 시작된다. **마감 후에도 신청은 컷오프 없이 받는다**: 지각 신청 기업은 유형(참가사/바이어) 무관하게 이미 등록자(Registrant)로 동기화돼 있으므로 로그인 → 프로필 작성 → 매칭에 합류한다. AI 전체 포화배정이 **반복 실행 가능**하므로 지각분은 다음 포화배정 재실행 또는 보정채널(Open·재트리거·Forced)로 합류한다(ADR-0006/0007).
_Avoid_: 사전 등록, 프로필 작성

**Schedule Table (스케줄 테이블)**:
모든 매칭 유형의 결과가 기록되는 중앙 테이블. 각 역할이 실시간으로 참조. 상태 흐름의 진입점은 **출처가 아니라 "받는 쪽이 누구·언제냐"** 로 갈린다:
- **`proposed`로 시작** (받는 쪽 수락 필요) → `accepted / rejected / cancelled → ...`: **일반 바이어가 받는 모든 건**(전 채널 — Open · AI 전체 포화배정 · 단일 재트리거 · Forced) · **Exhibitor가 받는 건**(Open · 단일 재트리거 · Forced — AI 전체 포화배정 제외)
- **`accepted`로 바로 진입** (거부 단계 없음) → `cancelled / completed`: **초청 바이어가 받는 모든 건**(전 채널) · **AI 전체 포화배정에서 참가사 측**(운영자가 참가사 캘린더를 대신 채우므로 자동확정). **노쇼는 상태가 아니라 `completed`의 결과 속성**(`attended=false`, 진실원천=`post_meeting_reviews`)이다(ADR-0010 — `meetings.status`에서 noshow 제거).
_Avoid_: 미팅 목록, 일정표

**거부(reject) vs 취소(cancel)**:
- **거부(reject)**: 미팅이 확정되기 *전*(`proposed`)에 받는 쪽이 거절하는 행위. **일반 바이어/Exhibitor가 받는 건**(출처 무관)에만 존재. 초청 바이어 수신 건·AI 전체 포화배정의 참가사 측에는 거부 단계가 없다(자동확정).
- **취소(cancel)**: 이미 `accepted`된 미팅을 무르는 행위. **모든 미팅·모든 출처에서 양쪽 누구나 가능**(취소 넛지 적용).
_Avoid_: 거부/취소 혼용

**Meeting Venue (미팅 장소)**:
미팅이 진행되는 물리적 공간. 참가사 부스, 비즈매칭 존 테이블, 비즈니스 룸 중 선택. AI/Forced 자동 배정 시 **1순위 선호는 바이어 동선 가까운 비즈니스 룸**(디폴트 강제가 아니라 선호)이나, 룸은 한정 자원(약 50개)이라 수요 초과 시 우선순위로 배정한다: **① 초청 바이어(Hosted) 미팅 → ② 적합도 높은 미팅 → ③ 비즈매칭 신청 빠른 순**. 룸을 못 받으면 **매칭존 테이블 → 참가사 부스**로 폴백(매칭존 테이블 폴백 포함 여부는 운영 확인 필요).
_Avoid_: 미팅룸, 장소

**전시장 부스 계층 (Hall / Booth)**:
참가사 부스 위치는 **3계층**으로 표현한다 — **Hall Number**(정렬·식별용 홀 번호) / **Hall 이름**(ㅇㅇㅇ관, 예 "제1전시관") / **Booth code**(부스 코드, 예 "b-12"). 과거에는 평문 한 칸(예 "A-101")으로 평면화돼 있어 계층·그룹·정렬이 불가능했으나, **정규화**하여 `halls`(이벤트별 홀) → `booths`(홀별 부스) 두 계층으로 분리하고 참가사 프로필은 `booth_id`로 부스를 참조한다(부스 미배정 가능 → NULL). **부스 위치 표시값**(F-DV-001 카드/상세 등)은 `{Hall 이름} {Booth code}`로 **파생**하며 평문으로 저장하지 않는다. `Meeting Venue`의 `booth` 유형도 같은 물리 부스를 가리킨다(`booths` 참조).
_Avoid_: 부스번호 평문, 부스 위치 텍스트(평면 문자열)

### 미팅 후 평가

**Post-meeting Review (미팅 회의록)**:
완료/노쇼된 미팅을 정리하고 평가 데이터를 남기는 절차. 기업에는 **미팅 보고 문서(회의록)를 자동 생성**(보고 시간 절감, 작성 동기)하고, 그 부산물로 NABI는 **미팅 데이터 자산화 + 매칭 성과 측정 자료**를 확보한다. (일회성 이벤트라 알고리즘 학습/보정이 아니라 성과 *측정·입증*이 목적) 사용자 표시 용어는 **미팅 회의록**(사용자가 체감하는 핵심 산출물=AI 자동 회의록). 영문 도메인 용어 Post-meeting Review·내부 식별자(`post_meeting_reviews`, `/review`)는 유지 — 만족도·Fit·Love Call 등 평가 데이터까지 포함하는 절차 전체를 가리킨다.
_Avoid_: 미팅 리뷰(구 표기 — 2026-06 회의록으로 통일), 미팅 결과 요약(요약은 일부 기능일 뿐), 후기

**Recording (녹음 원본)**:
미팅 음성 파일 원본. 작성자(업로더) 기업 **전용·비공개**(상대 비노출, ADR-0004 비공개 경계 연장). 보관 목적은 둘: ① 서비스 제공자(NABI)의 **AI 전사·구조화 성능 검증**, ② **전사 재처리 원천**(예: 더 정확한 화자 분리로 사후 재처리). 영구보관(S3, 암호화·접근통제). 한 미팅을 양사가 함께 진행해도 녹음은 **공유하지 않는다**(올린 쪽 전용).
_Avoid_: 음성파일(맥락 없이), 녹취록(=Transcript와 혼동)

**Transcript (전사 원문)**:
녹음 원본을 STT로 받아쓴 텍스트. 화자(우리/상대)는 별도 화자분리 없이 **AI가 추정**한다("AI 추정 화자"로 고지 — 음성 기반 분리 아님, 검수 보조용이지 증빙 아님). 작성자 본인 **검수용 읽기전용·비공개**(상대 비노출, 보고문서 미포함). 회의록 본문(아래 Report Sections)은 이 전사를 사람이 직접 고치는 게 아니라, 전사를 근거로 한 **요약 3섹션을 편집**해 완성한다.
_Avoid_: 회의록(=완성 산출물/Report와 혼동), 녹취록

**Report Sections (회의록 본문)**:
전사를 AI가 구조화한 **핵심 논의사항 / 합의 사항 / 후속 액션** 3섹션. 사용자가 검수·편집하는 대상이자 내보내는 보고문서의 본문. 비공개 평가(Fit·Follow-up)와 전사 원문은 **포함하지 않는다**(D6).
_Avoid_: 요약(너무 일반적), 미팅 노트

**Follow-up Intent (후속 진행 의향)**:
미팅 후 사용자가 후속을 진행할 의향. 없음/검토중/있음. **비공개** — 상대에게 보이지 않으며, 매칭 효과를 측정하는 핵심 지표.
_Avoid_: 후속 의사, 팔로업

**Love Call (러브콜)**:
미팅 상대 Organization에 후속 거래 희망을 능동적으로 표명하는 **공개** 신호. 단방향 통지로 전달되며, 양측이 서로 러브콜을 보내면 **Mutual Love Call**로 격상된다. Mutual Love Call은 **NABI가 추가 매칭(후속 미팅)을 검토하는 신호**로 쓴다. (당초 구상한 "대화 채널 자동 개설"은 v1 구현 범위 밖 — backlog) Follow-up Intent(비공개 측정)와 별개 항목.
_Avoid_: 관심표명, EOI, 좋아요

**Fit Assessment (내부 적합도 평가)**:
미팅 상대가 자사와 맞는지에 대한 **비공개** 판단(맞음/안 맞음 + 사유). 본인 의사결정 + 알고리즘용. 상대에게 절대 공개되지 않음.
_Avoid_: 상대 평가, 점수

**Notification (알림)**:
도메인 사건(미팅 신청·수락·취소, 미팅 임박, 리뷰 입력 안내, 회의록 정리 완료 등)을 한쪽 당사자에게 통지하는 것. **Organization에 귀속**되며, 같은 기업 **Member 누구나 공유 인박스에서 조회**한다(읽음 상태도 기업 단위 공유). 인박스 조회와 별개로, 멤버 **연락처로 외부 통지**될 수도 있다. **Love Call과 구분** — Love Call은 *상대 기업에 보내는* 도메인 신호이고, Notification은 *내 기업에 도착하는* 통지다.
_Avoid_: 푸시·알럿·메시지(전달 채널/UI 표현일 뿐), 회원 개인 알림(수신 단위는 기업)

### 라우팅

**Role-based Route (역할별 라우트)**:
동일 기능이라도 바이어와 참가사는 대체로 별도 라우트를 갖는다. 프로필은 바이어 `/profile`(BM-004), 참가사 `/exhibitor/profile`(BM-005); 신청은 `/apply`(BM-001) vs `/exhibitor/apply`(BM-002) 식으로 분리.
- **예외 — 로그인 후 첫 랜딩과 미팅은 전원 공용 단일 라우트**: 로그인 직후 참가사·바이어 모두 **HM-001 대시보드(`/`)에 랜딩**(미팅현황 요약·today 일정·프로필 요약·알림 3종)하고, 미팅 타임라인 상세는 **MY-001(`/meetings`)** 에 전원 공용으로 둔다. 둘 다 화면 안에서 역할별 뷰로 분기. (구 EX-000 `/exhibitor` 홈은 HM-001로 일반화, 구 EX-003 `/exhibitor/meetings`는 MY-001로 흡수) ⚠ 대시보드 랜딩은 **참가자 메뉴가 "전체 메뉴"인 행사**의 동작이다 — 기본("미팅만")에서는 MY-001(`/meetings`)에 랜딩한다(아래 참가자 메뉴).
_Avoid_: 통합 라우트, 공유 경로

**참가자 메뉴 (Participant Menu)**:
행사 단위 설정 — 참가사·바이어 화면의 왼쪽 메뉴를 **"미팅만"(`meetings_only`, 기본)** 낼지 **"전체 메뉴"(`full` — 대시보드·기업 탐색·미팅·알림·프로필)** 낼지 행사가 고른다(F-NV-001 D15). 슈퍼어드민(master)이 행사 설정에서 바꾸고, 값을 알 수 없으면 언제나 기본값("미팅만")이다. **화면 구성용 값이지 권한이 아니다** — "미팅만"이어도 숨긴 화면은 주소로 열리고 API는 그대로 동작한다(ADR-0015). 달라지는 건 진입점(메뉴·로그인 후 도착 화면·탐색/신청으로 나가는 버튼·도움말과 알림 메일이 가리키는 화면)뿐이다.
_Avoid_: 메뉴 권한·접근 제어(막는 게 아니라 숨기는 것), 미팅 전용 모드를 특정 행사 이름으로 부르기(행사 설정값이다)

## Relationships

- An **Organization** has one or more **Members**
- An **Organization** has one or more roles per event: **Exhibitor**, **Buyer**, or both
- An **Organizer** account holds a **permission level** (master / sub) **per event** (on the Organizer×Event link), not globally — the same account can be master in one event and sub in another (ADR-0012). Event-specific org roles (주최사, KOTRA 본부, 무역관) are **data** (which accounts are master/sub for that event + which Buyers they own), not schema types
- A **sub** Organizer **owns** the overseas **Buyers** it currently manages — a Buyer has **at most one current managing Organizer** (nullable, reassignable), and the account that first registered it is recorded separately. This buyer-ownership link **defines the sub's Jurisdiction**: a sub can register/manage/대리신청/체류정보 only for Buyers it manages, but may **view all 국내기업(Exhibitors)** to broker (no write). **master** operators have global Jurisdiction for the event (this link does not constrain them)
- Permission checks live in FastAPI (boundary B, ADR-0008) and test **capability + scope**: admin actions require **master-for-this-event**; scoped actions require the caller to **manage that Buyer** (or be master). Bare "is an Organizer" never grants admin
- A **Buyer** recruited overseas by a sub (무역관) may be **created directly by the Organizer**, not via the 주관사 snapshot (it has no 회원ID) — the snapshot path and operator-direct path **coexist**; such a Buyer enters matching only after **master approval** (the existing approval gate, ADR-0013)
- **대리신청** (proxy application) records the **Buyer as the applicant** with the acting Organizer **stamped separately**; the recipient is an **Exhibitor**, so the normal rule applies → `proposed`, recipient must accept — it is **not** Forced (ADR-0005/0013)
- **Stay Info** (체류·항공·숙박) attaches **per Buyer attendee** (person) and **reuses the attendee's existing interpreter fields**; editable by the managing sub or by master (ADR-0012/0013)
- All **Members** within an **Organization** share equal permissions (flat)
- A **master** can delete an **Organization**'s participation in an event only while it has no scheduled (`proposed`/`accepted`) or `completed` meetings there; its `cancelled`/`rejected` meetings are deleted together with it, and the Organization itself (with its **Members**) goes only when nothing outside this participation still points to it (another event's data, or a meeting it is not a party to) — otherwise only this event's participation goes and everything else stays untouched (F-OP-002 D27)
- **Open Matching**, **AI Matching**, **Forced Matching**, **On-site Matching** all write to the same **Schedule Table**
- **Provenance** (Open / AI / Forced / On-site, who created the match) and the **acceptance rule** (does the recipient have to accept) are independent axes
- The acceptance rule is keyed on **the recipient's buyer type** (not provenance): a **Hosted Buyer** recipient → immediate `accepted` (Open / AI re-trigger / Forced alike); a **일반 Buyer or Exhibitor** recipient → `proposed`, recipient must accept (Open / AI re-trigger / Forced alike). **There is no type-agnostic exception** — the old "AI initial batch → everyone accepted" rule is retired (ADR-0005). The **AI full-saturation batch** only auto-confirms the **Exhibitor side** (the organizer fills exhibitors' schedules on their behalf), so within that channel `proposed` arises only for 일반 Buyer recipients. Organizers do **not** pick confirmed/proposed manually, and cannot force-confirm a 일반 Buyer
- Any meeting, any provenance, can be **cancelled** by either side afterward
- Both **Exhibitor** and **Buyer** can initiate meeting requests to the other side (fully symmetric); neither side is passive
- **Open Matching** is bidirectional: **Exhibitor** can request meetings with **Buyer**, and vice versa
- A **Visitor** (unauthenticated on-site person) **cannot access NABI service pages** — no guest browsing and no self-service Visitor→On-site-Buyer conversion; they must authenticate via deep-link login (the route guard redirects unauthenticated access to `/login`). The **On-site Buyer** subtype (`on_site`) still exists as a data value but is **not created under the current policy** — its only creation path was the now-removed self-service conversion, and no on-site buyers are created unless a separate policy change reintroduces one (2026-07-02 policy change)
- **Biz-Matching Application** precedes all matching types except **On-site Matching**
- Every meeting in the **Schedule Table** requires a **Meeting Venue**
- A completed/noshow meeting produces a **Post-meeting Review**, which collects **Follow-up Intent** + **Love Call** (Step 1) and **Fit Assessment** (Step 2)
- A **Love Call** is sent one-way from one **Organization** to the other; when both directions exist it becomes a **Mutual Love Call**, which NABI uses as a signal to consider an additional follow-up match (the originally-envisioned auto-opened conversation channel is out of v1 scope — backlog)
- **Follow-up Intent** and **Fit Assessment** are private to the sender and the algorithm; **Love Call** is the only review signal visible to the counterpart
- 로그인엔 **세 종류의 토큰**이 순서대로 등장한다: Deeplink Token(진입) → **Login Ticket**(약관 게이트 전 진행중 로그인) → Session JWT(완료 후). 발급 주체·수명·소비 지점이 모두 다르며, 최초 진입자만 Login Ticket을 거친다(재방문자는 건너뜀, ADR-0011)

## Example dialogue

> **Dev:** "바이어가 미팅 신청하면 Organization 단위로 매칭되는 건가요, Member 단위인가요?"
> **Domain expert:** "Organization 단위. 매칭은 기업 대 기업이고, 미팅 참석자(Member)는 기업 내부에서 지정하면 돼."

> **Dev:** "AI Matching이 빈 슬롯을 자동으로 채우나요?"
> **Domain expert:** "응. 신청기간(9/11) 끝나면 운영자가 AI 전체 포화배정을 돌려 참가사 우선으로 빈 슬롯을 채워. 참가사는 자동확정이고, 바이어는 초청이면 즉시 확정·일반이면 수락대기로 가. 참가사 일정을 우리가 대신 채우는 거라 참가사가 일일이 수락할 필요는 없게 한 거지. 원치 않으면 취소하면 돼. 그리고 이건 1회성이 아니라 빈자리 생기면 또 돌릴 수 있어. 한 기업만 빈 슬롯 보충할 땐 그 기업만 골라 재트리거하고 — 그땐 받는 쪽 유형 따라 수락 규칙이 정해져."

> **Dev:** "그럼 거절은 어떻게 되나요?"
> **Domain expert:** "즉시 확정된 건엔(초청 바이어 수신·포화배정 참가사 측) '거절(reject)' 단계가 없어 — 거부할 틈 없이 확정되니까. 대신 '취소(cancel)'는 어떤 미팅이든 양쪽 누구나 할 수 있어. 거절과 취소는 다른 행위야."

> **Dev:** "참가사가 동시에 바이어일 수 있나요?"
> **Domain expert:** "당연하지. 드론 전시하면서 소재 부품 찾는 기업도 있어. Organization에 역할이 복수로 붙는 거야."

> **Dev:** "참가사도 바이어에게 먼저 미팅 신청할 수 있나요?"
> **Domain expert:** "당연하지. 바이어와 참가사는 동등한 존재야. 참가사가 AI 매칭 제안을 받고 바이어에게 먼저 미팅 신청할 수도 있고, 바이어 리스트에서 관심 바이어를 찾아서 Open Matching으로 미팅 신청할 수도 있어."

## Flagged ambiguities

- "참관객"은 Buyer와 Visitor 양쪽에 쓰이고 있었음 — 해결: 초대받은 기업은 **Buyer**, QR 진입 비등록자는 **Visitor**
- "참가사"와 "바이어"가 별개 엔티티처럼 쓰였으나 — 해결: 둘 다 **Organization**의 역할(role)이며 동일 기업이 양쪽 역할을 가질 수 있음
- "에이전트"가 AI 에이전트와 전시 대행사 양쪽 의미로 사용됨 — 해결: UI에서 "에이전트"는 AI만 의미, 전시 대행사는 "대행사(Agency)"로 분리
- **Visitor** 미팅 신청 — 해결(2026-07-02 정책 변경): Visitor→On-site Buyer 자기전환 게이트 폐지. 미인증 사용자는 nav/서비스 페이지(기업 탐색·미팅 포함) 진입 불가 → 딥링크 로그인으로 인증해야 함(라우트 가드 → `/login`). 게스트 폼·게스트 탐색·자기전환 경로 없음. (구버전: 게스트 폼 폐기 후 BM-001 5단계로 On-site Buyer 전환·전체 기업 탭만 탐색 — 폐지됨)
- NABI 플랫폼 자체 회원가입 기능 여부 — 미해결: 현재는 초대 링크(바이어/참가사) + QR(일반 참관객)만으로 진입. 자체 가입을 열지 여부 논의 필요
- 키워드 카테고리 체계 — 미해결(CTO 협의 필요): 현재 프로토타입 기준 방산 8개 + 기술/소재 6개 카테고리가 있으나, 키워드 그룹핑 방식과 매칭 로직이 미정. 참가사 103개 전시품목 데이터 분석 기반으로 카테고리를 도출하는 것이 바람직. 6/17 데모는 현재 목록으로 진행. ⚠ **적합도(fit score) 정의는 AI 매칭 우선순위·룸 배정 우선순위의 선행 조건** — 이게 정해져야 배정 알고리즘이 완성됨
- 매칭존 테이블 존재 여부·수량 — 미확인: 룸 폴백 체인(룸 → 매칭존 테이블 → 부스)에 매칭존 테이블을 넣을지 운영 확인 후 결정
