"""엑셀 export — 순수 포매팅 함수(app.excel.service) + 엔드포인트(app.excel.router) 계약.

포매팅 함수는 DB 없이 항상 돈다. 엔드포인트는 실제 DB 조회를 검증하므로 db_session/event
픽스처(conftest.py, migrated Postgres)를 쓴다 — Postgres 미가용 환경에서는 자동 skip.
"""

from __future__ import annotations

import io
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient
from openpyxl import load_workbook
from sqlalchemy import select

from app.admin.guard import EventOperatorPrincipal, require_event_operator
from app.auth.organizer_guard import (
    EventMasterPrincipal,
    InMemoryEventOperatorDirectory,
    StubSessionAuthenticator,
    get_authenticator,
    get_operator_directory,
    require_event_master,
)
from app.db import get_session
from app.excel.service import (
    build_meetings_workbook,
    build_organizations_workbook,
    build_reviews_workbook,
    format_meetings_rows,
    format_organization_rows,
    format_reviews_rows,
)
from app.main import app
from app.models import (
    BuyerAttendee,
    BuyerProfile,
    ExhibitorKeyword,
    ExhibitorProfile,
    Keyword,
    LoveCall,
    Meeting,
    MeetingVenue,
    Organization,
    OrganizationEventRole,
    Organizer,
    PostMeetingReview,
)

# =============================================================================
# 순수 함수 — format_*_rows / build_*_workbook (DB 불필요)
# =============================================================================


class TestFormatOrganizationRows:
    def test_format_organization_rows_empty(self):
        assert format_organization_rows([]) == []

    def test_format_organization_rows_basic(self):
        # 헤더 한영 병기 11컬럼 고정 순서 + 값 매핑(전화·등록일 추가 — 이슈: 명단 내보내기 개선).
        rows = format_organization_rows([{
            "name_ko": "새한방산",
            "name_en": "Saehan Defense",
            "is_exhibitor": True,
            "is_buyer": False,
            "application_status": "approved",
            "contact_name": "김새한",
            "contact_email": "contact@saehan.kr",
            "contact_phone": "02-1234-5678",
            "booth_location": "HALL 7 A-101",
            "keywords": "기동, 화력",
            "registered_at": datetime(2026, 6, 1, 9, 0),
        }])
        (row,) = rows
        assert list(row.keys()) == [
            "기업명(국문) / Company Name (KO)",
            "기업명(영문) / Company Name (EN)",
            "역할 / Role",
            "승인상태 / Status",
            "담당자명 / Contact Name",
            "연락처 / Contact Email",
            "전화 / Phone",
            "부스 / Booth",
            "키워드 / Keywords",
            "등록일 / Registered At",
            "대리작성 / Proxy Submit",
        ]
        assert row["기업명(국문) / Company Name (KO)"] == "새한방산"
        assert row["기업명(영문) / Company Name (EN)"] == "Saehan Defense"
        assert row["담당자명 / Contact Name"] == "김새한"
        assert row["전화 / Phone"] == "02-1234-5678"
        assert row["키워드 / Keywords"] == "기동, 화력"
        assert row["등록일 / Registered At"] == "2026-06-01"

    def test_format_organization_rows_filters_status(self):
        # rejected는 물론 등록/변경요청 상태도 내보내기 대상이 아니다 — approved/submitted만 남는다.
        orgs = [
            {"name_ko": "승인기업", "application_status": "approved"},
            {"name_ko": "제출기업", "application_status": "submitted"},
            {"name_ko": "등록기업", "application_status": "registered"},
            {"name_ko": "변경요청기업", "application_status": "changes_requested"},
            {"name_ko": "거절기업", "application_status": "rejected"},
        ]
        rows = format_organization_rows(orgs)
        assert [r["기업명(국문) / Company Name (KO)"] for r in rows] == ["승인기업", "제출기업"]

    def test_role_text_both(self):
        org = {"is_exhibitor": True, "is_buyer": True, "name_ko": "새한방산", "application_status": "approved"}
        rows = format_organization_rows([org])
        assert rows[0]["역할 / Role"] == "참가기업/바이어"

    def test_role_text_exhibitor_only(self):
        rows = format_organization_rows(
            [{"is_exhibitor": True, "is_buyer": False, "application_status": "approved"}]
        )
        assert rows[0]["역할 / Role"] == "참가기업"

    def test_role_text_buyer_only(self):
        rows = format_organization_rows(
            [{"is_exhibitor": False, "is_buyer": True, "application_status": "approved"}]
        )
        assert rows[0]["역할 / Role"] == "바이어"

    def test_role_text_neither(self):
        rows = format_organization_rows(
            [{"is_exhibitor": False, "is_buyer": False, "application_status": "approved"}]
        )
        assert rows[0]["역할 / Role"] == ""

    def test_status_display_mapping(self):
        rows = format_organization_rows([{"application_status": "approved"}, {"application_status": "submitted"}])
        assert rows[0]["승인상태 / Status"] == "승인"
        assert rows[1]["승인상태 / Status"] == "제출"

    def test_missing_fields_default_to_empty_string(self):
        rows = format_organization_rows([{"application_status": "approved"}])
        row = rows[0]
        assert row["기업명(국문) / Company Name (KO)"] == ""
        assert row["담당자명 / Contact Name"] == ""
        assert row["전화 / Phone"] == ""
        assert row["등록일 / Registered At"] == ""
        assert row["대리작성 / Proxy Submit"] == "N/A"

    def test_keywords_passthrough(self):
        rows = format_organization_rows([{"keywords": "기동, 화력", "application_status": "approved"}])
        assert rows[0]["키워드 / Keywords"] == "기동, 화력"


