# 알림 모델 — 조직 공유 인박스 + 폴링 스케줄러 + 스냅샷 payload

NABI는 미팅 신청·수락·취소, 미팅 임박, 리뷰 입력 안내, 회의록 정리 완료 등 도메인 사건을 당사자에게 **통지(Notification)** 하고 **조회**하게 하는 시스템이 필요하다. 수신 단위·발화 메커니즘·데이터 모델·표면을 여기서 확정한다. 용어는 CONTEXT.md `Notification` 참조. 기능 정의는 F-NT-001.

## 수신 단위 — Organization 공유 인박스

- 알림은 **Organization에 귀속**된다. 같은 기업 Member 누구나 **공유 인박스**에서 조회하고, **읽음 상태(read_at)도 기업 공유**다(매칭·권한이 Org 단위·플랫 — ADR-0002와 일관).
- 읽은 주체를 표시·감사하기 위해 **`read_by_member_id`** 를 함께 기록한다("읽음: 시각, 멤버").
- **외부 발송은 멤버 연락처로 팬아웃**된다(인박스는 Org, 발송은 Member).
- 운영사(Organizer) 알림은 **v1 범위 밖**(OP-001 대시보드 위젯으로 대체). 수신 단위를 Organization 단일로 유지해 수신자 다형성을 피한다. 운영사 알림은 backlog.

## 채널 (v1)

- **인앱 인박스** = 전 6종(조회의 단일 진실원천). **이메일** = 전 6종(저비용 기본). **SMS** = 현장 시급건(10분 리마인더, 취소 선택)만, 인증 OTP와 공유하는 SMS 인프라 준비 시 조건부. **푸시** = 보류.
- 우아한 열화: 연락처 없는 멤버·SMS 인프라 미비 시 가능한 채널만 발송하고 `notification_dispatches.status='skipped'`. **읽음(read_at)은 외부 발송 성공과 분리** — 발송 0건이어도 인앱으로 읽힐 수 있고, 외부 재시도가 읽음을 되돌리지 않는다.

## 발화 메커니즘 — 이벤트성 / 시간성

- **이벤트성**(미팅 신청·수락·취소): 상태 전이 시 즉시 알림 행 생성.
- **시간성**(10분 리마인더, 리뷰 입력 안내): **폴링 스케줄러**(FastAPI cron, ~1분)가 due + **여전히 적격**인 미팅을 `meetings` 현재 상태와 조인해 질의·발화. 취소된 미팅은 질의에 안 걸려 자동 제외. 멱등.
- **비동기 작업성**(회의록 정리 완료): 전사·구조화 작업(F-MY-002, transcription job)이 `done`으로 완료될 때 **녹음을 업로드한 org**에 즉시 발화. `due_at` NULL(이벤트형). 시급 알림 아님 → 인앱·이메일만(SMS 제외). 재전사 시 재통지 안 함(아래 매트릭스 멱등 키로 org·미팅당 1행).
- **미팅 자동 완료**: scheduled_end 경과 시 스케줄러가 **`accepted` 미팅만** `completed`로 전환(취소/거부 제외 — 취소건에 리뷰안내가 나가지 않게). `noshow`는 상태가 아니라 **사후 리뷰 입력값**으로 옮긴다(`meetings.status`에서 제거, ADR-0004 보정).

### 스케줄러 정확성 규칙
- **scheduled_start/end 둘 다 존재할 때만** 시간성 알림 enqueue. 나중에 채워지면 **소급 enqueue**(운영자 자동드래프트는 시각 미정일 수 있음).
- **리스케줄**: 시간 변경 시 해당 리마인더 행을 **삭제+재생성**(`meeting.updated_at` 기준) — stale due_at 발화 방지.
- **타임존**: `scheduled_*`는 `timestamptz`(**저장은 UTC 정규화**) — 워커가 다른 TZ여도 드리프트 없음.
  > ⚠ **정정(2026-09-12, H5/H9 근본원인 분석)**: 위 항목이 예전엔 "Asia/Seoul(UTC+9, DST 없음)
  > 불변식"이라고 적혀 있었다. 이는 **ADR-0014**(`events.timezone` 신설, 슬롯 id·미팅 시각 해석·
  > 표시는 행사 현지 타임존 기준 — KST 하드코딩을 명시 기각)와 정면 충돌했고, 정정되지 않은 채
  > 남아 있던 이 문구가 FE 코드에 12곳의 `Asia/Seoul` 하드코딩이 반복 생산된 근거였다
  > (`.e2e-artifacts/timezone-analysis.md` §3.2). **현재 진실은 ADR-0014**: 저장은 UTC
  > (`timestamptz`가 자동 정규화), 해석·표시는 **`events.timezone`**(행사 현지, 예: 베트남 행사는
  > `Asia/Ho_Chi_Minh`) 기준이다. `docs/prd/F-NT-001.md`의 동일 문구도 함께 정정했다.

