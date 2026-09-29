# 미팅 도메인 구현 — 슬롯 점유·동시성 제어·사유 분리·시간축 단일화·데모 인증 확정

참가자용 미팅 API(신청/수락/거절/취소/조회/가용성)를 레포 컨벤션대로 `/api/meetings` 슬라이스로 신설하면서, 지금까지 ADR·PRD가 정책만 정하고 구현으로 못 박지 않았던 지점들을 확정한다. deep-reasoner 2개를 서로의 답을 보여주지 않고 병렬로 설계시킨 뒤 종합해 결정했다.

## 배경

ADR-0005(수락 모델 opt-out)·ADR-0006(AI 일괄 포화배정)·ADR-0002(매칭 단위=Organization)가 "무엇을"(정책)을 정했고, F-MT-001·F-MY-001·F-OP-003·F-OP-005가 화면·상태흐름을 정의했지만, 실제로 엔드포인트를 짜려면 정책만으로 답이 안 나오는 구현 갈림길이 남아 있었다 — 슬롯을 언제 점유된 것으로 볼지, 동시 신청 경합을 무엇으로 막을지, 거절/취소 사유를 어떻게 저장할지, 슬롯 id의 타임존을 무엇 기준으로 풀지, 데모 인증을 어디에 분기할지 등. 이 ADR은 그 구현 갈림길들의 결정을 기록한다.

## 결정

1. **슬롯 점유 술어 = `status='accepted'`만.** `proposed`는 슬롯을 점유하지 않는다. 같은 슬롯에 복수의 `proposed`가 공존할 수 있고, 먼저 수락한 건이 슬롯을 가져가며 나머지 수락 시도는 409로 실패한다. 근거: 매칭 밀도 극대화(제품 목표, ADR-0005)와 스쿼팅(무응답 수신자가 슬롯을 잠그는 상태) 원천 차단, 그리고 만료 정책이 불필요해진다는 이점. 대가는 수락 시점의 충돌 가능성인데, 이는 락을 재검증하지 않고 그대로 409로 처리한다(결정 2).

2. **동시성 제어 = advisory lock(주) + EXCLUDE 제약(부).** Organization 겹침은 `exhibitor_org_id`·`buyer_org_id` 두 컬럼에 걸쳐 있고, 참가사·바이어 이중역할 Organization의 교차 충돌은 단일 컬럼 EXCLUDE로 표현할 수 없다 — 그래서 `pg_advisory_xact_lock`(키: `mtslot:{event_id}:{org_id}`, 정렬된 순서로 획득)이 정확성을 담당한다. 단일 컬럼(예: `venue_id`, 같은 컬럼끼리의 겹침)은 `EXCLUDE`(`btree_gist`, `tstzrange &&`, `WHERE status='accepted'`)가 방어선으로 남는다. 미팅을 `accepted`로 만드는 **모든** 미래 경로(포화배정·Forced 포함)는 `app/matching/slot_booking.py`의 락 프로토콜을 통과해야 한다 — 새 경로를 추가하는 쪽이 이 불변식을 지킬 책임을 진다.

3. **거절/취소 사유는 분리 컬럼(`rejected_*`/`cancelled_*`).** 도메인 커널이 "거절 ≠ 취소"를 이미 강제하고(CONTEXT.md), 어드민 FE 계약도 둘을 별개 필드셋으로 기대한다. 사유 어휘는 DB CHECK가 아니라 **Pydantic Literal로만 강제**한다 — 취소 사유 어휘가 어느 PRD에도 명시돼 있지 않아 `schedule_conflict`/`counterpart_request`/`internal_change`/`other`로 잠정 확정했다. PM이 확정하면 코드(Literal)만 고치면 되고 마이그레이션은 불필요하다.

4. **`events.timezone` 신설**(IANA 문자열, default `Asia/Seoul`). 슬롯 id(`"YYYY-MM-DDTHH:MM"`)는 행사 현지 벽시계 기준이라 `timestamptz` 변환에 행사 타임존이 필수다. KST 하드코딩은 베트남 행사(ICT, UTC+7)에서 2시간 오차를 내고, 마인즈그라운드가 멀티 행사 재사용 플랫폼이어야 한다는 원칙과도 어긋난다.

5. **`slot_minutes` 진실원천 = `events.slot_minutes` 단일화.** `event_schedule_settings.slot_minutes`는 읽는 코드가 0개라 DROP한다. 시간축(운영시간·점심 블록)은 `event_schedule_settings`가, 슬롯 단위(분)는 `events`가 갖는 것으로 역할을 나눈다 — 같은 값을 두 테이블이 따로 들고 있으면 드리프트가 난다.