class TestFormatMeetingsRows:
    def test_date_time_slot_formatting(self):
        rows = format_meetings_rows([{
            "scheduled_start": datetime(2026, 9, 16, 10, 0),
            "scheduled_end": datetime(2026, 9, 16, 10, 30),
        }], slot_minutes=30)
        assert rows[0]["날짜 / Date"] == "2026-09-16"
        assert rows[0]["시간 / Time"] == "10:00~10:30"
        assert rows[0]["슬롯 / Slot"] == "10:00-10:30"  # 슬롯ID는 하이픈 구분

    def test_slot_column_is_grid_cell_while_time_is_measured_span(self):
        # 40분/텀5분 격자(mt003gap0001)의 2칸 연속 미팅: **시간**은 실측 스팬(10:00~11:25, 85분),
        # **슬롯**은 그 미팅이 시작하는 그리드 한 칸(10:00-10:40). 구버전은 시작 시각을 30분 그리드로
        # floor 해서 이 행사에 존재하지 않는 칸 이름("10:00-10:30")을 찍었다.
        rows = format_meetings_rows([{
            "scheduled_start": datetime(2026, 10, 20, 10, 0),
            "scheduled_end": datetime(2026, 10, 20, 11, 25),
        }], slot_minutes=40)
        assert rows[0]["시간 / Time"] == "10:00~11:25"
        assert rows[0]["슬롯 / Slot"] == "10:00-10:40"

    def test_slot_cell_follows_event_slot_minutes_not_a_hardcoded_thirty(self):
        # 같은 시작 시각이라도 행사의 슬롯 길이에 따라 칸이 달라진다 — 30분 상수 제거 회귀 방지.
        row = {"scheduled_start": datetime(2026, 10, 20, 10, 0),
               "scheduled_end": datetime(2026, 10, 20, 10, 40)}
        assert format_meetings_rows([row], slot_minutes=40)[0]["슬롯 / Slot"] == "10:00-10:40"
        assert format_meetings_rows([row], slot_minutes=60)[0]["슬롯 / Slot"] == "10:00-11:00"

    def test_no_scheduled_end_falls_back_to_event_slot_minutes(self):
        # scheduled_end가 NULL이면 **이 행사의** 슬롯 길이로 시간을 메운다(30분 고정 아님).
        rows = format_meetings_rows(
            [{"scheduled_start": datetime(2026, 9, 16, 10, 0)}], slot_minutes=30
        )
        assert rows[0]["날짜 / Date"] == "2026-09-16"
        assert rows[0]["시간 / Time"] == "10:00~10:30"
        assert rows[0]["슬롯 / Slot"] == "10:00-10:30"

        rows40 = format_meetings_rows(
            [{"scheduled_start": datetime(2026, 10, 20, 10, 0)}], slot_minutes=40
        )
        assert rows40[0]["시간 / Time"] == "10:00~10:40"

    def test_iso_string_start_and_end_are_parsed(self):
        rows = format_meetings_rows([{
            "scheduled_start": "2026-09-16T15:45:00",
            "scheduled_end": "2026-09-16T16:15:00",
        }], slot_minutes=30)
        assert rows[0]["시간 / Time"] == "15:45~16:15"

    def test_status_and_provenance_mapping(self):
        rows = format_meetings_rows([{"status": "accepted", "matching_type": "ai"}], slot_minutes=30)
        assert rows[0]["미팅상태 / Status"] == "확정"
        assert rows[0]["발생근거 / Provenance"] == "AI매칭"

    def test_noshow_flag(self):
        rows = format_meetings_rows(
            [{"counterpart_noshow": True}, {"counterpart_noshow": False}], slot_minutes=30
        )
        assert rows[0]["노쇼 여부 / No-show"] == "Y"
        assert rows[1]["노쇼 여부 / No-show"] == "N"

    def test_no_start_time_leaves_blank(self):
        rows = format_meetings_rows([{}], slot_minutes=30)
        assert rows[0]["날짜 / Date"] == ""
        assert rows[0]["시간 / Time"] == ""


class TestFormatReviewsRows:
    def test_review_flags(self):
        rows = format_reviews_rows([{"exhibitor_reviewed": True, "buyer_reviewed": False, "has_love_call": True}])
        row = rows[0]
        assert row["리뷰작성(참가기업) / Review by Exhibitor"] == "Y"
        assert row["리뷰작성(바이어) / Review by Buyer"] == "N"
        assert row["러브콜 / Love Call"] == "Y"

    def test_date_formatting(self):
        rows = format_reviews_rows([{"scheduled_start": datetime(2026, 9, 17, 9, 0)}])
        assert rows[0]["날짜 / Date"] == "2026-09-17"


