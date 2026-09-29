"""엑셀 export 데이터 준비 및 workbook 빌드 (순수 함수, DB 불필요).

DB 조회는 router.py가 소유하고, 여기서는 조회 결과(dict 리스트)를 엑셀 행/워크북으로 포매팅만
한다 — DB 세션 없이도 단위 테스트할 수 있도록 분리(테스트 가능성 확보).
"""

from __future__ import annotations

from datetime import datetime, timedelta

from openpyxl import Workbook
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter

# 내보내기 대상 승인상태 — 매칭 노출 게이트와 동일하게 approved/submitted만(rejected·registered 등 제외).
_EXPORTABLE_STATUSES = {"approved", "submitted"}


def format_organization_rows(
    organizations_data: list[dict],
    *,
    all_statuses: bool = False,
) -> list[dict[str, str]]:
    """기업 목록 데이터 → 엑셀 행 dict 리스트 (순수 함수).

    기본은 approved/submitted인 행만 내보낸다. OP-002의 명시적 필터 export는
    all_statuses=True로 요청해 미신청 등 화면에서 선택한 상태도 포함한다.
    """
    rows = []
    for org in organizations_data:
        if not all_statuses and org.get("application_status") not in _EXPORTABLE_STATUSES:
            continue
        role_text = ""
        if org.get("is_exhibitor") and org.get("is_buyer"):
            role_text = "참가기업/바이어"
        elif org.get("is_exhibitor"):
            role_text = "참가기업"
        elif org.get("is_buyer"):
            role_text = "바이어"

        status_display = {
            "registered": "등록",
            "submitted": "제출",
            "approved": "승인",
            "changes_requested": "변경요청",
            "rejected": "거절",
        }.get(org.get("application_status"), "")

        registered_at = org.get("registered_at")
        registered_display = _to_datetime(registered_at).strftime("%Y-%m-%d") if registered_at else ""

        rows.append({
            "기업명(국문) / Company Name (KO)": org.get("name_ko") or "",
            "기업명(영문) / Company Name (EN)": org.get("name_en") or "",
            "역할 / Role": role_text,
            "승인상태 / Status": status_display,
            "담당자명 / Contact Name": org.get("contact_name") or "",
            "연락처 / Contact Email": org.get("contact_email") or "",
            "전화 / Phone": org.get("contact_phone") or "",
            "부스 / Booth": org.get("booth_location") or "",
            "키워드 / Keywords": org.get("keywords") or "",
            "등록일 / Registered At": registered_display,
            "대리작성 / Proxy Submit": "N/A",
        })
    return rows


def _to_datetime(value: datetime | str) -> datetime:
    """DB datetime이거나 ISO 문자열(직렬화·테스트 경로 혼재)인 시각 값을 datetime으로 정규화."""
    return datetime.fromisoformat(value) if isinstance(value, str) else value


def format_meetings_rows(
    meetings_data: list[dict],
    *,
    slot_minutes: int,
) -> list[dict[str, str]]:
    """미팅 목록 데이터 → 엑셀 행 dict 리스트.

    Args:
        meetings_data: router가 조회한 미팅 행들.
        slot_minutes: **이 행사의** 슬롯 한 칸 길이(``events.slot_minutes``). ``scheduled_end`` 가
            없는 행의 소요시간 폴백과 "슬롯" 칼럼의 칸 길이에 쓴다. 필수 인자로 둔 이유: 예전에는
            모듈 상수 ``_SLOT_MINUTES = 30`` 이었는데, 격자가 "40분 상담 + 5분 텀"(mt003gap0001)으로
            바뀌면 그 상수는 조용히 거짓이 된다 — 기본값을 주면 호출부가 넘기는 걸 잊어도 테스트가
            통과해버리므로 아예 강제한다.
    """
    rows = []
    for meeting in meetings_data:
        start = meeting.get("scheduled_start")
        end = meeting.get("scheduled_end")
        date_str = ""
        time_str = ""
        slot_str = ""
        if start:
            dt = _to_datetime(start)
            date_str = dt.strftime("%Y-%m-%d")
            # 시간은 scheduled_end 실측 기준, 없으면 이 행사의 슬롯 길이로만 메운다(30분 가정 금지).
            end_dt = _to_datetime(end) if end else dt + timedelta(minutes=slot_minutes)
            time_str = f"{dt:%H:%M}~{end_dt:%H:%M}"
            # "슬롯" 칼럼은 이 미팅이 **시작하는 그리드 한 칸**. 구버전처럼 시작 시각을 30분 그리드로
            # floor 하면 40분/텀5분 격자에는 존재하지 않는 칸(예: "10:40-11:10")이 찍힌다. 칸의 시작은
            # 이미 그리드에 정렬돼 있으므로 floor 하지 않고 칸 길이만 이 행사의 값으로 쓴다.
            slot_str = f"{dt:%H:%M}-{dt + timedelta(minutes=slot_minutes):%H:%M}"

        status_map = {
            "proposed": "예정",
            "accepted": "확정",
            "rejected": "거절",
            "cancelled": "취소",
            "completed": "완료",
        }

        provenance_map = {
            "ai": "AI매칭",
            "open": "개방",
            "forced": "강제",
            "on_site": "현장",
        }

        rows.append({
            "날짜 / Date": date_str,
            "시간 / Time": time_str,
            "슬롯 / Slot": slot_str,
            "참가기업 / Exhibitor": meeting.get("exhibitor_name") or "",
            "바이어 / Buyer": meeting.get("buyer_name") or "",
            "미팅상태 / Status": status_map.get(meeting.get("status"), ""),
            "발생근거 / Provenance": provenance_map.get(meeting.get("matching_type"), ""),
            "장소 / Venue": meeting.get("venue_label") or "",
            "노쇼 여부 / No-show": "Y" if meeting.get("counterpart_noshow") else "N",
        })
    return rows