6. **D9(복수신청·재신청 규칙) 강제 = 부분 unique 인덱스.** `UNIQUE (event_id, exhibitor_org_id, buyer_org_id) WHERE status IN ('proposed','accepted')`. `completed`/`rejected`/`cancelled`는 인덱스 밖이라 "같은 상대에 동시 활성 미팅은 1건, completed 후·거절 후 재신청 가능"이 애플리케이션 코드 없이 인덱스 하나로 자동 성립한다.

7. **알림은 커밋 경계 밖.** 상태 전이(신청/수락/거절/취소)를 먼저 commit하고, 알림 발화는 그 이후 별도 try/except(+실패 시 rollback은 알림 쪽에만)로 격리한다. 근거: notifications 서비스가 내부에서 자체 commit을 하므로, 순서를 뒤집으면(알림 먼저) 알림 실패가 상태 전이까지 함께 롤백시켜 버린다. 이 경계가 만드는 유실 창(상태 전이 commit~알림 발화 사이의 크래시)은 notifications 유니크 키(ADR-0010)의 멱등성과, 후속 스케줄러 백필로 보완 가능하다(백필은 이번 슬라이스 범위 밖).

8. **진입상태·가시성 판정은 기존 모듈에 위임하고 재구현하지 않는다.** 받는 쪽 유형 × 채널로 진입 상태(`accepted`/`proposed`)를 정하는 로직은 `app/matching/acceptance_rule.py`(`resolve_entry_state`)가, 노출 여부는 `app/domain/visibility_rules.py`가 이미 갖고 있다 — 미팅 API는 이 둘을 호출만 한다. `requested_by_org_id`는 별도 컬럼으로 저장하지 않고, 기존 `requested_by` enum(`exhibitor`/`buyer`/`organizer`)에서 파생한다(`organizer`일 때는 신청 주체 Organization이 없으므로 null).

9. **`awaiting_org_id` 컬럼 신설.** `proposed` 상태에서 "지금 응답을 기다리는 쪽"을 명시적으로 저장한다. 자가신청(Open)이면 받는 쪽에서 유도할 수 있지만, 운영자가 만든 미팅(포화배정·Forced)은 신청자·수신자 구도가 없어 유도가 불가능하므로 컬럼으로 직접 든다.

10. **데모 인증은 `get_current_principal` 내부 `AUTH_BACKEND=demo` 분기로 처리하고, 신규 가드를 만들지 않는다.** `subject`가 UUID 형식이면 `members.id`로, 아니면 `registrants.organizer_member_id` 브리지를 거쳐 org를 해석한다. 기존 운영자 가드(`organizer_guard.py`)가 이미 `AUTH_BACKEND=demo`일 때만 데모 스텁을 폴백으로 쓰고 그 외엔 fail-closed인 패턴을 그대로 따른다 — cognito 기본값은 fail-closed를 유지한다.

11. **Meeting Venue 어휘는 DB 어휘(`booth`/`zone_table`/`business_room`, `docs/db/schema.sql` `meeting_venues.venue_type`)로 통일한다.** FE의 `table`/`room` 표기, FE 이벤트설정 화면의 `matching_zone` 표기는 **입력 별칭(alias)** 으로만 흡수하고, API 응답은 항상 캐노니컬 값으로 나간다. 여러 계층이 각자 방언으로 응답을 렌더하다 드리프트 나는 것을 막는다.

12. **경로 = `/api/meetings`.** 레포 컨벤션인 `/api/{도메인}`을 따른다. 기존 리뷰 라우터(`app/api/reviews.py`)가 무접두사 `/meetings/{id}/...`를 쓰는 것은 레거시 아웃라이어로 인지하되, 이 슬라이스에서 함께 고치지 않고 존치한다(별도 정리 필요 시 후속).

## Considered Options