class TestBuildWorkbooks:
    def _read_back(self, wb):
        buf = io.BytesIO()
        wb.save(buf)
        buf.seek(0)
        return load_workbook(buf)

    def test_organizations_workbook_has_header_and_rows(self):
        rows = format_organization_rows(
            [{"name_ko": "새한방산", "is_exhibitor": True, "application_status": "approved"}]
        )
        wb = self._read_back(build_organizations_workbook(rows))
        ws = wb.active
        assert ws.title == "기업목록"
        header = [c.value for c in ws[1]]
        assert "기업명(국문) / Company Name (KO)" in header
        assert ws[1][0].font.bold is True
        data_row = [c.value for c in ws[2]]
        assert "새한방산" in data_row

    def test_build_organizations_workbook_structure(self):
        # 시트명·열 개수(한영 병기 11컬럼 — 전화·등록일 추가) 계약.
        rows = format_organization_rows([{"name_ko": "새한방산", "application_status": "approved"}])
        ws = self._read_back(build_organizations_workbook(rows)).active
        assert ws.title == "기업목록"
        assert ws.max_column == 11
        assert ws.max_row == 2  # 헤더 1행 + 데이터 1행

    def test_header_style_autofilter_and_freeze_panes(self):
        # "볼품없는 CSV" 개선 계약 — 헤더 배경색·흰 굵은 글자·가운데정렬 + 자동필터 + 틀고정(A2).
        rows = format_organization_rows([{"name_ko": "새한방산", "application_status": "approved"}])
        ws = self._read_back(build_organizations_workbook(rows)).active

        header_cell = ws["A1"]
        assert header_cell.font.bold is True
        assert header_cell.font.color.rgb == "FFFFFFFF"
        assert header_cell.fill.start_color.rgb == "FF1F2A44"
        assert header_cell.alignment.horizontal == "center"

        last_col_letter = ws.cell(row=1, column=ws.max_column).column_letter
        assert ws.auto_filter.ref == f"A1:{last_col_letter}{ws.max_row}"
        assert ws.freeze_panes == "A2"

    def test_column_width_autofits_and_clamps(self):
        # 짧은 값은 최소폭 이상, 매우 긴 값은 상한(40)으로 클램프 — 잘리지도 과하게 넓지도 않게.
        long_value = "가" * 60
        rows = format_organization_rows([{"name_ko": long_value, "application_status": "approved"}])
        ws = self._read_back(build_organizations_workbook(rows)).active
        name_col_width = ws.column_dimensions["A"].width
        assert 10 <= name_col_width <= 40

        short_rows = format_organization_rows([{"name_ko": "새한", "application_status": "approved"}])
        short_ws = self._read_back(build_organizations_workbook(short_rows)).active
        assert short_ws.column_dimensions["A"].width >= 10

    def test_meetings_workbook_title(self):
        rows = format_meetings_rows([{"status": "accepted"}], slot_minutes=30)
        wb = self._read_back(build_meetings_workbook(rows))
        assert wb.active.title == "미팅목록"

    def test_reviews_workbook_title(self):
        wb = self._read_back(build_reviews_workbook(format_reviews_rows([{"has_love_call": True}])))
        assert wb.active.title == "회의록현황"

    def test_empty_rows_produce_workbook_without_header(self):
        wb = self._read_back(build_organizations_workbook([]))
        ws = wb.active
        assert ws.max_row == 1
        assert ws["A1"].value is None


# =============================================================================
# 엔드포인트 — DB 조회 계약(migrated Postgres 필요, 없으면 skip)
# =============================================================================


@pytest.fixture
def client(db_session, event):
    app.dependency_overrides[get_session] = lambda: db_session
    app.dependency_overrides[require_event_master] = lambda: EventMasterPrincipal(
        member_id="mbr-test-master", event_id=event.id
    )
    # 기업목록 export 2종(POST 필터/GET 역할)은 require_event_operator(master+sub 겸용)로 열렸다
    # (2026-09-17, 발주자 지시) — 기존 테스트는 전부 master 신원을 기대하므로 기본값도 master.
    # sub 시나리오는 _as_sub()로 테스트 내에서 다시 override한다.
    app.dependency_overrides[require_event_operator] = lambda: EventOperatorPrincipal(
        member_id="mbr-test-master", event_id=event.id, permission_level="master", organizer_id="org-test-master"
    )
    yield TestClient(app), event.id, db_session
    app.dependency_overrides.clear()


def _as_sub(event_id: str, *, organizer_id: str, member_id: str = "mbr-test-sub") -> None:
    """기업목록 export의 principal을 이 행사의 sub로 바꾼다(``organizer_id`` 관할 판정용)."""
    app.dependency_overrides[require_event_operator] = lambda: EventOperatorPrincipal(
        member_id=member_id, event_id=event_id, permission_level="sub", organizer_id=organizer_id
    )


def _seed_organizer(db_session, *, name="테스트운영자") -> str:
    """managing_organizer_id가 organizers.id FK라 실제 행이 있어야 한다. email은 unique라 매번 새로 만든다."""
    o = Organizer(name=name, email=f"{uuid.uuid4()}@organizer.nabi.local")
    db_session.add(o)
    db_session.flush()
    return o.id


