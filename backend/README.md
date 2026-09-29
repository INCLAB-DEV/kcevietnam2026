# NABI Backend (FastAPI)

FastAPI가 모든 DB 접근·컴퓨트·AI·시크릿을 소유한다(ADR-0008 경계 B). Next.js는 이 API만 호출한다.
도메인 정의는 루트 `CONTEXT.md` + `backend/CONTEXT.md`, 스키마 진실원천은 이 디렉토리의 Alembic 마이그레이션.

## 스택
- FastAPI · SQLAlchemy 2.0 · Alembic · PostgreSQL(psycopg v3)
- 패키지/런타임: `uv` (파이썬 버전은 uv managed, `requires-python >=3.12`)

## 개발 셋업
> ⚠️ **Docker 잠정 미사용(2026-08 결정)**: 이 머신에 Docker가 설치돼 있지 않아, 로컬 Postgres는 당분간
> Homebrew 네이티브 설치로 돌린다. `docker-compose.yml`/`Dockerfile`은 지우지 않고 그대로 둔다 —
> 추후 Docker를 다시 붙일 계획이라 설정을 보존한다(재도입 시 아래 `brew` 줄만 `docker compose up -d db`로
> 되돌리면 됨, `.env`의 `DATABASE_URL`은 포트/계정이 동일해 안 바뀜).
```bash
cd backend
uv sync                                  # 의존성 설치 (+ uv가 파이썬 3.12 확보)
brew install postgresql@17               # 로컬 Postgres(최초 1회) — Docker 재도입 전까지 이 방식
brew services start postgresql@17        # 포트 5432
createuser -d nabi && createdb -O nabi nabi   # 최초 1회: nabi 롤(CREATEDB)/DB 생성 — tests/conftest.py가
                                               # 테스트 DB(nabi_consent_test)를 만들었다 지우는 구조라 CREATEDB 필요.
                                               # 로컬 접속은 pg_hba.conf 기본이 trust라 비번 불문 통과(운영 아님, 로컬 전용)
cp .env.example .env                     # DATABASE_URL 확인
uv run alembic upgrade head              # 스키마 적용
uv run uvicorn app.main:app --reload
```

## 마이그레이션
스키마 변경의 단일 권한은 Alembic(Python만 DDL). `docs/db/schema.sql`은 여기서 파생되는 ERD 산출물이다.
```bash
uv run alembic revision --autogenerate -m "설명"   # 모델 변경 후 생성
uv run alembic upgrade head                          # 적용
uv run alembic downgrade -1                          # 롤백
```
모델은 `app/models.py`(= schema.sql의 1:1 표현). 모델을 고치고 autogenerate → 검토 후 커밋.
`fit score`(적합도) 정의 미확정 → 점수 의존 컬럼(meetings.ai_score 등)은 nullable로 깔되 채우지 않는다.

## 도메인 엔드포인트
### 명단 적재 — OP-002 / F-OP-002 (#50)
`POST /organizer/events/{event_id}/members/import` (multipart)
- `file`: 주관사 전체 신청자 스냅샷(CSV/엑셀). `default_role`(form, 선택): `exhibitor|buyer` — 행에 구분 컬럼이 없을 때 파일 출처로 role 유추. `dry_run`(form, 선택): `true`면 적용 없이 미리보기.
- 동작: 원본 S3 보관 → 회원ID 키 `(event_id, organizer_member_id)`로 멱등 upsert + eager 생성(org/member/role) + 원본 전체 raw 보존(ADR-0007/0009).
- 응답: `{added, updated, unchanged, skipped, changes}`. 같은 파일 반복 업로드는 무변경으로 집계(멱등). `changes`=갱신 건의 컬럼별 `{old,new}` diff.
- **적용 전 미리보기:** `dry_run=true`로 올리면 같은 적재 로직을 savepoint에서 돌려 `changes`만 모으고 롤백(아무것도 영속 안 됨, S3 보관 안 함). 운영자가 모달로 검토 후 `dry_run=false`로 재호출하면 실제 적용한다.
- 코어 모듈: `app/roster/`(parser=파일→레코드, import_service=멱등 적재), 보관 포트 `app/storage.py`.

