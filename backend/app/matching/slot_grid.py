"""slot-grid — 미팅 슬롯 그리드 생성과 슬롯 id 왕복 (F-MT-001).

**순수 모듈** — DB·현재시각·I/O 의존이 없다. "지금"은 항상 인자로 주입받는다(결정적 테스트).

슬롯 id 형식은 ``"YYYY-MM-DDTHH:MM"`` (행사 로컬 시각). ⚠ **이 형식은 바꾸면 안 된다** — 이미
두 곳이 같은 문자열을 쓴다:

- ``exhibitor_profiles.unavailable_meeting_slots`` (참가사가 저장해둔 미팅 불가 슬롯 키)
- 프런트 ``TimeSlot.id`` (``frontend/lib/meeting/types.ts``)

타임존은 행사별(``events.timezone``, IANA 문자열)이다 — KST를 코드에 박지 않는다. 문자열 id는
**로컬 벽시계 시각**이고, DB에 들어가는 ``scheduled_start/end``는 그 시각을 행사 타임존으로 해석한
tz-aware datetime이다. 이 변환의 단일 지점이 여기다.

점심시간은 "슬롯을 만들되 막는" 게 아니라 **아예 생성하지 않는다**. 막힌 슬롯으로 두면 "왜 이건
불가인가"라는 상태가 늘고(참가사 opt-out 불가와 구분 불가), 클라이언트가 점심 규칙을 다시 알아야
한다. 그리드에 없으면 선택지 자체가 없다.

**상담 길이와 슬롯 간격은 다른 값이다** (mt003gap0001). 발주사 운영표가 "40분 상담 + 5분 텀"
(10:00~10:40, 10:45~11:25, 11:30~12:10 …)이라, 한 칸의 **길이**(``slot_minutes``)와 다음 칸까지의
**간격**(stride = ``slot_minutes + gap_minutes``)을 분리한다. 예전에는 이 둘이 같은 값이었고 그
가정 위에서 "슬롯 인덱스 × slot_minutes = 시작 시각"이 성립했다 — 이제는 stride를 써야 한다.
5분 텀은 **어느 미팅에도 점유되지 않는다**(칸 사이의 빈 시간). 단 연속 예약으로 묶인 미팅의
``scheduled_end`` 는 마지막 칸의 end 이므로, 2칸 예약의 스팬(10:00~11:25, 85분)에는 중간 텀이
**포함**된다 — ``tstzrange`` 단일 구간 EXCLUDE 제약이 불연속 구간을 표현할 수 없고, 상담 뒤 방을
비우는 시간도 점유로 잡는 게 운영상 맞기 때문이다.

연속 예약 상한은 **칸 수가 아니라 분**이다(``max_meeting_minutes``, 기본 90). 슬롯이 40분이 되면
3칸 스팬이 130분이 되어 원래 기준인 "최대 1시간 반"을 넘기 때문이다. 기본 90은 현행
``30분 × 3칸 = 90분`` 을 그대로 허용한다.

기지 한계 — **DST**: 슬롯 시각은 로컬 벽시계를 그대로 tz에 붙여(``replace(tzinfo=...)``) 만든다.
현재 대상 행사(``Asia/Seoul``·``Asia/Ho_Chi_Minh``)는 서머타임이 없어 문제가 없지만, DST가 있는
지역(예 ``Europe/Berlin``)에서 전환일에 걸치면 존재하지 않는 시각이나 두 번 오는 시각이 생긴다 —
그날 하루의 슬롯 경계가 한 칸 어긋날 수 있다. 그런 행사가 실제로 생길 때 fold/gap 처리를 넣는다
(지금 넣으면 검증할 사례가 없어 추측 코드가 된다).
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, time, timedelta
from typing import Final, Sequence
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

#: 슬롯 id의 strftime 포맷. ⚠ 변경 금지(위 docstring 참고).
SLOT_ID_FORMAT: Final = "%Y-%m-%dT%H:%M"

#: 오전/오후 경계 — 12:00 미만에 시작하면 오전.
NOON: Final = time(12, 0)

#: 미팅 1건 최대 길이(분) 기본값 — ``event_schedule_settings.max_meeting_minutes`` 의 server_default와
#: 같은 값. 진실원천은 그 컬럼이고, 여기 것은 정책 행을 못 읽었을 때의 폴백이 아니라 **테스트·문서가
#: 참조하는 이름**이다(구 ``MAX_RUN_SLOTS`` 의 자리). 칸 수 상한을 분 상한으로 바꾼 근거는 모듈
#: docstring 참고 — 40분 슬롯에서 3칸은 130분이 되어 "최대 1시간 반"을 넘는다.
DEFAULT_MAX_MEETING_MINUTES: Final = 90

#: 요일 표기(월=0). 프런트 MeetingDate.weekday와 같은 한 글자 표기.
_WEEKDAY_KO: Final = ("월", "화", "수", "목", "금", "토", "일")


class SlotError(ValueError):
    """슬롯 입력이 그리드/연속성 규칙을 어겼다 — 호출부가 422로 환산한다."""


@dataclass(frozen=True, slots=True)
class SchedulePolicy:
    """행사의 슬롯 정책 — ``events`` + ``event_schedule_settings``에서 조립한다.

    슬롯 길이는 ``events.slot_minutes`` 단일 진실원천에서 온다(mt001meet01에서 통합).
    칸 사이 텀(``gap_minutes``)과 미팅 최대 길이(``max_meeting_minutes``)는 행사별 운영 세부값이라
    ``event_schedule_settings`` 에서 온다(mt003gap0001).
    """

    operating_start: time
    operating_end: time
    slot_minutes: int
    timezone: str  # IANA 문자열(예: 'Asia/Seoul', 'Asia/Ho_Chi_Minh')
    exhibition_start: date
    exhibition_end: date  # 포함(inclusive) — 마지막 전시일도 미팅 가능
    lunch_start: time | None = None
    lunch_end: time | None = None
    #: 상담 한 칸 뒤의 텀(분). 0이면 간격 = 길이(구 동작과 동일).
    gap_minutes: int = 0
    #: 연속 슬롯으로 묶은 미팅 1건의 스팬 상한(분).
    max_meeting_minutes: int = DEFAULT_MAX_MEETING_MINUTES

    def __post_init__(self) -> None:
        if self.slot_minutes <= 0:
            raise SlotError(f"슬롯 길이는 양수여야 한다: {self.slot_minutes}")
        if self.gap_minutes < 0:
            raise SlotError(f"슬롯 사이 텀은 음수일 수 없다: {self.gap_minutes}")
        if self.max_meeting_minutes < self.slot_minutes:
            # 상한이 한 칸보다 작으면 어떤 미팅도 예약할 수 없는 정책이 된다 — 조용히 빈 격자를
            # 만들지 않고 여기서 실패한다(설정 오류는 가능한 한 일찍 드러내야 한다).
            raise SlotError(
                f"미팅 최대 길이({self.max_meeting_minutes}분)는 슬롯 한 칸 길이"
                f"({self.slot_minutes}분)보다 작을 수 없다"
            )
        if self.operating_end <= self.operating_start:
            raise SlotError("운영 종료 시각이 시작 시각보다 뒤여야 한다")
        if self.exhibition_end < self.exhibition_start:
            raise SlotError("행사 종료일이 시작일보다 앞설 수 없다")

    @property
    def stride_minutes(self) -> int:
        """한 칸의 시작에서 다음 칸의 시작까지(분) = 상담 길이 + 텀.

        격자 산술은 전부 이 값을 쓴다 — ``slot_minutes`` 를 간격으로 쓰면 40분 상담 + 5분 텀
        격자가 10:00/10:40/11:20… 으로 어긋난다(모듈 docstring의 실측 표 참고).
        """
        return self.slot_minutes + self.gap_minutes

    @property
    def zone(self) -> ZoneInfo:
        """행사 타임존. 알 수 없는 IANA 이름이면 :class:`SlotError`."""
        return resolve_zone(self.timezone)


@dataclass(frozen=True, slots=True)
class Slot:
    """그리드 한 칸. ``available``은 여기서 정하지 않는다(예약 상태는 DB 의존이라 service 몫)."""

    id: str  # "YYYY-MM-DDTHH:MM"
    time: str  # "HH:MM" — 화면 표기용
    start: datetime  # tz-aware(행사 타임존)
    end: datetime  # tz-aware, start + slot_minutes

    @property
    def is_morning(self) -> bool:
        return self.start.timetz().replace(tzinfo=None) < NOON


@dataclass(frozen=True, slots=True)
class DayGrid:
    """하루치 슬롯 — 오전/오후로 갈라 담는다(프런트 MeetingDate 계약)."""

    id: str  # "YYYY-MM-DD"
    label: str  # "9/16"
    weekday: str  # "화"
    morning: tuple[Slot, ...]
    afternoon: tuple[Slot, ...]

    @property
    def slots(self) -> tuple[Slot, ...]:
        return self.morning + self.afternoon


def resolve_zone(timezone: str) -> ZoneInfo:
    """IANA 타임존 문자열 → ZoneInfo. 해석 불가면 :class:`SlotError`.

    ``events.timezone``에 DB CHECK를 걸지 않는 대신(IANA DB를 CHECK로 흉내낼 수 없다) 값 검증을
    여기서 한다 — 잘못된 값은 조용히 UTC로 폴백하지 않고 명확히 실패한다.
    """
    try:
        return ZoneInfo(timezone)
    except (ZoneInfoNotFoundError, ValueError, KeyError) as exc:
        raise SlotError(f"알 수 없는 타임존: {timezone!r}") from exc


def slot_id(moment: datetime) -> str:
    """tz-aware datetime → 슬롯 id. **로컬 벽시계 시각**을 그대로 찍는다.

    tz-naive datetime은 어느 벽시계인지 알 수 없으므로 거부한다(조용한 UTC 가정 금지).
    """
    if moment.tzinfo is None:
        raise SlotError("슬롯 id는 tz-aware datetime에서만 만든다(naive 입력 거부)")
    return moment.strftime(SLOT_ID_FORMAT)


def slot_datetime(value: str, timezone: str | ZoneInfo) -> datetime:
    """슬롯 id → 행사 타임존의 tz-aware datetime. :func:`slot_id`의 역함수."""
    zone = timezone if isinstance(timezone, ZoneInfo) else resolve_zone(timezone)
    try:
        naive = datetime.strptime(value, SLOT_ID_FORMAT)
    except (ValueError, TypeError) as exc:
        raise SlotError(f"슬롯 id 형식이 아니다(YYYY-MM-DDTHH:MM): {value!r}") from exc
    return naive.replace(tzinfo=zone)


def _day_slots(policy: SchedulePolicy, day: date, zone: ZoneInfo) -> tuple[list[Slot], list[Slot]]:
    """하루치 (오전, 오후) 슬롯. 점심 구간과 겹치는 칸은 만들지 않는다.

    전진은 **stride**(상담 길이 + 텀)로 하고, 칸의 끝은 **상담 길이**로 정한다. 이 둘을 구분하지
    않으면 "40분 상담 + 5분 텀" 격자를 만들 수 없다(모듈 docstring의 실측 표 참고).
    ``gap_minutes=0`` 이면 stride == 상담 길이가 되어 구동작과 완전히 동일하다.
    """
    length = timedelta(minutes=policy.slot_minutes)
    stride = timedelta(minutes=policy.stride_minutes)
    cursor = datetime.combine(day, policy.operating_start, tzinfo=zone)
    closing = datetime.combine(day, policy.operating_end, tzinfo=zone)
    lunch = None
    if policy.lunch_start is not None and policy.lunch_end is not None:
        lunch = (
            datetime.combine(day, policy.lunch_start, tzinfo=zone),
            datetime.combine(day, policy.lunch_end, tzinfo=zone),
        )

    morning: list[Slot] = []
    afternoon: list[Slot] = []
    while cursor + length <= closing:
        end = cursor + length
        # 반열림 구간끼리의 겹침 — 점심 [12:10,13:00)에 걸치는 칸은 통째로 생략. 끝이 점심 시작과
        # **접하는** 것은 겹침이 아니다(11:30~12:10 칸은 lunch_start=12:10 이어도 살아남는다).
        if lunch is not None and cursor < lunch[1] and end > lunch[0]:
            cursor += stride
            continue
        slot = Slot(id=slot_id(cursor), time=cursor.strftime("%H:%M"), start=cursor, end=end)
        (morning if slot.is_morning else afternoon).append(slot)
        cursor += stride
    return morning, afternoon


def build_grid(policy: SchedulePolicy) -> list[DayGrid]:
    """행사 기간 전체의 날짜별 슬롯 그리드. 예약 상태와 무관한 **구조**만 만든다."""
    zone = policy.zone
    grid: list[DayGrid] = []
    day = policy.exhibition_start
    while day <= policy.exhibition_end:
        morning, afternoon = _day_slots(policy, day, zone)
        grid.append(
            DayGrid(
                id=day.isoformat(),
                label=f"{day.month}/{day.day}",
                weekday=_WEEKDAY_KO[day.weekday()],
                morning=tuple(morning),
                afternoon=tuple(afternoon),
            )
        )
        day += timedelta(days=1)
    return grid


def grid_slot_ids(policy: SchedulePolicy) -> set[str]:
    """그리드가 허용하는 슬롯 id 전체 — 소속 검사(운영시간·점심·행사기간)의 단일 술어."""
    return {slot.id for day in build_grid(policy) for slot in day.slots}


@dataclass(frozen=True, slots=True)
class SlotRun:
    """연속성 검증을 통과한 슬롯 묶음 — 미팅 한 건의 시간 구간."""

    slot_ids: tuple[str, ...]
    start: datetime  # tz-aware
    end: datetime  # tz-aware, 마지막 칸의 끝
    day: date

    @property
    def duration_minutes(self) -> int:
        return int((self.end - self.start).total_seconds() // 60)


def validate_slot_run(
    policy: SchedulePolicy, slot_ids: Sequence[str], *, now: datetime
) -> SlotRun:
    """슬롯 묶음이 미팅 한 건으로 성립하는지 검증하고 시간 구간을 돌려준다.

    검사(전부 통과해야 한다):

    1. 최소 1개, 중복 없음
    2. 전부 같은 날짜
    3. **stride**(= ``slot_minutes + gap_minutes``) 간격으로 엄격히 인접(빈틈·역순 금지).
       점심을 가로지르는 조합은 이 검사에서 **자동으로** 걸린다 — 11:30 칸의 다음 칸은 13:00이
       아니라 (점심에 먹힌) 12:15이므로, 별도의 "점심 횡단 금지" 분기가 필요 없다.
    4. 스팬(마지막 칸 ``end`` − 첫 칸 ``start``, 중간 텀 포함)이 ``max_meeting_minutes`` 이하
    5. 그리드 소속 — 운영시간 안, 점심 아님, 행사 기간 안
    6. ``now``보다 미래(진행 중/지난 슬롯 예약 금지)

    Args:
        policy: 행사 슬롯 정책.
        slot_ids: 신청자가 고른 슬롯 id들.
        now: 현재 시각(tz-aware). **주입** — 이 모듈은 시계를 읽지 않는다.

    Raises:
        SlotError: 위 검사 중 하나라도 실패.
    """
    if now.tzinfo is None:
        raise SlotError("now는 tz-aware여야 한다(naive 입력 거부)")

    ids = list(slot_ids)
    if not ids:
        raise SlotError("슬롯을 최소 1개 선택해야 한다")
    if len(set(ids)) != len(ids):
        raise SlotError("같은 슬롯을 두 번 선택할 수 없다")

    zone = policy.zone
    starts = [slot_datetime(value, zone) for value in ids]

    days = {moment.date() for moment in starts}
    if len(days) > 1:
        raise SlotError("연속 슬롯은 같은 날짜여야 한다")
    day = starts[0].date()

    # 입력 순서에 의존하지 않는다 — 정렬 후 인접성을 본다(순서는 사용자 선택 순서일 수 있다).
    ordered = sorted(starts)
    length = timedelta(minutes=policy.slot_minutes)
    stride = timedelta(minutes=policy.stride_minutes)
    for previous, current in zip(ordered, ordered[1:]):
        if current - previous != stride:
            raise SlotError(
                f"연속된 슬롯이 아니다 — {slot_id(previous)} 다음은 "
                f"{slot_id(previous + stride)}여야 한다(선택: {slot_id(current)})"
            )

    # 상한은 칸 수가 아니라 **분**이다(mt003gap0001). 스팬은 중간 텀을 포함한다 — 40분/텀5분에서
    # 2칸은 10:00~11:25(85분), 3칸은 10:00~12:10(130분).
    start = ordered[0]
    end = ordered[-1] + length
    span_minutes = int((end - start).total_seconds() // 60)
    if span_minutes > policy.max_meeting_minutes:
        raise SlotError(
            f"미팅은 최대 {policy.max_meeting_minutes}분까지 이어 붙일 수 있다 — "
            f"{len(ordered)}칸을 이으면 {span_minutes}분이 된다"
        )

    allowed = grid_slot_ids(policy)
    outside = [value for value in ids if value not in allowed]
    if outside:
        raise SlotError(
            f"행사 슬롯 그리드에 없는 슬롯이다(운영시간·점심시간·행사기간 확인): {', '.join(sorted(outside))}"
        )

    if start <= now:
        raise SlotError("이미 지났거나 진행 중인 슬롯은 신청할 수 없다")

    return SlotRun(slot_ids=tuple(slot_id(moment) for moment in ordered), start=start, end=end, day=day)


def run_slot_ids(policy: SchedulePolicy, start: datetime, end: datetime) -> tuple[str, ...]:
    """확정된 시간 구간 → 그 구간이 덮는 슬롯 id들(불가 슬롯 교차 검사 등에 쓴다).

    ``start`` 가 그리드의 슬롯 시작과 정렬돼 있다고 가정하고 **stride** 로 걷는다(mt003gap0001 —
    구버전은 ``slot_minutes`` 로 걸어서 상담 길이 ≠ 간격 격자에서는 두 번째 칸부터 어긋난다).
    프로덕션 호출부는 아직 없고(강제배정 시간 이동 경로가 필요로 할 계약) 테스트만 덮는다.
    """
    zone = policy.zone
    stride = timedelta(minutes=policy.stride_minutes)
    ids: list[str] = []
    cursor = start.astimezone(zone)
    limit = end.astimezone(zone)
    while cursor < limit:
        ids.append(slot_id(cursor))
        cursor += stride
    return tuple(ids)
