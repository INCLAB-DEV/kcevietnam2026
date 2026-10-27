"""고객사 참가기업 명단 양식(2026 베트남 K-콘텐츠 엑스포, 39열) 파싱·적재 — 2026-10-01 결정 사항.

실측 특징(발주처 확인): '아이디' 열은 45행 전부 빈칸, '전시회 담당자'(성명·이메일·휴대폰)가 로그인
계정 한 사람 단위다(2026-10-01 결정 변경 — 처음엔 '신청자'로 갔다가 전시회 담당자로 바뀌었다). 실제
고객 파일은 전시회 담당자와 신청자가 같은 사람이라 이 둘을 섞어도 테스트로는 못 잡는다 — 그래서 아래
픽스처는 기본적으로 **둘을 다른 사람**으로 만들어 계정이 정확히 전시회 담당자에서만 오는지 고정한다.

여기서는 전부 합성 가짜 데이터만 쓴다(실 PII 금지, references/ 안의 실제 고객 파일은 절대 열지 않는다).

파서 단위 테스트(DB 무관)와 import_service를 거친 HTTP 통합 테스트로 나눈다 — 전자는 헤더 해석·
자동 키·사람 단위(담당자/신청자 폴백)·라벨 정규화·raw 보존, 후자는 멱등 재업로드·대소문자 이메일
갱신·exhibitor_profiles 미생성·행별 폴백 경고를 확인한다.
"""

from __future__ import annotations

import csv
import io
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from openpyxl import Workbook
from sqlalchemy import select

from app.auth.organizer_guard import (
    InMemoryEventOperatorDirectory,
    StubSessionAuthenticator,
    get_authenticator,
    get_operator_directory,
)
from app.db import get_session
from app.main import app
from app.models import ExhibitorProfile, Member, Organization, OrganizationEventRole
from app.roster.parser import parse_rows, to_records, to_records_detailed
from app.storage import get_storage

MASTER = {"Authorization": "Bearer access-mbr-master-1"}
BOM = chr(0xFEFF)

# 고객사 양식 헤더 — 순서 그대로(17번째는 끝에 공백이 있다, 실측 그대로 재현).
CUSTOMER_HEADERS = [
    "아이디", "사업자번호", "사업자명", "사업자명(영문)",
    "대표자명", "대표 이메일", "대표 전화번호", "홈페이지 주소",
    "우편번호", "주소", "상세주소", "업태",
    "업종", "대표이사 성명", "대표이사 연락처", "대표이사 이메일",
    "신청자 성명 ", "신청자 연락처", "신청자 이메일", "전시회 담당자 성명",
    "전시회 담당자 직위", "전시회 담당자 부서", "전시회 담당자 이메일", "전시회 담당자 휴대폰",
    "전시회 담당자 전화", "세금계산서 성명", "세금계산서 직위", "세금계산서 부서",
    "세금계산서 이메일", "세금계산서 휴대폰", "세금계산서 전화", "대분류",
    "중분류", "전시품목(국문)", "전시품목(영문)", "브랜드명(국문)",
    "브랜드명(영문)", "부스명", "부스신청수량",
]


