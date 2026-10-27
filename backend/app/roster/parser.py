"""스냅샷 파일(CSV/엑셀) → 정규 레코드 파싱. 적재 로직(import_service)과 분리한 순수 모듈.

원본 컬럼 구조는 미확정(선행 블로커, ADR-0009 D4)이라 **모든 컬럼을 raw로 통째 보존**하고,
알려진 필드만 헤더 별칭으로 해석한다. 별칭은 FE(lib/organizer/roster-import.ts)와 의도적으로 맞춘다.

사업분야(business_field)·카테고리(content_category)는 K-콘텐츠 택소노미(kct001tax01) 코드로
정규화해 RosterRecord에 싣는다 — 라벨/코드 어느 쪽 셀 값이든 인식한다. 카테고리는 적재 시
참가사의 빈 exhibitor_profiles.content_category에 보강한다(상충 값은 경고, 기존 프로필 보존).
사업분야 구조화 반영은 BM 프로필 플로우 소관이며 원본은 raw JSONB에 계속 보존된다.

명단 업로드는 두 콘솔(/admin/organizations·/organizer/members)이 **같은 다이얼로그·같은 API**로 쓴다.
다운로드 템플릿(frontend lib/roster/template.ts)은 회원가입 필드에 맞춘 영문 키(name_ko·name_en·
contact_name·contact_email·contact_phone …)를 쓰고, 옛 헤더(name·tab·담당자·이메일 …)도 계속 받는다.
행 번호(스프레드시트 기준, 헤더=1행)는 행별 결과 보고용으로 함께 넘긴다(to_records_detailed).
**비밀번호 컬럼이 든 파일은 거부한다** — 원본이 S3·raw JSONB에 그대로 보존되므로 평문 비밀번호가
영속되는 것을 파싱 단계에서 막는다(공통 비밀번호는 파일이 아니라 별도 입력란으로만 받는다).
"""

from __future__ import annotations

import csv
import io
from dataclasses import dataclass, field

from openpyxl import load_workbook

from app.models import BUSINESS_FIELDS, CONTENT_CATEGORIES

