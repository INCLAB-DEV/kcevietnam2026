"""slot-grid 단위 테스트 — 미팅 슬롯 그리드 생성·왕복(app.matching.slot_grid) 검증.

**순수 모듈** — DB·현재시각 픽스처를 쓰지 않는다(migrated_db/db_session 금지). "지금"은 항상
`now` 인자로 주입한다. 슬롯 id 형식(``"YYYY-MM-DDTHH:MM"``)은
``exhibitor_profiles.unavailable_meeting_slots``·프런트 ``TimeSlot.id``와 공유하는 계약이라
이 파일의 형식 테스트는 문자열을 하드코딩해 고정한다(회귀 방지).
"""

from __future__ import annotations

from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo

import pytest

from app.matching.slot_grid import (
    DEFAULT_MAX_MEETING_MINUTES,
    SchedulePolicy,
    SlotError,
    build_grid,
    grid_slot_ids,
    run_slot_ids,
    slot_datetime,
    slot_id,
    validate_slot_run,
)

# =============================================================================
# 공통 정책 픽스처
# =============================================================================
# 표준 정책: 서울, 30분 슬롯, 09:00~18:00 운영, 점심 12:00~13:00, 9/16~9/18 3일.
SEOUL_LUNCH_POLICY = SchedulePolicy(
    operating_start=time(9, 0),
    operating_end=time(18, 0),
    slot_minutes=30,
    timezone="Asia/Seoul",
    exhibition_start=date(2026, 9, 16),
    exhibition_end=date(2026, 9, 18),
    lunch_start=time(12, 0),
    lunch_end=time(13, 0),
)

# 같은 정책을 호치민 타임존(UTC+7)으로 — 절대시각이 서울(+9)과 달라야 한다.
HCM_LUNCH_POLICY = SchedulePolicy(
    operating_start=time(9, 0),
    operating_end=time(18, 0),
    slot_minutes=30,
    timezone="Asia/Ho_Chi_Minh",
    exhibition_start=date(2026, 9, 16),
    exhibition_end=date(2026, 9, 18),
    lunch_start=time(12, 0),
    lunch_end=time(13, 0),
)

# 점심 없는 정책 — 오전/오후 경계(12:00) 자체를 점심과 분리해서 본다.
NO_LUNCH_POLICY = SchedulePolicy(
    operating_start=time(9, 0),
    operating_end=time(18, 0),
    slot_minutes=30,
    timezone="Asia/Seoul",
    exhibition_start=date(2026, 9, 16),
    exhibition_end=date(2026, 9, 16),
)

# 10분 슬롯, 점심 없음 — slot_minutes 변형 + 하루 슬롯 개수 검증용.
TEN_MIN_POLICY = SchedulePolicy(
    operating_start=time(9, 0),
    operating_end=time(18, 0),
    slot_minutes=10,
    timezone="Asia/Seoul",
    exhibition_start=date(2026, 9, 16),
    exhibition_end=date(2026, 9, 16),
)

# 60분 슬롯 + 점심 — slot_minutes 변형과 점심 스킵이 겹치는 경계 검증용.
SIXTY_MIN_LUNCH_POLICY = SchedulePolicy(
    operating_start=time(9, 0),
    operating_end=time(18, 0),
    slot_minutes=60,
    timezone="Asia/Seoul",
    exhibition_start=date(2026, 9, 16),
    exhibition_end=date(2026, 9, 16),
    lunch_start=time(12, 0),
    lunch_end=time(13, 0),
)

# 운영 종료가 슬롯 배수에 딱 안 맞는 정책 — 마지막 슬롯이 운영시간을 넘지 않는지 검증용.
BOUNDARY_POLICY = SchedulePolicy(
    operating_start=time(9, 0),
    operating_end=time(17, 45),
    slot_minutes=30,
    timezone="Asia/Seoul",
    exhibition_start=date(2026, 9, 16),
    exhibition_end=date(2026, 9, 16),
)