def _sample_row(n: int, *, same_person: bool = False, with_id: str | None = None, staff_email: str | None = "") -> dict:
    """가짜 참가기업 한 행.

    기본(same_person=False)은 **전시회 담당자와 신청자를 다른 사람**으로 만든다(실제 고객 파일은 둘이
    같아서 이 차이를 못 잡는다 — 2026-10-01 지시). same_person=True면 실제 고객 파일처럼 동일인.
    staff_email=""(기본)은 전시회 담당자 이메일을 채운 정상 행, staff_email=None이면 그 열을 비워
    신청자 단위 폴백을 재현한다.
    """
    applicant_email = f"applicant{n}@example.com"
    staff_email_value = applicant_email if same_person else f"staff{n}@example.com"
    row = {
        "아이디": with_id or "",
        "사업자번호": f"000-00-0000{n}",
        "사업자명": f"가짜기업{n}",
        "사업자명(영문)": f"Fake Company {n}",
        "대표자명": f"대표{n}",
        "대표 이메일": f"ceo{n}@example.com",  # 신청자·담당자와 다른 사람 — 계정 이메일로 잡히면 안 됨
        "대표이사 성명": f"대표이사{n}",
        "대표이사 연락처": f"010-9{n:03d}-0000",  # 전용 컬럼 없음 — raw 보존 확인용
        "대표이사 이메일": f"chairman{n}@example.com",
        "신청자 성명 ": f"신청자{n}",
        "신청자 연락처": f"010-0{n:03d}-0000",
        "신청자 이메일": applicant_email,
        "전시회 담당자 성명": "신청자" + str(n) if same_person else f"담당자{n}",
        "전시회 담당자 이메일": staff_email_value,
        "전시회 담당자 휴대폰": f"010-8{n:03d}-0000",
        "전시회 담당자 전화": f"02-{n:03d}-0000",  # 사무실 전화 — 전용 컬럼 없음(raw만)
        "전시회 담당자 직위": "과장",
        "대분류": "방송",
        "중분류": "콘텐츠 제작",
    }
    if staff_email is None:
        row["전시회 담당자 이메일"] = ""  # 폴백 재현 — 담당자 이메일 결측
    elif staff_email != "":
        row["전시회 담당자 이메일"] = staff_email
    return row


def _grid(rows: list[dict]) -> list[list[str]]:
    return [CUSTOMER_HEADERS] + [[r.get(h, "") for h in CUSTOMER_HEADERS] for r in rows]


def _csv_bytes(rows: list[dict]) -> bytes:
    buf = io.StringIO()
    writer = csv.writer(buf)
    for line in _grid(rows):
        writer.writerow(line)
    return (BOM + buf.getvalue()).encode("utf-8")


def _xlsx_bytes(rows: list[dict]) -> bytes:
    wb = Workbook()
    ws = wb.active
    for line in _grid(rows):
        ws.append(line)
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


# =============================================================================
# 파서 단위(DB 무관) — 헤더 해석·자동 키·담당자/신청자 사람 단위·라벨 정규화·raw 보존
# =============================================================================
def test_blank_ids_load_every_row_from_staff_columns():
    """계정은 전시회 담당자 단위다 — 신청자 값이 섞이지 않는다(담당자≠신청자 픽스처)."""
    rows = [_sample_row(1), _sample_row(2)]
    headers, parsed_rows = parse_rows("roster.csv", _csv_bytes(rows))
    records, skipped = to_records(headers, parsed_rows, default_role="exhibitor")
    assert skipped == 0
    assert len(records) == 2
    r1, r2 = records
    assert r1.organizer_member_id == "staff1@example.com"  # 아이디 빈칸 → 담당자 이메일로 자동 채움
    assert r1.org_name == "가짜기업1"
    assert r1.org_name_en == "Fake Company 1"
    assert r1.name == "담당자1"  # 전시회 담당자 성명 — 신청자1이 섞이면 안 됨
    assert r1.contact_email == "staff1@example.com"
    assert r1.contact_phone == "010-8001-0000"  # 전시회 담당자 휴대폰(사무실 전화 아님)
    assert r1.title == "과장"  # 같은 사람이므로 무조건 적용
    assert r1.contact_source == "staff"
    assert r2.organizer_member_id == "staff2@example.com"


def test_xlsx_customer_template_parses_same_as_csv():
    rows = [_sample_row(1)]
    headers, parsed_rows = parse_rows("roster.xlsx", _xlsx_bytes(rows))
    records, skipped = to_records(headers, parsed_rows)
    assert skipped == 0
    (rec,) = records
    assert rec.organizer_member_id == "staff1@example.com"
    assert rec.org_name == "가짜기업1"
    assert rec.contact_email == "staff1@example.com"
    assert rec.name == "담당자1"