def _load_xlsx(resp) -> list[list]:
    wb = load_workbook(io.BytesIO(resp.content))
    ws = wb.active
    return [[c.value for c in row] for row in ws.iter_rows()]


def _make_org_role(
    db_session, event_id, *, name_ko, is_exhibitor=False, is_buyer=False, status="approved",
    managing_organizer_id=None,
):
    org = Organization(name_ko=name_ko)
    db_session.add(org)
    db_session.flush()
    role = OrganizationEventRole(
        organization_id=org.id,
        event_id=event_id,
        is_exhibitor=is_exhibitor,
        is_buyer=is_buyer,
        application_status=status,
        managing_organizer_id=managing_organizer_id,
    )
    db_session.add(role)
    db_session.flush()
    return org, role


class TestExportOrganizationsEndpoint:
    def test_missing_event_id_400(self, client):
        tc, _, _ = client
        resp = tc.get("/api/admin/export/organizations.xlsx")
        assert resp.status_code == 400

    def test_invalid_event_id_400(self, client):
        tc, _, _ = client
        resp = tc.get("/api/admin/export/organizations.xlsx", params={"event_id": "not-a-uuid"})
        assert resp.status_code == 400

    def test_invalid_role_400(self, client):
        tc, event_id, _ = client
        resp = tc.get(
            "/api/admin/export/organizations.xlsx", params={"event_id": event_id, "role": "vip"}
        )
        assert resp.status_code == 400

    def test_unknown_event_404(self, client):
        tc, _, _ = client
        resp = tc.get(
            "/api/admin/export/organizations.xlsx",
            params={"event_id": "00000000-0000-0000-0000-000000000000"},
        )
        assert resp.status_code == 404

    def test_returns_approved_and_submitted_only(self, client):
        tc, event_id, db = client
        _make_org_role(db, event_id, name_ko="승인기업", is_exhibitor=True, status="approved")
        _make_org_role(db, event_id, name_ko="제출기업", is_buyer=True, status="submitted")
        _make_org_role(db, event_id, name_ko="등록만한기업", is_exhibitor=True, status="registered")
        db.flush()

        resp = tc.get("/api/admin/export/organizations.xlsx", params={"event_id": event_id})
        assert resp.status_code == 200
        assert resp.headers["content-type"].startswith(
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        )
        grid = _load_xlsx(resp)
        names = [row[0] for row in grid[1:]]
        assert "승인기업" in names
        assert "제출기업" in names
        assert "등록만한기업" not in names  # registered는 export 대상 아님

    def test_role_filter_exhibitor(self, client):
        tc, event_id, db = client
        _make_org_role(db, event_id, name_ko="셀러만", is_exhibitor=True, status="approved")
        _make_org_role(db, event_id, name_ko="바이어만", is_buyer=True, status="approved")
        db.flush()

        resp = tc.get(
            "/api/admin/export/organizations.xlsx", params={"event_id": event_id, "role": "exhibitor"}
        )
        grid = _load_xlsx(resp)
        names = [row[0] for row in grid[1:]]
        assert "셀러만" in names
        assert "바이어만" not in names

    def test_buyer_contact_fallback_and_blank_booth(self, client):
        # 바이어 전용 기업은 셀러 프로필이 없어 담당자/연락처가 빌 수 있다 — 바이어 첫 담당자
        # (buyer_attendees, sort_order 최소)로 폴백해야 한다. 부스 컬럼은 셀러만 노출(바이어 빈칸).
        tc, event_id, db = client
        _, role = _make_org_role(db, event_id, name_ko="글로벌트레이딩", is_buyer=True, status="approved")
        profile = BuyerProfile(org_event_role_id=role.id)
        db.add(profile)
        db.flush()
        db.add(
            BuyerAttendee(
                buyer_profile_id=profile.id, first_name="John", last_name="Smith",
                email="john@global.com", sort_order=1,
            )
        )
        db.add(
            BuyerAttendee(
                buyer_profile_id=profile.id, first_name="Jane", last_name="Doe",
                email="jane@global.com", sort_order=0,
            )
        )
        db.flush()

        resp = tc.get("/api/admin/export/organizations.xlsx", params={"event_id": event_id})
        grid = _load_xlsx(resp)
        header = grid[0]
        row = grid[1]
        assert row[header.index("담당자명 / Contact Name")] == "Jane Doe"  # sort_order 최소 담당자
        assert row[header.index("연락처 / Contact Email")] == "jane@global.com"
        assert row[header.index("부스 / Booth")] in (None, "")

    def test_exhibitor_keywords_scoped_to_own_profile(self, client):
        # 서로 다른 두 참가기업이 다른 키워드를 가질 때, 각자 자기 키워드만 나와야 한다
        # (수정 전 초안은 ExhibitorProfile.id == ExhibitorProfile.id 자기참조라 전체 키워드가 섞였다).
        tc, event_id, db = client
        org1, role1 = _make_org_role(db, event_id, name_ko="게임기업", is_exhibitor=True, status="approved")
        org2, role2 = _make_org_role(db, event_id, name_ko="콘텐츠기업", is_exhibitor=True, status="approved")

        profile1 = ExhibitorProfile(org_event_role_id=role1.id)
        profile2 = ExhibitorProfile(org_event_role_id=role2.id)
        db.add_all([profile1, profile2])
        db.flush()

        # keywords.(category, code)는 K-콘텐츠 사업분야 8종 고정 마스터 데이터 — 마이그레이션
        # kct001tax01이 이미 시드해 두었다(unique(category, code)). 새로 만들지 않고 시드된 행을 재사용한다.
        kw_game = db.execute(select(Keyword).where(Keyword.code == "game_production")).scalar_one()
        kw_content = db.execute(select(Keyword).where(Keyword.code == "content_production")).scalar_one()

        db.add(ExhibitorKeyword(exhibitor_profile_id=profile1.id, keyword_id=kw_game.id))
        db.add(ExhibitorKeyword(exhibitor_profile_id=profile2.id, keyword_id=kw_content.id))
        db.flush()

        resp = tc.get("/api/admin/export/organizations.xlsx", params={"event_id": event_id})
        grid = _load_xlsx(resp)
        rows_by_name = {row[0]: row for row in grid[1:]}
        header = grid[0]
        kw_idx = header.index("키워드 / Keywords")
        assert rows_by_name["게임기업"][kw_idx] == kw_game.label
        assert rows_by_name["콘텐츠기업"][kw_idx] == kw_content.label