# 발주사(마인즈그라운드) 운영표 그대로 — "40분 상담 + 5분 텀", 10:00~18:10, 점심 12:10~13:00,
# 10/20~10/22 3일. 상담 길이와 슬롯 간격이 **다른** 유일한 픽스처라 stride 경로는 전부 이걸로 검증한다
# (mt003gap0001). 하루 10칸 × 3일 = 30칸이 나와야 한다.
CLIENT_GRID_POLICY = SchedulePolicy(
    operating_start=time(10, 0),
    operating_end=time(18, 10),
    slot_minutes=40,
    timezone="Asia/Seoul",
    exhibition_start=date(2026, 10, 20),
    exhibition_end=date(2026, 10, 22),
    lunch_start=time(12, 10),
    lunch_end=time(13, 0),
    gap_minutes=5,
)

#: 발주사 운영표의 하루 10칸(시작~종료). 위 정책이 이걸 분 단위까지 재현해야 한다.
CLIENT_GRID_DAY = [
    "10:00-10:40",
    "10:45-11:25",
    "11:30-12:10",
    "13:00-13:40",
    "13:45-14:25",
    "14:30-15:10",
    "15:15-15:55",
    "16:00-16:40",
    "16:45-17:25",
    "17:30-18:10",
]

# validate_slot_run의 now 인자 — 모든 정책의 행사 기간보다 앞선 시각(주입식 "지금").
NOW_BEFORE_EXHIBITION = datetime(2026, 9, 1, tzinfo=ZoneInfo("Asia/Seoul"))


def _base_policy_kwargs(**overrides):
    """SchedulePolicy 방어 테스트용 — 유효한 기본값에 한 필드만 깨서 override."""
    kwargs = dict(
        operating_start=time(9, 0),
        operating_end=time(18, 0),
        slot_minutes=30,
        timezone="Asia/Seoul",
        exhibition_start=date(2026, 9, 16),
        exhibition_end=date(2026, 9, 16),
    )
    kwargs.update(overrides)
    return kwargs


# =============================================================================
# 슬롯 id 왕복 + 형식
# =============================================================================
@pytest.mark.parametrize("tz_name", ["Asia/Seoul", "Asia/Ho_Chi_Minh"])
def test_slot_id_round_trip(tz_name):
    zone = ZoneInfo(tz_name)
    moment = datetime(2026, 9, 16, 9, 30, tzinfo=zone)
    assert slot_datetime(slot_id(moment), tz_name) == moment


def test_slot_id_rejects_naive_datetime():
    # 어느 벽시계인지 알 수 없는 naive datetime은 조용히 UTC로 취급하지 않고 거부한다.
    with pytest.raises(SlotError):
        slot_id(datetime(2026, 9, 16, 9, 0))


@pytest.mark.parametrize("value", ["2026-09-16 09:00", "garbage"])
def test_slot_datetime_rejects_malformed_string(value):
    with pytest.raises(SlotError):
        slot_datetime(value, "Asia/Seoul")


def test_slot_id_format_is_pinned():
    # ⚠ 이 형식은 exhibitor_profiles.unavailable_meeting_slots·프런트 TimeSlot.id와 공유하는
    # 계약이다 — 바뀌면 두 곳이 동시에 깨지므로 문자열을 그대로 하드코딩해 고정한다.
    moment = datetime(2026, 9, 16, 9, 0, tzinfo=ZoneInfo("Asia/Seoul"))
    assert slot_id(moment) == "2026-09-16T09:00"


# =============================================================================
# 점심 슬롯은 생성 자체가 안 됨
# =============================================================================
def test_lunch_slots_are_absent_not_marked_unavailable():
    grid = build_grid(SEOUL_LUNCH_POLICY)
    day = grid[0]
    ids = {slot.id for slot in day.slots}
    # available=False가 아니라 애초에 그리드에 없어야 한다.
    assert "2026-09-16T12:00" not in ids
    assert "2026-09-16T12:30" not in ids
    assert "2026-09-16T11:30" in ids  # 점심 직전 칸은 정상 생성.
    assert day.afternoon[0].time == "13:00"  # 오후 첫 슬롯은 점심 끝나는 13:00부터.