# 헤더 별칭 — 주관사 컬럼명이 영문/한글 어느 쪽이어도 매핑(구조 미확정, ADR-0009 D4).
# 키는 registrants 컬럼. `name`=담당자(사람), `org_name`=기업명 — 혼동 주의(FE의 MemberRow.name=기업명).
HEADER_ALIASES: dict[str, list[str]] = {
    # "아이디" = 고객사 양식(2026 K-콘텐츠 엑스포) 헤더. 그 열이 전부 빈칸이거나 열 자체가 없으면
    # to_records_detailed가 로그인 이메일로 멱등 키를 자동 채운다(아래 결정 2, 2026-10-01).
    "organizer_member_id": ["id", "회원id", "회원아이디", "memberid", "organizer_member_id", "신청id", "아이디"],
    # name_ko = 명단 템플릿·회원가입(org_name_ko) 키. 이 별칭이 없어서 /admin/organizations 템플릿으로
    # 채운 파일이 "기업명 컬럼을 찾을 수 없습니다"(400)로 전부 거부되던 결함(2026-09-16) 수정.
    # 사업자명 = 고객사 양식 헤더(기업명과 동의어).
    "org_name": ["name", "name_ko", "org_name_ko", "기업명", "기업명(국문)", "회사명", "기관명", "업체명", "org_name", "사업자명"],
    # 영문 기업명 — organizations.name_en. 새 기업은 그대로, 기존 기업은 비어 있을 때만 보강한다.
    "org_name_en": ["name_en", "org_name_en", "기업명(영문)", "영문기업명", "업체명(영문)", "사업자명(영문)"],
    # 계정(로그인) 한 사람 단위 = **전시회 담당자**(2026-10-01 결정 변경, 신청자 아님). 같은 파일에
    # 대표·대표이사·세금계산서 담당자 이메일도 있어 혼동 위험이 크다 — "전시회 담당자 OO"만 exact match로
    # 잡는다. "전시회 담당자 전화"는 사무실 전화라 여기 안 넣는다(raw에만, 휴대폰만 계정 연락처로 씀).
    "name": ["담당자", "담당자명", "성명", "이름", "contact_name", "primary_contact", "참가자성명", "전시회 담당자 성명"],
    "contact_email": ["email", "이메일", "메일", "contact_email", "e-mail", "전시회 담당자 이메일"],
    "contact_phone": ["phone", "연락처", "전화", "전화번호", "contact_phone", "휴대폰", "mobile", "전시회 담당자 휴대폰"],
    # 아래 세 키는 RosterRecord 필드가 아니라 **행 단위 폴백 전용** 힌트(고객사 양식 전용 리터럴 헤더).
    # 그 행의 "전시회 담당자 이메일"이 비어 있으면 이 행만 신청자 단위 전체(성명·이메일·연락처)로 계정을
    # 만든다(to_records_detailed 참고) — 담당자 이름 + 신청자 이메일처럼 사람을 섞지 않는다.
    "applicant_email_hint": ["신청자 이메일"],
    "applicant_name_hint": ["신청자 성명"],
    "applicant_phone_hint": ["신청자 연락처"],
    "business_number": ["사업자번호", "사업자등록번호", "business_number", "business_reg_no"],
    "role_hint": ["tab", "구분", "role", "역할"],
    # 국가 — organizations에 착지 컬럼이 없다(국가는 buyer_profiles.country, 신청서 소관). 명단 적재가
    # 신청서(프로필) 행을 새로 만들면 로그인 게이트(has_profile)가 바뀌므로 구조화하지 않고 raw로만 보존.
    "country": ["country", "국가"],
    # 사업분야(business_field, 8종·멀티) — K-콘텐츠 택소노미(kct001tax01). registrants에는 착지
    # 컬럼이 없어(exhibitor_products.business_field만 CHECK 보유) 파싱값은 RosterRecord에만 싣고
    # raw로도 보존한다 — 구조화 착지는 BM 프로필 플로우(SmartFill 등) 소관, 이 REQ 범위 밖.
    # category = 옛 /admin/organizations 템플릿 헤더(예시값 "콘텐츠 제작" = 사업분야 라벨)라 여기로 받는다.
    # 중분류 = 고객사 양식 헤더(사업분야와 동의어, 예시값 "게임 제작" 등 8종).
    "business_field": ["사업분야", "business_field", "category", "관심분야", "관심품목", "중분류"],
    # 카테고리(content_category, 3종·단일·셀러 전용) — kct001tax01 신설. 마찬가지로 registrants
    # 착지 컬럼 없음(exhibitor_profiles.content_category만 CHECK 보유).
    # 대분류 = 고객사 양식 헤더(카테고리와 동의어, 예시값 "방송" 등 3종).
    "content_category": ["카테고리", "content_category", "대분류"],
    # 직위 — members.title. 명시적 "직위"류 헤더(신청자 직위·직위 등 범용 템플릿)가 있으면 그 값이 항상
    # 우선. 고객사 양식은 이 열이 없고 "전시회 담당자 직위"만 있는데, 계정 주인이 곧 그 담당자이므로
    # 이제는 조건 없이 쓴다 — 단, 그 행이 신청자 폴백(담당자 이메일 결측)이면 다른 사람 직위이므로
    # 쓰지 않는다(to_records_detailed의 staff_title_hint 처리 참고, 사람 섞임 방지).
    "title": ["신청자 직위", "직위", "title", "직책"],
    "staff_title_hint": ["전시회 담당자 직위"],
    # application_status는 파일에서 읽지 않는다 — roster 적재는 항상 server default 'registered'고,
    # 'submitted'는 프로필 완료로만 얻는다(ADR-0009 D6). 파일 컬럼으로 매칭 게이트를 못 열게 의도적으로 미매핑.
}

# role 출처유추(ADR-0009 D5) — 명시 컬럼 값 정규화. 모호하면 None(파일 출처 default로 폴백).
_EXHIBITOR_SYNONYMS = {"exhibitor", "참가기업", "참가사", "전시", "전시기업"}
_BUYER_SYNONYMS = {"buyer", "바이어", "참관객", "구매자"}
_BOTH_SYNONYMS = {"both", "참가기업/바이어", "둘다"}

# registrants.role_hint CHECK와 일치하는 정규 role 값(default_role 검증용).
VALID_ROLES = {"exhibitor", "buyer", "both"}

