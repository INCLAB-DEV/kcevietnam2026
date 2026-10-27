"""표시 로케일 공용 규칙 — 참가자 화면에 실리는 **값**(기업명·홀 이름·장소 라벨)의 언어 선택.

참가자 API는 ``?locale=ko|en``을 받는다(BFF가 화면의 ``NEXT_LOCALE`` 쿠키 값을 그대로 실어 보낸다).
로케일은 응답의 **키가 아니라 값**을 고른다 — 탐색(``app.discover``)이 먼저 세운 규약이고, 미팅·알림·
러브콜 메일도 같은 규약을 쓰려고 그 판단을 이 모듈로 모았다. 슬라이스마다 "영문이 없으면 무엇으로
내려가는가"가 다르면 한 화면 안에서 같은 기업이 두 이름으로 보인다.

저장값은 건드리지 않는다. 여기 함수들은 전부 읽기 시점의 표시 변환이다 — DB에는 여전히 국문 라벨이
들어 있고(부스 장소 라벨은 멱등키라 바꾸면 안 된다), 한국어 응답은 이전과 바이트 단위로 같다.

이 모듈은 다른 슬라이스(discover·meetings·notifications)를 임포트하지 않는다 — 그쪽들이 서로를
임포트하고 있어(discover → meetings) 공용 규칙을 어느 한쪽에 두면 순환 임포트가 생긴다.
"""

from __future__ import annotations

import re
from typing import Protocol, Sequence

#: 지원 로케일. 이외의 값은 422가 아니라 ``DEFAULT_LOCALE``로 관대하게 접는다 — 로케일은 표시
#: 선택지지 권한이 아니라서, 오타 하나로 화면이 통째로 에러가 되는 편이 더 나쁘다.
LOCALES: tuple[str, ...] = ("ko", "en")
DEFAULT_LOCALE = "ko"

#: 한글 음절·자모(호환 자모 포함) — "이 값이 한국어 표기인가"의 판정 기준.
_HANGUL = re.compile(r"[ㄱ-ㆎ가-힣]")


def normalize_locale(value: str | None) -> str:
    """쿼리로 들어온 로케일 문자열 → 지원 로케일. 모르는 값·None은 전부 기본(ko)."""
    normalized = str(value).strip().lower() if value is not None else ""
    return normalized if normalized in LOCALES else DEFAULT_LOCALE


def has_hangul(text: str | None) -> bool:
    return bool(text) and _HANGUL.search(text) is not None


class _NamedOrg(Protocol):
    name_ko: str | None
    name_en: str | None


def localized_org_name(org: _NamedOrg | None, locale: str, *, fallback: str = "") -> str:
    """표시용 기업명 — 로케일 우선 컬럼이 먼저고, 없으면 반대쪽, 둘 다 없으면 ``fallback``.

    ko는 ``name_ko ?? name_en``, en은 ``name_en ?? name_ko``다. 영문명이 없는 기업은 en 화면에서도
    국문명이 보인다 — 이름 없는 줄보다 낫고, 그 한글은 번역 누락이 아니라 **데이터가 없는 것**이다.
    """
    if org is None:
        return fallback
    if locale == "en":
        return org.name_en or org.name_ko or fallback
    return org.name_ko or org.name_en or fallback


def localized_hall_name(hall_no: str | None, hall_name: str | None, locale: str) -> str:
    """홀 이름 — ``halls``에는 영문 컬럼이 없어, en 화면에서는 한국어 이름을 홀 번호로 바꿔 부른다.

    "7홀"·"제1전시관"처럼 한글이 섞인 이름은 해외 바이어가 읽지 못한다. 번역을 지어내는 대신
    운영자가 직접 넣은 식별자(``hall_no``)로 ``"Hall 7"``을 만든다 — 번호는 현장 안내판과 맞는
    유일한 값이다. 이름이 이미 로마자("Grand Castor")면 고유명사로 보고 그대로 둔다.

    ko 경로는 입력을 **그대로** 돌려준다(공백 정리도 하지 않는다) — 이 값이 부스 장소 저장 라벨
    (멱등키)의 일부로 쓰여서, 한 글자라도 달라지면 같은 부스에 장소 행이 하나 더 생긴다.
    """
    name = hall_name or ""
    if locale != "en" or not has_hangul(name):
        return name
    # 번호 칸에 "7홀"처럼 단위까지 적은 행사도 있다 — 한글만 걷어내고 남는 식별자를 쓴다.
    number = _HANGUL.sub("", hall_no or "").strip()
    return f"Hall {number}" if number else name