# =============================================================================
# 오전/오후 경계
# =============================================================================
def test_morning_afternoon_boundary_without_lunch():
    # 점심이 없는 정책에서도 경계는 순수하게 12:00 미만 여부로만 갈린다.
    grid = build_grid(NO_LUNCH_POLICY)
    day = grid[0]
    slots_by_time = {slot.time: slot for slot in day.slots}
    assert slots_by_time["11:30"] in day.morning
    assert slots_by_time["12:00"] in day.afternoon


# =============================================================================
# slot_minutes 변형
# =============================================================================
def test_slot_minutes_10_daily_count_and_boundary():
    grid = build_grid(TEN_MIN_POLICY)
    day = grid[0]
    # 09:00~18:00 = 540분 / 10분 = 54칸.
    assert len(day.slots) == 54
    assert day.slots[0].time == "09:00"
    assert day.slots[-1].time == "17:50"


def test_slot_minutes_60_with_lunch_daily_slots():
    grid = build_grid(SIXTY_MIN_LUNCH_POLICY)
    day = grid[0]
    times = [slot.time for slot in day.slots]
    assert times == ["09:00", "10:00", "11:00", "13:00", "14:00", "15:00", "16:00", "17:00"]


# =============================================================================
# 운영 종료 경계
# =============================================================================
def test_last_slot_end_does_not_exceed_operating_end():
    # 09:00~17:45 운영, 30분 슬롯 — 17:00 슬롯(end 17:30)까지만 있고 17:30 슬롯(end 18:00)은 없다.
    grid = build_grid(BOUNDARY_POLICY)
    ids = {slot.id for slot in grid[0].slots}
    assert "2026-09-16T17:00" in ids
    assert "2026-09-16T17:30" not in ids


# =============================================================================
# 타임존
# =============================================================================
def test_validate_slot_run_timezone_offset_ho_chi_minh():
    run = validate_slot_run(
        HCM_LUNCH_POLICY, ["2026-09-16T09:00"], now=NOW_BEFORE_EXHIBITION
    )
    assert run.start.utcoffset() == timedelta(hours=7)


def test_same_slot_id_is_different_absolute_time_across_timezones():
    # 같은 로컬 벽시계 문자열("09:00")이라도 행사 타임존이 다르면 절대시각이 다르다(+9 vs +7).
    seoul_run = validate_slot_run(
        SEOUL_LUNCH_POLICY, ["2026-09-16T09:00"], now=NOW_BEFORE_EXHIBITION
    )
    hcm_run = validate_slot_run(
        HCM_LUNCH_POLICY, ["2026-09-16T09:00"], now=NOW_BEFORE_EXHIBITION
    )
    assert seoul_run.start != hcm_run.start


# =============================================================================
# 연속성 검증(validate_slot_run) — 정상 케이스
# =============================================================================
def test_default_max_meeting_minutes_is_ninety():
    # 상한이 "칸 수"에서 "분"으로 바뀌었다(mt003gap0001). 기본값 90은 현행 30분×3칸=90분을 그대로
    # 허용해야 하므로 아래 정상/실패 케이스들이 정확히 "한도"와 "한도+1칸"을 시험하게 된다.
    assert DEFAULT_MAX_MEETING_MINUTES == 90
    assert SEOUL_LUNCH_POLICY.max_meeting_minutes == DEFAULT_MAX_MEETING_MINUTES


def test_single_slot_run():
    run = validate_slot_run(
        SEOUL_LUNCH_POLICY, ["2026-09-16T09:00"], now=NOW_BEFORE_EXHIBITION
    )
    assert run.slot_ids == ("2026-09-16T09:00",)
    assert run.start == slot_datetime("2026-09-16T09:00", "Asia/Seoul")
    assert run.end == slot_datetime("2026-09-16T09:30", "Asia/Seoul")
    assert run.duration_minutes == 30


