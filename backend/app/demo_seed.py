"""데모 데이터 시드 — 6·17 컨셉 데모용 행사/기업/장소/미팅/알림을 **멱등하게** 깐다.

실행::

    uv run python -m app.demo_seed          # DATABASE_URL 대상
    uv run python -m app.demo_seed --dry-run

여러 번 돌려도 같은 상태로 수렴한다(자연키 기반 get-or-create). 데모 중에 데이터가 꼬이면 그냥
다시 돌리면 된다.

⚠ ``DEMO_SEED`` 설정 플래그와는 **다른 것**이다. 그 플래그는 리뷰 API가 인메모리 목업
리포지토리를 쓸지 고르는 스위치(``app/api/deps.py``)라 DB에 아무것도 쓰지 않는다. 여기에 DB
쓰기를 얹으면 "앱이 뜰 때마다 조용히 데이터를 만든다"가 되어 그 플래그의 의미가 바뀌므로,
DB 시드는 이렇게 **명시적으로 실행하는 CLI**로 분리한다.

시드 신원은 로그인 경로와 정확히 맞춘다:

- ``login_router._DEMO_CREDENTIALS``의 회원ID(``mbr-buyer-01`` 등)를 ``registrants.organizer_member_id``로
  깐다 — 데모 로그인이 내는 토큰 ``access-mbr-buyer-01-1``의 subject가 그 값이고,
  ``auth.principal``의 데모 분기가 그 컬럼으로 org를 찾기 때문이다.
- 행사는 ``organizer_guard.DEMO_EVENT_ID`` 하나를 재사용한다 — 운영자 가드의 데모 배정
  (mbr-org-01=master)이 그 행사에만 걸려 있어서, 다른 행사를 만들면 어드민 콘솔이 안 열린다.

수락 규칙(ADR-0005) 두 경로를 다 시연할 수 있게 바이어를 나눠 깐다:

- ``mbr-buyer-01`` = **hosted**(초청 바이어) → 이 바이어에게 신청하면 **즉시 확정**
- ``mbr-buyer-02``/``mbr-buyer-03`` = **pre_registered**(일반 바이어) → **수락대기**

참가사도 로그인 유무로 나눈다 — 계정 있는 두 곳(픽셀아츠 스튜디오·한강게임즈)은 로그인 데모를,
계정 없는 세 곳(툰브릿지·사운드웨이브·케이브로드캐스트)은 "탐색만 되는 카드"를 시연한다
(``mbr-exh-03``/``mbr-exh-04``/``mbr-exh-05``는 ``login_router._DEMO_CREDENTIALS``에 없어 로그인
경로가 없다 — browse-only).

프로필도 함께 깐다 — 참가사는 소개·전시품목·사업분야·카테고리·부스, 바이어는 영문 소개·관심
사업분야·규모. 탐색 화면(``/api/discover``)이 이름만 있는 빈 카드로 보이면 데모가 성립하지
않기 때문이다. 채우는 값은 전부 **공개 프로젝션에 실리는 필드**다(남의 카드에 안 나가는 비공개
연락처는 시드하지 않는다 — 담당자 본인의 연락처는 ``/api/me``가 그리는 값이라 별개로 채운다).

**국/영 양쪽을 다 채운다**(i18n 데이터 레벨) — 기업명(``name_ko``/``name_en``), 참가사 소개
(``intro_ko``/``intro_en``), 제품명(``name_ko``/``name_en``), 사업분야 라벨(``label``/``label_en``).
``/api/discover?locale=en``이 한글 값을 되돌려주면 그건 시드가 비어 있다는 뜻이지 API 버그가 아니다.

미팅 5건(``_seed_meetings``)과 그에 매달린 알림(``seed_notifications``)도 깐다 — 팀원이 git
pull 후 곧바로 신청/수락/거절/취소/리뷰 화면을 전부 눈으로 볼 수 있게 하려는 목적이다. 미팅은
자연키((event, exhibitor_org, buyer_org, scheduled_start))로 get-or-create한다(#11로 쌍 단위
유일성 제약은 없어졌지만, 시드를 반복 실행해도 같은 미팅을 중복 생성하지 않으려는 멱등키다).
DB 제약(슬롯 EXCLUDE 등)과 충돌하는 드문 레이스는 IntegrityError로 잡아 건너뛰고 경고만 남긴다
(``meeting_warnings``). 알림은 ``notifications.service``의
notify_* 함수를 그대로 호출한다(직접 INSERT 금지 — 유니크 키 멱등 + 채널 디스패치를 실 앱과
동일하게 태운다). notify_*는 내부에서 자체 커밋을 하므로, **미팅이 이미 커밋된 뒤에만** 부른다
(``main()``이 ``seed()``를 커밋한 다음 ``seed_notifications()``를 호출하는 순서 — dry-run은
그래서 알림 단계를 아예 건너뛴다. 커밋 전에 알림부터 쏘면 미확정 상태를 통지하는 꼴이 된다).
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.auth.organizer_guard import DEMO_EVENT_ID, PERMISSION_MASTER
from app.db import SessionLocal
from app.meetings.service import get_or_create_booth_venue
from app.models import (
    Booth,
    BuyerInterestKeyword,
    BuyerProfile,
    Event,
    EventOrganizer,
    EventScheduleSettings,
    ExhibitorKeyword,
    ExhibitorProduct,
    ExhibitorProfile,
    Hall,
    Keyword,
    Meeting,
    MeetingVenue,
    Member,
    Organization,
    OrganizationEventRole,
    Organizer,
    Registrant,
)
from app.notifications import service as notification_service

# 행사 일정 — CLAUDE.md의 비즈매칭 신청기간(8/26~9/11)과 9월 전시를 그대로 반영한다.
DEMO_EXHIBITION_START = date(2026, 10, 20)
DEMO_EXHIBITION_END = date(2026, 10, 22)
DEMO_APPLICATION_START = date(2026, 8, 26)
DEMO_APPLICATION_END = date(2026, 9, 11)
DEMO_TIMEZONE = "Asia/Seoul"
DEMO_SLOT_MINUTES = 30
_DEMO_ZONE = ZoneInfo(DEMO_TIMEZONE)

#: 사업분야 8종 마스터(``keywords``, category='business_field') — 코드→(국문 라벨, 영문 라벨).
#: 정상 DB에는 마이그레이션 kct001tax01이 국문·영문 라벨을 이미 깔아뒀다. 여기 표가 마스터가
#: 비었을 때의 폴백이자, 이 시드가 참조하는 라벨의 원천이다.
#: 국문 라벨은 마이그레이션 시드와 같은 값이어야 한다 — 다르면 재시드가 마스터 라벨을 조용히
#: 갈아치운다. 탐색 카드의 ``keywords``는 로케일에 따라 이 둘 중 하나를 그대로 내보낸다(en이면
#: label_en ?? label).
DEMO_BUSINESS_FIELDS: dict[str, tuple[str, str]] = {
    "game_production": ("게임 제작", "Game Production"),
    "animation_distribution": ("애니메이션 유통 및 배급", "Animation Distribution"),
    "content_production": ("콘텐츠 제작", "Content Production"),
    "music_platform": ("음악 플랫폼", "Music Platform"),
    "newtech_content": ("신기술융합콘텐츠", "New-Tech Convergence Content"),
    "character_licensor": ("캐릭터 라이센서", "Character Licensor"),
    "webtoon_production": ("만화웹툰 제작", "Comics & Webtoon Production"),
    "music_production": ("음악 제작", "Music Production"),
}

#: 데모 담당자 연락처 — 회원ID → 가짜 휴대폰 번호. **전부 지어낸 번호다**(실 PII 아님).
#: 사이드바·마이페이지가 ``/api/me``의 ``member_phone``을 그리는데, 시드가 이걸 비워두면 데모
#: 화면에 연락처 자리가 통째로 빈다. 번호를 코드에 고정하는 건 재시드해도 같은 값으로 수렴하게
#: 하기 위함이다(랜덤 생성은 멱등이 아니다).
DEMO_PHONES: dict[str, str] = {
    "mbr-exh-01": "010-2201-0001",
    "mbr-exh-02": "010-2201-0002",
    "mbr-exh-03": "010-2201-0003",
    "mbr-exh-04": "010-2201-0004",
    "mbr-exh-05": "010-2201-0005",
    "mbr-buyer-01": "010-2202-0001",
    "mbr-buyer-02": "010-2202-0002",
    "mbr-buyer-03": "010-2202-0003",
}


@dataclass(frozen=True, slots=True)
class ExhibitorSpec:
    """참가사 한 곳의 프로필 시드 재료 — 부스(홀+코드), 소개, 전시품목, 취급분야."""

    member_id: str
    org_name: str
    #: 기업명(영문) — ``organizations.name_en``. 국문명을 그대로 넣지 않는다: en 로케일 탐색이
    #: 이 컬럼을 표시명으로 쓰므로(``discover.service.display_name``), 여기에 한글이 들어가면
    #: 영문 화면이 한글 기업명을 보여준다.
    org_name_en: str
    hall_no: str
    hall_name: str
    booth_code: str
    intro_ko: str
    intro_en: str
    employee_range: str
    #: 카테고리(content_category, 3종 중 단일선택) — Hall 필터를 대체하는 회사 분류축.
    content_category: str
    #: 전시품목 — (제품명(국문), 제품명(영문), 사업분야 코드). 순서가 곧 ``sort_order``(응답 순서 박제).
    products: tuple[tuple[str, str, str], ...]
    #: 취급 사업분야(탐색 카드 ``keywords``).
    keywords: tuple[str, ...]
    #: 참가사가 직접 막아둔 슬롯(opt-out). 기본은 없음 — 픽셀아츠 스튜디오만 시연용으로 둘 채운다.
    unavailable_slots: tuple[str, ...] = ()

    @property
    def booth_label(self) -> str:
        """미팅 장소 라벨 — ``app.meetings.service._booth_label``과 동일한 표기 규칙."""
        return f"{self.hall_name} {self.booth_code}"


#: 참가사 5곳 — 앞 둘(픽셀아츠 스튜디오·한강게임즈)은 로그인 계정이 있고(_DEMO_CREDENTIALS 참고),
#: 뒤 셋(툰브릿지·사운드웨이브·케이브로드캐스트)은 browse-only(계정 없음 — 탐색 카드로만 존재).
#: 카테고리(3종)·사업분야(8종)가 고루 분포하도록 잡는다(매칭 데모가 0%로 보이지 않게 — 아래
#: DEMO_BUYER_PROFILES 주석 참고).
DEMO_EXHIBITORS: tuple[ExhibitorSpec, ...] = (
    ExhibitorSpec(
        member_id="mbr-exh-01",
        org_name="픽셀아츠 스튜디오",
        org_name_en="PixelArts Studio",
        hall_no="7",
        hall_name="7홀",
        booth_code="A-12",
        intro_ko="오리지널 애니메이션과 캐릭터 IP를 기획·제작하는 애니메이션 스튜디오입니다.",
        intro_en="Animation studio creating original series and character IP.",
        employee_range="e_11_50",
        content_category="animation_character",
        products=(
            (
                "오리지널 애니메이션 시리즈 '스타빔레인저'",
                "Original Animation Series 'StarBeam Rangers'",
                "content_production",
            ),
            (
                "캐릭터 라이선싱 패키지 '문라이트 프렌즈'",
                "Character Licensing Package 'Moonlight Friends'",
                "character_licensor",
            ),
            (
                "AR 캐릭터 체험 부스 '스타빔 AR'",
                "AR Character Experience 'StarBeam AR'",
                "newtech_content",
            ),
        ),
        keywords=("content_production", "character_licensor", "newtech_content"),
        unavailable_slots=("2026-10-20T09:00", "2026-10-20T09:30"),
    ),
    ExhibitorSpec(
        member_id="mbr-exh-02",
        org_name="한강게임즈",
        org_name_en="Hangang Games",
        hall_no="7",
        hall_name="7홀",
        booth_code="B-05",
        intro_ko="모바일·콘솔 게임과 실감형 신기술 콘텐츠를 개발하는 게임 개발사입니다.",
        intro_en="Game studio developing mobile and console titles alongside immersive new-tech content.",
        employee_range="e_51_100",
        content_category="comics_game_music",
        products=(
            (
                "모바일 RPG '한강 크로니클'",
                "Mobile RPG 'Hangang Chronicles'",
                "game_production",
            ),
            (
                "실감형 콘텐츠 데모 '메타플레이'",
                "Immersive Content Demo 'MetaPlay'",
                "newtech_content",
            ),
        ),
        keywords=("game_production", "newtech_content"),
    ),
    ExhibitorSpec(
        member_id="mbr-exh-03",
        org_name="툰브릿지",
        org_name_en="ToonBridge",
        hall_no="8",
        hall_name="8홀",
        booth_code="C-21",
        intro_ko="웹툰을 제작하고 해외 플랫폼에 유통·배급하는 콘텐츠 기업입니다.",
        intro_en="Webtoon studio producing original series and distributing them to global platforms.",
        employee_range="e_11_50",
        content_category="comics_game_music",
        products=(
            ("웹툰 시리즈 '나이트 브릿지'", "Webtoon Series 'Night Bridge'", "webtoon_production"),
            (
                "해외 배급 패키지 '글로벌 웹툰 라인업'",
                "Global Distribution Package 'Global Webtoon Lineup'",
                "animation_distribution",
            ),
        ),
        keywords=("webtoon_production", "animation_distribution"),
    ),
    ExhibitorSpec(
        member_id="mbr-exh-04",
        org_name="사운드웨이브",
        org_name_en="SoundWave",
        hall_no="8",
        hall_name="8홀",
        booth_code="D-07",
        intro_ko="음원을 제작하고 자체 스트리밍 플랫폼을 운영하는 음악 콘텐츠 기업입니다.",
        intro_en="Music company producing original tracks and operating its own streaming platform.",
        employee_range="e_11_50",
        content_category="comics_game_music",
        products=(
            ("오리지널 음원 앨범 '웨이브 시그널'", "Original Music Album 'Wave Signal'", "music_production"),
            (
                "스트리밍 플랫폼 '사운드웨이브 라이브'",
                "Streaming Platform 'SoundWave Live'",
                "music_platform",
            ),
        ),
        keywords=("music_production", "music_platform"),
    ),
    ExhibitorSpec(
        member_id="mbr-exh-05",
        org_name="케이브로드캐스트",
        org_name_en="K-Broadcast",
        hall_no="9",
        hall_name="9홀",
        booth_code="E-15",
        intro_ko="예능·드라마 포맷을 기획하고 방송 송출 기술을 제공하는 방송 콘텐츠 기업입니다.",
        intro_en="Broadcasting company developing entertainment formats and live broadcast technology.",
        employee_range="e_51_100",
        content_category="broadcasting",
        products=(
            ("예능 포맷 '서울 나이트쇼'", "Entertainment Format 'Seoul Night Show'", "content_production"),
            (
                "실시간 방송 송출 솔루션 'K-Broadcast Live'",
                "Live Broadcast Streaming Solution 'K-Broadcast Live'",
                "newtech_content",
            ),
        ),
        keywords=("content_production", "newtech_content"),
    ),
)

#: 데모 참가자 — 참가사는 위 ``DEMO_EXHIBITORS``에서 파생하고, 바이어는 여기 그대로 나열한다.
#: 회원ID는 login_router._DEMO_CREDENTIALS와 반드시 일치해야 한다(계정이 있는 회원만 — 로그인
#: 경로 → 토큰 subject → registrants 조회 사슬). browse-only 참가사(mbr-exh-03/04)는 그 사전에
#: 없어 로그인이 없다 — 그래도 조직/역할/프로필은 정상 시드된다(탐색 화면 노출 목적).
#: (회원ID, 기업명(국문), 기업명(영문), 역할, 바이어 세부유형). 해외 바이어는 국/영이 같은
#: 영문명이다 — 국문 상호가 실재하지 않는 기관에 번역명을 지어내지 않는다.
DEMO_PARTICIPANTS: tuple[tuple[str, str, str, str, str | None], ...] = tuple(
    (spec.member_id, spec.org_name, spec.org_name_en, "exhibitor", None)
    for spec in DEMO_EXHIBITORS
) + (
    (
        "mbr-buyer-01",
        "Seoul Content Partners",
        "Seoul Content Partners",
        "buyer",
        "hosted",
    ),
    ("mbr-buyer-02", "Asia Webtoon Distribution", "Asia Webtoon Distribution", "buyer", "pre_registered"),
    ("mbr-buyer-03", "Global Music Ventures", "Global Music Ventures", "buyer", "pre_registered"),
)

#: 운영자가 프로비저닝하는 장소 풀(참가자 신청 경로는 이걸 **조회만** 한다 — 없으면 422).
DEMO_ZONE_TABLES = ("T-01", "T-02", "T-03", "T-04")
DEMO_BUSINESS_ROOMS = ("Room A", "Room B")

#: 바이어 공개 프로필 — 회원ID → (영문 소개, 관심 사업분야 코드들, 임직원 규모).
#: 소개가 영문인 건 스키마 그대로다(``buyer_profiles.company_intro_en`` — 해외 바이어 전제).
#: 관심분야는 참가사 5곳과 골고루 겹치게 잡는다(전부 0% 매칭으로 보이지 않게) — 각 참가사가
#: 최소 한 바이어와는 겹치도록 역산했다(예: 케이브로드캐스트의 newtech_content는 mbr-buyer-03에도
#: 있어, newtech_content만 취급하는 참가사가 바이어 누구와도 안 겹치는 상황을 막는다).
DEMO_BUYER_PROFILES: dict[str, tuple[str, tuple[str, ...], str]] = {
    "mbr-buyer-01": (
        "Content investment group sourcing game, animation, and character IP for international co-production.",
        ("game_production", "content_production", "character_licensor"),
        "e_101plus",
    ),
    "mbr-buyer-02": (
        "Webtoon and animation distributor expanding Korean content into Southeast Asian streaming platforms.",
        ("webtoon_production", "animation_distribution", "music_platform"),
        "e_51_100",
    ),
    "mbr-buyer-03": (
        "Music and tech-content investor scouting streaming and immersive content partnerships.",
        ("music_production", "newtech_content"),
        "e_11_50",
    ),
}

#: 바이어 신청자 식별(담당자) — 회원ID → (영문 이름, 영문 직위, 이메일, 상담언어, 통역필요).
#: BM-001 실배선(buyer_profiles.contact_*, 전부 지어낸 값·실 PII 아님). 해외 바이어라 국문
#: 이름/직위는 위 DEMO_BUYER_PROFILES와 같은 원칙으로 채우지 않는다(실재하지 않는 번역명 금지).
#: 이 값은 본인 프로필 조회(GET /api/bm/buyer/{id})에만 실리고 discover 공개 카드엔 노출되지 않는다.
DEMO_BUYER_CONTACTS: dict[str, tuple[str, str, str, str, bool]] = {
    "mbr-buyer-01": ("Jiyoon Han", "Investment Director", "jiyoon.han@seoulcontentpartners.example", "en", False),
    "mbr-buyer-02": ("Linh Tran", "Business Development Manager", "linh.tran@asiawebtoon.example", "vi", True),
    "mbr-buyer-03": ("Daniel Cho", "Partnerships Lead", "daniel.cho@globalmusicventures.example", "en", False),
}


@dataclass(frozen=True, slots=True)
class MeetingSpec:
    """미팅 시드 한 건 — 자연키는 (exhibitor_member, buyer_member, start)다.

    ``key``는 알림 단계(``seed_notifications``)가 방금 만든/재사용한 미팅을 다시 찾을 때 쓰는
    안정 식별자(DB PK가 아니다 — PK는 매 시드마다 새로 생성/재사용될 수 있어 코드에 박을 수 없다).
    """

    key: str
    exhibitor_member: str
    buyer_member: str
    status: str  # 'proposed' | 'accepted' | 'completed' | 'cancelled'
    start: str  # "YYYY-MM-DDTHH:MM" — DEMO_TIMEZONE(Asia/Seoul) 로컬 시각
    duration_minutes: int
    requested_by: str  # 'exhibitor' | 'buyer'
    request_reason: str
    cancelled_by: str | None = None
    cancelled_reason_code: str | None = None
    cancelled_reason_text: str | None = None


#: 미팅 5건 — 신청/수락대기(양방향)/완료(리뷰 시연)/취소를 전부 눈으로 볼 수 있게 구성한다.
DEMO_MEETINGS: tuple[MeetingSpec, ...] = (
    MeetingSpec(
        key="m1",
        exhibitor_member="mbr-exh-01",
        buyer_member="mbr-buyer-01",
        status="accepted",
        start="2026-10-20T13:00",
        duration_minutes=30,
        requested_by="buyer",
        request_reason=(
            "안녕하세요, 픽셀아츠 스튜디오 담당자님.\n\n"
            "저희는 귀사의 오리지널 애니메이션 IP에 관심이 있어 미팅을 요청드립니다. "
            "공동 투자 및 배급 가능성을 자세히 논의하고 싶습니다."
        ),
    ),
    MeetingSpec(
        key="m2",
        exhibitor_member="mbr-exh-01",
        buyer_member="mbr-buyer-02",
        status="proposed",
        start="2026-10-21T10:00",
        duration_minutes=30,
        requested_by="buyer",
        request_reason=(
            "안녕하세요, 픽셀아츠 스튜디오 담당자님.\n\n"
            "저희 웹툰 유통 네트워크와의 IP 콜라보레이션 가능성을 검토하고자 미팅을 요청드립니다."
        ),
    ),
    MeetingSpec(
        key="m3",
        exhibitor_member="mbr-exh-01",
        buyer_member="mbr-buyer-03",
        status="proposed",
        start="2026-10-22T14:00",
        duration_minutes=60,
        requested_by="exhibitor",
        request_reason=(
            "안녕하세요, Global Music Ventures 담당자님.\n\n"
            "저희 캐릭터 IP를 활용한 음악 콘텐츠 콜라보레이션 가능성을 논의하고 싶어 미팅을 요청드립니다."
        ),
    ),
    MeetingSpec(
        key="m4",
        exhibitor_member="mbr-exh-02",
        buyer_member="mbr-buyer-02",
        status="completed",
        start="2026-08-28T10:00",
        duration_minutes=30,
        requested_by="buyer",
        request_reason="사전 화상미팅으로 게임 IP와 웹툰 콜라보레이션 방안을 논의했습니다.",
    ),
    MeetingSpec(
        key="m5",
        exhibitor_member="mbr-exh-02",
        buyer_member="mbr-buyer-03",
        status="cancelled",
        start="2026-10-21T11:00",
        duration_minutes=30,
        requested_by="buyer",
        request_reason=(
            "안녕하세요, 한강게임즈 담당자님.\n\n게임 배경음악(OST) 공동 제작 관련 미팅을 요청드립니다."
        ),
        cancelled_by="buyer",
        cancelled_reason_code="schedule_conflict",
        cancelled_reason_text="바이어 측 일정이 겹쳐 부득이하게 취소합니다. 다음 기회에 다시 요청드리겠습니다.",
    ),
)


def _get_or_create_event(db: Session) -> Event:
    event = db.get(Event, DEMO_EVENT_ID)
    if event is None:
        event = Event(id=DEMO_EVENT_ID, slug="demo-kadex-2026")
        db.add(event)
    # name/name_en은 매 시드마다 갱신(id/slug는 FK 참조라 고정) — 기존 행이 있어도 최신 데모 행사명으로 맞춘다.
    event.name = "2026 베트남 K-콘텐츠 엑스포 (데모)"
    event.name_en = "2026 Vietnam K-Content Expo (Demo)"
    event.venue_name = "베트남 호치민 GEM Center"
    event.timezone = DEMO_TIMEZONE
    event.slot_minutes = DEMO_SLOT_MINUTES
    event.exhibition_start = DEMO_EXHIBITION_START
    event.exhibition_end = DEMO_EXHIBITION_END
    event.application_start = DEMO_APPLICATION_START
    event.application_end = DEMO_APPLICATION_END
    event.enabled_venue_types = ["booth", "zone_table", "business_room"]
    db.flush()
    return event


def _get_or_create_schedule(db: Session, event_id: str) -> EventScheduleSettings:
    row = db.execute(
        select(EventScheduleSettings).where(EventScheduleSettings.event_id == event_id)
    ).scalar_one_or_none()
    if row is None:
        row = EventScheduleSettings(event_id=event_id)
        db.add(row)
    row.operating_start = time(9, 0)
    row.operating_end = time(18, 0)
    row.lunch_start = time(12, 0)
    row.lunch_end = time(13, 0)
    row.min_guaranteed_slots = 10
    db.flush()
    return row


#: 데모 운영자(주최사 master) 회원ID — login_router._DEMO_CREDENTIALS의 ("organizer", "demo1234")와
#: organizer_guard._DEMO_ASSIGNMENTS 양쪽이 참조하는 것과 동일한 값이어야 한다(신원 일관성).
DEMO_OPERATOR_MEMBER_ID = "mbr-org-01"


def _seed_operator_master(db: Session, event_id: str) -> None:
    """데모 운영자(mbr-org-01)를 이 행사의 master로 멱등 배정 — 없으면 운영자 콘솔이 빈 목록이 된다.

    organizer_guard의 인메모리 데모 배정(_DEMO_ASSIGNMENTS)은 단일 행사 권한검사(require_event_master
    등)에만 쓰이고, 행사 **목록**(``GET /api/admin/events``)은 DB의 organizers/event_organizers를
    직접 조회한다(admin.service.list_events_for_organizer) — 그래서 이 DB 행이 없으면 로그인은 되도
    콘솔이 빈다. backend/README.md "슈퍼어드민 부여" §1의 SQL을 멱등 코드로 반영(자연키:
    organizers.member_id, event_organizers(event_id, organizer_id) UNIQUE).
    """
    organizer = db.execute(
        select(Organizer).where(Organizer.member_id == DEMO_OPERATOR_MEMBER_ID)
    ).scalar_one_or_none()
    if organizer is None:
        organizer = Organizer(
            name="데모 운영자", email=f"{DEMO_OPERATOR_MEMBER_ID}@organizer.nabi.local",
            member_id=DEMO_OPERATOR_MEMBER_ID,
        )
        db.add(organizer)
        db.flush()

    assignment = db.execute(
        select(EventOrganizer).where(
            EventOrganizer.event_id == event_id, EventOrganizer.organizer_id == organizer.id
        )
    ).scalar_one_or_none()
    if assignment is None:
        db.add(EventOrganizer(event_id=event_id, organizer_id=organizer.id, permission_level=PERMISSION_MASTER))
    else:
        assignment.permission_level = PERMISSION_MASTER  # 재시드해도 master로 수렴(강등 방지)
    db.flush()


def _get_or_create_participant(
    db: Session,
    event_id: str,
    member_id: str,
    org_name: str,
    org_name_en: str,
    role: str,
    buyer_subtype: str | None,
) -> Organization:
    """회원ID 하나에 대응하는 기업/담당자/명단/역할을 멱등하게 깐다.

    멱등 키는 ``registrants(event_id, organizer_member_id)`` 유니크다 — 이미 있으면 그 행이 가리키는
    기업을 그대로 재사용한다(데모를 다시 시드해도 기업이 복제되지 않는다). browse-only 참가사
    (로그인 계정 없음)도 여기 지나간다 — registrants는 로그인 여부와 무관한 적재층이다.

    **기업명은 재사용 경로에서도 매번 덮어쓴다.** 예전엔 생성 시에만 이름을 넣어서, 한 번 잘못
    들어간 값(국문명이 ``name_en``에 그대로 복사돼 있던 버그)이 재시드로 고쳐지지 않았다 —
    시드가 "다시 돌리면 수렴한다"는 계약을 지키려면 이름도 수렴 대상이어야 한다.
    """
    registrant = db.execute(
        select(Registrant).where(
            Registrant.event_id == event_id, Registrant.organizer_member_id == member_id
        )
    ).scalar_one_or_none()

    if registrant is not None and registrant.organization_id:
        org = db.get(Organization, registrant.organization_id)
    else:
        org = Organization()
        db.add(org)
    org.name_ko = org_name
    org.name_en = org_name_en
    db.flush()

    if registrant is None:
        registrant = Registrant(
            event_id=event_id,
            organizer_member_id=member_id,
            organization_id=org.id,
            raw={"source": "demo_seed"},
        )
        db.add(registrant)
    registrant.organization_id = org.id
    registrant.name = f"{org_name} 담당자"
    registrant.org_name = org_name
    registrant.contact_email = f"{member_id}@demo.nabi.test"
    # 연락처 — 명단 적재층에도, 회원 행에도 같은 값을 둔다. ``/api/me``는 회원 행이 있으면 그쪽을
    # 우선 읽고 없으면 registrant로 폴백하므로(discover.service._resolve_identity), 두 경로 중
    # 어느 쪽으로 들어와도 사이드바에 같은 번호가 보인다.
    registrant.contact_phone = DEMO_PHONES.get(member_id)
    registrant.role_hint = role
    db.flush()

    # 담당자(Member) — 알림 수신자 목록과 참석자 지정의 대상이다.
    email = f"{member_id}@demo.nabi.test"
    member = db.execute(select(Member).where(Member.email == email)).scalar_one_or_none()
    if member is None:
        member = Member(organization_id=org.id, name=f"{org_name} 담당자", email=email)
        db.add(member)
    member.organization_id = org.id
    member.registrant_id = registrant.id
    member.name = f"{org_name} 담당자"
    member.title = "매니저"
    member.phone = DEMO_PHONES.get(member_id)
    db.flush()

    role_row = db.execute(
        select(OrganizationEventRole).where(
            OrganizationEventRole.event_id == event_id,
            OrganizationEventRole.organization_id == org.id,
        )
    ).scalar_one_or_none()
    if role_row is None:
        role_row = OrganizationEventRole(event_id=event_id, organization_id=org.id)
        db.add(role_row)
    role_row.is_exhibitor = role == "exhibitor"
    role_row.is_buyer = role == "buyer"
    role_row.buyer_subtype = buyer_subtype
    # 미팅 신청은 승인(approved) 이후에만 열린다 — 데모는 승인된 상태에서 시작한다.
    role_row.application_status = "approved"
    db.flush()
    return org


def _role_of(db: Session, event_id: str, org_id: str) -> OrganizationEventRole:
    return db.execute(
        select(OrganizationEventRole).where(
            OrganizationEventRole.event_id == event_id,
            OrganizationEventRole.organization_id == org_id,
        )
    ).scalar_one()


def _get_or_create_business_keyword(db: Session, code: str) -> Keyword:
    """사업분야 키워드 한 건 — 없으면 만들고, 있으면 **영문 라벨을 채워 넣는다**.

    정상 DB에는 마이그레이션(kct001tax01)이 8종을 국문·영문 라벨로 이미 깔아뒀다. get-or-create로
    두는 건 시드가 **자기완결적**이어야 하기 때문이다 — 마스터가 비어 있는 DB에서 조용히 키워드
    없는 카드를 만들면 "탐색이 비어 보이지 않게" 한다는 목적이 무너진다.
    """
    label_ko, label_en = DEMO_BUSINESS_FIELDS.get(code, (code, code))
    keyword = db.execute(
        select(Keyword).where(Keyword.category == "business_field", Keyword.code == code)
    ).scalar_one_or_none()
    if keyword is None:
        keyword = Keyword(code=code, label=label_ko, category="business_field")
        db.add(keyword)
    keyword.label_en = label_en
    db.flush()
    return keyword


def _seed_business_field_keyword_labels(db: Session) -> None:
    """8종 전체의 영문 라벨을 채운다 — 데모 참가사가 쓰지 않는 분야도 포함.

    화면의 분야 필터·프로필 편집 드롭다운은 마스터 8개를 통째로 그리므로, 실제로 링크된
    분야만 번역하면 en 화면에서 목록 일부가 한글로 남는다.
    """
    for code in DEMO_BUSINESS_FIELDS:
        _get_or_create_business_keyword(db, code)


def _business_field_keyword_ids(db: Session, codes: tuple[str, ...]) -> list[str]:
    """사업분야 키워드 id들(멱등 키는 (category, code) 유니크)."""
    return [str(_get_or_create_business_keyword(db, code).id) for code in codes]


def _link_keywords(db: Session, link_model, owner_column: str, owner_id: str, keyword_ids) -> None:
    """프로필 ↔ 키워드 N:M 링크를 멱등하게 건다(복합 PK라 존재 확인 후 삽입).

    ``ON CONFLICT DO NOTHING``을 쓰지 않는 건 시드가 한 트랜잭션 안에서 flush를 섞어 쓰기
    때문이다 — 이미 세션에 올라온 행과 충돌하면 예외가 나므로, 있는지 보고 없을 때만 넣는다.
    """
    for keyword_id in keyword_ids:
        exists = db.execute(
            select(link_model).where(
                getattr(link_model, owner_column) == owner_id,
                link_model.keyword_id == keyword_id,
            )
        ).scalar_one_or_none()
        if exists is None:
            db.add(link_model(**{owner_column: owner_id, "keyword_id": keyword_id}))
    db.flush()


def _seed_exhibitor_profile(db: Session, event_id: str, org_id: str, spec: ExhibitorSpec) -> None:
    """부스 계층(Hall > Booth) + 참가사 공개 프로필 — 미팅 장소 라벨(예: "7홀 A-12")의 원천이자
    탐색 카드(소개·전시품목·취급분야·부스)의 원천."""
    hall = db.execute(
        select(Hall).where(Hall.event_id == event_id, Hall.hall_no == spec.hall_no)
    ).scalar_one_or_none()
    if hall is None:
        hall = Hall(event_id=event_id, hall_no=spec.hall_no, hall_name=spec.hall_name)
        db.add(hall)
        db.flush()

    booth = db.execute(
        select(Booth).where(Booth.hall_id == hall.id, Booth.code == spec.booth_code)
    ).scalar_one_or_none()
    if booth is None:
        booth = Booth(hall_id=hall.id, code=spec.booth_code)
        db.add(booth)
        db.flush()

    role_row = _role_of(db, event_id, org_id)
    profile = db.execute(
        select(ExhibitorProfile).where(ExhibitorProfile.org_event_role_id == role_row.id)
    ).scalar_one_or_none()
    if profile is None:
        profile = ExhibitorProfile(org_event_role_id=role_row.id)
        db.add(profile)
    profile.booth_id = booth.id
    profile.booth_hall = spec.hall_no
    profile.intro_ko = spec.intro_ko
    profile.intro_en = spec.intro_en
    profile.employee_range = spec.employee_range
    profile.content_category = spec.content_category
    # 참가사가 직접 막아둔 슬롯(opt-out). 참가자 API는 이 값을 **읽기만** 한다 — 쓰기는 운영자 경로.
    profile.unavailable_meeting_slots = list(spec.unavailable_slots)
    db.flush()

    # 전시품목 — 멱등 키는 (프로필, 국문 제품명). 제품에는 자연 유니크가 없어 이름으로 잡는다.
    # 영문명은 en 로케일 탐색 카드의 ``exhibits`` 값이다(name_en ?? name_ko 폴백).
    for order, (name_ko, name_en, business_field) in enumerate(spec.products):
        product = db.execute(
            select(ExhibitorProduct).where(
                ExhibitorProduct.exhibitor_profile_id == profile.id,
                ExhibitorProduct.name_ko == name_ko,
            )
        ).scalar_one_or_none()
        if product is None:
            product = ExhibitorProduct(exhibitor_profile_id=profile.id, name_ko=name_ko)
            db.add(product)
        product.name_en = name_en
        product.business_field = business_field
        product.sort_order = order
    db.flush()

    _link_keywords(
        db,
        ExhibitorKeyword,
        "exhibitor_profile_id",
        str(profile.id),
        _business_field_keyword_ids(db, spec.keywords),
    )


def _seed_buyer_profile(db: Session, event_id: str, org_id: str, member_id: str) -> None:
    """바이어 공개 프로필 — 탐색 카드의 소개·관심분야·규모. 멱등 키는 역할행 1:1(unique)."""
    spec = DEMO_BUYER_PROFILES.get(member_id)
    if spec is None:
        return
    intro_en, keyword_codes, employee_range = spec

    role_row = _role_of(db, event_id, org_id)
    profile = db.execute(
        select(BuyerProfile).where(BuyerProfile.org_event_role_id == role_row.id)
    ).scalar_one_or_none()
    if profile is None:
        profile = BuyerProfile(org_event_role_id=role_row.id)
        db.add(profile)
    profile.company_intro_en = intro_en
    profile.employee_range = employee_range
    contact = DEMO_BUYER_CONTACTS.get(member_id)
    if contact is not None:
        name_en, title_en, email, language, interpreter_need = contact
        profile.contact_name_en = name_en
        profile.contact_title_en = title_en
        profile.contact_email = email
        profile.contact_language = language
        profile.contact_interpreter_need = interpreter_need
    db.flush()

    _link_keywords(
        db,
        BuyerInterestKeyword,
        "buyer_profile_id",
        str(profile.id),
        _business_field_keyword_ids(db, keyword_codes),
    )


def _seed_venues(db: Session, event_id: str) -> None:
    """비즈매칭존/비즈니스룸 장소 풀. (event_id, venue_type, label) 유니크가 멱등 키."""
    for venue_type, labels in (
        ("zone_table", DEMO_ZONE_TABLES),
        ("business_room", DEMO_BUSINESS_ROOMS),
    ):
        for label in labels:
            exists = db.execute(
                select(MeetingVenue.id).where(
                    MeetingVenue.event_id == event_id,
                    MeetingVenue.venue_type == venue_type,
                    MeetingVenue.label == label,
                )
            ).scalar_one_or_none()
            if exists is None:
                db.add(MeetingVenue(event_id=event_id, venue_type=venue_type, label=label))
    db.flush()


# =============================================================================
# 미팅 5건
# =============================================================================
def _find_meeting_by_natural_key(
    db: Session, event_id: str, exhibitor_org_id: str, buyer_org_id: str, scheduled_start: datetime
) -> Meeting | None:
    return db.execute(
        select(Meeting).where(
            Meeting.event_id == event_id,
            Meeting.exhibitor_org_id == exhibitor_org_id,
            Meeting.buyer_org_id == buyer_org_id,
            Meeting.scheduled_start == scheduled_start,
        )
    ).scalar_one_or_none()


def _seed_meetings(
    db: Session, event_id: str, orgs: dict[str, str]
) -> tuple[dict[str, str], list[str]]:
    """미팅 5건을 자연키로 get-or-create한다. 반환은 (spec.key → meeting_id, 건너뛴 사유 목록)."""
    exhibitor_specs = {spec.member_id: spec for spec in DEMO_EXHIBITORS}
    meetings: dict[str, str] = {}
    warnings: list[str] = []

    for spec in DEMO_MEETINGS:
        exhibitor_org_id = orgs[spec.exhibitor_member]
        buyer_org_id = orgs[spec.buyer_member]
        start = datetime.fromisoformat(spec.start).replace(tzinfo=_DEMO_ZONE)
        end = start + timedelta(minutes=spec.duration_minutes)

        existing = _find_meeting_by_natural_key(db, event_id, exhibitor_org_id, buyer_org_id, start)
        if existing is not None:
            meetings[spec.key] = str(existing.id)
            continue

        exhibitor_spec = exhibitor_specs[spec.exhibitor_member]
        venue = get_or_create_booth_venue(
            db, event_id=event_id, label=exhibitor_spec.booth_label
        )
        requested_by_org_id = (
            exhibitor_org_id if spec.requested_by == "exhibitor" else buyer_org_id
        )
        awaiting_org_id = None
        if spec.status == "proposed":
            awaiting_org_id = (
                buyer_org_id if requested_by_org_id == exhibitor_org_id else exhibitor_org_id
            )

        meeting = Meeting(
            event_id=event_id,
            exhibitor_org_id=exhibitor_org_id,
            buyer_org_id=buyer_org_id,
            venue_id=venue.id,
            matching_type="open",
            status=spec.status,
            requested_by=spec.requested_by,
            awaiting_org_id=awaiting_org_id,
            request_reason=spec.request_reason,
            scheduled_start=start,
            scheduled_end=end,
        )
        if spec.status == "cancelled":
            meeting.cancelled_at = start - timedelta(hours=20)
            meeting.cancelled_by = spec.cancelled_by
            meeting.cancelled_by_org_id = (
                exhibitor_org_id if spec.cancelled_by == "exhibitor" else buyer_org_id
            )
            meeting.cancelled_reason_code = spec.cancelled_reason_code
            meeting.cancelled_reason_text = spec.cancelled_reason_text
        db.add(meeting)
        try:
            db.flush()
        except IntegrityError:
            # 마지막 방어선 — 사전 확인과 실제 커밋 사이의 레이스(동시 시드 실행 등). 사용자에게
            # 500을 내는 대신 건너뛰고 계속한다(시드는 최선을 다해 수렴하는 도구지, all-or-nothing
            # 트랜잭션 계약이 아니다).
            db.rollback()
            warnings.append(f"{spec.key} 건너뜀 — DB 제약 충돌(동시 시드 실행 의심)")
            continue
        meetings[spec.key] = str(meeting.id)

    return meetings, warnings


# =============================================================================
# 알림 — notify_* 함수를 그대로 호출(직접 INSERT 금지, ADR-0010 멱등 유니크에 위임)
# =============================================================================
def seed_notifications(db: Session, meetings: dict[str, str]) -> dict[str, list[str]]:
    """미팅 시드에 매달린 알림 4건(총 7행 — 양측에 나가는 건 2행)을 발화한다.

    ``meetings``는 ``_seed_meetings``가 돌려준 (spec.key → meeting_id) 맵이다. **미팅이 이미
    커밋된 뒤에** 불러야 한다 — notify_*는 내부에서 자체 커밋을 하므로(notifications.service의
    멱등 생성 + 채널 디스패치 계약), 커밋 전에 부르면 미확정 상태를 통지하는 꼴이 된다(``main()``
    참고). 실패해도 시드 전체가 죽지 않는다 — ``notify_after_commit``이 예외를 삼키고 로그만
    남기는, 실 앱(``app.meetings.service``)과 동일한 방어 패턴이다.
    """
    created: list[str] = []

    def _meeting(key: str) -> Meeting | None:
        meeting_id = meetings.get(key)
        return db.get(Meeting, meeting_id) if meeting_id else None

    # #2·#3 — 신청받음(수신측 1행씩).
    for key, requester_role in (("m2", "buyer"), ("m3", "exhibitor")):
        meeting = _meeting(key)
        if meeting is None:
            continue
        if requester_role == "buyer":
            recipient_org_id, requester_org_id = str(meeting.exhibitor_org_id), str(meeting.buyer_org_id)
        else:
            recipient_org_id, requester_org_id = str(meeting.buyer_org_id), str(meeting.exhibitor_org_id)
        result = notification_service.notify_after_commit(
            db,
            lambda m=meeting, rid=recipient_org_id, oid=requester_org_id, role=requester_role: (
                notification_service.notify_meeting_requested(
                    db,
                    event_id=str(m.event_id),
                    meeting_id=str(m.id),
                    recipient_org_id=rid,
                    counterpart_org_name=notification_service.org_display_name(db, oid),
                    requested_by_role=role,
                )
            ),
            description=f"demo_seed meeting_requested ({key})",
        )
        if result is not None:
            created.append(f"{key}:meeting_requested→{recipient_org_id}")

    # #1 — 확정(양측 각 1행).
    meeting1 = _meeting("m1")
    if meeting1 is not None:
        venue_label = notification_service.venue_label(db, meeting1.venue_id)
        for recipient_org_id, counterpart_org_id in (
            (str(meeting1.exhibitor_org_id), str(meeting1.buyer_org_id)),
            (str(meeting1.buyer_org_id), str(meeting1.exhibitor_org_id)),
        ):
            result = notification_service.notify_after_commit(
                db,
                lambda m=meeting1, rid=recipient_org_id, cid=counterpart_org_id, vl=venue_label: (
                    notification_service.notify_meeting_accepted(
                        db,
                        event_id=str(m.event_id),
                        meeting_id=str(m.id),
                        recipient_org_id=rid,
                        counterpart_org_name=notification_service.org_display_name(db, cid),
                        scheduled_start=m.scheduled_start,
                        venue_label=vl,
                    )
                ),
                description="demo_seed meeting_accepted (m1)",
            )
            if result is not None:
                created.append(f"m1:meeting_accepted→{recipient_org_id}")

    # #5 — 취소(취소 안 한 쪽 1행).
    meeting5 = _meeting("m5")
    if meeting5 is not None and meeting5.cancelled_by_org_id is not None:
        canceller_org_id = str(meeting5.cancelled_by_org_id)
        recipient_org_id = (
            str(meeting5.exhibitor_org_id)
            if canceller_org_id == str(meeting5.buyer_org_id)
            else str(meeting5.buyer_org_id)
        )
        result = notification_service.notify_after_commit(
            db,
            lambda m=meeting5, rid=recipient_org_id, cid=canceller_org_id: (
                notification_service.notify_meeting_cancelled(
                    db,
                    event_id=str(m.event_id),
                    meeting_id=str(m.id),
                    recipient_org_id=rid,
                    counterpart_org_name=notification_service.org_display_name(db, cid),
                    cancelled_by_role=m.cancelled_by,
                    scheduled_start=m.scheduled_start,
                )
            ),
            description="demo_seed meeting_cancelled (m5)",
        )
        if result is not None:
            created.append(f"m5:meeting_cancelled→{recipient_org_id}")

    # #4 — 리뷰 입력 안내(양측 각 1행, due_at=scheduled_end).
    meeting4 = _meeting("m4")
    if meeting4 is not None:
        for recipient_org_id, counterpart_org_id in (
            (str(meeting4.exhibitor_org_id), str(meeting4.buyer_org_id)),
            (str(meeting4.buyer_org_id), str(meeting4.exhibitor_org_id)),
        ):
            result = notification_service.notify_after_commit(
                db,
                lambda m=meeting4, rid=recipient_org_id, cid=counterpart_org_id: (
                    notification_service.notify_review_prompt(
                        db,
                        event_id=str(m.event_id),
                        meeting_id=str(m.id),
                        recipient_org_id=rid,
                        counterpart_org_name=notification_service.org_display_name(db, cid),
                        due_at=m.scheduled_end,
                    )
                ),
                description="demo_seed review_prompt (m4)",
            )
            if result is not None:
                created.append(f"m4:review_prompt→{recipient_org_id}")

    return {"created": created}


def seed(db: Session) -> dict:
    """데모 데이터를 깐다(멱등). 커밋은 호출부가 한다 — dry-run이 가능하도록.

    ⚠ 알림은 여기 포함되지 않는다 — ``seed_notifications``를 따로, **이 함수의 결과가 커밋된
    뒤에** 불러야 한다(모듈 docstring 참고). 이 함수는 event/org/profile/venue/meeting까지만
    다루고, 전부 flush만 한다(commit 없음) — 그래야 dry-run이 진짜로 아무것도 안 남긴다.
    """
    event = _get_or_create_event(db)
    _get_or_create_schedule(db, str(event.id))
    _seed_operator_master(db, str(event.id))
    _seed_business_field_keyword_labels(db)

    exhibitor_specs = {spec.member_id: spec for spec in DEMO_EXHIBITORS}
    orgs: dict[str, str] = {}
    for member_id, org_name, org_name_en, role, buyer_subtype in DEMO_PARTICIPANTS:
        org = _get_or_create_participant(
            db, str(event.id), member_id, org_name, org_name_en, role, buyer_subtype
        )
        orgs[member_id] = str(org.id)
        if role == "exhibitor":
            _seed_exhibitor_profile(db, str(event.id), str(org.id), exhibitor_specs[member_id])
        elif role == "buyer":
            _seed_buyer_profile(db, str(event.id), str(org.id), member_id)

    _seed_venues(db, str(event.id))
    meetings, meeting_warnings = _seed_meetings(db, str(event.id), orgs)
    return {
        "event_id": str(event.id),
        "organizations": orgs,
        "meetings": meetings,
        "meeting_warnings": meeting_warnings,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="NABI 데모 데이터 시드(멱등)")
    parser.add_argument(
        "--dry-run", action="store_true", help="커밋하지 않고 무엇이 만들어지는지만 확인"
    )
    args = parser.parse_args(argv)

    with SessionLocal() as db:
        result = seed(db)
        if args.dry_run:
            db.rollback()
            print("[dry-run] 롤백함 — 아무것도 쓰지 않았다(알림도 발화하지 않음)")
        else:
            db.commit()
        print(f"데모 행사: {result['event_id']}")
        for member_id, org_id in result["organizations"].items():
            print(f"  {member_id:<16} → organization {org_id}")
        print(f"미팅: {len(result['meetings'])}건 생성/재사용")
        for warning in result["meeting_warnings"]:
            print(f"  [skip] {warning}")
        if not args.dry_run:
            notif_result = seed_notifications(db, result["meetings"])
            print(f"알림: {len(notif_result['created'])}건 발화(신규)")
            for line in notif_result["created"]:
                print(f"  [notify] {line}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
