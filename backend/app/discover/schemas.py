"""기업 탐색 API의 요청/응답 계약 — **공개 프로젝션의 단일 화이트리스트**.

이 파일의 존재 이유는 "무엇을 내보낼지"가 아니라 **"무엇을 절대 내보내지 않을지"** 다.

``app.bm.schemas``의 ``ExhibitorProfileResponse``/``BuyerProfileResponse``는 **본인 프로필 편집**
화면용이라 참석자 연락처(email·tel·mobile·whatsapp)·추천 바이어·사업자번호·매출구간·미팅 불가
슬롯·비공개 노트까지 전부 담는다. 그 모델을 탐색에 재사용하면 그 순간 남의 기업 상세 화면에서
연락처가 새므로, 탐색은 **별도의 좁은 모델**을 갖는다.

Pydantic 응답 모델은 선언되지 않은 키를 직렬화에서 떨어뜨린다 — 서비스가 실수로 프로필 행을
통째로 dict에 담아도 여기 없는 필드는 응답에 실리지 않는다. 즉 이 모델이 마지막 게이트고,
``tests/test_discover_api.py``의 유출 방지 테스트가 그 게이트를 회귀 방지한다. **필드를 추가할
때는 그 값이 "행사에서 부스에 붙여둬도 되는 정보인가"를 먼저 물어라.**
"""

from __future__ import annotations

from typing import Literal, get_args

from pydantic import BaseModel, ConfigDict, Field

from app.models import DEFAULT_PARTICIPANT_MENU, PARTICIPANT_MENUS

PartyRole = Literal["exhibitor", "buyer"]
#: 관심기업을 담은 출처 — bookmark-store.ts의 BookmarkSource와 1:1(H-01 실연동).
BookmarkSource = Literal["ai", "all"]
#: 참가자 메뉴(F-NV-001 D15) — 참가사·바이어 화면의 왼쪽 메뉴 구성. 어휘의 진실원천은
#: ``app.models.PARTICIPANT_MENUS``(= DB CHECK ``event_schedule_settings_participant_menu_check``)다 —
#: 갈라지면 API는 통과하고 DB에서 터지므로 임포트 시점 assert로 드리프트를 잡는다(``app.admin.schemas``
#: 의 SlotMinutes와 같은 패턴). 행사 설정 PATCH(``app.admin.schemas``)도 이 Literal을 가져다 쓴다.
#: **화면 구성용 값이다 — 권한이 아니다**(ADR-0015).
ParticipantMenu = Literal["meetings_only", "full"]
assert get_args(ParticipantMenu) == PARTICIPANT_MENUS


# =============================================================================
# 탐색 — 공개 프로젝션
# =============================================================================
class DiscoverBoothOut(BaseModel):
    """부스 위치 — 참가사에만 있고, 배정 전이면 통째로 ``None``이다(빈 값을 지어내지 않는다)."""

    hall_no: str
    hall_name: str
    code: str


class DiscoverOrgOut(BaseModel):
    """탐색 카드 1장 = **(기업, 뷰어에게 보이는 역할)** 한 쌍.

    참가사이자 바이어인 기업(dual-role)은 카드가 두 장 나올 수 있다 — 같은 기업이라도 "참가사로서
    무엇을 전시하는가"와 "바이어로서 무엇에 관심 있는가"는 다른 정보고, 열람 권한도 역할별로
    따로 판정되기 때문이다(``visibility_rules``).

    프로필을 아직 아무도 쓰지 않은 기업(엑셀 임포트만 된 상태)도 ``org_id``·``role``·``name``만으로
    목록에 나온다 — 나머지는 빈 값으로 정직하게 비운다.
    """

    org_id: str
    role: PartyRole
    #: 표시용 기업명 — ``name_ko`` 우선, 없으면 ``name_en``. 둘 다 없으면 빈 문자열(지어내지 않는다).
    name: str
    #: 바이어 세부유형(hosted/pre_registered/on_site). 참가사 카드에서는 항상 None.
    buyer_subtype: str | None = None
    booth: DiscoverBoothOut | None = None
    #: 관심/취급 분야 라벨(참가사=전시품목 분야, 바이어=관심 분야).
    keywords: list[str] = Field(default_factory=list)
    #: 전시 품목명(참가사 전용, 등록 순서). 바이어 카드에서는 항상 빈 목록.
    exhibits: list[str] = Field(default_factory=list)
    #: 기업 소개 — 참가사는 ``intro_ko ?? intro_en``, 바이어는 ``company_intro_en``.
    description: str | None = None
    employee_range: str | None = None
    #: 카테고리(3종, 셀러 전용 단일선택) — Hall 필터를 대체하는 회사 분류축. 바이어 카드에서는 항상 None.
    content_category: str | None = None


class DiscoverListResponse(BaseModel):
    """탐색 목록. ``total``은 **카드 수**다 — dual-role 기업은 2를 더한다(기업 수가 아니다)."""

    items: list[DiscoverOrgOut]
    total: int