class TestExportMeetingsEndpoint:
    def _make_meeting(
        self, db, event_id, *, status="accepted", exhibitor_name="셀러A", buyer_name="바이어A",
        scheduled_start=datetime(2026, 9, 16, 10, 0, tzinfo=timezone.utc),
    ):
        # 시작 시각은 인자로 받는다 — 나중에 start만 옮기면 end가 따라오지 않아
        # meetings_schedule_order_check(끝 > 시작)를 깬다.
        exhibitor_org = Organization(name_ko=exhibitor_name)
        buyer_org = Organization(name_ko=buyer_name)
        db.add_all([exhibitor_org, buyer_org])
        db.flush()
        meeting = Meeting(
            event_id=event_id,
            exhibitor_org_id=exhibitor_org.id,
            buyer_org_id=buyer_org.id,
            matching_type="ai",
            status=status,
            scheduled_start=scheduled_start,
            # accepted는 시작·종료가 둘 다 있어야 한다(mt001meet01 CHECK) — 확정 미팅의
            # 슬롯 점유(EXCLUDE)가 시간 구간 위에 서 있기 때문.
            scheduled_end=scheduled_start + timedelta(minutes=30),
        )
        db.add(meeting)
        db.flush()
        return meeting, exhibitor_org, buyer_org

    def test_cancelled_meetings_excluded(self, client):
        tc, event_id, db = client
        self._make_meeting(db, event_id, status="accepted")
        self._make_meeting(db, event_id, status="cancelled")
        db.flush()

        resp = tc.get("/api/admin/export/meetings.xlsx", params={"event_id": event_id})
        grid = _load_xlsx(resp)
        assert len(grid) - 1 == 1  # 헤더 제외 1건만

    def test_exhibitor_and_buyer_names_not_swapped(self, client):
        # 같은 organizations 테이블을 exhibitor_org_id/buyer_org_id 두 FK로 조인하므로
        # aliased() 없이 두 번 join하면 SQLAlchemy가 모호한 self-join을 만든다(회귀 방지).
        tc, event_id, db = client
        self._make_meeting(db, event_id, exhibitor_name="셀러구분용", buyer_name="바이어구분용")

        resp = tc.get("/api/admin/export/meetings.xlsx", params={"event_id": event_id})
        assert resp.status_code == 200
        grid = _load_xlsx(resp)
        header = grid[0]
        ex_idx = header.index("참가기업 / Exhibitor")
        by_idx = header.index("바이어 / Buyer")
        row = grid[1]
        assert row[ex_idx] == "셀러구분용"
        assert row[by_idx] == "바이어구분용"

    def test_two_reviews_do_not_duplicate_meeting_row(self, client):
        # PostMeetingReview는 미팅당 최대 2건(참가기업/바이어 각 1건)이라, 그대로 join하면
        # 미팅 행이 fan-out되어 두 번 나온다 — bool_or 서브쿼리로 접었으므로 1행이어야 한다.
        tc, event_id, db = client
        meeting, exhibitor_org, buyer_org = self._make_meeting(db, event_id, status="completed")
        db.add(PostMeetingReview(meeting_id=meeting.id, reviewer_org_id=exhibitor_org.id, counterpart_noshow=False))
        db.add(PostMeetingReview(meeting_id=meeting.id, reviewer_org_id=buyer_org.id, counterpart_noshow=True))
        db.flush()

        resp = tc.get("/api/admin/export/meetings.xlsx", params={"event_id": event_id})
        grid = _load_xlsx(resp)
        assert len(grid) - 1 == 1
        header = grid[0]
        noshow_idx = header.index("노쇼 여부 / No-show")
        assert grid[1][noshow_idx] == "Y"  # 둘 중 하나라도 노쇼 보고하면 Y

    def test_self_noshow_also_counts_as_noshow(self, client):
        """상대 리뷰가 아예 없어도, 본인 리뷰의 self_noshow=True 하나만으로 Y여야 한다(회귀 방지 —
        예전엔 counterpart_noshow만 보느라 "내가 불참"은 노쇼로 집계되지 않았다)."""
        tc, event_id, db = client
        meeting, exhibitor_org, buyer_org = self._make_meeting(db, event_id, status="completed")
        db.add(PostMeetingReview(meeting_id=meeting.id, reviewer_org_id=exhibitor_org.id, self_noshow=True))
        db.flush()

        resp = tc.get("/api/admin/export/meetings.xlsx", params={"event_id": event_id})
        grid = _load_xlsx(resp)
        header = grid[0]
        noshow_idx = header.index("노쇼 여부 / No-show")
        assert grid[1][noshow_idx] == "Y"

    def test_date_filter(self, client):
        tc, event_id, db = client
        m1, ex1, by1 = self._make_meeting(
            db, event_id, scheduled_start=datetime(2026, 9, 16, 10, 0, tzinfo=timezone.utc)
        )
        m2, ex2, by2 = self._make_meeting(
            db, event_id, scheduled_start=datetime(2026, 9, 17, 10, 0, tzinfo=timezone.utc)
        )
        db.flush()

        resp = tc.get(
            "/api/admin/export/meetings.xlsx", params={"event_id": event_id, "date": "2026-09-16"}
        )
        grid = _load_xlsx(resp)
        assert len(grid) - 1 == 1

    def test_invalid_date_400(self, client):
        tc, event_id, _ = client
        resp = tc.get(
            "/api/admin/export/meetings.xlsx", params={"event_id": event_id, "date": "16-09-2026"}
        )
        assert resp.status_code == 400

    def test_venue_label_included(self, client):
        tc, event_id, db = client
        venue = MeetingVenue(event_id=event_id, venue_type="zone_table", label="비즈매칭존 T-01")
        db.add(venue)
        db.flush()
        meeting, _, _ = self._make_meeting(db, event_id)
        meeting.venue_id = venue.id
        db.flush()

        resp = tc.get("/api/admin/export/meetings.xlsx", params={"event_id": event_id})
        grid = _load_xlsx(resp)
        header = grid[0]
        venue_idx = header.index("장소 / Venue")
        assert grid[1][venue_idx] == "비즈매칭존 T-01"