def test_two_slot_run():
    run = validate_slot_run(
        SEOUL_LUNCH_POLICY,
        ["2026-09-16T09:00", "2026-09-16T09:30"],
        now=NOW_BEFORE_EXHIBITION,
    )
    assert run.start == slot_datetime("2026-09-16T09:00", "Asia/Seoul")
    assert run.end == slot_datetime("2026-09-16T10:00", "Asia/Seoul")
    assert run.duration_minutes == 60


def test_three_slot_run():
    run = validate_slot_run(
        SEOUL_LUNCH_POLICY,
        ["2026-09-16T09:00", "2026-09-16T09:30", "2026-09-16T10:00"],
        now=NOW_BEFORE_EXHIBITION,
    )
    assert run.start == slot_datetime("2026-09-16T09:00", "Asia/Seoul")
    assert run.end == slot_datetime("2026-09-16T10:30", "Asia/Seoul")
    assert run.duration_minutes == 90


def test_run_order_independent_of_input_order():
    # 사용자가 09:30을 먼저 골랐어도 정렬 후 인접성을 보므로 통과하고, start는 이른 쪽이다.
    run = validate_slot_run(
        SEOUL_LUNCH_POLICY,
        ["2026-09-16T09:30", "2026-09-16T09:00"],
        now=NOW_BEFORE_EXHIBITION,
    )
    assert run.start == slot_datetime("2026-09-16T09:00", "Asia/Seoul")
    assert run.slot_ids == ("2026-09-16T09:00", "2026-09-16T09:30")


# =============================================================================
# 연속성 검증(validate_slot_run) — 실패 케이스
# =============================================================================
def test_four_slot_run_exceeds_max():
    # 4칸은 인접성·그리드 소속은 모두 통과하고 **스팬**(09:00~11:00 = 120분)이 상한 90분을 넘는다.
    # 구버전은 칸 수(>3)로 막았고 지금은 분으로 막는다 — 30분/gap=0 에서는 둘 다 같은 결과다.
    ids = ["2026-09-16T09:00", "2026-09-16T09:30", "2026-09-16T10:00", "2026-09-16T10:30"]
    with pytest.raises(SlotError, match="최대 90분"):
        validate_slot_run(SEOUL_LUNCH_POLICY, ids, now=NOW_BEFORE_EXHIBITION)


# =============================================================================
# 발주사 운영표 격자(40분 상담 + 5분 텀) — mt003gap0001
# =============================================================================
def test_client_grid_day_is_reproduced_exactly():
    """§5-1 인수기준: 발주사 운영표의 하루 10칸을 분 단위까지 재현한다."""
    day = build_grid(CLIENT_GRID_POLICY)[0]
    assert [f"{s.time}-{s.end:%H:%M}" for s in day.slots] == CLIENT_GRID_DAY
    # 오전 3칸(10:00·10:45·11:30) / 오후 7칸 — 12:15 칸은 점심 [12:10,13:00) 에 먹혀 생성되지 않는다.
    assert (len(day.morning), len(day.afternoon)) == (3, 7)


def test_client_grid_slot_length_is_forty_not_stride():
    # 칸의 **길이**는 40분이고 간격(stride)은 45분 — 이 둘이 같아지면 10:00/10:40/11:20… 으로 어긋난다.
    assert CLIENT_GRID_POLICY.stride_minutes == 45
    day = build_grid(CLIENT_GRID_POLICY)[0]
    assert all(s.end - s.start == timedelta(minutes=40) for s in day.slots)
    starts = [s.start for s in day.slots]
    # 점심으로 끊기는 11:30→13:00 을 빼면 인접 칸 사이는 정확히 45분.
    gaps = {b - a for a, b in zip(starts, starts[1:])}
    assert gaps == {timedelta(minutes=45), timedelta(minutes=90)}