# 사업분야 8종 한글 라벨 — app.models.BUSINESS_FIELDS와 순서 1:1(kct001tax01 마이그레이션과 동일값).
# 라벨→코드 정규화용(셀 값이 라벨/코드 어느 쪽이어도 인식). 코드 자체 목록의 캐노니컬 소스는 app.models.
_BUSINESS_FIELD_LABELS_KO = (
    "게임 제작", "애니메이션 유통 및 배급", "콘텐츠 제작", "음악 플랫폼",
    "신기술융합콘텐츠", "캐릭터 라이센서", "만화웹툰 제작", "음악 제작",
)
# 캐노니컬 라벨은 "만화,웹툰/게임/음악"(쉼표·공백 없음, 2026-09-17 발주사 라벨 변경). 구 라벨(가운뎃점,
# 쉼표+공백)은 업로드 호환을 위해 별칭으로 계속 받는다 — 예전 명단 파일이 여전히 구 라벨을 쓸 수 있다.
_CONTENT_CATEGORY_LABELS_KO = ("애니메이션/캐릭터", "방송", "만화,웹툰/게임/음악")
_BUSINESS_FIELD_BY_LABEL = dict(zip(_BUSINESS_FIELD_LABELS_KO, BUSINESS_FIELDS))
_CONTENT_CATEGORY_BY_LABEL = dict(zip(_CONTENT_CATEGORY_LABELS_KO, CONTENT_CATEGORIES))
_CONTENT_CATEGORY_BY_LABEL["만화·웹툰/게임/음악"] = "comics_game_music"  # 구 라벨(가운뎃점)
_CONTENT_CATEGORY_BY_LABEL["만화, 웹툰/게임/음악"] = "comics_game_music"  # 구 라벨(쉼표+공백)
_CONTENT_CATEGORY_BY_LABEL["만화웹툰, 게임, 음악"] = "comics_game_music"  # 고객사 양식 라벨(2026-10-01, 슬래시 없음)
# 고객사 양식은 "신기술융합컨텐츠"(컨텐츠 철자)를 쓴다 — 캐노니컬 라벨 "신기술융합콘텐츠"와 같은 코드로 받는다.
_BUSINESS_FIELD_BY_LABEL["신기술융합컨텐츠"] = _BUSINESS_FIELD_BY_LABEL["신기술융합콘텐츠"]


def normalize_business_field(value: str | None) -> str | None:
    """사업분야 셀(쉼표구분 라벨|코드 다중, 8종) → 콤마조인 정규 코드 문자열.

    매칭 안 되는 토큰은 조용히 버린다(정규 코드값만 보장 — CHECK 통과 전제, #REQ-04).
    """
    if not value:
        return None
    codes: list[str] = []
    for token in value.split(","):
        t = token.strip()
        if not t:
            continue
        code = _BUSINESS_FIELD_BY_LABEL.get(t) or (t if t in BUSINESS_FIELDS else None)
        if code and code not in codes:
            codes.append(code)
    return ",".join(codes) if codes else None


def normalize_content_category(value: str | None) -> str | None:
    """카테고리 셀(단일 라벨|코드, 3종) → 정규 코드. 매칭 안 되면 None(셀러 전용 — 바이어 행은 보통 빈 셀)."""
    if not value:
        return None
    t = value.strip()
    return _CONTENT_CATEGORY_BY_LABEL.get(t) or (t if t in CONTENT_CATEGORIES else None)


class RosterParseError(ValueError):
    """파일을 행으로 풀 수 없거나 회원ID 컬럼이 없는 등 적재 불가 상태."""


class RosterPasswordColumnError(RosterParseError):
    """파일에 비밀번호 컬럼이 있다 — 원본 보존(S3·raw)으로 평문이 영속되므로 적재 전에 거부한다."""

    code = "ROSTER_PASSWORD_COLUMN"


# 비밀번호로 보이는 헤더 — 공백·밑줄·하이픈을 지운 소문자 헤더에 이 조각이 들어 있거나(부분일치),
# 짧은 약어와 정확히 같으면(완전일치) 비밀번호 컬럼으로 본다.
_PASSWORD_HEADER_FRAGMENTS = ("password", "passwd", "비밀번호", "패스워드")
_PASSWORD_HEADER_EXACT = {"pw", "pwd", "비번", "암호"}