class TestExportReviewsEndpoint:
    def _make_completed_meeting(self, db, event_id):
        exhibitor_org = Organization(name_ko="셀러B")
        buyer_org = Organization(name_ko="바이어B")
        db.add_all([exhibitor_org, buyer_org])
        db.flush()
        meeting = Meeting(
            event_id=event_id,
            exhibitor_org_id=exhibitor_org.id,
            buyer_org_id=buyer_org.id,
            matching_type="ai",
            status="completed",
            scheduled_start=datetime(2026, 9, 16, 11, 0, tzinfo=timezone.utc),
            scheduled_end=datetime(2026, 9, 16, 11, 30, tzinfo=timezone.utc),
        )
        db.add(meeting)
        db.flush()
        return meeting, exhibitor_org, buyer_org

    def test_only_completed_meetings_included(self, client):
        tc, event_id, db = client
        self._make_completed_meeting(db, event_id)
        exhibitor_org = Organization(name_ko="셀러C")
        buyer_org = Organization(name_ko="바이어C")
        db.add_all([exhibitor_org, buyer_org])
        db.flush()
        db.add(
            Meeting(
                event_id=event_id,
                exhibitor_org_id=exhibitor_org.id,
                buyer_org_id=buyer_org.id,
                matching_type="ai",
                status="proposed",
            )
        )
        db.flush()

        resp = tc.get("/api/admin/export/reviews.xlsx", params={"event_id": event_id})
        grid = _load_xlsx(resp)
        assert len(grid) - 1 == 1

    def test_review_and_love_call_flags(self, client):
        tc, event_id, db = client
        meeting, exhibitor_org, buyer_org = self._make_completed_meeting(db, event_id)
        db.add(PostMeetingReview(meeting_id=meeting.id, reviewer_org_id=exhibitor_org.id))
        db.add(LoveCall(meeting_id=meeting.id, event_id=event_id, from_org_id=exhibitor_org.id, to_org_id=buyer_org.id))
        db.flush()

        resp = tc.get("/api/admin/export/reviews.xlsx", params={"event_id": event_id})
        grid = _load_xlsx(resp)
        header = grid[0]
        row = grid[1]
        assert row[header.index("리뷰작성(참가기업) / Review by Exhibitor")] == "Y"
        assert row[header.index("리뷰작성(바이어) / Review by Buyer")] == "N"
        assert row[header.index("러브콜 / Love Call")] == "Y"

    def test_private_review_fields_not_leaked(self, client):
        # 비공개 평가 필드(만족도·후속의향·적합도 값/사유·전사·녹음 키)는 절대 export에 새면 안
        # 된다 — "작성 여부(Y/N)"만 노출해야 한다(F-OP-006 요구사항). 각 필드에 고유 마커 값을
        # 심어 놓고, 응답 xlsx 전체(모든 시트 셀 + 헤더)에 그 마커가 전혀 나타나지 않는지 검증한다.
        tc, event_id, db = client
        meeting, exhibitor_org, buyer_org = self._make_completed_meeting(db, event_id)
        db.add(
            PostMeetingReview(
                meeting_id=meeting.id,
                reviewer_org_id=exhibitor_org.id,
                satisfaction_rating=5,
                follow_up_intent="yes",
                fit_rating="good",
                fit_reason="MARKER-FIT-REASON-비공개사유",
                audio_s3_key="s3://nabi-private/MARKER-AUDIO-KEY",
                transcript="MARKER-TRANSCRIPT-전사원문비공개",
            )
        )
        db.flush()

        resp = tc.get("/api/admin/export/reviews.xlsx", params={"event_id": event_id})
        assert resp.status_code == 200

        # xlsx는 압축(zip/DEFLATE)이라 resp.content 원본 바이트 grep은 신뢰할 수 없다(값이 있어도
        # 안 걸릴 수 있음) — load_workbook으로 실제 디코딩한 셀 값을 검사해야 유의미하다.
        grid = _load_xlsx(resp)
        header = grid[0]
        # 헤더에도 비공개 필드용 라벨이 없어야 한다(작성 여부 Y/N 컬럼만 허용).
        private_header_terms = ["만족도", "후속의향", "적합도", "전사", "녹음", "satisfaction", "transcript", "audio"]
        for h in header:
            for term in private_header_terms:
                assert term.lower() not in h.lower()
        for row in grid[1:]:
            for cell in row:
                assert cell not in ("MARKER-FIT-REASON-비공개사유", "MARKER-AUDIO-KEY", "MARKER-TRANSCRIPT-전사원문비공개")