def test_client_grid_three_days_has_thirty_slots():
    grid = build_grid(CLIENT_GRID_POLICY)
    assert [d.id for d in grid] == ["2026-10-20", "2026-10-21", "2026-10-22"]
    assert sum(len(d.slots) for d in grid) == 30


def test_client_grid_last_slot_ends_exactly_at_closing():
    # 17:30 + 40분 = 18:10 == operating_end → 살아남는다(경계 포함). 한 칸 더(18:15)는 마감 초과로 탈락.
    day = build_grid(CLIENT_GRID_POLICY)[0]
    assert day.slots[-1].time == "17:30"
    assert day.slots[-1].end.strftime("%H:%M") == "18:10"


def test_slot_touching_lunch_start_is_kept():
    # 11:30~12:10 칸은 lunch_start=12:10 과 **접하기만** 한다(반열림 구간이라 겹침 아님) → 생성된다.
    day = build_grid(CLIENT_GRID_POLICY)[0]
    assert "11:30-12:10" in [f"{s.time}-{s.end:%H:%M}" for s in day.slots]


@pytest.mark.parametrize(
    ("ids", "expected_minutes"),
    [
        # §2 상한 표 — 40분/텀5분, 상한 90분.
        (["2026-10-20T10:00"], 40),
        (["2026-10-20T10:00", "2026-10-20T10:45"], 85),
    ],
)
def test_client_grid_run_within_cap(ids, expected_minutes):
    run = validate_slot_run(CLIENT_GRID_POLICY, ids, now=NOW_BEFORE_EXHIBITION)
    assert run.duration_minutes == expected_minutes
    assert run.end - run.start == timedelta(minutes=expected_minutes)


def test_client_grid_three_slots_exceed_ninety_minute_cap():
    # 3칸 스팬 = 10:00~12:10 = 130분 > 90분. 칸 수(3)는 구버전 상한과 같지만 **분**으로 막힌다.
    ids = ["2026-10-20T10:00", "2026-10-20T10:45", "2026-10-20T11:30"]
    with pytest.raises(SlotError, match="최대 90분"):
        validate_slot_run(CLIENT_GRID_POLICY, ids, now=NOW_BEFORE_EXHIBITION)


def test_client_grid_three_slots_allowed_when_cap_raised():
    # 상한은 배포 없이 설정값으로 푼다 — 135분으로 올리면 같은 3칸(130분)이 통과해야 한다.
    policy = SchedulePolicy(
        operating_start=CLIENT_GRID_POLICY.operating_start,
        operating_end=CLIENT_GRID_POLICY.operating_end,
        slot_minutes=40,
        timezone="Asia/Seoul",
        exhibition_start=date(2026, 10, 20),
        exhibition_end=date(2026, 10, 22),
        lunch_start=time(12, 10),
        lunch_end=time(13, 0),
        gap_minutes=5,
        max_meeting_minutes=135,
    )
    ids = ["2026-10-20T10:00", "2026-10-20T10:45", "2026-10-20T11:30"]
    assert validate_slot_run(policy, ids, now=NOW_BEFORE_EXHIBITION).duration_minutes == 130


def test_client_grid_run_across_lunch_rejected():
    # §5-4: 11:30 칸과 13:00 칸은 한 미팅으로 이어 붙일 수 없다. 11:30 의 다음 칸은 (점심에 먹힌)
    # 12:15 이므로 인접성 검사에서 자동으로 걸린다 — 별도 "점심 횡단 금지" 분기는 없다.
    with pytest.raises(SlotError, match="연속된 슬롯이 아니다"):
        validate_slot_run(
            CLIENT_GRID_POLICY, ["2026-10-20T11:30", "2026-10-20T13:00"], now=NOW_BEFORE_EXHIBITION
        )