def test_other_email_columns_are_not_picked_as_account_email():
    # 대표 이메일·대표이사 이메일·신청자 이메일이 계정 이메일로 잘못 잡히지 않는다.
    rows = [_sample_row(1)]
    headers, parsed_rows = parse_rows("roster.csv", _csv_bytes(rows))
    (rec,) = to_records(headers, parsed_rows)[0]
    assert rec.contact_email == "staff1@example.com"
    for other in ("ceo1@example.com", "chairman1@example.com", "applicant1@example.com"):
        assert rec.contact_email != other
    # 매칭 안 된(또는 폴백 전용) 이메일 열은 raw에 그대로 남는다.
    assert rec.raw["대표 이메일"] == "ceo1@example.com"
    assert rec.raw["신청자 이메일"] == "applicant1@example.com"


def test_mixed_file_partial_ids_use_given_value_or_fallback_to_staff_email():
    rows = [_sample_row(1, with_id="custom-id-1"), _sample_row(2)]
    headers, parsed_rows = parse_rows("roster.csv", _csv_bytes(rows))
    records, skipped = to_records(headers, parsed_rows)
    assert skipped == 0
    assert records[0].organizer_member_id == "custom-id-1"  # 값이 있으면 그 값 그대로
    assert records[1].organizer_member_id == "staff2@example.com"  # 없으면 담당자 이메일로 자동 채움


def test_staff_email_blank_falls_back_to_applicant_unit_without_mixing_people():
    """전시회 담당자 이메일이 빈 행만 신청자 단위 전체(성명·이메일·연락처)로 폴백한다."""
    row = _sample_row(1, staff_email=None)
    headers, parsed_rows = parse_rows("roster.csv", _csv_bytes([row]))
    (rec,) = to_records(headers, parsed_rows)[0]
    assert rec.contact_source == "applicant"
    assert rec.contact_email == "applicant1@example.com"
    assert rec.name == "신청자1"  # 담당자 이름(담당자1)과 섞이지 않는다
    assert rec.contact_phone == "010-0001-0000"  # 신청자 연락처
    assert rec.title is None  # 담당자 직위를 다른 사람(신청자) 계정에 심지 않는다
    assert rec.organizer_member_id == "applicant1@example.com"  # 아이디 빈칸 → 폴백 이메일로 자동 채움


def test_rows_missing_both_staff_and_applicant_email_are_skipped_with_reason():
    row = _sample_row(1, staff_email=None)
    row["신청자 이메일"] = ""
    headers, parsed_rows = parse_rows("roster.csv", _csv_bytes([row]))
    records, issues = to_records_detailed(headers, parsed_rows)
    assert records == []
    assert len(issues) == 1
    assert issues[0].reason == "missing_member_id"


def test_category_label_variants_normalize_to_codes():
    row = _sample_row(1)
    row["대분류"] = "만화웹툰, 게임, 음악"
    row["중분류"] = "신기술융합컨텐츠"  # 고객사 철자("컨텐츠")
    headers, parsed_rows = parse_rows("roster.csv", _csv_bytes([row]))
    (rec,) = to_records(headers, parsed_rows)[0]
    assert rec.content_category == "comics_game_music"
    assert rec.business_field == "newtech_content"


def test_direct_title_header_takes_priority_over_staff_hint():
    row = _sample_row(1)
    headers0, parsed0 = parse_rows("roster.csv", _csv_bytes([row]))
    # "직위" 헤더가 별도로 있으면 그 값이 우선(고객사 양식엔 없지만 다른 템플릿 호환 확인).
    headers = [*headers0, "직위"]
    parsed = [{**parsed0[0], "직위": "본부장"}]
    (rec,) = to_records(headers, parsed)[0]
    assert rec.title == "본부장"


