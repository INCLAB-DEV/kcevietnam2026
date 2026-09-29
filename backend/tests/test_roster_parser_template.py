"""명단 업로드 템플릿 파서 단위 테스트(DB 무관) — 헤더 별칭(새/옛 템플릿)·비밀번호 컬럼 거부·행 번호·CP949.

두 콘솔이 같은 다운로드 템플릿(frontend lib/roster/template.ts)을 쓰고, 옛 어드민/운영자 템플릿 헤더도
계속 받아야 한다(2026-09-16 — 어드민 템플릿의 name_ko를 몰라 업로드가 전부 400이던 결함).
"""

import pytest

from app.roster.parser import (
    RosterParseError,
    RosterPasswordColumnError,
    parse_numbered_rows,
    parse_rows,
    to_records,
    to_records_detailed,
)

BOM = chr(0xFEFF)  # 편집 훅이 보이지 않는 문자를 지우므로 코드포인트로 만든다


def _csv(text: str) -> bytes:
    return (BOM + text).encode("utf-8")


def test_new_template_header_maps_signup_fields():
    data = _csv(
        "id,role,name_ko,name_en,country,contact_name,contact_email,contact_phone,content_category\r\n"
        "ex-1,참가기업,콘텐츠랩,Content Lab,대한민국,김담당,Lab@Contents.example.com,010-1111-2222,방송\r\n"
    )
    headers, rows = parse_rows("roster.csv", data)
    (rec,) = to_records(headers, rows)[0]
    assert (rec.organizer_member_id, rec.org_name, rec.org_name_en, rec.country) == (
        "ex-1", "콘텐츠랩", "Content Lab", "대한민국",
    )
    assert (rec.name, rec.contact_email, rec.contact_phone) == ("김담당", "lab@contents.example.com", "010-1111-2222")
    assert (rec.role_hint, rec.content_category) == ("exhibitor", "broadcasting")
    assert rec.row_number is None  # to_records(번호 없이)로 만든 레코드


def test_old_admin_template_category_column_is_business_field():
    # 옛 /admin/organizations 템플릿: category 예시값 "콘텐츠 제작" = 사업분야 라벨, registered_by는 raw만.
    data = _csv(
        "id,role,name_ko,name_en,country,contact_name,contact_email,contact_phone,category,registered_by\r\n"
        "adm-ex-999,exhibitor,예시기업,Example Corp,대한민국,홍길동,hong@example.com,010-0000-0000,콘텐츠 제작,직접등록"
    )
    headers, rows = parse_rows("roster.csv", data)
    (rec,) = to_records(headers, rows)[0]
    assert rec.org_name == "예시기업"
    assert rec.business_field == "content_production"
    assert rec.content_category is None and rec.category_invalid is False
    assert rec.raw["registered_by"] == "직접등록"


@pytest.mark.parametrize("header", ["password", "Password", "비밀번호", "초기 비밀번호", "contact_password", "PW", "pwd", "패스워드"])
def test_password_column_is_rejected(header):
    data = _csv(f"id,name_ko,{header}\r\nm-1,회사,Secret123\r\n")
    with pytest.raises(RosterPasswordColumnError) as info:
        parse_rows("roster.csv", data)
    assert "Secret123" not in str(info.value)
    assert isinstance(info.value, RosterParseError)  # 기존 400 매핑과 호환


def test_similar_but_not_password_headers_are_allowed():
    data = _csv("id,name_ko,passport_no,power\r\nm-1,회사,M1234,high\r\n")
    headers, rows = parse_rows("roster.csv", data)
    assert rows[0]["passport_no"] == "M1234"


def test_row_numbers_follow_spreadsheet_rows_including_blank_lines():
    data = _csv("id,name_ko,contact_email\r\nm-1,회사A,a@a.example.com\r\n\r\n,회사B,b@b.example.com\r\nm-3,,c@c.example.com\r\nm-4,회사D,\r\n")
    headers, rows, numbers = parse_numbered_rows("roster.csv", data)
    assert numbers == [2, 4, 5, 6]  # 3행은 빈 줄
    records, issues = to_records_detailed(headers, rows, None, numbers)
    assert [(r.organizer_member_id, r.row_number) for r in records] == [("m-1", 2), ("m-4", 6)]
    assert [(i.row_number, i.reason, i.org_name) for i in issues] == [
        (4, "missing_member_id", "회사B"),
        (5, "missing_org_name", None),
    ]
    assert to_records(headers, rows)[1] == 2  # 기존 계약(무효 행 개수) 그대로


def test_cp949_csv_from_korean_excel_is_decoded():
    data = "id,name_ko,contact_name\r\nm-1,새빛스튜디오,김담당\r\n".encode("cp949")
    headers, rows = parse_rows("roster.csv", data)
    (rec,) = to_records(headers, rows)[0]
    assert (rec.org_name, rec.name) == ("새빛스튜디오", "김담당")