- **슬롯 점유 술어에 `proposed`도 포함(기각).** 스쿼팅(응답 없는 `proposed`가 슬롯을 계속 잠그는 상태)을 막으려면 만료 정책이 필수가 되는데 PRD에 정의가 없다. `accepted`만 점유로 보면 만료 정책 없이도 안전하다.
- **동시성 제어를 EXCLUDE 제약만으로 (기각).** `exhibitor_org_id`·`buyer_org_id` 두 컬럼에 걸친 교차 겹침(이중역할 Organization)을 단일 range EXCLUDE로 표현할 수 없다. advisory lock으로 정확성을, EXCLUDE로 방어선을 이중화하는 쪽을 택했다.
- **거절/취소 사유를 DB CHECK enum으로 강제 (기각).** 취소 사유 어휘는 PRD 어디에도 확정돼 있지 않아, PM 확정 전에 마이그레이션이 필요한 CHECK로 못박으면 잦은 스키마 변경이 생긴다. 애플리케이션 계층(Pydantic Literal)에서만 강제하면 어휘 변경이 코드 한 곳으로 끝난다.
- **KST 하드코딩 유지 (기각).** 베트남 등 해외 행사에서 오차가 나고, 마인즈그라운드의 멀티 행사 재사용 원칙(발주사 프로필)에 위배된다.
- **`slot_minutes`를 `event_schedule_settings`·`events` 양쪽에 유지 (기각).** 읽는 코드가 없는 컬럼을 남겨두면 다음에 누군가 잘못된 쪽을 읽어 드리프트가 재발한다.
- **알림을 상태 전이 이전에 commit (기각).** notifications 서비스의 내부 commit과 순서가 얽혀, 알림 실패가 정상적으로 완료됐어야 할 상태 전이까지 롤백시킨다.
- **진입상태·가시성 로직을 미팅 API 안에서 재구현 (기각).** `acceptance_rule`/`visibility_rules`와 별도 사본을 만들면 두 판정이 갈라질 위험이 생긴다. 단일 인터페이스 재사용을 유지한다.
- **미팅 API 전용 신규 데모 인증 가드 신설 (기각).** `organizer_guard.py`가 이미 `AUTH_BACKEND=demo` 분기 패턴을 검증된 형태로 갖고 있다 — 같은 패턴을 `get_current_principal`에 반복하는 편이 새 가드보다 일관적이다.
- **Venue 응답을 FE 방언(`table`/`room`) 그대로 통과 (기각).** 계층마다 다른 어휘가 API 응답에 그대로 새어나가면 프런트 여러 곳이 각자 매핑을 재구현하게 된다. 캐노니컬 하나로 응답을 고정하고 입력만 별칭을 흡수한다.

## Consequences

- **스키마(파생 — db-schema-keeper 동기화 필요, 이 ADR 범위 밖):** `events.timezone`(신설) · `event_schedule_settings.slot_minutes`(DROP) · `meetings.rejected_reason`/`rejected_detail`/`cancelled_reason`/`cancelled_detail`(분리 컬럼, 신설) · `meetings.awaiting_org_id`(신설) · `(event_id, exhibitor_org_id, buyer_org_id) WHERE status IN ('proposed','accepted')` 부분 unique 인덱스(신설) · `venue_id` 등 단일 컬럼 겹침에 대한 `EXCLUDE`(`btree_gist`, `WHERE status='accepted'`) 제약(신설). 캐노니컬 DDL은 `docs/db/schema.sql`이고 실제 마이그레이션은 Alembic이 진실원천이다(ADR-0008) — 둘 다 db-schema-keeper 서브에이전트가 이 ADR에서 파생해 별도로 동기화해야 한다.
- **`app/matching/slot_booking.py`가 락 프로토콜의 단일 진입점이 된다.** 포화배정·재트리거·Forced 등 미팅을 `accepted`로 만드는 모든 현재·미래 코드 경로는 여기를 거쳐야 하며, 우회 경로를 추가하는 것은 이 ADR의 동시성 불변식 위반이다.
- **`/api/meetings` 신설이 F-MT-001(신청)·F-MY-001(수락/거절/취소·MY-001)·F-OP-003(단일 재트리거)·F-OP-005(전체 포화배정) 구현의 공통 기반이 된다.** 각 PRD의 상태흐름·수락 규칙(D1~D9 등)은 이 ADR이 아니라 여전히 ADR-0005/0006이 정한다 — 이 ADR은 그것을 코드로 옮기는 방법만 정한다.
- **거절 알림 누락(F-MT-001 US13·F-MY-001 D4 vs ADR-0010 6종 불일치)·바이어 불가슬롯 저장소 부재·meeting_venues 어드민 CRUD 부재·리뷰 API 인증 헤더 placeholder·`proposed` 만료 정책 부재·`allow_same_role_discovery=true` 모순은 이 ADR의 결정으로 닫히지 않아 backlog로 이관한다:** `docs/backlog/meeting-domain-pm-decisions.md`(PM 확정 필요 3건) · `docs/backlog/meeting-domain-data-model-gaps.md`(데이터 모델 갭 2건) · `docs/backlog/reviews-api-auth-migration.md`(보안, 우선순위 높음).
- **F-MT-001의 stale한 `noshow` 상태 표기(D2 상태흐름·상태 설명 표)를 5-상태 캐노니컬로 정정**(ADR-0010 보정 반영, 이 작업과 함께 처리).

Status: accepted