class TestFilteredMembersExport:
    def test_category_export_includes_registered_and_uses_business_field_codes(self, client):
        tc, event_id, db = client
        org, role = _make_org_role(db, event_id, name_ko="합성 방송", is_exhibitor=True, status="registered")
        profile = ExhibitorProfile(org_event_role_id=role.id, content_category="broadcasting")
        db.add(profile)
        db.flush()
        keyword = db.scalars(select(Keyword).where(Keyword.code == "content_production")).first()
        db.add(ExhibitorKeyword(exhibitor_profile_id=profile.id, keyword_id=keyword.id))
        _make_org_role(db, event_id, name_ko="미분류", is_exhibitor=True)
        db.flush()
        response = tc.post(f"/api/admin/export/organizations.xlsx?event_id={event_id}", json={
            "tab": "exhibitor", "query": "합성", "statuses": ["registered"],
            "content_categories": ["broadcasting"], "business_fields": ["content_production"],
            "ordered_ids": [org.id],
        })
        grid = _load_xlsx(response)
        assert len(grid) == 2
        assert grid[1][0] == "합성 방송"
        assert grid[1][grid[0].index("카테고리 / Category")] == "방송"
        response = tc.post(f"/api/admin/export/organizations.xlsx?event_id={event_id}", json={
            "tab": "exhibitor", "content_categories": ["animation_character"],
        })
        assert len(_load_xlsx(response)) == 1

    def test_export_all_pages_and_order_without_trusting_ids_for_membership(self, client):
        tc, event_id, db = client
        ids = []
        for i in range(12):
            org, _ = _make_org_role(db, event_id, name_ko=f"합성 {i:02}", is_exhibitor=True, status="registered")
            ids.append(org.id)
        buyer, _ = _make_org_role(db, event_id, name_ko="바이어", is_buyer=True)
        db.flush()
        response = tc.post(f"/api/admin/export/organizations.xlsx?event_id={event_id}", json={
            "tab": "exhibitor", "ordered_ids": [buyer.id, *reversed(ids)],
        })
        grid = _load_xlsx(response)
        assert len(grid) == 13
        assert [r[0] for r in grid[1:]] == [f"합성 {i:02}" for i in reversed(range(12))]