def format_reviews_rows(
    reviews_data: list[dict],
) -> list[dict[str, str]]:
    """회의록 현황 데이터 → 엑셀 행 dict 리스트."""
    rows = []
    for review in reviews_data:
        start = review.get("scheduled_start")
        date_str = _to_datetime(start).strftime("%Y-%m-%d") if start else ""

        rows.append({
            "날짜 / Date": date_str,
            "참가기업 / Exhibitor": review.get("exhibitor_name") or "",
            "바이어 / Buyer": review.get("buyer_name") or "",
            "리뷰작성(참가기업) / Review by Exhibitor": "Y" if review.get("exhibitor_reviewed") else "N",
            "리뷰작성(바이어) / Review by Buyer": "Y" if review.get("buyer_reviewed") else "N",
            "러브콜 / Love Call": "Y" if review.get("has_love_call") else "N",
        })
    return rows


#  운영자가 "볼품없다"고 느끼지 않게 — 헤더 스타일(진한 배경+흰 굵은 글자+가운데정렬)·자동 열너비·
# 자동필터·틀고정을 표준 스타일로 굳힌다(이슈: 참가기업 명단 내보내기 가독성 개선).
_HEADER_FILL = PatternFill(start_color="FF1F2A44", end_color="FF1F2A44", fill_type="solid")  # 네이비
_HEADER_FONT = Font(bold=True, color="FFFFFFFF")
_HEADER_ALIGNMENT = Alignment(horizontal="center", vertical="center", wrap_text=True)

_COL_WIDTH_MIN = 10
_COL_WIDTH_MAX = 40
_COL_WIDTH_PADDING = 2


def _display_width(text: str) -> float:
    """엑셀 열너비 근사 계산용 문자 폭. 한글·한자 등 전각 문자는 라틴 문자의 약 2배로 보이므로
    2, 그 외(영문·숫자·기호)는 1로 셈한다 — 정밀 폰트 메트릭이 아니라 잘림 방지용 휴리스틱이다.
    """
    width = 0.0
    for ch in text:
        code = ord(ch)
        is_wide = (
            0x1100 <= code <= 0x115F  # 한글 자모
            or 0x2E80 <= code <= 0xA4CF  # CJK 부수~한글 호환 자모~한자~가나 전체 대역
            or 0xAC00 <= code <= 0xD7A3  # 한글 음절
            or 0xF900 <= code <= 0xFAFF  # CJK 호환 한자
            or 0xFF00 <= code <= 0xFFEF  # 전각 형태
        )
        width += 2 if is_wide else 1
    return width


def _autofit_column_width(header: str, values: list[str]) -> int:
    """헤더/값 중 가장 넓은 표시폭 + 여백을 [최소, 최대]로 클램프 — 내용이 안 잘리되 과하게 넓어지지 않게."""
    widest = max([_display_width(header)] + [_display_width(v) for v in values], default=0.0)
    return int(min(_COL_WIDTH_MAX, max(_COL_WIDTH_MIN, widest + _COL_WIDTH_PADDING)))


def _build_workbook(sheet_title: str, rows: list[dict[str, str]]) -> Workbook:
    """스타일 갖춘 헤더(굵게+배경색+가운데정렬) + 자동 열너비 + 자동필터 + 틀고정(A2) 단일 시트
    워크북. 세 build_* 함수가 공유하는 내부 헬퍼."""
    wb = Workbook()
    ws = wb.active
    ws.title = sheet_title

    if not rows:
        return wb

    headers = list(rows[0].keys())
    ws.append(headers)

    for cell in ws[1]:
        cell.font = _HEADER_FONT
        cell.fill = _HEADER_FILL
        cell.alignment = _HEADER_ALIGNMENT

    for row_data in rows:
        ws.append([row_data.get(h, "") for h in headers])

    for idx, header in enumerate(headers, start=1):
        values = [str(row_data.get(header, "")) for row_data in rows]
        ws.column_dimensions[get_column_letter(idx)].width = _autofit_column_width(header, values)

    last_col = get_column_letter(len(headers))
    ws.auto_filter.ref = f"A1:{last_col}{len(rows) + 1}"  # 헤더행에 필터 드롭다운
    ws.freeze_panes = "A2"  # 헤더행 고정 — 스크롤해도 헤더가 보인다

    return wb


def build_organizations_workbook(rows: list[dict[str, str]]) -> Workbook:
    """기업 목록 행 리스트 → openpyxl Workbook."""
    return _build_workbook("기업목록", rows)


def build_meetings_workbook(rows: list[dict[str, str]]) -> Workbook:
    """미팅 목록 행 리스트 → openpyxl Workbook."""
    return _build_workbook("미팅목록", rows)


def build_reviews_workbook(rows: list[dict[str, str]]) -> Workbook:
    """회의록 현황 행 리스트 → openpyxl Workbook."""
    return _build_workbook("회의록현황", rows)
