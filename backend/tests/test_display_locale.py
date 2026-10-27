"""표시 로케일 공용 규칙 단위 테스트 (``app.display_locale``) — DB 없이 문자열 규칙만 잠근다.

여기서 지키는 불변식은 둘이다:

- **ko 경로는 입력을 그대로 돌려준다.** 홀 이름·부스 라벨은 ``meeting_venues`` 멱등키의 재료라,
  공백 하나라도 정리하면 같은 부스에 장소 행이 하나 더 생긴다.
- **en 경로는 지어내지 않는다.** 영문명이 없으면 국문명으로 내려가고, 모르는 모양의 라벨은 손대지
  않는다 — 틀린 영문보다 원문이 낫다.
"""

from __future__ import annotations

from dataclasses import dataclass

import pytest

from app.display_locale import (
    booth_title,
    has_hangul,
    localized_booth_venue_label,
    localized_hall_name,
    localized_org_name,
    normalize_locale,
    unassigned_booth_label,
)


@dataclass
class _Org:
    name_ko: str | None
    name_en: str | None


@pytest.mark.parametrize(
    "raw, expected",
    [
        ("en", "en"),
        ("EN", "en"),
        (" en ", "en"),
        ("ko", "ko"),
        (None, "ko"),
        ("", "ko"),
        ("ja", "ko"),
        ("en-US", "ko"),  # 지역 태그는 받지 않는다 — 화면이 보내는 값은 ko|en 둘뿐이다.
    ],
)
def test_normalize_locale_folds_unknown_values_to_korean(raw, expected):
    assert normalize_locale(raw) == expected


def test_has_hangul_detects_syllables_and_jamo_only():
    assert has_hangul("7홀")
    assert has_hangul("ㄱ")
    assert not has_hangul("Hall 7")
    assert not has_hangul("")
    assert not has_hangul(None)


def test_org_name_prefers_the_locale_column_and_falls_back_to_the_other():
    both = _Org(name_ko="한빛디펜스", name_en="Hanbit Defense")
    assert localized_org_name(both, "ko") == "한빛디펜스"
    assert localized_org_name(both, "en") == "Hanbit Defense"

    korean_only = _Org(name_ko="한빛디펜스", name_en=None)
    assert localized_org_name(korean_only, "en") == "한빛디펜스"

    english_only = _Org(name_ko=None, name_en="Global Marine")
    assert localized_org_name(english_only, "ko") == "Global Marine"

    assert localized_org_name(None, "en", fallback="org-1") == "org-1"
    assert localized_org_name(_Org(name_ko=None, name_en=None), "en") == ""


def test_hall_name_is_returned_untouched_in_korean():
    # 공백까지 그대로다 — 이 값이 저장 라벨(멱등키)의 일부로 쓰인다.
    assert localized_hall_name("7", " 7홀 ", "ko") == " 7홀 "
    assert localized_hall_name("7", None, "ko") == ""


@pytest.mark.parametrize(
    "hall_no, hall_name, expected",
    [
        ("7", "7홀", "Hall 7"),
        ("7홀", "7홀", "Hall 7"),  # 번호 칸에 단위까지 적은 행사
        ("B1", "제1전시관", "Hall B1"),
        ("7", "Grand Castor", "Grand Castor"),  # 로마자 이름은 고유명사로 둔다
        ("", "7홀", "7홀"),  # 번호가 없으면 지어내지 않는다
        ("홀", "7홀", "7홀"),  # 한글을 걷어내면 남는 식별자가 없다
    ],
)
def test_hall_name_in_english_uses_the_hall_number(hall_no, hall_name, expected):
    assert localized_hall_name(hall_no, hall_name, "en") == expected


def test_booth_title_and_storage_label():
    assert unassigned_booth_label("한빛디펜스") == "한빛디펜스 부스"
    assert booth_title("한빛디펜스", "ko") == "한빛디펜스 부스"
    assert booth_title("Hanbit Defense", "en") == "Hanbit Defense Booth"


HALLS = [("7", "7홀"), ("8", "8홀"), ("1", "제1전시관"), ("1A", "제1전시관 별관")]


def test_booth_venue_label_is_untouched_in_korean():
    assert (
        localized_booth_venue_label(
            "7홀 A-12", exhibitor_name_en="Hanbit Defense", halls=HALLS, locale="ko"
        )
        == "7홀 A-12"
    )
    assert (
        localized_booth_venue_label(
            "한빛디펜스 부스", exhibitor_name_en="Hanbit Defense", halls=HALLS, locale="ko"
        )
        == "한빛디펜스 부스"
    )


@pytest.mark.parametrize(
    "label, name_en, expected",
    [
        ("7홀 A-12", "Hanbit Defense", "Hall 7 A-12"),
        ("8홀 B-03", None, "Hall 8 B-03"),
        # 긴 홀 이름이 먼저 걸린다 — "제1전시관"이 "제1전시관 별관 C-1"을 가로채면 안 된다.
        ("제1전시관 별관 C-1", None, "Hall 1A C-1"),
        ("제1전시관 C-1", None, "Hall 1 C-1"),
        ("한빛디펜스 부스", "Hanbit Defense", "Hanbit Defense Booth"),
        ("한빛디펜스 부스", None, "한빛디펜스 Booth"),  # 영문명이 없으면 저장된 이름 그대로
        ("한빛디펜스 부스", "", "한빛디펜스 Booth"),
        ("Legacy Stage", None, "Legacy Stage"),  # 어느 모양에도 안 맞는 과거 데이터
    ],
)
def test_booth_venue_label_in_english(label, name_en, expected):
    assert (
        localized_booth_venue_label(label, exhibitor_name_en=name_en, halls=HALLS, locale="en")
        == expected
    )


def test_booth_venue_label_without_hall_list_keeps_the_stored_label():
    """홀 목록을 못 읽었어도(빈 목록) 깨지지 않는다 — 저장 라벨이 그대로 나간다."""
    assert (
        localized_booth_venue_label("7홀 A-12", exhibitor_name_en=None, halls=(), locale="en")
        == "7홀 A-12"
    )