def test_client_grid_rejects_old_thirty_minute_slot_ids():
    # 격자가 바뀌면 구 30분 키는 더 이상 그리드에 속하지 않는다(unavailable_meeting_slots 백필이
    # 필요한 이유 — 마이그레이션 §5.2 참고).
    assert "2026-10-20T09:30" not in grid_slot_ids(CLIENT_GRID_POLICY)
    assert "2026-10-20T10:45" in grid_slot_ids(CLIENT_GRID_POLICY)


def test_zero_gap_policy_matches_legacy_grid():
    """§5-2 하위호환: gap=0 이면 간격 == 길이로, 구동작과 동일한 격자가 나와야 한다."""
    with_gap_zero = SchedulePolicy(
        operating_start=time(9, 0),
        operating_end=time(18, 0),
        slot_minutes=30,
        timezone="Asia/Seoul",
        exhibition_start=date(2026, 9, 16),
        exhibition_end=date(2026, 9, 16),
        lunch_start=time(12, 0),
        lunch_end=time(13, 0),
        gap_minutes=0,
    )
    assert with_gap_zero.stride_minutes == 30
    explicit = build_grid(with_gap_zero)[0].slots
    assert [s.id for s in explicit] == [s.id for s in build_grid(SEOUL_LUNCH_POLICY)[0].slots]
    # gap=0 기본값으로도 동일해야 한다(기존 호출부가 gap을 안 넘기는 경로).
    assert all(s.end - s.start == timedelta(minutes=30) for s in explicit)


def test_policy_rejects_negative_gap():
    with pytest.raises(SlotError, match="음수"):
        SchedulePolicy(**_base_policy_kwargs(gap_minutes=-5))


def test_policy_rejects_cap_smaller_than_one_slot():
    # 상한이 한 칸보다 작으면 어떤 미팅도 예약 불가능한 정책이 된다 — 조용히 빈 결과를 내지 않고 실패.
    with pytest.raises(SlotError, match="작을 수 없다"):
        SchedulePolicy(**_base_policy_kwargs(slot_minutes=40, max_meeting_minutes=30))


def test_empty_slot_list_rejected():
    with pytest.raises(SlotError):
        validate_slot_run(SEOUL_LUNCH_POLICY, [], now=NOW_BEFORE_EXHIBITION)


def test_duplicate_slot_rejected():
    ids = ["2026-09-16T09:00", "2026-09-16T09:00"]
    with pytest.raises(SlotError):
        validate_slot_run(SEOUL_LUNCH_POLICY, ids, now=NOW_BEFORE_EXHIBITION)


def test_different_dates_rejected():
    ids = ["2026-09-16T09:00", "2026-09-17T09:00"]
    with pytest.raises(SlotError):
        validate_slot_run(SEOUL_LUNCH_POLICY, ids, now=NOW_BEFORE_EXHIBITION)


def test_non_adjacent_slots_rejected():
    # 30분 슬롯 정책에서 09:00과 10:00은 사이에 빈틈(09:30)이 있다.
    ids = ["2026-09-16T09:00", "2026-09-16T10:00"]
    with pytest.raises(SlotError):
        validate_slot_run(SEOUL_LUNCH_POLICY, ids, now=NOW_BEFORE_EXHIBITION)


def test_run_across_lunch_gap_rejected():
    # 11:30 다음 실제 슬롯은 13:00이지만 stride(30분, gap=0) 기준 인접이 아니므로 인접성 검사에서
    # 걸린다 — "점심을 가로지르면 안 된다"는 별도 분기는 없고 이 검사 하나로 족하다(mt003gap0001).
    ids = ["2026-09-16T11:30", "2026-09-16T13:00"]
    with pytest.raises(SlotError):
        validate_slot_run(SEOUL_LUNCH_POLICY, ids, now=NOW_BEFORE_EXHIBITION)


