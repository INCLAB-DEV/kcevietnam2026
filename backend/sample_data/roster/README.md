# roster-import 수동 테스트 샘플 (F-OP-002 / #50)

명단 적재 엔드포인트(`POST /organizer/events/{event_id}/members/import`)를 손으로 테스트하기 위한
**합성 데이터**다(실 PII 아님 — 이메일/사업자번호 전부 가짜). `/docs` 업로드 폼이나 아래 curl로 쓴다.

## 파일

| 파일 | 용도 | 기대 결과(빈 이벤트 기준) |
|------|------|------|
| `exhibitors.csv` | 참가기업 8개 정상 스냅샷(방산 시절 컬럼 구성 — `업종` 미매핑, 아래 참고) | `added:8` |
| `exhibitors.xlsx` | 참가기업 8개, K-콘텐츠 택소노미 컬럼 구성(`사업분야`/`카테고리` 신설, xlsx 파싱 확인) | `added:8` (재업로드 시 `unchanged:8`) |
| `buyers.csv` | 바이어 6개(`default_role=buyer`) | `added:6` |
| `exhibitors_updated.csv` | exhibitors.csv 적용 후 일부 정정 + 1건 신규 | `added:1, updated:3, unchanged:5` |
| `edge_cases.csv` | 회원ID·기업명 결측, 중복 ID, 이메일 결측 | `added:2, skipped:2` |

헤더 별칭: `회원ID`(주키), `기업명`(org), `담당자`/`이메일`/`연락처`/`사업자등록번호`, `구분`(역할),
`업종`(매핑 안 됨 → raw로만 보존). 영문 헤더(id/name/email/role …)도 동일하게 인식된다.

⚠ `exhibitors.csv`/`exhibitors_updated.csv`/`edge_cases.csv`는 다른 REQ가 쓰는 회귀 픽스처라 이번
K-콘텐츠 택소노미 전환(REQ-04)에서 손대지 않았다 — 여전히 방산 시절 자유텍스트 `업종` 컬럼을 쓰고
`exhibitors.xlsx`와 내용이 다르다(이전엔 두 파일이 동일 내용이었음). `exhibitors.xlsx`만 실제 배포
템플릿 형태로 갱신됨: `업종` 대신 `사업분야`(business_field, 8종 — 쉼표구분 다중 라벨/코드 모두 인식,
`app.roster.parser.normalize_business_field`) 컬럼과 신설 `카테고리`(content_category, 3종 단일 —
`normalize_content_category`) 컬럼을 쓴다. 두 컬럼 모두 라벨 원문 그대로 셀에 적어도 파서가 정규
코드로 변환한다(값 목록은 `app.models.BUSINESS_FIELDS`/`CONTENT_CATEGORIES`).

## 빠른 시작

```bash
BASE=http://127.0.0.1:3050
# 1) 테스트 이벤트 ID 확보(slug=dx-korea-2026-test 시드돼 있으면 그 id 사용)
EVENT_ID=<your-event-uuid>
URL="$BASE/organizer/events/$EVENT_ID/members/import"

# 2) 참가기업 적용
curl -s -X POST "$URL" -F "file=@exhibitors.csv;type=text/csv" -F "default_role=exhibitor"

# 3) 바이어 적용
curl -s -X POST "$URL" -F "file=@buyers.csv;type=text/csv" -F "default_role=buyer"

# 4) 정정 스냅샷 미리보기(적용 X) — changes에 컬럼별 old→new
curl -s -X POST "$URL" -F "file=@exhibitors_updated.csv;type=text/csv" \
     -F "default_role=exhibitor" -F "dry_run=true" | python3 -m json.tool

# 5) 확인 후 실제 적용
curl -s -X POST "$URL" -F "file=@exhibitors_updated.csv;type=text/csv" -F "default_role=exhibitor"

# 6) 멱등 확인 — 같은 파일 재업로드는 전부 unchanged
curl -s -X POST "$URL" -F "file=@exhibitors.csv;type=text/csv" -F "default_role=exhibitor"
```

## 에러 케이스(4xx 확인)

```bash
# 비-UUID event_id → 400
curl -s -o /dev/null -w "%{http_code}\n" -X POST "$BASE/organizer/events/not-a-uuid/members/import" \
     -F "file=@exhibitors.csv"
# 잘못된 default_role → 400
curl -s -o /dev/null -w "%{http_code}\n" -X POST "$URL" -F "file=@exhibitors.csv" -F "default_role=구매담당"
# 기업명 컬럼 없는 파일 → 400 (회원ID만 있는 CSV로 시도)
```