> 테스트: `tests/test_roster_*` — 파서는 순수 단위, 적재/엔드포인트는 postgres 통합(미가용 시 graceful skip).
> 권한검사는 #47 인증 가드 `require_event_master`(`app/auth/organizer_guard.py`)가 의존성으로 붙는다 —
> 이 행사의 운영자 master만 통과(비-master 403·무인증 401, ADR-0012). 단일 권한검사 지점(경계 B).

### 참가자 미팅 — F-MT-001
`/api/meetings` (전 라우트 `get_current_principal`). 권한의 닻은 **소속 org** 하나 — 내 org가 낀
미팅만 보이고 바꿀 수 있다.

| Method / Path | 설명 |
|---|---|
| `GET /api/meetings` | 내 미팅 목록. `event_id`(생략 시 참가 행사가 하나면 자동 해석) · `status`(반복) · `limit`/`offset` |
| `GET /api/meetings/availability` | 상대와의 가용 슬롯·장소·신청사유 초안. `counterpart_org_id` 필수, `slot_ids`(반복) 주면 장소 가용을 그 시간 기준으로 |
| `GET /api/meetings/{id}` | 단건(참가 당사자만) |
| `POST /api/meetings` | 신청 → 201. 수신측 유형에 따라 즉시 확정(accepted)/수락대기(proposed) |
| `POST /api/meetings/{id}/accept` | 수락(응답 대기 당사자만) |
| `POST /api/meetings/{id}/reject` | 거절(응답 대기 당사자만) |
| `POST /api/meetings/{id}/cancel` | 취소. 수락대기면 신청측만, 확정이면 양측 누구나 |
| `PUT /api/meetings/{id}/participants` | 내 org 참석자 명단 치환 |

**에러 바디는 이 라우터만 코드를 싣는다**: `{"detail": {"code": "SLOT_TAKEN", "message": "..."}}`.
화면이 실패 종류마다 다르게 처리해야 해서(시간 다시 고르기 / 승인 안내 / 기존 미팅으로 이동) 기계가
읽는 `code`를 함께 준다. `ACTIVE_MEETING_EXISTS`는 `existing_meeting_id`를 덧붙인다.

핵심 규칙:
- **슬롯 점유는 `accepted`만.** 같은 시간에 proposed가 여럿 공존하고 **첫 수락이 이긴다** — 수락 시점에
  락을 다시 잡고 재검증하며, 진 쪽은 409(`SLOT_TAKEN`)로 튕기되 **proposed로 남는다**(시간 바꿔 재시도 가능).
- **D9** — 같은 행사의 같은 두 기업 사이에 살아있는 미팅은 하나. 역할이 뒤집힌 역쌍도 같은 쌍으로 본다.
- **거절 ≠ 취소** — 수신측은 reject(사유 어휘가 다르고 감사 컬럼도 다르다), 신청측은 cancel.
- 동시성(락·겹침 술어)은 `app/matching/slot_booking.py`에 **단일 봉인**돼 있다. 가용성 계산과 쓰기 가드가
  같은 함수를 쓰게 하려는 의도 — 갈라지면 "화면엔 비었는데 누르면 409"가 된다. 미래의 포화배정/forced
  경로도 반드시 이 모듈을 통과해야 한다.
- 슬롯 id 형식 `"YYYY-MM-DDTHH:MM"`은 `exhibitor_profiles.unavailable_meeting_slots`·프런트 `TimeSlot.id`와
  공유하는 계약이다 — **변경 금지**(`app/matching/slot_grid.py`).
- 슬롯 길이 진실원천은 **`events.slot_minutes` 하나**(마이그레이션 `mt001meet01`에서 `event_schedule_settings`
  쪽 중복 컬럼 제거). 운영시간·점심은 `event_schedule_settings`.

> 코어 모듈: `app/meetings/`(router·service·schemas) + `app/matching/`(`meeting_state`=전이표,
> `slot_grid`=그리드/타임존, `slot_booking`=락·겹침). 시간 경과 → `completed` 전이와 리뷰 안내는
> `app/notifications/scheduler.py`의 `run_completion_tick`(lifespan 순서: reminder → completion).
> 테스트: `tests/test_meetings_*`, `tests/test_meeting_state.py`, `tests/test_slot_grid.py`.