class TestSubScopedExport:
    """sub 운영자의 기업목록 export 관할 스코프(ADR-0012, 발주자 지시 2026-09-17).

    GET(역할 필터)·POST(OP-002 필터) 둘 다 sub는 자기가 관리하는 바이어만 받는다 — 참가사는
    절대 실리지 않고(요청 role/tab과 무관하게), 다른 sub의 바이어도 안 실린다. 관할 바이어가
    0건이면 오류가 아니라 헤더만 있는 파일. master는 기존 동작(참가사+전체 바이어) 그대로.
    """

    def test_get_export_sub_sees_only_own_buyers_no_exhibitors(self, client):
        tc, event_id, db = client
        sub_id = _seed_organizer(db, name="서브A")
        other_sub_id = _seed_organizer(db, name="서브B")
        _make_org_role(db, event_id, name_ko="참가사", is_exhibitor=True, status="approved")
        _make_org_role(
            db, event_id, name_ko="내바이어", is_buyer=True, status="approved",
            managing_organizer_id=sub_id,
        )
        _make_org_role(
            db, event_id, name_ko="남의바이어", is_buyer=True, status="approved",
            managing_organizer_id=other_sub_id,
        )
        db.flush()

        _as_sub(event_id, organizer_id=sub_id)
        resp = tc.get("/api/admin/export/organizations.xlsx", params={"event_id": event_id})
        assert resp.status_code == 200
        grid = _load_xlsx(resp)
        names = [row[0] for row in grid[1:]]
        assert names == ["내바이어"]  # 참가사·남의바이어 모두 제외

    def test_get_export_sub_requesting_exhibitor_role_still_excludes_exhibitors(self, client):
        # role=exhibitor를 명시해도 sub는 참가사를 절대 못 받는다(요청 role은 무시하고 buyer로 좁힌다).
        tc, event_id, db = client
        sub_id = _seed_organizer(db, name="서브C")
        _make_org_role(db, event_id, name_ko="참가사2", is_exhibitor=True, status="approved")
        _make_org_role(
            db, event_id, name_ko="내바이어2", is_buyer=True, status="approved",
            managing_organizer_id=sub_id,
        )
        db.flush()

        _as_sub(event_id, organizer_id=sub_id)
        resp = tc.get(
            "/api/admin/export/organizations.xlsx", params={"event_id": event_id, "role": "exhibitor"}
        )
        grid = _load_xlsx(resp)
        names = [row[0] for row in grid[1:]]
        assert names == ["내바이어2"]

    def test_get_export_zero_buyers_sub_gets_valid_empty_file_not_error(self, client):
        # 관할 바이어가 0건이어도 200 + 유효한 xlsx(빈 결과, build_organizations_workbook([])의
        # 기존 규약 그대로 — "test_empty_rows_produce_workbook_without_header"와 동일) — 예외 아님.
        tc, event_id, db = client
        sub_id = _seed_organizer(db, name="서브D")
        _as_sub(event_id, organizer_id=sub_id)
        resp = tc.get("/api/admin/export/organizations.xlsx", params={"event_id": event_id})
        assert resp.status_code == 200
        assert resp.headers["content-type"].startswith(
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        )
        grid = _load_xlsx(resp)
        assert grid == []  # 0행 — 파싱 가능한 유효 파일이며 오류 응답이 아니다

    def test_post_filtered_export_sub_buyer_tab_scoped_to_own_buyers(self, client):
        tc, event_id, db = client
        sub_id = _seed_organizer(db, name="서브E")
        other_sub_id = _seed_organizer(db, name="서브F")
        _make_org_role(
            db, event_id, name_ko="내바이어3", is_buyer=True, status="submitted",
            managing_organizer_id=sub_id,
        )
        _make_org_role(
            db, event_id, name_ko="남의바이어3", is_buyer=True, status="submitted",
            managing_organizer_id=other_sub_id,
        )
        db.flush()

        _as_sub(event_id, organizer_id=sub_id)
        resp = tc.post(
            f"/api/admin/export/organizations.xlsx?event_id={event_id}", json={"tab": "buyer"}
        )
        assert resp.status_code == 200
        grid = _load_xlsx(resp)
        names = [row[0] for row in grid[1:]]
        assert names == ["내바이어3"]

    def test_post_filtered_export_sub_exhibitor_tab_returns_header_only(self, client):
        # sub가 tab=exhibitor로 요청해도(프론트는 안 보내지만 방어적으로) 참가사는 절대 안 실린다.
        tc, event_id, db = client
        sub_id = _seed_organizer(db, name="서브G")
        _make_org_role(db, event_id, name_ko="참가사4", is_exhibitor=True, status="approved")
        db.flush()

        _as_sub(event_id, organizer_id=sub_id)
        resp = tc.post(
            f"/api/admin/export/organizations.xlsx?event_id={event_id}", json={"tab": "exhibitor"}
        )
        assert resp.status_code == 200
        grid = _load_xlsx(resp)
        assert len(grid) == 1

    def test_master_export_unchanged_includes_exhibitors_and_all_buyers(self, client):
        tc, event_id, db = client
        sub_id = _seed_organizer(db, name="서브H")
        _make_org_role(db, event_id, name_ko="참가사5", is_exhibitor=True, status="approved")
        _make_org_role(
            db, event_id, name_ko="바이어5", is_buyer=True, status="approved",
            managing_organizer_id=sub_id,
        )
        db.flush()
        # client 픽스처 기본값 = master(override 안 건드림)
        resp = tc.get("/api/admin/export/organizations.xlsx", params={"event_id": event_id})
        grid = _load_xlsx(resp)
        names = {row[0] for row in grid[1:]}
        assert names == {"참가사5", "바이어5"}

    def test_operator_of_another_event_forbidden(self, db_session, event):
        """override 없이 실 가드 배선(require_event_operator)을 태운다 — 이 행사 배정이 없는
        회원은 403(test_admin_api.py "가드 배선" 절과 같은 패턴)."""
        app.dependency_overrides[get_session] = lambda: db_session
        app.dependency_overrides[get_authenticator] = StubSessionAuthenticator
        app.dependency_overrides[get_operator_directory] = lambda: InMemoryEventOperatorDirectory({})
        try:
            tc = TestClient(app, raise_server_exceptions=False)
            resp = tc.get(
                "/api/admin/export/organizations.xlsx",
                params={"event_id": event.id},
                headers={"Authorization": "Bearer access-mbr-nobody-1"},
            )
            assert resp.status_code == 403
        finally:
            app.dependency_overrides.clear()