def test_unmapped_columns_are_preserved_in_raw():
    row = _sample_row(1)
    headers, parsed_rows = parse_rows("roster.csv", _csv_bytes([row]))
    (rec,) = to_records(headers, parsed_rows)[0]
    assert rec.raw["대표이사 연락처"] == "010-9001-0000"
    assert rec.raw["대표이사 성명"] == "대표이사1"
    assert rec.raw["대표이사 이메일"] == "chairman1@example.com"
    assert rec.raw["전시회 담당자 전화"] == "02-001-0000"  # 사무실 전화 — raw만(휴대폰만 계정 연락처)


# =============================================================================
# HTTP 통합(DB) — 멱등 재업로드·대소문자 이메일 갱신·exhibitor_profiles 미생성·폴백 경고
# =============================================================================
@pytest.fixture
def api(db_session, event):
    storage = SimpleNamespace(calls=[], put_original=lambda *a: None)
    app.dependency_overrides[get_session] = lambda: db_session
    app.dependency_overrides[get_storage] = lambda: storage
    app.dependency_overrides[get_authenticator] = StubSessionAuthenticator
    app.dependency_overrides[get_operator_directory] = lambda: InMemoryEventOperatorDirectory(
        {("mbr-master", event.id): "master"}
    )
    yield SimpleNamespace(client=TestClient(app), event_id=event.id, db=db_session)
    app.dependency_overrides.clear()


def _upload(api, data: bytes, *, filename: str = "roster.csv", **form):
    files = {"file": (filename, data, "text/csv" if filename.endswith(".csv") else
                       "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")}
    body = {k: str(v).lower() if isinstance(v, bool) else v for k, v in form.items()}
    return api.client.post(
        "/api/admin/import/roster", params={"event_id": api.event_id}, files=files, data=body, headers=MASTER
    )


def test_reupload_same_file_creates_no_duplicates(api):
    rows = [_sample_row(1), _sample_row(2), _sample_row(3)]
    data = _csv_bytes(rows)
    first = _upload(api, data)
    assert first.status_code == 200, first.text
    assert first.json()["added"] == 3

    second = _upload(api, data)
    assert second.status_code == 200, second.text
    assert (second.json()["added"], second.json()["unchanged"]) == (0, 3)

    # 전역 카운트는 공유 DB의 기존 시드와 섞이므로(다른 테스트 모듈과 같은 트랜잭션풀), 이번 업로드가
    # 만든 기업명("가짜기업N")으로 좁혀서 센다.
    org_count = len(
        api.db.scalars(select(Organization.id).where(Organization.name_ko.in_(["가짜기업1", "가짜기업2", "가짜기업3"]))).all()
    )
    member_count = len(
        api.db.scalars(
            select(Member.id).where(
                Member.email.in_(["staff1@example.com", "staff2@example.com", "staff3@example.com"])
            )
        ).all()
    )
    assert org_count == 3
    assert member_count == 3


def test_reupload_with_different_email_case_updates_same_company(api):
    row = _sample_row(1)
    first = _upload(api, _csv_bytes([row]))
    assert first.json()["added"] == 1

    row_upper = dict(row)
    row_upper["전시회 담당자 이메일"] = row["전시회 담당자 이메일"].upper()
    second = _upload(api, _csv_bytes([row_upper]))
    assert second.status_code == 200, second.text
    # 멱등 키(이메일 소문자 정규화)가 같아 같은 registrant로 합류 — 신규 0, 기업 1개만 유지.
    assert (second.json()["added"], second.json()["unchanged"] + second.json()["updated"]) == (0, 1)
    orgs = api.db.scalars(select(Organization).where(Organization.name_ko == "가짜기업1")).all()
    assert len(orgs) == 1
    members = api.db.scalars(select(Member).where(Member.email == "staff1@example.com")).all()
    assert len(members) == 1