# =============================================================================
# 참가사 부스 장소 라벨
# =============================================================================
#: 부스가 아직 배정되지 않은 참가사의 장소 **저장 라벨** 접미사 — ``"{기업명} 부스"``.
#: ⚠ 저장 라벨은 ``meeting_venues`` 멱등키((event_id, 'booth', label))의 일부라 로케일과 무관하게
#: 이 한국어 규칙으로만 만든다(``unassigned_booth_label``). en 표시는 읽을 때 되돌려 만든다.
_UNASSIGNED_BOOTH_SUFFIX = " 부스"


def unassigned_booth_label(company_name: str) -> str:
    """부스 미배정 참가사의 장소 저장 라벨(한국어 고정 — 멱등키)."""
    return f"{company_name}{_UNASSIGNED_BOOTH_SUFFIX}"


def booth_title(company_name: str, locale: str) -> str:
    """부스 장소의 표시 제목 — ko ``"{참가사} 부스"`` / en ``"{Exhibitor} Booth"``."""
    if locale == "en":
        return f"{company_name} Booth"
    return unassigned_booth_label(company_name)


def localized_booth_venue_label(
    label: str,
    *,
    exhibitor_name_en: str | None,
    halls: Sequence[tuple[str, str]],
    locale: str,
) -> str:
    """부스 장소의 **저장 라벨** → 화면 표시 라벨. ko는 저장값 그대로다.

    저장 라벨은 두 모양뿐이다(``app.meetings.service._booth_label``):

    - 배정된 부스 ``"{홀 이름} {부스코드}"`` → 홀 이름만 en 표기로 바꾼다(``"7홀 A-12"`` → ``"Hall 7 A-12"``).
    - 미배정 ``"{기업명} 부스"`` → ``"{영문 기업명} Booth"``(영문명이 없으면 저장된 이름 그대로).

    현재 배정 상태로 다시 계산하지 않고 **저장된 라벨을 옮긴다** — 미팅이 잡힌 뒤 부스가 바뀌어도
    그 미팅 행이 가리키는 장소는 예약 당시의 것이고, ko 화면이 보여주는 것도 그 저장값이다.
    두 모양 어디에도 안 맞으면(과거 데이터) 손대지 않는다.

    Args:
        label: ``meeting_venues.label`` 저장값.
        exhibitor_name_en: 그 미팅의 참가사 영문명(없으면 None).
        halls: 그 행사의 ``(hall_no, hall_name)`` 목록.
        locale: 정규화된 로케일.
    """
    if locale != "en":
        return label
    if label.endswith(_UNASSIGNED_BOOTH_SUFFIX):
        stored_name = label[: -len(_UNASSIGNED_BOOTH_SUFFIX)]
        return booth_title(exhibitor_name_en or stored_name, locale)
    # 이름이 긴 홀부터 맞춘다 — "제1전시관"과 "제1전시관 별관"이 함께 있으면 긴 쪽이 먼저 걸려야 한다.
    for hall_no, hall_name in sorted(halls, key=lambda hall: len(hall[1] or ""), reverse=True):
        prefix = f"{hall_name} "
        if hall_name and label.startswith(prefix):
            return f"{localized_hall_name(hall_no, hall_name, locale)} {label[len(prefix):]}"
    return label


__all__ = [
    "DEFAULT_LOCALE",
    "LOCALES",
    "booth_title",
    "has_hangul",
    "localized_booth_venue_label",
    "localized_hall_name",
    "localized_org_name",
    "normalize_locale",
    "unassigned_booth_label",
]