def _is_password_header(header: str) -> bool:
    key = header.strip().lower()
    for ch in (" ", "_", "-"):
        key = key.replace(ch, "")
    return key in _PASSWORD_HEADER_EXACT or any(frag in key for frag in _PASSWORD_HEADER_FRAGMENTS)


@dataclass
class RosterRecord:
    """스냅샷 한 줄에서 추출한 명단 레벨 레코드. raw에 원본 전체 컬럼을 보존한다."""

    organizer_member_id: str
    org_name: str
    name: str | None = None
    contact_email: str | None = None
    contact_phone: str | None = None
    business_number: str | None = None
    role_hint: str | None = None  # 'exhibitor' | 'buyer' | 'both' | None
    business_field: str | None = None  # 정규 코드 콤마조인(8종 중 다중) — 착지 컬럼 없음(파싱 전용, #REQ-04)
    content_category: str | None = None  # 정규 코드 단일(3종), 빈 참가사 프로필 보강용
    raw: dict[str, str] = field(default_factory=dict)
    category_invalid: bool = False
    org_name_en: str | None = None  # organizations.name_en(새 기업은 그대로, 기존 기업은 빈 값만 보강)
    country: str | None = None  # 착지 컬럼 없음 — raw로만 보존(HEADER_ALIASES 주석 참고)
    title: str | None = None  # members.title(비어 있을 때만 보강, org_name_en과 같은 규칙 — import_service 참고)
    # 'staff'=전시회 담당자 단위(기본) | 'applicant'=담당자 이메일 결측으로 신청자 단위 전체 폴백(2026-10-01).
    # 폴백 행은 import_service가 행별 결과에 경고로 노출한다 — 운영자가 알아볼 수 있게.
    contact_source: str = "staff"
    row_number: int | None = None  # 스프레드시트 행 번호(헤더=1행) — 행별 결과 보고용, 직접 만든 레코드는 None


@dataclass(frozen=True)
class RowIssue:
    """적재 전에 걸러진 행(회원ID·기업명 결측 등) — 행별 결과 보고에 사유 코드로 실린다."""

    row_number: int | None
    # 'missing_member_id' = 아이디·이메일이 모두 없어 멱등 키를 만들 수 없음(아이디만 없으면 이메일로
    # 자동 채워 여기 걸리지 않는다, 2026-10-01 결정) | 'missing_org_name'
    reason: str
    organizer_member_id: str | None = None
    org_name: str | None = None
    contact_email: str | None = None


def normalize_role(value: str | None) -> str | None:
    """구분/역할 셀 → registrants.role_hint 정규값. 모호하면 None."""
    if not value:
        return None
    s = value.strip().lower()
    if s in _EXHIBITOR_SYNONYMS:
        return "exhibitor"
    if s in _BUYER_SYNONYMS:
        return "buyer"
    if s in _BOTH_SYNONYMS:
        return "both"
    return None


def _decode_csv(data: bytes) -> list[list[str]]:
    try:
        text = data.decode("utf-8-sig")  # 선행 BOM 제거(Excel 한글 CSV)
    except UnicodeDecodeError:
        # 한글 Windows Excel의 "CSV(쉼표로 분리)" 저장은 UTF-8이 아니라 CP949(ANSI)다 — 받은 템플릿을
        # 열어 고친 뒤 그대로 저장하면 흔히 이렇게 된다. UTF-8로 못 읽으면 CP949로 한 번 더 읽는다
        # (그래도 못 읽으면 호출부가 RosterParseError로 바꾼다).
        text = data.decode("cp949")
    return [row for row in csv.reader(io.StringIO(text))]


def _decode_xlsx(data: bytes) -> list[list[str]]:
    wb = load_workbook(io.BytesIO(data), read_only=True, data_only=True)
    ws = wb.active
    rows: list[list[str]] = []
    for row in ws.iter_rows(values_only=True):
        rows.append(["" if cell is None else str(cell).strip() for cell in row])
    wb.close()
    return rows