## 데이터 모델

- **`notifications`**: id, event_id, **recipient_org_id**(FK), **type**(CHECK enum), **meeting_id**(FK, 링크·조인용), **due_at**(시간성 발화시각; 이벤트성은 NULL), **payload jsonb**(표시 데이터 **스냅샷** — 보낼 때 박제, 형태는 Pydantic/TS로 강제), created_at, **read_at**(org 공유, null=안읽음), **read_by_member_id**.
  - **멱등 유니크: `UNIQUE(type, meeting_id, recipient_org_id, due_at) NULLS NOT DISTINCT`** (RDS Postgres 15+) → 이벤트형 due_at NULL도 중복 제거. 프로듀서는 `INSERT … ON CONFLICT DO NOTHING`.
- **`notification_dispatches`**: id, notification_id(FK), member_id(FK), channel, status, sent_at, error. **UNIQUE(notification_id, member_id, channel)** + 재시도 시 upsert(중복 발송 행 방지).
- **payload는 하이브리드(방법 3)**: meeting_id는 컬럼(링크/쿼리), 표시 데이터는 jsonb 스냅샷. 알림을 **불변 기록**("언제 무엇을 통지했나")으로 만든다 — 미팅이 사후 변경돼도 통지 당시 내용 보존.

## 수신 타깃팅 매트릭스 (트리거별 어느 org에 몇 행)

미팅은 2개 Organization이고 알림 행은 org당 1개이므로 트리거별 수신자를 못박는다:

| 트리거 | 수신 org | 행 수 |
|--------|----------|-------|
| 미팅 신청받음 | 받는 쪽(신청 안 한 org) | 1 |
| 내 신청 수락됨 | 신청한 쪽(요청자 org) | 1 |
| 미팅 취소됨 | 취소 안 한 쪽 | 1 |
| 10분 리마인더 | 양측 | 2 |
| 리뷰 입력 안내 | 양측(리뷰는 org별 독립) | 2 |
| 회의록 정리 완료 | 녹음 업로드한 org | 1 |

## 표면 (v1)

- 전역 nav **벨 아이콘 + 안읽음 배지** → 클릭 시 `/notifications`(드롭다운 v1 컷). **`/notifications` 페이지** = 6종 전체·필터·모두읽음(조회 본진).
- org 공유 읽음 **UI 노출**: "조직 공용 알림함", 배지="조직에 새 것", 행에 "읽음: 시각, 멤버".
- 권한 없음(Visitor 등): **벨 숨김**(nav 가드). 모바일: 반응형 nav 벨 배지, 10분 리마인더 상단 버블업.
- HM-001 대시보드는 이 시스템을 **소비하는 한 뷰**일 뿐(구체 표시 항목은 F-HM-001 소관).

## Considered Options

- **Member별 개인 인박스 (기각):** 매칭·권한이 Org 단위·플랫(ADR-0002)이라 알림은 기업 관심사. 개인별 읽음 추적은 일회성 이벤트에 과한 복잡도. (개인 "내가 본 시각" 클라 플래그는 post-v1 옵션)
- **미팅별 예약 작업 스케줄러 (기각):** 정밀하나 상태 변경 시 작업 취소·재예약 생명주기 관리 부담. 폴링이 자기보정·멱등.
- **payload 참조만(read 시 조인) (기각):** 중복은 적으나 미팅 재조정·기업명 변경 시 과거 통지가 소급 변조 → 인박스의 "통지 기록" 가치 파괴.
- **수신자 다형성(Org + Organizer) (기각/연기):** 운영사 알림 위해 수신자 타입을 늘리면 모델 복잡. v1은 Org 단일.

## Consequences

- `notifications`·`notification_dispatches` 테이블 신설(NULLS NOT DISTINCT 유니크 등). **db-schema-keeper가 본 ADR에서 파생해 schema.sql 동기화**, 운영 DDL은 Alembic.
- **`meetings.status`에서 `noshow` 제거** + `post_meeting_reviews`에 noshow 값 추가(ADR-0004 보정) — 본 알림 작업과 함께 처리.
- 기능 정의 **F-NT-001**(`/notifications`), page-list.csv 새 행(1:1).
- PRD는 **타입별 payload 스냅샷 스키마 + 표면별 렌더 필드 + 딥링크 타깃**을 명시한다.
- 운영사 알림·푸시·벨 드롭다운·개인별 읽음은 backlog.

Status: accepted