# =============================================================================
# /api/me — 뷰어 자신의 참가 컨텍스트
# =============================================================================
class MeEventRoleOut(BaseModel):
    """내 기업이 어떤 행사에 어떤 역할·승인 상태로 참가 중인가(행사 1건 = 1행)."""

    event_id: str
    #: BM 프로필 API(``/api/bm/...``)의 경로 키 — 화면이 프로필 편집으로 넘어갈 때 쓴다.
    org_event_role_id: str
    is_exhibitor: bool
    is_buyer: bool
    buyer_subtype: str | None = None
    #: registered / submitted / changes_requested / approved / rejected.
    #: **탐색·미팅은 approved부터 열린다** — 화면의 잠금 안내가 이 값으로 갈린다.
    application_status: str
    #: 전시(미팅 진행) 기간 YYYY-MM-DD. 미팅 타임라인의 날짜 탭 원천 — 화면이 이걸 안 쓰고
    #: 상수를 박으면 행사일이 바뀔 때 그날 잡힌 실 미팅이 탭에서 조용히 사라진다.
    exhibition_start: str | None = None
    exhibition_end: str | None = None
    #: 격자 모양(mt003gap0001) — 칸 길이와 칸 사이 텀(분). 간격(stride) = slot_minutes +
    #: slot_gap_minutes. 참가자 미팅 타임라인(``frontend/lib/meeting/timeline.ts``)이 행을 이
    #: 값으로 끊는다. 없으면 프런트가 30분/텀0 으로 폴백하는데, 그건 40분/텀5분 행사에서
    #: 10:45 미팅을 10:30 행에 그리는 조용한 오류가 된다 — 그래서 위 기간 필드와 달리
    #: **필수**로 둔다(행사가 있으면 slot_minutes는 NOT NULL, 설정 행이 없으면 텀은 0).
    slot_minutes: int
    slot_gap_minutes: int
    #: 운영시간·점심 "HH:MM"(``event_schedule_settings``). 칸 길이·텀만으로는 격자를 못 만든다 —
    #: **어디서 시작해 어디서 끊는지**가 빠지면 참가자 타임라인이 09:00~18:00 폴백으로 떨어져,
    #: 발주사 운영표(10:00~18:10)에서는 백엔드 격자(10:00, 10:45 …)와 **공유하는 시각이 하나도
    #: 없어진다**. 운영자 배정 그리드가 읽는 값(``AssignmentScheduleSettingsOut``)과 같은 원천이다.
    #: 설정 행이 없는 행사는 None — 그때만 화면이 폴백을 고른다. 점심 미설정도 None(운영자 응답은
    #: "00:00" 폴백을 쓰지만, 여기선 "없음"과 "자정"을 구분할 수 있게 null을 그대로 내보낸다).
    operating_start: str | None = None
    operating_end: str | None = None
    lunch_start: str | None = None
    lunch_end: str | None = None
    #: 참가자 메뉴(nv001menu0001) — ``meetings_only``(미팅만, 기본) / ``full``(전체 메뉴). 참가사·바이어
    #: 화면이 왼쪽 메뉴·도착 화면·탐색으로 나가는 버튼을 이 값으로 고른다. 설정 행이 없는 행사는
    #: 기본값(``DEFAULT_PARTICIPANT_MENU``)이다. **화면 구성용 값이다** — 이 값이 ``meetings_only`` 여도
    #: 탐색·알림·프로필 API는 그대로 열려 있고, 화면도 주소로 직접 들어오면 열린다(ADR-0015).
    participant_menu: ParticipantMenu = DEFAULT_PARTICIPANT_MENU


class MeOut(BaseModel):
    """현재 로그인 주체의 소속 기업과 참가 역할 전부.

    로그인 응답은 세션만 주고 승인 상태를 싣지 않는다 — 화면이 "탐색을 열어도 되는가"를 판단하는
    유일한 원천이 이 엔드포인트다.

    **신원 필드(member_*)는 이 응답에만 있다.** 탐색 카드(``DiscoverOrgOut``)의 화이트리스트에
    연락처가 없는 것과 모순이 아니다 — 여기 실리는 건 **뷰어 자신의** 이름·이메일·연락처고
    (사이드바·마이페이지가 그리는 값), 탐색은 **남의** 기업 카드다. 남의 연락처는 여전히 안 나간다.

    전부 nullable이다: 명단 임포트만 된 주체는 members 행이 없을 수 있고(그때는 registrants의
    신고값으로 폴백), 그마저 비어 있으면 화면이 자리표시자를 고르게 비워 둔다.
    """

    organization_id: str
    organization_name: str
    #: 기업명(영문) — en 로케일 화면 표시용. 없으면 None(국문명으로 폴백할지는 화면이 정한다).
    organization_name_en: str | None = None
    member_name: str | None = None
    member_email: str | None = None
    member_phone: str | None = None
    #: 직함(members.title). registrants 폴백 경로에는 대응 값이 없어 None.
    member_title: str | None = None
    roles: list[MeEventRoleOut]


# =============================================================================
# 관심기업(북마크) — H-01: 서버 영속화(interested_organizations)
# =============================================================================
class BookmarkCreateBody(BaseModel):
    """POST /api/discover/bookmarks 요청 바디. ``extra="forbid"``라 오타 필드는 422."""

    model_config = ConfigDict(extra="forbid")

    target_org_id: str
    #: 담은 화면(AI 추천 탭="ai" / 전체 기업 탭="all"). 생략하면 None(모델 CHECK는 NULL 허용).
    source: BookmarkSource | None = None


class BookmarkOut(BaseModel):
    """관심기업 카드 1건 — 담은 대상과 출처만. 대상 기업의 상세 정보는 탐색 카드 API로 따로 조회한다."""

    target_org_id: str
    source: BookmarkSource | None = None


class BookmarkListResponse(BaseModel):
    items: list[BookmarkOut]