def parse_rows(filename: str, data: bytes) -> tuple[list[str], list[dict[str, str]]]:
    """파일 바이트 → (헤더, 원본 행 dict 목록). 모든 컬럼을 문자열로 보존(raw 원천)."""
    headers, rows, _ = parse_numbered_rows(filename, data)
    return headers, rows


def parse_numbered_rows(filename: str, data: bytes) -> tuple[list[str], list[dict[str, str]], list[int]]:
    """parse_rows + 각 데이터 행의 스프레드시트 행 번호(헤더=1행, 빈 줄도 번호는 센다).

    비밀번호 컬럼이 있으면 RosterPasswordColumnError — 어떤 적재·원본 보관보다 먼저 거부한다.
    """
    if not data:
        raise RosterParseError("빈 파일입니다.")
    name = (filename or "").lower()
    try:
        grid = _decode_xlsx(data) if name.endswith((".xlsx", ".xlsm")) else _decode_csv(data)
    except Exception as exc:  # noqa: BLE001 — 파싱 실패를 도메인 에러로 변환
        raise RosterParseError(f"파일을 읽을 수 없습니다: {exc}") from exc

    # 완전 빈 줄 제거(원래 위치 = 행 번호는 보존)
    numbered = [(index + 1, r) for index, r in enumerate(grid) if any((c or "").strip() for c in r)]
    if len(numbered) < 2:
        raise RosterParseError("헤더와 최소 1개 데이터 행이 필요합니다.")

    headers = [(h or "").strip() for h in numbered[0][1]]
    if any(_is_password_header(h) for h in headers if h):
        raise RosterPasswordColumnError(
            "파일에 비밀번호 컬럼이 있습니다. 비밀번호는 파일에 넣지 말고 업로드 화면의 공통 비밀번호 칸에 입력해 주세요."
        )
    rows: list[dict[str, str]] = []
    row_numbers: list[int] = []
    for row_number, raw_row in numbered[1:]:
        row = {headers[i]: (raw_row[i] if i < len(raw_row) else "").strip() for i in range(len(headers))}
        rows.append(row)
        row_numbers.append(row_number)
    return headers, rows, row_numbers


def _resolve_columns(headers: list[str]) -> dict[str, str]:
    """정규 키 → 실제 헤더명. 별칭으로 해석(대소문자·공백 무시)."""
    norm = {h.strip().lower(): h for h in headers}
    mapping: dict[str, str] = {}
    for key, aliases in HEADER_ALIASES.items():
        for alias in aliases:
            if alias in norm:
                mapping[key] = norm[alias]
                break
    return mapping


def to_records(
    headers: list[str],
    rows: list[dict[str, str]],
    default_role: str | None = None,
) -> tuple[list[RosterRecord], int]:
    """원본 행 → 정규 레코드 + 무효(skipped) 집계.

    회원ID·기업명이 없으면 건너뛴다(멱등 주키·org 생성 불가). role은 명시 컬럼 우선,
    없으면 파일 출처 default_role로 유추(ADR-0009 D5). raw에는 원본 전체 컬럼을 담는다.
    """
    records, issues = to_records_detailed(headers, rows, default_role)
    return records, len(issues)