### 기업 탐색 · 내 컨텍스트 — `/api/discover`, `/api/me`

| Method / Path | 설명 |
|---|---|
| `GET /api/discover/organizations` | 열람 가능한 참가기업 카드 목록. `event_id`(참가 행사가 하나면 생략) · `locale` |
| `GET /api/discover/organizations/{org_id}` | 카드 단건. 자기 기업은 가시성 검사 없이 열린다 |
| `GET /api/me` | 내 기업·참가 역할·승인 상태 + **뷰어 본인의 신원** |

**`locale=ko|en`(기본 ko)은 응답 키를 바꾸지 않는다 — 값만 고른다.** en이면 `name`←`name_en`,
`description`←참가사 `intro_en`, `keywords`←`keywords.label_en`, `exhibits`←제품 `name_en`이고,
영문이 없으면 국문으로 폴백한다. 모르는 로케일 값은 `422`가 아니라 조용히 `ko`로 접는다(표시
선택지의 오타로 화면이 통째로 죽지 않게). 카드 정렬은 로케일과 무관하게 국문명 기준이다 — 언어를
바꿀 때마다 순서가 재배열되면 "3번째 카드"라는 사용자의 기억이 깨진다.

> 응답 필드는 **화이트리스트**다(`app/discover/schemas.py`). 남의 기업 카드에 연락처·매출구간·
> 비공개 노트가 새지 않는지 `tests/test_discover_api.py`가 마커 값으로 회귀 검사한다 —
> **필드를 더할 때는 "부스에 붙여둬도 되는 정보인가"를 먼저 물어라.** `/api/me`의 `member_*`는
> 예외가 아니라 별개다: 그건 남이 아니라 **뷰어 자신의** 이름·이메일·연락처·직함이다.

`/api/me`의 신원은 주체 키 두 갈래를 모두 푼다 — UUID면 `members` 행에서, 데모 subject
(`mbr-buyer-01` 등)면 `registrants.organizer_member_id`로 명단 행을 찾고 그걸 가리키는 `members`가
있으면 그쪽을(없으면 명단의 신고값으로) 쓴다. 못 찾으면 전부 `null`이고 역할 응답은 그대로 나온다.

## 데모 로그인 계정 (dev/test 전용)
모든 비밀번호는 `demo1234`. 자격증명은 `app/auth/login_router.py`의 `_DEMO_CREDENTIALS`(목업 — 실 DX
Korea·Cognito 배선으로 교체될 자리). `POST /api/auth/login/start`로 검증한다.

| username | 역할 | 결과 |
|---|---|---|
| `buyer` | 바이어(최초) | `consent_required` → 약관 후 세션 |
| `buyer-old` | 바이어(재방문, 프로필 완료) | `succeeded` → `/` |
| `buyer-wip` | 바이어(재방문, 프로필 미완) | `succeeded` → 프로필 작성 |
| `exhibitor` | 참가사(최초) | `consent_required` |
| `organizer` | **운영사 master(주최사)** | `succeeded` → `/organizer` |
| `trade-office` | **운영사 sub(무역관)** | `succeeded` → `/organizer` (단, master 전용 API는 403) |
| `ghost` | 검증 통과·명단 없음 | `not_found` |

운영자 권한등급(master/sub)은 **계정×행사 단위**(ADR-0012)라 로그인이 아니라 **API 가드**가 가른다.
가드를 데모로 켜려면 `AUTH_BACKEND=demo`로 실행한다(기본 `cognito`는 fail-closed — 실 어댑터 미구현 시 거부).
데모 행사는 `organizer_guard.DEMO_EVENT_ID`(`…0000de`)이며, 그 행사에서 `organizer`=master·`trade-office`=sub.
예) `POST /organizer/events/{DEMO_EVENT_ID}/members/import` 에 `Authorization: Bearer access-mbr-org-01-1`
→ 통과 / `access-mbr-trade-01-1` → 403.