def test_run_selecting_lunch_slot_directly_rejected():
    # 60분 슬롯 정책에서 11:00→12:00은 산술적으로는 인접(60분 간격)이지만, 12:00은 점심이라
    # 그리드에 아예 없다 — 인접성 검사가 아니라 그리드 소속 검사에서 걸려야 한다.
    ids = ["2026-09-16T11:00", "2026-09-16T12:00"]
    with pytest.raises(SlotError):
        validate_slot_run(SIXTY_MIN_LUNCH_POLICY, ids, now=NOW_BEFORE_EXHIBITION)


def test_outside_operating_hours_rejected():
    ids = ["2026-09-16T08:00"]
    with pytest.raises(SlotError):
        validate_slot_run(SEOUL_LUNCH_POLICY, ids, now=NOW_BEFORE_EXHIBITION)


def test_outside_exhibition_period_rejected():
    # SEOUL_LUNCH_POLICY의 행사 기간은 9/16~9/18까지다.
    ids = ["2026-09-20T09:00"]
    with pytest.raises(SlotError):
        validate_slot_run(SEOUL_LUNCH_POLICY, ids, now=NOW_BEFORE_EXHIBITION)


def test_past_run_rejected():
    past_now = datetime(2026, 9, 17, 0, 0, tzinfo=ZoneInfo("Asia/Seoul"))
    with pytest.raises(SlotError):
        validate_slot_run(SEOUL_LUNCH_POLICY, ["2026-09-16T09:00"], now=past_now)


def test_run_exactly_at_now_rejected():
    # start <= now 이므로 경계(현재 진행 중인 슬롯)도 거부된다.
    start = slot_datetime("2026-09-16T09:00", "Asia/Seoul")
    with pytest.raises(SlotError):
        validate_slot_run(SEOUL_LUNCH_POLICY, ["2026-09-16T09:00"], now=start)


def test_naive_now_rejected():
    with pytest.raises(SlotError):
        validate_slot_run(SEOUL_LUNCH_POLICY, ["2026-09-16T09:00"], now=datetime(2026, 9, 1))


# =============================================================================
# SchedulePolicy 방어
# =============================================================================
@pytest.mark.parametrize(
    "overrides",
    [
        {"slot_minutes": 0},
        {"slot_minutes": -10},
        {"operating_end": time(9, 0)},  # == operating_start
        {"operating_start": time(18, 0), "operating_end": time(9, 0)},  # end < start
        {"exhibition_start": date(2026, 9, 17), "exhibition_end": date(2026, 9, 16)},
    ],
)
def test_schedule_policy_rejects_invalid_input(overrides):
    with pytest.raises(SlotError):
        SchedulePolicy(**_base_policy_kwargs(**overrides))


# =============================================================================
# run_slot_ids
# =============================================================================
def test_run_slot_ids_single_slot():
    zone = ZoneInfo("Asia/Seoul")
    start = datetime(2026, 9, 16, 9, 0, tzinfo=zone)
    end = datetime(2026, 9, 16, 9, 30, tzinfo=zone)
    assert run_slot_ids(SEOUL_LUNCH_POLICY, start, end) == ("2026-09-16T09:00",)


def test_run_slot_ids_three_slots():
    zone = ZoneInfo("Asia/Seoul")
    start = datetime(2026, 9, 16, 9, 0, tzinfo=zone)
    end = datetime(2026, 9, 16, 10, 30, tzinfo=zone)
    assert run_slot_ids(SEOUL_LUNCH_POLICY, start, end) == (
        "2026-09-16T09:00",
        "2026-09-16T09:30",
        "2026-09-16T10:00",
    )


# =============================================================================
# grid_slot_ids
# =============================================================================
def test_grid_slot_ids_matches_build_grid():
    grid = build_grid(SEOUL_LUNCH_POLICY)
    expected = {slot.id for day in grid for slot in day.slots}
    assert expected  # 정책이 최소한의 슬롯은 만든다는 전제 자체도 깨지지 않았는지 확인.
    assert grid_slot_ids(SEOUL_LUNCH_POLICY) == expected