def test_no_exhibitor_profile_row_when_no_category_or_exhibitor_role(api):
    # 지시서 결정 4번과 실제 코드가 어긋나는 지점(아래 참고) — 카테고리/exhibitor 신호가 전혀 없으면
    # 지금도 신청서 행을 만들지 않는다는 부분은 그대로 성립한다.
    row = _sample_row(1)
    row["대분류"] = ""  # content_category 신호 제거
    resp = _upload(api, _csv_bytes([row]), default_role="buyer")
    assert resp.status_code == 200, resp.text
    role = api.db.scalars(select(OrganizationEventRole).where(OrganizationEventRole.event_id == api.event_id)).one()
    profile = api.db.scalars(
        select(ExhibitorProfile).where(ExhibitorProfile.org_event_role_id == role.id)
    ).first()
    assert profile is None


def test_exhibitor_profile_backfill_only_touches_content_category(api):
    # ⚠ 판단 필요: 지시서 결정 4번("신청서 행은 만들지 않는다 — 지금 동작 유지")과 달리, import_service는
    # role=exhibitor + content_category(대분류)가 있으면 **기존부터**(이 작업 이전부터) 빈
    # exhibitor_profiles를 만들어 content_category만 채운다(app.roster.import_service, parser.py 모듈
    # docstring에도 명시된 기존 설계). 이 작업에서 추가한 고객사 양식 컬럼(브랜드명·부스명 등)이 이 기존
    # 백필에 새로 올라타지 않는지만 고정한다 — "신청서 행을 만들지 않는다"는 문자 그대로의 보장이 아니라
    # "새 컬럼이 신청서에 새로 쓰이지 않는다"는 보장으로 해석했다(오케스트레이터 확인 필요).
    row = _sample_row(1)
    resp = _upload(api, _csv_bytes([row]), default_role="exhibitor")
    assert resp.status_code == 200, resp.text
    role = api.db.scalars(select(OrganizationEventRole).where(OrganizationEventRole.event_id == api.event_id)).one()
    profile = api.db.scalars(
        select(ExhibitorProfile).where(ExhibitorProfile.org_event_role_id == role.id)
    ).one()
    assert profile.content_category == "broadcasting"
    # 브랜드명·부스명 등 고객사 양식 전용 컬럼은 raw에만 남고 이 프로필 행에는 손대지 않는다.
    assert profile.representative_name_ko is None
    assert profile.booth_hall is None
    assert profile.business_type is None


def test_staff_title_lands_on_member_title_via_http(api):
    row = _sample_row(1)
    resp = _upload(api, _csv_bytes([row]))
    assert resp.status_code == 200, resp.text
    member = api.db.scalars(select(Member).where(Member.email == "staff1@example.com")).one()
    assert member.title == "과장"


def test_missing_id_and_email_row_is_skipped_and_other_rows_still_load(api):
    ok_row = _sample_row(1)
    bad_row = _sample_row(2, staff_email=None)
    bad_row["신청자 이메일"] = ""
    resp = _upload(api, _csv_bytes([ok_row, bad_row]), row_report=True)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert (body["added"], body["skipped"]) == (1, 1)
    skipped_row = next(r for r in body["rows"] if r["result"] == "skipped")
    assert skipped_row["reason"] == "missing_member_id"


def test_fallback_row_is_surfaced_as_warning(api):
    """담당자 이메일 결측으로 신청자 단위 폴백한 행은 행별 결과에 경고로 노출된다."""
    row = _sample_row(1, staff_email=None)
    resp = _upload(api, _csv_bytes([row]), row_report=True)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["added"] == 1
    assert any(
        w["reason"] == "contact_fallback_to_applicant" and w["organizer_member_id"] == "applicant1@example.com"
        for w in body["warnings"]
    )
    member = api.db.scalars(select(Member).where(Member.email == "applicant1@example.com")).one()
    assert member.name == "신청자1"
    assert member.title is None


def test_normal_row_has_no_fallback_warning(api):
    row = _sample_row(1)
    resp = _upload(api, _csv_bytes([row]), row_report=True)
    assert resp.status_code == 200, resp.text
    assert resp.json().get("warnings", []) == []