### 데모 데이터 시드 (멱등 CLI)
위 데모 계정이 **실제로 미팅을 신청할 수 있으려면** 행사·기업·명단·부스·장소가 DB에 있어야 한다.
그걸 까는 게 `app/demo_seed.py`다.

```bash
uv run python -m app.demo_seed            # DATABASE_URL 대상에 시드
uv run python -m app.demo_seed --dry-run  # 커밋 없이 확인만
```

여러 번 돌려도 같은 상태로 수렴한다(자연키 기반 get-or-create) — 데모 중 데이터가 꼬이면 그냥 다시
돌리면 된다. 까는 것: 데모 행사(`DEMO_EVENT_ID`, `Asia/Seoul`, 30분 슬롯, 운영 09:00~18:00 · 점심
12:00~13:00) + `_DEMO_CREDENTIALS`의 회원ID와 **1:1로 맞는** 기업/담당자/명단/역할(전부 `approved`) +
참가사 부스(`7홀 A-12`) 및 불가 슬롯 일부 + 비즈매칭존 테이블 4 · 비즈니스룸 2.

바이어는 수락 규칙(ADR-0005) 두 경로를 다 시연할 수 있게 나눠 깔린다 — `mbr-buyer-01`은 **hosted**
(신청하면 즉시 확정), `mbr-buyer-02`/`03`은 **pre_registered**(수락대기).

> ⚠ `DEMO_SEED` **환경변수와는 다른 것**이다. 그 플래그는 리뷰 API가 인메모리 목업 리포지토리를 쓸지
> 고르는 스위치(`app/api/deps.py`)라 DB에 아무것도 쓰지 않는다. DB 시드는 명시적으로 이 CLI를 실행한다.

## 자체 회원가입 (개발계획서 §7.3, ADR-0007 부분 supersede)
`POST /api/auth/signup` — **참가사(exhibitor)/바이어(buyer)만** 만들 수 있다(`role`이 이 두 값만
받는 Literal이라 organizer/admin 계열은 pydantic 레벨에서 422). body: `email`(유일)·`password`(최소
8자·영문+숫자)·`name`·`phone`(선택)·`org_name_ko`·`org_name_en`(선택)·`role`·`event_id`(선택 — 없으면
진행 중인 최신 행사). 성공 시 `201 {"outcome": "created"}`(내부 식별자 미노출), 이메일 중복은 `409`.
로그인은 기존 `POST /api/auth/login/start`를 그대로 쓴다 — `LocalCredentialVerifier`가 데모 스텁보다
먼저 시도되고(email+bcrypt 대조), AUTH_BACKEND 무관하게 항상 켜져 있다(데모 스텁만 `demo`에 한정, 로컬
검증은 실 경로라 fail-closed 대상이 아님). 코어: `app/auth/signup_*.py`, `app/auth/local_verify.py`.

## 슈퍼어드민 부여(운영 절차, DB 직접)
**슈퍼어드민(event master)은 어떤 API로도 생성되지 않는다** — 항상 DB에서 직접 부여한다(발주자 지시).
자체 회원가입(§7.3)도, 서브어드민 부여 API(`POST .../organizers`)도 `permission_level`에 `"master"`를
보내면 422로 거부한다(`app.admin.schemas.OrganizerGrantIn`).

### 1) 최초 부트스트랩(첫 행사 + 첫 마스터)
`POST /api/admin/events`는 "어디선가 이미 master인 운영자"만 호출할 수 있다
(`require_existing_master_identity`) — 아무 운영자나 행사를 만들어 스스로 master가 되는 구멍을
막았다. 그래서 **가장 처음의 행사와 가장 처음의 master는 API가 아니라 DB에 직접 INSERT**한다:

