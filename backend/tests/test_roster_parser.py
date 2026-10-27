"""roster 파서 단위 테스트(DB 무관, 순수) — 헤더 별칭·role 유추·raw 보존·무효행 집계."""

import io

import pytest
from openpyxl import Workbook

from app.roster.parser import (
    RosterParseError,
    normalize_business_field,
    normalize_content_category,
    parse_rows,
    to_records,
)


def _csv(text: str) -> bytes:
    return ("" + text).encode("utf-8")  # 선행 BOM(Excel 한글)


def test_parse_csv_resolves_korean_aliases_and_preserves_raw():
    data = _csv("회원ID,기업명,담당자,이메일,구분,업종\nm-1,새한방산,김철수,kim@a.com,참가기업,방산전자\n")
    headers, rows = parse_rows("roster.csv", data)
    records, skipped = to_records(headers, rows)
    assert skipped == 0
    (rec,) = records
    assert rec.organizer_member_id == "m-1"
    assert rec.org_name == "새한방산"
    assert rec.name == "김철수"
    assert rec.contact_email == "kim@a.com"
    assert rec.role_hint == "exhibitor"  # '참가기업' → exhibitor 유추
    # raw에 알려지지 않은 컬럼(업종 포함) 전체가 보존된다.
    assert rec.raw["업종"] == "방산전자"
    assert rec.raw["기업명"] == "새한방산"


def test_rows_missing_member_id_or_org_name_are_skipped():
    # 2행: 아이디·이메일 둘 다 없음(진짜 결측, missing_member_id) — 아이디만 없고 이메일이 있으면
    # 자동으로 채워지므로(test_missing_member_id_falls_back_to_email) 여기선 재현하지 않는다.
    data = _csv("id,name,email\nm-1,새한방산,a@a.com\n,빈회원이메일도없음,\nm-3,,c@c.com\n")
    headers, rows = parse_rows("r.csv", data)
    records, skipped = to_records(headers, rows)
    assert [r.organizer_member_id for r in records] == ["m-1"]
    assert skipped == 2  # 아이디+이메일 결측 1 + 기업명 결측 1


def test_missing_member_id_falls_back_to_email():
    """아이디 열이 있어도 빈칸이면 정규화(소문자·공백 제거)한 이메일로 멱등 키를 자동 채운다(결정 2)."""
    data = _csv("id,name,email\n,새한방산, Kim@A.com \n")
    headers, rows = parse_rows("r.csv", data)
    records, skipped = to_records(headers, rows)
    assert skipped == 0
    assert records[0].organizer_member_id == "kim@a.com"


def test_missing_member_id_column_falls_back_to_email():
    """아이디 열 자체가 없어도 이메일 열만 있으면 파일을 거부하지 않고 이메일로 멱등 키를 채운다."""
    data = _csv("name,email\n새한방산,a@a.com\n")
    headers, rows = parse_rows("r.csv", data)
    records, skipped = to_records(headers, rows)
    assert skipped == 0
    assert records[0].organizer_member_id == "a@a.com"


def test_default_role_fills_when_no_explicit_column():
    data = _csv("id,name\nm-1,어느바이어\n")
    headers, rows = parse_rows("buyers.csv", data)
    records, _ = to_records(headers, rows, default_role="buyer")
    assert records[0].role_hint == "buyer"  # 명시 컬럼 없으면 파일 출처로 유추


def test_explicit_role_column_overrides_default():
    data = _csv("id,name,구분\nm-1,혼합사,참가기업\n")
    headers, rows = parse_rows("buyers.csv", data)
    records, _ = to_records(headers, rows, default_role="buyer")
    assert records[0].role_hint == "exhibitor"  # 행의 명시 값이 default보다 우선


def test_missing_member_id_and_email_columns_raises():
    """아이디·이메일 열이 둘 다 없으면 멱등 키를 만들 방법이 없어 파일 전체를 거부한다."""
    data = _csv("name,phone\n새한방산,010-0000-0000\n")
    headers, rows = parse_rows("r.csv", data)
    with pytest.raises(RosterParseError):
        to_records(headers, rows)