def to_records_detailed(
    headers: list[str],
    rows: list[dict[str, str]],
    default_role: str | None = None,
    row_numbers: list[int] | None = None,
) -> tuple[list[RosterRecord], list[RowIssue]]:
    """to_records와 같되, 무효 행을 개수 대신 행 번호·사유(RowIssue)로 돌려준다(행별 결과 보고용).

    회원ID("아이디")가 비어 있거나 열 자체가 없어도 거부하지 않는다 — 로그인 이메일 열(contact_email,
    고객사 양식은 "전시회 담당자 이메일")이 있으면 행마다 정규화한 이메일(소문자·공백 제거)로 멱등 키를
    자동 채운다(2026-10-01 결정). 아이디·이메일 열이 **둘 다** 없으면 멱등 키를 만들 방법이 없어 거부한다.

    계정(로그인) 한 사람 단위는 **전시회 담당자**다(2026-10-01 결정 변경 — 신청자 아님). 그 행의 담당자
    이메일이 비어 있으면 그 행만 신청자 단위 전체(성명·이메일·연락처)로 폴백한다 — 담당자 이름 +
    신청자 이메일처럼 사람을 섞지 않는다(RosterRecord.contact_source로 표시, import_service가 경고로 보고).
    """
    cols = _resolve_columns(headers)
    if "organizer_member_id" not in cols and "contact_email" not in cols and "applicant_email_hint" not in cols:
        raise RosterParseError("회원ID 또는 이메일 컬럼을 찾을 수 없습니다(멱등 주키 필수).")
    if "org_name" not in cols:
        # 기업명 컬럼이 없으면 전 행이 skip돼 무의미한 0건 적재가 된다 → malformed로 거부(eager 생성 필수).
        raise RosterParseError("기업명 컬럼을 찾을 수 없습니다(org eager 생성 필수).")

    default_hint = normalize_role(default_role)
    records: list[RosterRecord] = []
    issues: list[RowIssue] = []
    for index, row in enumerate(rows):
        def cell(key: str) -> str:
            col = cols.get(key)
            return row.get(col, "").strip() if col else ""

        row_number = row_numbers[index] if row_numbers is not None and index < len(row_numbers) else None
        raw_member_id = cell("organizer_member_id")
        org_name = cell("org_name")

        # 담당자(전시회 담당자) 단위가 기본. 담당자 이메일이 비면 이 행만 신청자 단위 전체로 폴백한다
        # (이름·이메일·연락처를 신청자 열에서 통째로 가져온다 — 담당자 이름 + 신청자 이메일 같은 혼합 금지).
        # ⚠ 폴백은 파일에 신청자 전용 열(applicant_email_hint="신청자 이메일")이 실제로 있을 때만 켠다 —
        # 그 열 자체가 없는 옛 템플릿·범용 템플릿까지 "이메일 없으면 전부 폴백"으로 오분류하면 안 된다
        # (contact_email 열이 아예 없는 파일에서 담당자 이름까지 사라지던 회귀, 2026-10-01).
        staff_email = cell("contact_email").lower()
        has_applicant_fallback_columns = "applicant_email_hint" in cols
        if staff_email or not has_applicant_fallback_columns:
            contact_source = "staff"
            contact_email = staff_email
            name = cell("name")
            contact_phone = cell("contact_phone")
            # 직위 — 명시적 "직위"류 헤더가 있으면 우선, 없으면 전시회 담당자 직위(같은 사람이므로 무조건).
            title = cell("title") or cell("staff_title_hint") or None
        else:
            applicant_email = cell("applicant_email_hint").lower()
            contact_source = "applicant"
            contact_email = applicant_email
            name = cell("applicant_name_hint")
            contact_phone = cell("applicant_phone_hint")
            # 폴백 행은 담당자 직위를 쓰지 않는다(다른 사람 직위를 신청자 계정에 심지 않음) — 명시적
            # "직위"류 헤더(신청자 전용 템플릿 등)만 허용.
            title = cell("title") or None

        # 아이디 값이 있으면 그대로, 없으면 위에서 정한 로그인 이메일(정규화)로 멱등 키를 자동 채운다.
        # 아이디·이메일 모두 없으면 DB 키가 NULL이 될 수 없어 이 행은 건너뛴다(missing_member_id).
        member_id = raw_member_id or contact_email
        if not member_id or not org_name:
            issues.append(
                RowIssue(
                    row_number=row_number,
                    reason="missing_member_id" if not member_id else "missing_org_name",
                    organizer_member_id=member_id or None,
                    org_name=org_name or None,
                    contact_email=contact_email or None,
                )
            )
            continue

        records.append(
            RosterRecord(
                organizer_member_id=member_id,
                org_name=org_name,
                name=name or None,
                contact_email=contact_email or None,
                contact_phone=contact_phone or None,
                business_number=cell("business_number") or None,
                role_hint=normalize_role(cell("role_hint")) or default_hint,
                business_field=normalize_business_field(cell("business_field")),
                content_category=normalize_content_category(cell("content_category")),
                category_invalid=bool(cell("content_category")) and normalize_content_category(cell("content_category")) is None,
                raw=dict(row),  # 원본 전체 보존
                org_name_en=cell("org_name_en") or None,
                country=cell("country") or None,
                title=title or None,
                contact_source=contact_source,
                row_number=row_number,
            )
        )
    return records, issues