```sql
-- 1. 첫 행사
INSERT INTO events (id, name, slug)
VALUES (gen_random_uuid(), '행사명', 'event-slug')
ON CONFLICT (slug) DO NOTHING;

-- 2. 운영자(NABI 내부 계정) — member_id는 그 사람이 로그인할 때 인증이 돌려주는 회원ID(Cognito sub 등).
INSERT INTO organizers (id, name, email, member_id)
VALUES (gen_random_uuid(), '운영자 이름', 'operator@example.com', 'mbr-REPLACE-ME')
ON CONFLICT (member_id) DO NOTHING;

-- 3. 그 운영자를 방금 만든 행사의 master로 배정
INSERT INTO event_organizers (id, event_id, organizer_id, permission_level)
SELECT gen_random_uuid(), e.id, o.id, 'master'
FROM events e, organizers o
WHERE e.slug = 'event-slug' AND o.member_id = 'mbr-REPLACE-ME'
ON CONFLICT (event_id, organizer_id) DO UPDATE SET permission_level = 'master';
```

이후 그 계정은 `POST /api/admin/events`로 새 행사를 만들 때마다 자동으로 그 행사의 master로도
배정된다(이미 master인 사람의 자기증식은 API로 허용 — DB 개입은 최초 1회만).

### 2) 기존 행사에 마스터 추가(예: 공동 주최사 계정)
```sql
INSERT INTO event_organizers (id, event_id, organizer_id, permission_level)
SELECT gen_random_uuid(), e.id, o.id, 'master'
FROM events e, organizers o
WHERE e.id = '<event_id>' AND o.member_id = '<추가할 member_id>'
ON CONFLICT (event_id, organizer_id) DO UPDATE SET permission_level = 'master';
```

### 3) 서브어드민(무역관 등)은 API로 — master 로그인 후
- 부여: `POST /api/admin/events/{event_id}/organizers` `{"member_id": "...", "permission_level": "sub"}`
- 회수: `DELETE /api/admin/events/{event_id}/organizers/{organizer_id}` — **sub만 회수 가능.**
  master 배정은 이 API로 절대 회수되지 않는다(403 — 마지막 슈퍼어드민을 지워 콘솔이 잠기는 사고
  방지). master를 내리거나 옮기려면 DB에서 직접 `UPDATE`/`DELETE`한다.
- 목록: `GET /api/admin/events/{event_id}/organizers`
- 참가 기업 역할 전환: `PATCH /api/admin/events/{event_id}/organizations/{organization_id}/role`
  `{"role": "buyer"|"exhibitor"}` — 이미 미팅이 있는 기업은 `409`(먼저 미팅을 정리해야 한다).

### 4) 미팅 장소(venue) 프로비저닝 — 읽기는 sub도, 쓰기는 master 전용

| 라우트 | 설명 |
| --- | --- |
| `GET /api/admin/events/{event_id}/venues` | 목록(**zone_table·business_room만**). 라벨 순 = 실제 배정 순서. `meeting_count`로 삭제 가능 여부를 미리 알 수 있다 |
| `POST /api/admin/events/{event_id}/venues` | `{"venue_type": "zone_table"\|"business_room", "label": "T-01"}` → 201 |
| `PATCH /api/admin/events/{event_id}/venues/{venue_id}` | 라벨 변경(종류는 불변) |
| `DELETE /api/admin/events/{event_id}/venues/{venue_id}` | 204 |

**부스(`booth`) 장소는 이 CRUD의 대상이 아니다.** 참가사 부스는 미팅 신청 시점에 `(행사, 'booth',
"7홀 A-12")` 자연키로 자동 생성되는 파생물이라(`app/meetings/service.py`), 콘솔이 만들거나 이름을
바꾸면 다음 신청이 같은 라벨로 또 만들어 장소가 둘로 갈라진다. 목록에서 제외하고, booth id로 들어온
`PATCH`/`DELETE`는 `422 VENUE_NOT_MANAGEABLE`로 거부한다(404가 아니다 — 그 장소는 실재한다).

에러 바디는 `{"code", "message"}` 규약이다(라벨 충돌과 사용 중 삭제가 둘 다 409라 코드로 갈린다):

- `409 VENUE_LABEL_TAKEN` — 같은 (행사, 종류)에 그 라벨이 이미 있다
- `409 VENUE_IN_USE` — 참조 미팅이 있다. `meeting_count`에 건수가 실린다. `meetings.venue_id`는
  `ondelete` 없는 FK라 선검사 없이 지우면 DB가 막아 500이 된다 — 미팅을 먼저 정리해야 한다