def test_missing_org_name_column_raises():
    # 회원ID는 있지만 기업명 별칭이 없으면 malformed로 거부(전 행 skip 방지, codex P2).
    data = _csv("id,email\nm-1,a@a.com\n")
    headers, rows = parse_rows("r.csv", data)
    with pytest.raises(RosterParseError):
        to_records(headers, rows)


def test_empty_file_raises():
    with pytest.raises(RosterParseError):
        parse_rows("empty.csv", b"")


# --- REQ-04: 사업분야(business_field)·카테고리(content_category) K-콘텐츠 코드 정규화 -----------
def test_business_field_header_resolves_korean_labels_to_codes():
    data = _csv("회원ID,기업명,사업분야\nm-1,새빛스튜디오,게임 제작\n")
    headers, rows = parse_rows("roster.csv", data)
    records, _ = to_records(headers, rows)
    (rec,) = records
    assert rec.business_field == "game_production"


def test_business_field_accepts_comma_separated_multi_values():
    data = _csv("회원ID,기업명,사업분야\nm-1,새빛스튜디오,\"게임 제작, 콘텐츠 제작\"\n")
    headers, rows = parse_rows("roster.csv", data)
    records, _ = to_records(headers, rows)
    (rec,) = records
    assert rec.business_field == "game_production,content_production"


def test_business_field_accepts_raw_codes_and_drops_unknown_tokens():
    data = _csv("회원ID,기업명,사업분야\nm-1,새빛스튜디오,\"music_production, 방산전자\"\n")
    headers, rows = parse_rows("roster.csv", data)
    records, _ = to_records(headers, rows)
    (rec,) = records
    assert rec.business_field == "music_production"  # 방산전자(구 택소노미)는 매칭 안 되어 버려진다


def test_content_category_header_resolves_korean_label_to_code():
    data = _csv("회원ID,기업명,카테고리\nm-1,새빛스튜디오,애니메이션/캐릭터\n")
    headers, rows = parse_rows("roster.csv", data)
    records, _ = to_records(headers, rows)
    (rec,) = records
    assert rec.content_category == "animation_character"


def test_business_field_and_content_category_blank_when_absent():
    data = _csv("회원ID,기업명\nm-1,새빛스튜디오\n")
    headers, rows = parse_rows("roster.csv", data)
    records, _ = to_records(headers, rows)
    (rec,) = records
    assert rec.business_field is None
    assert rec.content_category is None


def test_normalize_business_field_unit():
    assert normalize_business_field(None) is None
    assert normalize_business_field("") is None
    assert normalize_business_field("음악 제작") == "music_production"
    assert normalize_business_field("음악 제작, music_platform") == "music_production,music_platform"
    assert normalize_business_field("알수없음") is None


def test_normalize_content_category_unit():
    assert normalize_content_category(None) is None
    assert normalize_content_category("방송") == "broadcasting"
    assert normalize_content_category("comics_game_music") == "comics_game_music"
    assert normalize_content_category("알수없음") is None


def test_normalize_content_category_comics_game_music_label_variants():
    """캐노니컬 라벨(쉼표·공백 없음)과 구 라벨 2종(가운뎃점 / 쉼표+공백) 모두 같은 코드로 정규화된다
    (2026-09-17 라벨 변경 — 만화·웹툰/게임/음악 → 만화,웹툰/게임/음악, 업로드 호환 유지)."""
    assert normalize_content_category("만화,웹툰/게임/음악") == "comics_game_music"
    assert normalize_content_category("만화·웹툰/게임/음악") == "comics_game_music"
    assert normalize_content_category("만화, 웹툰/게임/음악") == "comics_game_music"


def test_parse_xlsx():
    wb = Workbook()
    ws = wb.active
    ws.append(["회원ID", "기업명", "이메일"])
    ws.append(["m-1", "새한방산", "kim@a.com"])
    buf = io.BytesIO()
    wb.save(buf)
    headers, rows = parse_rows("roster.xlsx", buf.getvalue())
    records, skipped = to_records(headers, rows)
    assert skipped == 0
    assert records[0].org_name == "새한방산"
    assert records[0].contact_email == "kim@a.com"
