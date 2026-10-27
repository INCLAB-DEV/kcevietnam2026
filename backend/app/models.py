"""NABI 도메인 ORM 모델 — docs/db/schema.sql의 1:1 파이썬 표현.

진실원천은 이 모델 + Alembic 마이그레이션(ADR-0008). docs/db/schema.sql은 여기서 파생되는
사람이 읽는 ERD 산출물이다. enum은 이식성을 위해 CHECK 제약으로 표현(schema.sql과 동일).

fit score(적합도) 정의 미해결(HITL) — 점수 의존 컬럼(meetings.ai_score / ai_score_reasons,
ai_match_suggestions.ai_score …)은 nullable로 깔되 정의 확정 전까지 채우지 않는다(#48).
"""

from sqlalchemy import (
    ARRAY,
    BigInteger,
    Boolean,
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    Text,
    Time,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID, ExcludeConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base

# 공통 서버 디폴트
_UUID_PK = text("gen_random_uuid()")
_NOW = text("now()")

# BM 프로필 고정 코드(docs/db/bm-profile-fields §1). CHECK 제약·시드·API 검증이 공유한다.
# 사업분야(business_field, 셀러·바이어 공용·멀티선택, 8종) — K-콘텐츠 택소노미(kct001tax01). 옛
# 방산 13분야(defense_field)를 대체(값·이름 전면 교체, 1:1 매핑 없음 — 데이터는 폐기·재시드).
BUSINESS_FIELDS = (
    "game_production", "animation_distribution", "content_production", "music_platform",
    "newtech_content", "character_licensor", "webtoon_production", "music_production",
)
# 카테고리(content_category, 셀러 전용·단일선택, 3종) — kct001tax01 신설. exhibitor_profiles의
# 스칼라 컬럼(keyword 조인 아님 — discover 태그 쿼리가 namespace를 필터하지 않아 조인에 넣으면
# business_field 태그와 뒤섞인다). Hall 필터를 대체하는 회사 분류축.
CONTENT_CATEGORIES = ("animation_character", "broadcasting", "comics_game_music")
ORG_TYPES = (
    "private_defense", "private_commercial", "association", "government",
    "exhibition_agent", "media", "local_gov", "other",
)
MEETING_LANGUAGES = ("ko", "en", "zh", "ja", "ru", "vi", "other")  # vi=베트남어(2026 베트남 K-콘텐츠 엑스포). 변경 시 마이그레이션으로 5개 언어 CHECK 재생성 필요.
PARTICIPATION_ROUTES = ("re_1_2", "re_3_5", "re_6plus", "new")
ACQUISITION_CHANNELS = ("edm", "official_letter", "kotra_invitation", "website_sns", "media")
ANNUAL_SALES_BUYER = ("usd_lt_500k", "usd_500k_1m", "usd_1m_5m", "usd_gt_5m")
ANNUAL_SALES_SELLER = ("krw_1_5", "krw_5_10", "krw_10_50", "krw_50plus")
EMPLOYEE_RANGES = ("e_0_10", "e_11_50", "e_51_100", "e_101plus")
BUSINESS_PERF_KOREA = ("none", "usd_1_1m", "usd_1m_5m", "usd_5m_plus")
TRAVELERS_KOREA = ("t_0_500", "t_501_1000", "t_1001_5000", "t_5001_10000", "t_10000plus")
PRODUCT_PRICE_RANGES = ("krw_0_10m", "krw_10_30m", "krw_30_50m", "krw_50_70m", "krw_70_100m")
# 바이어 지출 가능 예산(USD, BM-001 신청서 신규 2026-06-29) — buyer_profiles.budget_range CHECK·
# bm/schemas.py BudgetRange Literal이 공유.
BUDGET_RANGES = ("usd_lt_100k", "usd_100k_500k", "usd_500k_1m", "usd_1m_5m", "usd_5m_10m", "usd_10m_plus")
# 바이어 도입 시기(년도+반기, BM-001 신청서 신규 2026-06-29) — buyer_profiles.adoption_timeline CHECK·
# bm/schemas.py AdoptionTimeline Literal이 공유. 코드=<year>_h<1|2>(상반기 h1/하반기 h2).
ADOPTION_TIMELINES = (
    "2026_h2", "2027_h1", "2027_h2", "2028_h1", "2028_h2",
    "2029_h1", "2029_h2", "2030_h1", "2030_h2", "undecided",
)
APPLICATION_STATUSES = ("registered", "submitted", "changes_requested", "approved", "rejected")
# 알림 6종(ADR-0010/F-NT-001). FE 목업(frontend/lib/home/notification.ts NotificationType)이 사실상의
# 타입 계약 — application_approved(신청 승인 완료)·meeting_rejected(미팅 거절, GitHub #4)까지
# 포함해 8종. app/notifications/schemas.py의 NotificationType Literal이 이 튜플과 일치하는지
# assert로 드리프트를 잡는다.
NOTIFICATION_TYPES = (
    "meeting_requested", "meeting_accepted", "meeting_cancelled",
    "meeting_reminder", "review_prompt", "review_ready", "application_approved",
    "meeting_rejected",
)
# 미팅 슬롯 한 칸 길이(분) 선택지(#OP 슈퍼어드민 콘솔) — events.slot_minutes CHECK·admin API 검증 공유.
# 40은 베트남 K-콘텐츠 엑스포 발주사 운영표(40분 상담 + 5분 텀) 대응으로 추가했다. event_schedule_settings
# .slot_gap_minutes와 짝을 이뤄 "상담 길이 ≠ 슬롯 간격" 격자를 만든다(app.matching.slot_grid docstring 참고).
SLOT_MINUTES_CHOICES = (10, 20, 30, 40, 60)
# Meeting Venue 유형(meeting_venues.venue_type과 동일 값) — events.enabled_venue_types(행사별 on/off
# 정책)가 이 집합의 부분집합인지 CHECK. 행사마다 어떤 미팅 장소 유형을 쓸지 다르다(예: 베트남 행사는
# booth만 운영 — matching_zone·business_room 없음).
VENUE_TYPES = ("booth", "zone_table", "business_room")
# 참가자 메뉴(F-NV-001 D15, nv001menu0001) — 참가사·바이어 화면의 왼쪽 메뉴 구성을 행사가 고른다.
# meetings_only=미팅만(기본), full=대시보드·기업 탐색·미팅·알림·프로필(이 설정이 생기기 전의 메뉴).
# event_schedule_settings.participant_menu CHECK·admin API 검증(app.discover.schemas.ParticipantMenu)·
# /api/me·알림 메일 문구가 공유한다.
# ⚠ **화면 구성용 값이다 — 권한이 아니다.** meetings_only여도 탐색·알림·프로필·미팅 신청 API는
#   그대로 열려 있다. 이 값으로 API를 막는 코드를 넣지 않는다(막아야 하면 별도 정책으로 결정한다).
PARTICIPANT_MENUS = ("meetings_only", "full")
#: 기본값 — 컬럼 server_default이자, 값을 알 수 없을 때(설정 행이 없는 행사·봉투에 값이 안 실린 알림)의
#: **유일한** 폴백이다. 폴백을 쓰는 곳은 전부 이 상수를 본다(값을 따로 적지 않는다).
#: 미팅만이 기본인 건 발주사 결정이다(2026-10-08): 배포하는 순간 참가사·바이어 화면이 미팅 전용으로
#: 보여야 하고 누가 설정을 켤 필요가 없어야 한다. 전체 메뉴는 행사 설정에서 고르면 돌아온다.
DEFAULT_PARTICIPANT_MENU = "meetings_only"
# 참가자 알림 메일(F-NT-001, nt004mail0001, 화면 이름 "참가사·바이어 알림 메일") — 이 행사의 참가기업·바이어에게
# 메일을 보낼지. 꺼져 있으면 **회원가입 인증 코드 말고는 어떤 메일도 나가지 않는다**(2026-10-16 발주사 요구
# "어떠한 메일도"): 자동 알림(신청 승인·미팅 요청/확정/거절/취소·리마인더·회의록 안내 등 notifications.service를
# 거치는 8종)은 인앱만 남고 외부 채널(이메일 등)은 보내지 않으며, 러브콜 메일(참가자가 직접 쓰고 '보내기'를 누르는
# 메일)은 409로 거절한다(app/api/love_call.py). 누가 조작했든(참가자 본인·운영자·스케줄러) 같다. 가입 인증 코드는
# 행사와 무관한 가입 절차라 예외다. event_schedule_settings.participant_email_enabled·admin API·알림 서비스·
# 러브콜 API가 공유한다.
#: 기본값 — 컬럼 server_default·ORM default이자, 설정 행이 없는 행사의 폴백이다(폴백을 쓰는 곳은 전부 이
#: 상수를 본다). **꺼짐이 기본**인 건 발주사 결정이다(2026-10-16): 배포하는 순간 모든 행사의 자동 알림 메일이
#: 멈추고(기존 행도 false로 백필), 메일을 보낼 행사는 마스터가 행사 설정에서 켠다.
#: ⚠ 그래서 이 상수가 들어간 배포는 무동작 변화가 아니다 — 이 설정이 생기기 전에는 늘 메일이 나갔다.
DEFAULT_PARTICIPANT_EMAIL_ENABLED = False
# 미팅 취소/거절 사유 코드(F-MT-001 참가자 미팅 도메인). app.meetings.schemas의 Pydantic Literal이
# 이 튜플과 일치하는지 assert로 드리프트를 잡는다(NOTIFICATION_TYPES와 같은 패턴).
# ⚠ DB CHECK 제약은 걸지 않는다 — 사유 어휘가 아직 확정 전이라 어휘 변경이 마이그레이션을 요구하지
#   않게 두고, 강제는 API 경계(Pydantic Literal)에서만 한다. 대신 "사유는 그 상태에서만 존재한다"는
#   구조적 불변식(cancelled_reason_code IS NULL OR status='cancelled')은 CHECK로 건다.
MEETING_CANCEL_REASONS = ("schedule_conflict", "counterpart_request", "internal_change", "other")
MEETING_REJECT_REASONS = ("interest_mismatch", "schedule_unavailable", "other")


def _in(column: str, values: tuple[str, ...]) -> str:
    """CHECK용 ``col IN ('a','b',...)`` 리터럴 생성(코드값을 단일 출처에서 파생)."""
    joined = ", ".join(f"'{v}'" for v in values)
    return f"{column} IN ({joined})"


def _array_subset(column: str, values: tuple[str, ...]) -> str:
    """text[] 멀티선택용 ``col <@ ARRAY[...]`` 제약(원소가 허용집합 부분집합)."""
    joined = ", ".join(f"'{v}'" for v in values)
    return f"{column} <@ ARRAY[{joined}]::text[]"


# =============================================================================
# 1. 이벤트
# =============================================================================
class Event(Base):
    """행사(전시회) — 슈퍼어드민이 행사마다 새로 만든다(멀티 이벤트, #OP 어드민 콘솔). 정책 컬럼
    (slot_minutes/enabled_venue_types/allow_same_role_discovery)은 행사별로 뒤집을 수 있다 — 베트남
    전시 전용 값을 스키마에 박지 않고 다음 행사에서 다른 값을 넣을 수 있게 한다."""

    __tablename__ = "events"

    id: Mapped[str] = mapped_column(UUID(as_uuid=False), primary_key=True, server_default=_UUID_PK)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    name_en: Mapped[str | None] = mapped_column(Text)  # 행사명(영문) — 한/영 다국어 요건(FE 어드민 콘솔)
    slug: Mapped[str] = mapped_column(Text, nullable=False, unique=True)
    venue_name: Mapped[str | None] = mapped_column(Text)  # 전시장 장소명(예: SECC 호치민) — 자유텍스트
    exhibition_start: Mapped[str | None] = mapped_column(Date)  # 전시(미팅 진행) 시작일
    exhibition_end: Mapped[str | None] = mapped_column(Date)  # 전시(미팅 진행) 종료일
    application_start: Mapped[str | None] = mapped_column(Date)
    application_end: Mapped[str | None] = mapped_column(Date)
    open_at: Mapped[str | None] = mapped_column(Date)
    # 행사 로컬 타임존(IANA 문자열, 예: 'Asia/Seoul'·'Asia/Ho_Chi_Minh'). 슬롯 그리드·신청기간·
    # "미래 슬롯만" 판정이 전부 이 값 기준이다 — 멀티 행사(해외 전시) 대응으로 KST를 코드에 박지
    # 않는다. 값 검증(zoneinfo 해석 가능 여부)은 앱에서 한다(DB CHECK로 IANA DB를 흉내내지 않음).
    timezone: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("'Asia/Seoul'"))
    # 미팅 슬롯 한 칸 길이(분) — 운영자가 10/20/30/40/60 중 선택(#OP 슈퍼어드민 설정). 기본 30.
    # ⚠ 슬롯 길이의 **단일 진실원천**이다. event_schedule_settings에도 같은 컬럼이 있었으나
    #   두 원천이 갈라지는 걸 막으려고 mt001meet01에서 제거했다(그쪽 값은 여기로 흡수).
    slot_minutes: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text("30"))
    # 이 행사에서 쓰는 미팅 장소 유형(부분집합, meeting_venues.venue_type과 동일 값집합). 기본 3종 전부.
    enabled_venue_types: Mapped[list[str]] = mapped_column(
        ARRAY(Text), nullable=False, server_default=text("'{booth,zone_table,business_room}'")
    )
    # 참가기업 열람 범위 정책(개발계획서 §8, app.domain.visibility_rules 소비) — 같은 역할끼리
    # (참가사↔참가사, 바이어↔바이어) 서로 열람 허용 여부. 기본 false(베트남 전시 정책) — 행사별 토글.
    allow_same_role_discovery: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("false"))
    created_at: Mapped[str] = mapped_column(DateTime(timezone=True), nullable=False, server_default=_NOW)

    __table_args__ = (
        CheckConstraint(
            "slot_minutes IN (" + ", ".join(str(v) for v in SLOT_MINUTES_CHOICES) + ")",
            name="events_slot_minutes_check",
        ),
        CheckConstraint(_array_subset("enabled_venue_types", VENUE_TYPES), name="events_enabled_venue_types_check"),
    )


# =============================================================================
# 2. 운영사(Organizer)
# =============================================================================
class Organizer(Base):
    __tablename__ = "organizers"

    # NABI 발급 내부 계정(주관사 roster 밖 — ADR-0007). 권한등급은 계정 전역이 아니라 계정×행사 단위라
    # event_organizers 로 옮겼다(ADR-0012) — 여기엔 권한 컬럼을 두지 않는다.
    id: Mapped[str] = mapped_column(UUID(as_uuid=False), primary_key=True, server_default=_UUID_PK)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    email: Mapped[str] = mapped_column(Text, nullable=False, unique=True)
    # 인증 신원(운영자 가드의 회원ID, app.auth.organizer_guard.EventMasterPrincipal.member_id)과
    # 이 행 사이의 다리. 실 Cognito 운영자 어댑터가 아직 없어(organizer_guard 자체 문서화된 갭) 어드민
    # 서비스가 최초 접근 시 get-or-create로 채운다(app.admin.guard.resolve_organizer_id). nullable·unique.
    member_id: Mapped[str | None] = mapped_column(Text, unique=True)
    created_at: Mapped[str] = mapped_column(DateTime(timezone=True), nullable=False, server_default=_NOW)


class EventOrganizer(Base):
    __tablename__ = "event_organizers"

    id: Mapped[str] = mapped_column(UUID(as_uuid=False), primary_key=True, server_default=_UUID_PK)
    event_id: Mapped[str] = mapped_column(ForeignKey("events.id", ondelete="CASCADE"), nullable=False)
    organizer_id: Mapped[str] = mapped_column(ForeignKey("organizers.id", ondelete="CASCADE"), nullable=False)
    # 계정×행사 단위 권한등급(ADR-0012). 전역 기본 없음 — 행사별 명시 부여. admin은 master-for-this-event.
    permission_level: Mapped[str] = mapped_column(Text, nullable=False)
    # 배정 시각(#OP 운영자 목록의 OrganizerOut.granted_at) — app.admin.router._organizer_out가 참조.
    created_at: Mapped[str] = mapped_column(DateTime(timezone=True), nullable=False, server_default=_NOW)

    __table_args__ = (
        CheckConstraint(
            "permission_level IN ('master', 'sub')", name="event_organizers_permission_level_check"
        ),
        UniqueConstraint("event_id", "organizer_id", name="event_organizers_event_id_organizer_id_key"),
    )


# =============================================================================
# 3. Organization(기업)
# =============================================================================
class Organization(Base):
    """기업 — 안정 법인정체성만(bm-profile-fields §2). 행사별 선언값(위치·연락·소개·규모)은
    역할 프로필 스냅샷으로 이관. name_ko/name_en 모두 nullable(이른 생성 시 한쪽만 있을 수 있음)."""

    __tablename__ = "organizations"

    id: Mapped[str] = mapped_column(UUID(as_uuid=False), primary_key=True, server_default=_UUID_PK)
    name_ko: Mapped[str | None] = mapped_column(Text)  # 기업명(국문)
    name_en: Mapped[str | None] = mapped_column(Text)  # 기업명(영문)/Organization
    business_reg_no: Mapped[str | None] = mapped_column(Text)  # 부가속성(upsert 키 아님, D4)
    website: Mapped[str | None] = mapped_column(Text)  # 홈페이지/Website
    created_at: Mapped[str] = mapped_column(DateTime(timezone=True), nullable=False, server_default=_NOW)


# =============================================================================
# 3b. Registrant 적재층 (ADR-0009)
# =============================================================================
class Registrant(Base):
    __tablename__ = "registrants"

    id: Mapped[str] = mapped_column(UUID(as_uuid=False), primary_key=True, server_default=_UUID_PK)
    event_id: Mapped[str] = mapped_column(ForeignKey("events.id", ondelete="CASCADE"), nullable=False)
    organizer_member_id: Mapped[str] = mapped_column(Text, nullable=False)
    organization_id: Mapped[str | None] = mapped_column(ForeignKey("organizations.id", ondelete="SET NULL"))
    name: Mapped[str | None] = mapped_column(Text)
    org_name: Mapped[str | None] = mapped_column(Text)
    contact_email: Mapped[str | None] = mapped_column(Text)
    contact_phone: Mapped[str | None] = mapped_column(Text)
    business_number: Mapped[str | None] = mapped_column(Text)
    role_hint: Mapped[str | None] = mapped_column(Text)
    raw: Mapped[dict] = mapped_column(JSONB, nullable=False)
    created_at: Mapped[str] = mapped_column(DateTime(timezone=True), nullable=False, server_default=_NOW)
    updated_at: Mapped[str] = mapped_column(DateTime(timezone=True), nullable=False, server_default=_NOW)

    __table_args__ = (
        CheckConstraint("role_hint IN ('exhibitor', 'buyer', 'both')", name="registrants_role_hint_check"),
        UniqueConstraint("event_id", "organizer_member_id", name="registrants_event_id_organizer_member_id_key"),
    )


class Member(Base):
    __tablename__ = "members"

    id: Mapped[str] = mapped_column(UUID(as_uuid=False), primary_key=True, server_default=_UUID_PK)
    organization_id: Mapped[str] = mapped_column(ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False)
    registrant_id: Mapped[str | None] = mapped_column(
        ForeignKey("registrants.id", ondelete="SET NULL"), unique=True
    )
    name: Mapped[str] = mapped_column(Text, nullable=False)
    email: Mapped[str] = mapped_column(Text, nullable=False, unique=True)
    title: Mapped[str | None] = mapped_column(Text)
    phone: Mapped[str | None] = mapped_column(Text)  # 자체 회원가입(§7.3)·명단 업로드 연락처 — 없으면 NULL
    # 로컬 로그인 비밀번호 해시(bcrypt, alg-cost-salt-hash 인코딩 포함). ADR-0007 "공개 자체
    # 회원가입은 열지 않는다"를 발주자 지시로 부분 supersede(app.auth.signup_service 참고).
    # 명단 업로드로 생긴 담당자는 운영자가 공통 비밀번호를 함께 올렸을 때만 채워진다(app.roster,
    # 2026-09-16 — 이미 있는 값은 덮어쓰지 않음). 그 외엔 NULL(로컬 로그인 대상 아님).
    password_hash: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[str] = mapped_column(DateTime(timezone=True), nullable=False, server_default=_NOW)


# =============================================================================
# 3b-1. 가입 이메일 인증코드 (#9 — 실존 이메일 인증)
# =============================================================================
class EmailVerificationCode(Base):
    """자체 회원가입 이메일 인증코드 1건 — app.auth.email_verification_service가 발급·소진한다.

    평문 코드는 어디에도 저장하지 않는다(code_hash만). 재발송 시 같은 email의 기존 미소비
    코드는 consumed_at을 채워 무효화한다(app.auth.email_verification_service.request_code).
    """

    __tablename__ = "email_verification_codes"

    id: Mapped[str] = mapped_column(UUID(as_uuid=False), primary_key=True, server_default=_UUID_PK)
    email: Mapped[str] = mapped_column(Text, nullable=False)
    code_hash: Mapped[str] = mapped_column(Text, nullable=False)
    expires_at: Mapped[str] = mapped_column(DateTime(timezone=True), nullable=False)
    consumed_at: Mapped[str | None] = mapped_column(DateTime(timezone=True))
    attempt_count: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text("0"))
    created_at: Mapped[str] = mapped_column(DateTime(timezone=True), nullable=False, server_default=_NOW)

    __table_args__ = (
        Index("ix_email_verification_codes_email_created_at", "email", "created_at"),
    )


# =============================================================================
# 3c. 약관 동의 모델 (ADR-0009)
# =============================================================================
_CONSENT_TYPES = "type IN ('tos', 'privacy', 'sensitive', 'third_party', 'marketing')"


class ConsentDocument(Base):
    __tablename__ = "consent_documents"

    id: Mapped[str] = mapped_column(UUID(as_uuid=False), primary_key=True, server_default=_UUID_PK)
    type: Mapped[str] = mapped_column(Text, nullable=False)
    title: Mapped[str] = mapped_column(Text, nullable=False)
    version: Mapped[str] = mapped_column(Text, nullable=False)
    content_url: Mapped[str | None] = mapped_column(Text)
    is_required: Mapped[bool] = mapped_column(Boolean, nullable=False)
    effective_date: Mapped[str | None] = mapped_column(Date)
    created_at: Mapped[str] = mapped_column(DateTime(timezone=True), nullable=False, server_default=_NOW)

    __table_args__ = (
        CheckConstraint(_CONSENT_TYPES, name="consent_documents_type_check"),
        UniqueConstraint("type", "version", name="consent_documents_type_version_key"),
    )


class UserConsentState(Base):
    __tablename__ = "user_consent_states"

    id: Mapped[str] = mapped_column(UUID(as_uuid=False), primary_key=True, server_default=_UUID_PK)
    member_id: Mapped[str] = mapped_column(ForeignKey("members.id", ondelete="CASCADE"), nullable=False)
    type: Mapped[str] = mapped_column(Text, nullable=False)
    consent_document_id: Mapped[str | None] = mapped_column(ForeignKey("consent_documents.id"))
    agreed: Mapped[bool] = mapped_column(Boolean, nullable=False)
    agreed_at: Mapped[str | None] = mapped_column(DateTime(timezone=True))
    withdrawn_at: Mapped[str | None] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[str] = mapped_column(DateTime(timezone=True), nullable=False, server_default=_NOW)

    __table_args__ = (
        CheckConstraint(_CONSENT_TYPES, name="user_consent_states_type_check"),
        UniqueConstraint("member_id", "type", name="user_consent_states_member_id_type_key"),
    )


class UserConsentHistory(Base):
    __tablename__ = "user_consent_history"

    id: Mapped[str] = mapped_column(UUID(as_uuid=False), primary_key=True, server_default=_UUID_PK)
    member_id: Mapped[str] = mapped_column(ForeignKey("members.id", ondelete="CASCADE"), nullable=False)
    consent_document_id: Mapped[str | None] = mapped_column(ForeignKey("consent_documents.id"))
    action: Mapped[str] = mapped_column(Text, nullable=False)
    acted_at: Mapped[str] = mapped_column(DateTime(timezone=True), nullable=False, server_default=_NOW)
    ip: Mapped[str | None] = mapped_column(Text)
    method: Mapped[str | None] = mapped_column(Text)

    __table_args__ = (
        CheckConstraint("action IN ('agreed', 'withdrawn')", name="user_consent_history_action_check"),
    )


# =============================================================================
# 4. 이벤트별 역할
# =============================================================================
class OrganizationEventRole(Base):
    __tablename__ = "organization_event_roles"

    id: Mapped[str] = mapped_column(UUID(as_uuid=False), primary_key=True, server_default=_UUID_PK)
    organization_id: Mapped[str] = mapped_column(ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False)
    event_id: Mapped[str] = mapped_column(ForeignKey("events.id", ondelete="CASCADE"), nullable=False)
    is_exhibitor: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("false"))
    is_buyer: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("false"))
    buyer_subtype: Mapped[str | None] = mapped_column(Text)
    # 승인 상태머신(bm-profile-fields §6): registered→submitted→{approved|changes_requested|rejected},
    # changes_requested→submitted(재제출). 매칭 노출은 approved 부터.
    application_status: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("'registered'"))
    # 승인 검토(bm-profile-fields §6) — submitted 검토 결과 기록.
    reviewed_at: Mapped[str | None] = mapped_column(DateTime(timezone=True))  # 운영 검토 시각
    reviewed_by: Mapped[str | None] = mapped_column(ForeignKey("organizers.id", ondelete="SET NULL"))
    review_note: Mapped[str | None] = mapped_column(Text)  # 반려·변경요청 사유
    # 바이어 소유권 링크(ADR-0012) — sub 운영자의 관할(Jurisdiction)을 정의. 해외 바이어는 "현재 관리 운영자
    # 최대 하나"(nullable·재배정 가능). 프로필 제출 전에도 소유권 존재 가능해 프로필이 아닌 역할 행에 둔다.
    # exhibitor-only·국내 바이어는 NULL. master는 이 링크와 무관하게 전역 관할(검사는 FastAPI 경계 B).
    managing_organizer_id: Mapped[str | None] = mapped_column(
        ForeignKey("organizers.id", ondelete="SET NULL")
    )  # 현재 관리 운영자(재배정 가능)
    created_by_organizer_id: Mapped[str | None] = mapped_column(
        ForeignKey("organizers.id", ondelete="SET NULL")
    )  # 최초 등록 운영자 기록(ADR-0012 문서상 created_by_operator_id — FK가 organizers라 일관 네이밍)
    # 신청서 대리작성 감사(#OP 슈퍼어드민 콘솔) — 엑셀 임포트만 되고 회원가입 안 한 기업의 프로필을
    # 운영자가 대신 작성했을 때 채운다. master 작성은 approved, sub 작성은 submitted로 함께 전이한다.
    # 일반 자가작성/직접수정 경로는 NULL.
    proxy_written_by_organizer_id: Mapped[str | None] = mapped_column(
        ForeignKey("organizers.id", ondelete="SET NULL")
    )
    created_at: Mapped[str] = mapped_column(DateTime(timezone=True), nullable=False, server_default=_NOW)

    __table_args__ = (
        CheckConstraint(
            "buyer_subtype IN ('hosted', 'pre_registered', 'on_site')",
            name="organization_event_roles_buyer_subtype_check",
        ),
        CheckConstraint(
            _in("application_status", APPLICATION_STATUSES),
            name="organization_event_roles_application_status_check",
        ),
        UniqueConstraint("organization_id", "event_id", name="organization_event_roles_organization_id_event_id_key"),
    )


# =============================================================================
# 4b. 매칭/스케줄 설정 (ADR-0006 / F-OP-005)
# =============================================================================
class EventScheduleSettings(Base):
    __tablename__ = "event_schedule_settings"

    id: Mapped[str] = mapped_column(UUID(as_uuid=False), primary_key=True, server_default=_UUID_PK)
    event_id: Mapped[str] = mapped_column(
        ForeignKey("events.id", ondelete="CASCADE"), nullable=False, unique=True
    )
    operating_start: Mapped[str] = mapped_column(Time, nullable=False, server_default=text("'09:00'"))
    operating_end: Mapped[str] = mapped_column(Time, nullable=False, server_default=text("'18:00'"))
    # ⚠ slot_minutes는 여기 없다 — events.slot_minutes가 단일 진실원천(mt001meet01에서 제거).
    #   두 테이블이 서로 다른 슬롯 길이를 들고 있으면 그리드와 예약이 갈라진다.
    lunch_start: Mapped[str | None] = mapped_column(Time)
    lunch_end: Mapped[str | None] = mapped_column(Time)
    # 슬롯과 슬롯 사이의 텀(분). 상담 길이(events.slot_minutes)와 **간격**을 분리한다 — 발주사 운영표가
    # "40분 상담 + 5분 텀"(10:00~10:40, 10:45~11:25 …)이라 "길이가 곧 간격"이라는 기존 가정을 깬다.
    # 간격(stride) = events.slot_minutes + 이 값. 0이면 간격 = 길이(현행과 동일) — 기존 행은 0으로
    # 백필되므로 무동작 변화다. 길이와 달리 events가 아닌 여기 두는 이유: slot_minutes는 매칭 노출·
    # 엑셀·지표가 널리 읽는 행사 정책이고, 텀은 격자 모양만 다루는 운영 세부값이라 변경 반경이 다르다.
    slot_gap_minutes: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text("0"))
    min_guaranteed_slots: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text("10"))
    # 미팅 1건의 최대 길이(분) — 연속 슬롯 예약 상한. 칸 수 상한(구 MAX_RUN_SLOTS=3)을 분으로 바꿨다:
    # 슬롯이 40분이 되면 3칸 스팬이 130분이 되어 원래 기준인 "최대 1시간 반"을 넘기 때문이다. 기본 90은
    # 현행 30분×3칸=90분을 그대로 허용한다(하위호환). 잴 때는 **스팬**(마지막 칸 end − 첫 칸 start,
    # 중간 텀 포함)이며, 상한을 바꾸는 건 배포 없이 이 설정값 하나로 된다.
    max_meeting_minutes: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text("90"))
    # 참가자 메뉴(PARTICIPANT_MENUS) — 참가사·바이어 화면의 왼쪽 메뉴를 미팅만 낼지(meetings_only, 기본)
    # 전부 낼지(full). 화면 구성용 값이고 API 권한과 무관하다(PARTICIPANT_MENUS 주석). 기존 행은 기본값
    # (meetings_only)으로 백필되고 행이 없는 행사도 같은 값으로 읽는다(DEFAULT_PARTICIPANT_MENU) —
    # ⚠ 위 두 설정과 달리 **무동작 변화가 아니다**: 이 컬럼을 읽는 코드가 배포되는 순간 모든 행사의
    # 참가자 화면이 미팅 전용이 된다(발주사 결정). 전체 메뉴로 되돌리려면 행사 설정에서 full을 고른다.
    # 행사 정책인데 events가 아닌 여기 두는 이유: events는 레포 밖 읽기 전용 계정이
    # 직접 읽는 테이블이라 스키마를 바꾸지 않는다 — 위 두 설정(mt003gap0001)과 같은 자리다.
    participant_menu: Mapped[str] = mapped_column(
        Text, nullable=False, server_default=text(f"'{DEFAULT_PARTICIPANT_MENU}'")
    )
    # 참가자 알림 메일(DEFAULT_PARTICIPANT_EMAIL_ENABLED 주석) — false면 이 행사의 자동 알림은 인앱만 남고
    # 이메일 등 외부 채널은 보내지 않으며(dispatch는 skipped + error='event_email_disabled'), 러브콜 메일도
    # 409로 거절한다(가입 인증 코드만 예외). **기본은 꺼짐**
    # — 기존 행은 false로 백필되고, 행이 없는 행사도 false로 읽고, 새로 만드는 행도 false다(발주사 결정
    # 2026-10-16). 켜는 건 마스터가 행사 설정에서 한다. 다시 켜도 꺼져 있던 동안의 메일을 몰아서 보내지
    # 않는다(백필 없음). 위 설정들과 같은 이유로 events가 아닌 여기 둔다.
    participant_email_enabled: Mapped[bool] = mapped_column(
        Boolean,
        nullable=False,
        default=DEFAULT_PARTICIPANT_EMAIL_ENABLED,
        server_default=text("true" if DEFAULT_PARTICIPANT_EMAIL_ENABLED else "false"),
    )
    created_at: Mapped[str] = mapped_column(DateTime(timezone=True), nullable=False, server_default=_NOW)
    updated_at: Mapped[str] = mapped_column(DateTime(timezone=True), nullable=False, server_default=_NOW)

    __table_args__ = (
        CheckConstraint(
            _in("participant_menu", PARTICIPANT_MENUS),
            name="event_schedule_settings_participant_menu_check",
        ),
    )


# =============================================================================
# 4c. 통역사 배정 (#OP 슈퍼어드민 콘솔) — 참가기업별 통역사. 회의록 작성은 통역사가 하지만
#    통역사 자체 로그인 계정 체계는 추후(v1은 스키마+운영자 관리만).
# =============================================================================
class Interpreter(Base):
    """행사에 소속된 통역사 인력 풀. 회사(Organization)가 아니라 개인 자원 — event_id로 행사에 귀속."""

    __tablename__ = "interpreters"

    id: Mapped[str] = mapped_column(UUID(as_uuid=False), primary_key=True, server_default=_UUID_PK)
    event_id: Mapped[str] = mapped_column(ForeignKey("events.id", ondelete="CASCADE"), nullable=False)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    languages: Mapped[list[str] | None] = mapped_column(ARRAY(Text))
    phone: Mapped[str | None] = mapped_column(Text)
    email: Mapped[str | None] = mapped_column(Text)
    note: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[str] = mapped_column(DateTime(timezone=True), nullable=False, server_default=_NOW)
    updated_at: Mapped[str] = mapped_column(DateTime(timezone=True), nullable=False, server_default=_NOW)

    __table_args__ = (
        CheckConstraint(_array_subset("languages", MEETING_LANGUAGES), name="interpreters_languages_check"),
    )


class InterpreterAssignment(Base):
    """참가기업(Organization) ↔ 통역사 배정. 한 기업은 행사당 통역사 하나(재배정은 갈아끼움) —
    unique(event, organization)로 강제. 한 통역사는 여러 기업을 맡을 수 있다(반대는 제약 없음)."""

    __tablename__ = "interpreter_assignments"

    id: Mapped[str] = mapped_column(UUID(as_uuid=False), primary_key=True, server_default=_UUID_PK)
    interpreter_id: Mapped[str] = mapped_column(ForeignKey("interpreters.id", ondelete="CASCADE"), nullable=False)
    organization_id: Mapped[str] = mapped_column(ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False)
    event_id: Mapped[str] = mapped_column(ForeignKey("events.id", ondelete="CASCADE"), nullable=False)
    created_at: Mapped[str] = mapped_column(DateTime(timezone=True), nullable=False, server_default=_NOW)

    __table_args__ = (
        UniqueConstraint(
            "event_id", "organization_id", name="interpreter_assignments_event_id_organization_id_key"
        ),
    )


# =============================================================================
# 5. 키워드
# =============================================================================
class Keyword(Base):
    """분류 키워드 — 고정 분류체계(bm-profile-fields §1.1). category='business_field'(8)·'org_type'(8).

    ``code``는 영문 슬러그(API·매칭 식별자), ``label``은 표시(국문). ``category``는 namespace다
    (어느 분류체계인지 — 3-카테고리(content_category)와는 무관, 그건 스칼라 컬럼으로 별도 관리).
    unique는 (category, code)로 둔다(라벨 전역 unique 폐기).

    ``label_en``은 en 로케일 표시 라벨(i18n0001) — 없으면 ``label``로 폴백한다. ``code``를 화면에
    보여주는 선택지는 없다(식별자지 라벨이 아니다).
    """

    __tablename__ = "keywords"

    id: Mapped[str] = mapped_column(UUID(as_uuid=False), primary_key=True, server_default=_UUID_PK)
    code: Mapped[str | None] = mapped_column(Text)  # 고정 분류 슬러그(예 'mobility')
    label: Mapped[str] = mapped_column(Text, nullable=False)  # 표시 라벨(국문)
    label_en: Mapped[str | None] = mapped_column(Text)  # 표시 라벨(영문) — 없으면 label 폴백
    category: Mapped[str | None] = mapped_column(Text)

    __table_args__ = (UniqueConstraint("category", "code", name="keywords_category_code_key"),)


# =============================================================================
# 5b. 전시장 부스 계층 (Hall / Booth)
# =============================================================================
class Hall(Base):
    __tablename__ = "halls"

    id: Mapped[str] = mapped_column(UUID(as_uuid=False), primary_key=True, server_default=_UUID_PK)
    event_id: Mapped[str] = mapped_column(ForeignKey("events.id", ondelete="CASCADE"), nullable=False)
    hall_no: Mapped[str] = mapped_column(Text, nullable=False)
    hall_name: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[str] = mapped_column(DateTime(timezone=True), nullable=False, server_default=_NOW)

    __table_args__ = (UniqueConstraint("event_id", "hall_no", name="halls_event_id_hall_no_key"),)


class Booth(Base):
    __tablename__ = "booths"

    id: Mapped[str] = mapped_column(UUID(as_uuid=False), primary_key=True, server_default=_UUID_PK)
    hall_id: Mapped[str] = mapped_column(ForeignKey("halls.id", ondelete="CASCADE"), nullable=False)
    code: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[str] = mapped_column(DateTime(timezone=True), nullable=False, server_default=_NOW)

    __table_args__ = (UniqueConstraint("hall_id", "code", name="booths_hall_id_code_key"),)


# =============================================================================
# 6. Exhibitor 프로필
# =============================================================================
class ExhibitorProfile(Base):
    """셀러 프로필 — 행사별 선언(bm-profile-fields §4.1). 국/영 이중·구간 enum·파일 FK.
    잠정 컬럼(strength·achievements·target_*) 대체."""

    __tablename__ = "exhibitor_profiles"

    id: Mapped[str] = mapped_column(UUID(as_uuid=False), primary_key=True, server_default=_UUID_PK)
    org_event_role_id: Mapped[str] = mapped_column(
        ForeignKey("organization_event_roles.id", ondelete="CASCADE"), nullable=False, unique=True
    )
    booth_id: Mapped[str | None] = mapped_column(ForeignKey("booths.id", ondelete="SET NULL"))
    # step1 기본정보: 회원가입 등록 시 신고값 스냅샷(읽기 전용). 부스는 Hall>관(pavilion)>부스위치 3단계
    # 신고값 — 실제 배정은 위 booth_id FK(정규화 halls/booths, 현재 미배정 가능). 둘은 별개(신고 vs 배정).
    booth_hall: Mapped[str | None] = mapped_column(Text)  # 부스 Hall(7·8·9·10)
    booth_pavilion: Mapped[str | None] = mapped_column(Text)  # 관(대한민국관·드론/대드론/로봇관 등)
    booth_location: Mapped[str | None] = mapped_column(Text)  # 부스위치(미배정 시 NULL)
    booth_type: Mapped[str | None] = mapped_column(Text)  # 부스타입(독립부스 등)
    booth_count: Mapped[int | None] = mapped_column(Integer)  # 부스개수
    representative_name_ko: Mapped[str | None] = mapped_column(Text)  # 대표자명(국문)
    representative_name_en: Mapped[str | None] = mapped_column(Text)  # 대표자명(영문)
    company_email: Mapped[str | None] = mapped_column(Text)  # 회사 이메일
    zip_code: Mapped[str | None] = mapped_column(Text)  # 회사 우편번호
    business_type: Mapped[str | None] = mapped_column(Text)  # 업태
    business_item: Mapped[str | None] = mapped_column(Text)  # 종목
    # step1: 연락/주소/규모(행사별 스냅샷)
    main_tel: Mapped[str | None] = mapped_column(Text)
    fax: Mapped[str | None] = mapped_column(Text)
    address_ko: Mapped[str | None] = mapped_column(Text)
    address_detail: Mapped[str | None] = mapped_column(Text)  # 회사 상세주소
    address_en: Mapped[str | None] = mapped_column(Text)
    annual_sales_range: Mapped[str | None] = mapped_column(Text)  # KRW 구간
    employee_range: Mapped[str | None] = mapped_column(Text)
    available_languages: Mapped[list[str] | None] = mapped_column(ARRAY(Text))  # 상담 가능언어(멀티)
    # step2/3: 소개·상품(국/영 분리)
    intro_ko: Mapped[str | None] = mapped_column(Text)
    intro_en: Mapped[str | None] = mapped_column(Text)
    product_intro_ko: Mapped[str | None] = mapped_column(Text)
    product_intro_en: Mapped[str | None] = mapped_column(Text)
    product_price_range: Mapped[str | None] = mapped_column(Text)  # KRW 구간
    company_logo_file_id: Mapped[str | None] = mapped_column(ForeignKey("files.id", ondelete="SET NULL"))
    company_profile_doc_file_id: Mapped[str | None] = mapped_column(ForeignKey("files.id", ondelete="SET NULL"))
    # step4: 선호 바이어 + 참가경로
    preferred_buyer_country: Mapped[str | None] = mapped_column(Text)  # (구) 자유텍스트 — 아래 멀티선택으로 대체
    preferred_buyer_countries: Mapped[list[str] | None] = mapped_column(ARRAY(Text))  # 선호 바이어 국가(멀티)
    preferred_buyer_types: Mapped[list[str] | None] = mapped_column(ARRAY(Text))  # 선호 바이어 구분(기관유형 멀티)
    participation_route: Mapped[str | None] = mapped_column(Text)
    new_acquisition_channel: Mapped[str | None] = mapped_column(Text)
    kst_available_time: Mapped[str | None] = mapped_column(Text)  # v1 text(§7 HITL: 슬롯 구조화)
    # 행사 기간 미팅 '불가' 슬롯 키 목록(opt-out; 나머지는 가능). 키="YYYY-MM-DDTHH:MM".
    # 슬롯 그리드(운영시간·슬롯길이·행사일)는 event_schedule_settings/events에서 파생 — 여기엔 선택만 저장.
    unavailable_meeting_slots: Mapped[list[str] | None] = mapped_column(ARRAY(Text))
    # 카테고리(3종, 단일선택) — kct001tax01. Hall 필터를 대체하는 회사 분류축, 셀러 전용(바이어엔 없음).
    # keyword 조인이 아니라 스칼라인 이유는 CONTENT_CATEGORIES 주석 참고.
    content_category: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[str] = mapped_column(DateTime(timezone=True), nullable=False, server_default=_NOW)

    __table_args__ = (
        CheckConstraint(_in("annual_sales_range", ANNUAL_SALES_SELLER), name="exhibitor_profiles_annual_sales_range_check"),
        CheckConstraint(_in("employee_range", EMPLOYEE_RANGES), name="exhibitor_profiles_employee_range_check"),
        CheckConstraint(_in("product_price_range", PRODUCT_PRICE_RANGES), name="exhibitor_profiles_product_price_range_check"),
        CheckConstraint(_in("participation_route", PARTICIPATION_ROUTES), name="exhibitor_profiles_participation_route_check"),
        CheckConstraint(_in("new_acquisition_channel", ACQUISITION_CHANNELS), name="exhibitor_profiles_new_acquisition_channel_check"),
        CheckConstraint(_array_subset("available_languages", MEETING_LANGUAGES), name="exhibitor_profiles_available_languages_check"),
        CheckConstraint(_in("content_category", CONTENT_CATEGORIES), name="exhibitor_profiles_content_category_check"),
        # 채널은 route='new'일 때만 허용(route NULL=부분저장 통과). "route=new면 채널 필수"는 제출 API 검증.
        CheckConstraint(
            "new_acquisition_channel IS NULL OR participation_route = 'new'",
            name="exhibitor_profiles_acquisition_channel_route_check",
        ),
    )


class ExhibitorProduct(Base):
    """전시 제품 — 제품명(국/영)·카테고리(국/영)·HS코드를 개별 행으로(bm-profile-fields §4.2, 별첨2)."""

    __tablename__ = "exhibitor_products"

    id: Mapped[str] = mapped_column(UUID(as_uuid=False), primary_key=True, server_default=_UUID_PK)
    exhibitor_profile_id: Mapped[str] = mapped_column(
        ForeignKey("exhibitor_profiles.id", ondelete="CASCADE"), nullable=False
    )
    name_ko: Mapped[str] = mapped_column(Text, nullable=False)  # 제품/서비스명(국문)
    name_en: Mapped[str | None] = mapped_column(Text)  # 제품명(영문)
    business_field: Mapped[str | None] = mapped_column(Text)  # 사업분야(business_field, 8종) 코드 — (구) category, kct001tax01에서 rename
    category_ko: Mapped[str | None] = mapped_column(Text)  # (구) 자유텍스트 카테고리(국문) — business_field로 대체
    category_en: Mapped[str | None] = mapped_column(Text)  # (구) 자유텍스트 카테고리(영문)
    hs_code: Mapped[str | None] = mapped_column(Text)  # HS코드(요구사항)
    hs_description: Mapped[str | None] = mapped_column(Text)  # HS 설명
    spec: Mapped[str | None] = mapped_column(Text)  # 사양(국문)
    spec_en: Mapped[str | None] = mapped_column(Text)  # 사양(영문)
    price_range: Mapped[str | None] = mapped_column(Text)  # 제품별 가격대(KRW 구간) — 프로필 단위에서 이동
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text("0"))
    created_at: Mapped[str] = mapped_column(DateTime(timezone=True), nullable=False, server_default=_NOW)

    __table_args__ = (
        CheckConstraint(_in("price_range", PRODUCT_PRICE_RANGES), name="exhibitor_products_price_range_check"),
        CheckConstraint(_in("business_field", BUSINESS_FIELDS), name="exhibitor_products_business_field_check"),
    )


class ExhibitorKeyword(Base):
    __tablename__ = "exhibitor_keywords"

    exhibitor_profile_id: Mapped[str] = mapped_column(
        ForeignKey("exhibitor_profiles.id", ondelete="CASCADE"), primary_key=True
    )
    keyword_id: Mapped[str] = mapped_column(ForeignKey("keywords.id", ondelete="CASCADE"), primary_key=True)


# =============================================================================
# 7. Buyer 프로필
# =============================================================================
class BuyerProfile(Base):
    """바이어 프로필 — 행사별 선언(bm-profile-fields §3.1). 위치·구간 enum·파일 FK·참가경로.
    잠정 컬럼(looking_for·adoption_* 등) 대체."""

    __tablename__ = "buyer_profiles"

    id: Mapped[str] = mapped_column(UUID(as_uuid=False), primary_key=True, server_default=_UUID_PK)
    org_event_role_id: Mapped[str] = mapped_column(
        ForeignKey("organization_event_roles.id", ondelete="CASCADE"), nullable=False, unique=True
    )
    # step1: 신청자 식별(담당자) — 신규(BM-001 실배선, docs/db/schema.sql §7). contact_name_en·
    # contact_email은 제출 필수(서비스 계층 _validate_submit, DB CHECK가 아니라 부분저장을 막지
    # 않는다). contact_language는 FE Lang(lib/apply/types.ts, 현재 en/vi 2종 — 상담 가능 언어
    # PPT 슬라이드6 확정)이 backend MEETING_LANGUAGES(ko/en/zh/ja/ru/other)와 다른 별개 어휘라
    # CHECK 없이 text로 둔다(로케일 확장 시 마이그레이션 불필요, vi가 CHECK 위반으로 막히는 것 방지).
    contact_name_ko: Mapped[str | None] = mapped_column(Text)
    contact_name_en: Mapped[str | None] = mapped_column(Text)
    contact_title_ko: Mapped[str | None] = mapped_column(Text)
    contact_title_en: Mapped[str | None] = mapped_column(Text)
    contact_email: Mapped[str | None] = mapped_column(Text)
    contact_language: Mapped[str | None] = mapped_column(Text)
    contact_interpreter_need: Mapped[bool | None] = mapped_column(Boolean)
    # step1: 위치/연락/규모(행사별 스냅샷)
    continent: Mapped[str | None] = mapped_column(Text)
    country: Mapped[str | None] = mapped_column(Text)
    city_state: Mapped[str | None] = mapped_column(Text)
    zip_code: Mapped[str | None] = mapped_column(Text)
    address1: Mapped[str | None] = mapped_column(Text)
    address2: Mapped[str | None] = mapped_column(Text)
    tel: Mapped[str | None] = mapped_column(Text)
    last_year_best_buyer: Mapped[str | None] = mapped_column(Text)
    annual_sales_range: Mapped[str | None] = mapped_column(Text)  # USD 구간
    employee_range: Mapped[str | None] = mapped_column(Text)
    business_perf_korea_3y: Mapped[str | None] = mapped_column(Text)  # USD 구간
    travelers_korea_3y: Mapped[str | None] = mapped_column(Text)
    # step2: 소개/예산/도입시기/파일/노트
    company_intro_ko: Mapped[str | None] = mapped_column(Text)  # 신규(BM-001) — company_intro_en 국문 짝
    company_intro_en: Mapped[str | None] = mapped_column(Text)
    budget_range: Mapped[str | None] = mapped_column(Text)  # 지출 가능 예산(USD 구간) — 신규(BM-001)
    adoption_timeline: Mapped[str | None] = mapped_column(Text)  # 도입 시기(년도+반기) — 신규(BM-001)
    company_logo_file_id: Mapped[str | None] = mapped_column(ForeignKey("files.id", ondelete="SET NULL"))
    company_profile_file_id: Mapped[str | None] = mapped_column(ForeignKey("files.id", ondelete="SET NULL"))
    note: Mapped[str | None] = mapped_column(Text)
    # step3: 참가경로
    participation_route: Mapped[str | None] = mapped_column(Text)
    new_acquisition_channel: Mapped[str | None] = mapped_column(Text)
    kst_available_time: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[str] = mapped_column(DateTime(timezone=True), nullable=False, server_default=_NOW)

    __table_args__ = (
        CheckConstraint(_in("annual_sales_range", ANNUAL_SALES_BUYER), name="buyer_profiles_annual_sales_range_check"),
        CheckConstraint(_in("employee_range", EMPLOYEE_RANGES), name="buyer_profiles_employee_range_check"),
        CheckConstraint(_in("business_perf_korea_3y", BUSINESS_PERF_KOREA), name="buyer_profiles_business_perf_korea_3y_check"),
        CheckConstraint(_in("travelers_korea_3y", TRAVELERS_KOREA), name="buyer_profiles_travelers_korea_3y_check"),
        CheckConstraint(_in("budget_range", BUDGET_RANGES), name="buyer_profiles_budget_range_check"),
        CheckConstraint(_in("adoption_timeline", ADOPTION_TIMELINES), name="buyer_profiles_adoption_timeline_check"),
        CheckConstraint(_in("participation_route", PARTICIPATION_ROUTES), name="buyer_profiles_participation_route_check"),
        CheckConstraint(_in("new_acquisition_channel", ACQUISITION_CHANNELS), name="buyer_profiles_new_acquisition_channel_check"),
        CheckConstraint(
            "new_acquisition_channel IS NULL OR participation_route = 'new'",
            name="buyer_profiles_acquisition_channel_route_check",
        ),
    )


class BuyerInterestKeyword(Base):
    __tablename__ = "buyer_interest_keywords"

    buyer_profile_id: Mapped[str] = mapped_column(
        ForeignKey("buyer_profiles.id", ondelete="CASCADE"), primary_key=True
    )
    keyword_id: Mapped[str] = mapped_column(ForeignKey("keywords.id", ondelete="CASCADE"), primary_key=True)


# =============================================================================
# 8. Visitor
# =============================================================================
class Visitor(Base):
    __tablename__ = "visitors"

    id: Mapped[str] = mapped_column(UUID(as_uuid=False), primary_key=True, server_default=_UUID_PK)
    event_id: Mapped[str] = mapped_column(ForeignKey("events.id", ondelete="CASCADE"), nullable=False)
    qr_token: Mapped[str] = mapped_column(Text, nullable=False, unique=True)
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("'browsing'"))
    converted_org_id: Mapped[str | None] = mapped_column(ForeignKey("organizations.id", ondelete="SET NULL"))
    created_at: Mapped[str] = mapped_column(DateTime(timezone=True), nullable=False, server_default=_NOW)

    __table_args__ = (
        CheckConstraint("status IN ('browsing', 'converted')", name="visitors_status_check"),
    )


# =============================================================================
# 9. Meeting Venue
# =============================================================================
class MeetingVenue(Base):
    __tablename__ = "meeting_venues"

    id: Mapped[str] = mapped_column(UUID(as_uuid=False), primary_key=True, server_default=_UUID_PK)
    event_id: Mapped[str] = mapped_column(ForeignKey("events.id", ondelete="CASCADE"), nullable=False)
    venue_type: Mapped[str] = mapped_column(Text, nullable=False)
    booth_id: Mapped[str | None] = mapped_column(ForeignKey("booths.id", ondelete="SET NULL"))
    label: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[str] = mapped_column(DateTime(timezone=True), nullable=False, server_default=_NOW)

    __table_args__ = (
        CheckConstraint(
            "venue_type IN ('booth', 'zone_table', 'business_room')", name="meeting_venues_venue_type_check"
        ),
        # get-or-create 멱등키 — 참가사 부스 장소는 신청 시점에 (행사, 'booth', 라벨)로 만들어지므로
        # 동시 신청 두 건이 같은 라벨의 장소 행을 두 개 만들지 않게 DB가 막는다.
        UniqueConstraint("event_id", "venue_type", "label", name="meeting_venues_event_type_label_key"),
    )


# =============================================================================
# 9b. AI 전체 포화배정 실행 기록 (ADR-0006)
# =============================================================================
class SaturationBatchRun(Base):
    __tablename__ = "saturation_batch_runs"

    id: Mapped[str] = mapped_column(UUID(as_uuid=False), primary_key=True, server_default=_UUID_PK)
    event_id: Mapped[str] = mapped_column(ForeignKey("events.id", ondelete="CASCADE"), nullable=False)
    run_number: Mapped[int] = mapped_column(Integer, nullable=False)
    min_guaranteed_slots: Mapped[int] = mapped_column(Integer, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("'draft'"))
    triggered_by: Mapped[str | None] = mapped_column(ForeignKey("organizers.id", ondelete="SET NULL"))
    created_at: Mapped[str] = mapped_column(DateTime(timezone=True), nullable=False, server_default=_NOW)
    confirmed_at: Mapped[str | None] = mapped_column(DateTime(timezone=True))

    __table_args__ = (
        CheckConstraint(
            "status IN ('draft', 'confirmed', 'discarded')", name="saturation_batch_runs_status_check"
        ),
        UniqueConstraint("event_id", "run_number", name="saturation_batch_runs_event_id_run_number_key"),
    )


# =============================================================================
# 10. Schedule Table (meetings) — ADR-0004/0005
# =============================================================================
class Meeting(Base):
    __tablename__ = "meetings"

    id: Mapped[str] = mapped_column(UUID(as_uuid=False), primary_key=True, server_default=_UUID_PK)
    event_id: Mapped[str] = mapped_column(ForeignKey("events.id", ondelete="CASCADE"), nullable=False)
    exhibitor_org_id: Mapped[str] = mapped_column(ForeignKey("organizations.id"), nullable=False)
    buyer_org_id: Mapped[str] = mapped_column(ForeignKey("organizations.id"), nullable=False)
    venue_id: Mapped[str | None] = mapped_column(ForeignKey("meeting_venues.id"))

    # provenance (ADR-0004) — 발생 시점 박제. ai_score/reasons는 fit score 미정이라 nullable, 미충전(#48 HITL).
    matching_type: Mapped[str] = mapped_column(Text, nullable=False)
    saturation_run_id: Mapped[str | None] = mapped_column(
        ForeignKey("saturation_batch_runs.id", ondelete="SET NULL")
    )
    ai_score: Mapped[float | None] = mapped_column(Numeric)
    ai_score_reasons: Mapped[dict | None] = mapped_column(JSONB)

    status: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("'proposed'"))
    requested_by: Mapped[str | None] = mapped_column(Text)
    scheduled_start: Mapped[str | None] = mapped_column(DateTime(timezone=True))
    scheduled_end: Mapped[str | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[str] = mapped_column(DateTime(timezone=True), nullable=False, server_default=_NOW)
    # 상태 전이 시각 — 리마인더 리스케줄 판단(ADR-0010)·completion tick이 읽는다. DB 트리거를 두지
    # 않는다(레포에 트리거 전례 없음) — ORM onupdate + 명시 UPDATE의 values(updated_at=...)로 갱신.
    updated_at: Mapped[str] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=_NOW, onupdate=func.now()
    )

    # --- 응답 대기 주체 (F-MT-001) ------------------------------------------
    # "지금 공을 쥔 org". proposed면 수신측 org, 확정/종료 상태면 NULL. 수락/거절 권한 판정의 닻이며
    # "내가 응답해야 하는 미팅" 목록을 인덱스 없이도 한 컬럼으로 뽑게 한다. 운영자 생성(requested_by=
    # 'organizer')처럼 수신측이 특정되지 않는 경로는 NULL.
    awaiting_org_id: Mapped[str | None] = mapped_column(
        ForeignKey("organizations.id", ondelete="CASCADE")
    )
    request_reason: Mapped[str | None] = mapped_column(Text)  # 신청 사유(신청자 작성, AI 초안 편집 가능)

    # --- 취소 (양측/운영자 모두 가능) ---------------------------------------
    cancelled_at: Mapped[str | None] = mapped_column(DateTime(timezone=True))
    cancelled_by: Mapped[str | None] = mapped_column(Text)  # 행위자 역할
    cancelled_by_org_id: Mapped[str | None] = mapped_column(
        ForeignKey("organizations.id", ondelete="SET NULL")
    )  # 운영자 취소는 NULL(org가 아니다)
    cancelled_reason_code: Mapped[str | None] = mapped_column(Text)  # MEETING_CANCEL_REASONS
    cancelled_reason_text: Mapped[str | None] = mapped_column(Text)  # 'other'면 필수(API 검증)

    # --- 거절 (수신측만, proposed에서만) ------------------------------------
    rejected_at: Mapped[str | None] = mapped_column(DateTime(timezone=True))
    rejected_by_org_id: Mapped[str | None] = mapped_column(
        ForeignKey("organizations.id", ondelete="SET NULL")
    )
    rejected_reason_code: Mapped[str | None] = mapped_column(Text)  # MEETING_REJECT_REASONS
    rejected_reason_text: Mapped[str | None] = mapped_column(Text)

    # 운영자 대리신청 감사(ADR-0013 확정 필드) — 현재 writer 없는 placeholder. 대리신청 경로가
    # 붙을 때 이 컬럼을 채운다. CHECK 없음(어느 상태에서도 유효한 순수 감사 필드).
    proxy_applied_by_organizer_id: Mapped[str | None] = mapped_column(
        ForeignKey("organizers.id", ondelete="SET NULL")
    )

    __table_args__ = (
        CheckConstraint(
            "matching_type IN ('ai', 'open', 'forced', 'on_site')", name="meetings_matching_type_check"
        ),
        CheckConstraint(
            "status IN ('proposed', 'accepted', 'rejected', 'cancelled', 'completed')",
            name="meetings_status_check",
        ),
        CheckConstraint(
            "requested_by IN ('exhibitor', 'buyer', 'organizer')", name="meetings_requested_by_check"
        ),
        CheckConstraint(
            "cancelled_by IN ('exhibitor', 'buyer', 'organizer')", name="meetings_cancelled_by_check"
        ),
        # 사유는 그 상태에서만 존재한다 — 어휘는 CHECK로 묶지 않되(미확정), 상태 정합성은 묶는다.
        CheckConstraint(
            "cancelled_reason_code IS NULL OR status = 'cancelled'",
            name="meetings_cancelled_reason_status_check",
        ),
        CheckConstraint(
            "rejected_reason_code IS NULL OR status = 'rejected'",
            name="meetings_rejected_reason_status_check",
        ),
        # 빈/역전 구간 금지. 둘 중 하나라도 NULL이면 통과(미확정 일정 허용).
        CheckConstraint(
            "scheduled_end IS NULL OR scheduled_start IS NULL OR scheduled_end > scheduled_start",
            name="meetings_schedule_order_check",
        ),
        # 확정된 미팅은 반드시 시간이 있다 — 슬롯 점유(EXCLUDE)의 전제.
        CheckConstraint(
            "status <> 'accepted' OR (scheduled_start IS NOT NULL AND scheduled_end IS NOT NULL)",
            name="meetings_accepted_requires_schedule_check",
        ),
        # D9(활성 쌍 유일성)는 #11(2026-09-15)로 제거됐다 — 같은 두 기업도 행사 중 여러 번 미팅할
        # 수 있어야 한다(발주자 결정). 예전에는 여기에 (event_id, exhibitor_org_id, buyer_org_id)
        # 부분 unique 인덱스가 있었다 — mt002pair01이 DROP했다. (쌍, 시각) 단위 중복 신청 방지는
        # app.matching.meeting_booking.find_duplicate_proposed가 애플리케이션 레벨에서 한다.
        # 슬롯 점유는 **accepted만** — proposed는 겹쳐도 된다(같은 시간에 여러 신청을 받아두고
        # 하나만 수락하는 게 정상 흐름). 첫 수락이 이기고, 둘째 수락은 여기서 튕긴다.
        ExcludeConstraint(
            ("exhibitor_org_id", "="),
            (func.tstzrange(text("scheduled_start"), text("scheduled_end"), text("'[)'")), "&&"),
            using="gist",
            where=text("status = 'accepted' AND scheduled_start IS NOT NULL AND scheduled_end IS NOT NULL"),
            name="meetings_exhibitor_slot_excl",
        ),
        ExcludeConstraint(
            ("buyer_org_id", "="),
            (func.tstzrange(text("scheduled_start"), text("scheduled_end"), text("'[)'")), "&&"),
            using="gist",
            where=text("status = 'accepted' AND scheduled_start IS NOT NULL AND scheduled_end IS NOT NULL"),
            name="meetings_buyer_slot_excl",
        ),
        ExcludeConstraint(
            ("venue_id", "="),
            (func.tstzrange(text("scheduled_start"), text("scheduled_end"), text("'[)'")), "&&"),
            using="gist",
            where=text(
                "status = 'accepted' AND venue_id IS NOT NULL "
                "AND scheduled_start IS NOT NULL AND scheduled_end IS NOT NULL"
            ),
            name="meetings_venue_slot_excl",
        ),
        Index("meetings_event_status_idx", "event_id", "status"),
        Index(
            "meetings_exhibitor_schedule_idx",
            "exhibitor_org_id",
            "scheduled_start",
            postgresql_where=text("status = 'accepted'"),
        ),
        Index(
            "meetings_buyer_schedule_idx",
            "buyer_org_id",
            "scheduled_start",
            postgresql_where=text("status = 'accepted'"),
        ),
        # completion tick(scheduled_end <= now 인 accepted 스캔) 전용.
        Index(
            "meetings_completion_scan_idx",
            "scheduled_end",
            postgresql_where=text("status = 'accepted'"),
        ),
        Index("meetings_event_created_idx", "event_id", text("created_at DESC")),
    )


class MeetingParticipant(Base):
    __tablename__ = "meeting_participants"

    id: Mapped[str] = mapped_column(UUID(as_uuid=False), primary_key=True, server_default=_UUID_PK)
    meeting_id: Mapped[str] = mapped_column(ForeignKey("meetings.id", ondelete="CASCADE"), nullable=False)
    member_id: Mapped[str] = mapped_column(ForeignKey("members.id", ondelete="CASCADE"), nullable=False)

    __table_args__ = (
        UniqueConstraint("meeting_id", "member_id", name="meeting_participants_meeting_id_member_id_key"),
    )


# =============================================================================
# 10b. Saturation Draft Item (OP-005 Phase 2) — 전체 포화배정 run의 미확정 제안.
#      confirm 시 book_meeting 으로 물질화되어 materialized_meeting_id 가 채워진다(ADR-0006).
# =============================================================================
class SaturationDraftItem(Base):
    __tablename__ = "saturation_draft_items"

    id: Mapped[str] = mapped_column(UUID(as_uuid=False), primary_key=True, server_default=_UUID_PK)
    saturation_run_id: Mapped[str] = mapped_column(
        ForeignKey("saturation_batch_runs.id", ondelete="CASCADE"), nullable=False
    )
    exhibitor_org_id: Mapped[str] = mapped_column(ForeignKey("organizations.id"), nullable=False)
    buyer_org_id: Mapped[str] = mapped_column(ForeignKey("organizations.id"), nullable=False)
    venue_id: Mapped[str | None] = mapped_column(ForeignKey("meeting_venues.id"))
    scheduled_start: Mapped[str] = mapped_column(DateTime(timezone=True), nullable=False)
    scheduled_end: Mapped[str] = mapped_column(DateTime(timezone=True), nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("'draft'"))
    materialized_meeting_id: Mapped[str | None] = mapped_column(ForeignKey("meetings.id"))
    seq_no: Mapped[int | None] = mapped_column(Integer)
    created_at: Mapped[str] = mapped_column(DateTime(timezone=True), nullable=False, server_default=_NOW)

    __table_args__ = (
        CheckConstraint(
            "status IN ('draft', 'confirmed', 'skipped')", name="saturation_draft_items_status_check"
        ),
        UniqueConstraint(
            "saturation_run_id", "buyer_org_id", "exhibitor_org_id",
            name="saturation_draft_items_run_id_buyer_org_id_exhibitor_org_id_key",
        ),
    )


# =============================================================================
# 11. Post-meeting Review (ADR-0004)
# =============================================================================
class PostMeetingReview(Base):
    __tablename__ = "post_meeting_reviews"

    id: Mapped[str] = mapped_column(UUID(as_uuid=False), primary_key=True, server_default=_UUID_PK)
    meeting_id: Mapped[str] = mapped_column(ForeignKey("meetings.id", ondelete="CASCADE"), nullable=False)
    reviewer_org_id: Mapped[str] = mapped_column(ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False)
    counterpart_noshow: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("false"))
    # "내가 불참"(Q1: SELF_NOSHOW) — counterpart_noshow와 상호 배타적(review_capture.build_review 보장).
    self_noshow: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("false"))
    # Step1 (비공개) — MY-002
    satisfaction_rating: Mapped[int | None] = mapped_column(Integer)  # 1~5 별점
    follow_up_intent: Mapped[str | None] = mapped_column(Text)
    # Step2 — Fit Assessment (비공개)
    fit_rating: Mapped[str | None] = mapped_column(Text)
    fit_reason: Mapped[str | None] = mapped_column(Text)
    fit_reason_tags: Mapped[list | None] = mapped_column(JSONB)  # AI 사후 카테고리 태깅 (MY-002 D10)
    # Step2 — 보고문서 (녹음 업로드 방향, MY-002). 전사·녹음은 업로더 전용 비공개(ADR-0004).
    audio_s3_key: Mapped[str | None] = mapped_column(Text)  # 원본 녹음 S3 키(비공개 원천)
    transcript: Mapped[str | None] = mapped_column(Text)  # 전사 원문(비공개)
    transcript_turns: Mapped[list | None] = mapped_column(JSONB)  # [{who,text}] 화자별 전사(AI 추정, 비공개)
    report_sections: Mapped[dict | None] = mapped_column(JSONB)  # {discussion,agreements,actions}
    report_confirmed_at: Mapped[str | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[str] = mapped_column(DateTime(timezone=True), nullable=False, server_default=_NOW)

    __table_args__ = (
        CheckConstraint(
            "follow_up_intent IN ('none', 'reviewing', 'yes')", name="post_meeting_reviews_follow_up_intent_check"
        ),
        CheckConstraint("fit_rating IN ('good', 'normal', 'bad')", name="post_meeting_reviews_fit_rating_check"),
        CheckConstraint(
            "satisfaction_rating BETWEEN 1 AND 5", name="post_meeting_reviews_satisfaction_rating_check"
        ),
        # 상대 불참/본인 불참은 proceeded 값 하나로만 갈라지므로(review_capture.build_review) 애초에
        # 동시에 true일 수 없다 — 그 불변식을 DB 레벨에서도 강제한다(my002slf0001).
        CheckConstraint(
            "NOT (counterpart_noshow AND self_noshow)", name="post_meeting_reviews_noshow_exclusive"
        ),
        UniqueConstraint("meeting_id", "reviewer_org_id", name="post_meeting_reviews_meeting_id_reviewer_org_id_key"),
    )


# =============================================================================
# 11b. Transcription Job (MY-002 비동기 전사, #42/#44 후속 — 영속화)
# =============================================================================
class TranscriptionJob(Base):
    """녹음 전사·구조화 비동기 작업 상태(app.services.transcription_jobs 참고).

    30분 분량 녹음은 전사(Whisper)에 수 분이 걸려 POST 요청을 동기로 못 묶는다 — 접수(202) 후
    전사 전용 스레드풀(app.services.ai_concurrency)에서 처리하고 FE 는 job_id 로 폴링한다.
    예전엔 프로세스 메모리 dict였는데(#44 표기), ECS 다중 태스크에서 접수한 프로세스와 폴링하는
    프로세스가 달라지면 깨졌다 — DB에 영속해 어느 프로세스가 폴링을 받아도 조회되게 한다. draft 는
    StructureDraftResponse 를 그대로 JSON 직렬화(스키마에 결합하지 않음, opaque).
    """

    __tablename__ = "transcription_jobs"

    id: Mapped[str] = mapped_column(UUID(as_uuid=False), primary_key=True, server_default=_UUID_PK)
    meeting_id: Mapped[str] = mapped_column(ForeignKey("meetings.id", ondelete="CASCADE"), nullable=False)
    org_id: Mapped[str] = mapped_column(ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("'pending'"))
    draft: Mapped[dict | None] = mapped_column(JSONB)  # 완료 시 StructureDraftResponse(검수용 초안)
    error: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[str] = mapped_column(DateTime(timezone=True), nullable=False, server_default=_NOW)
    updated_at: Mapped[str] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=_NOW, onupdate=func.now()
    )

    __table_args__ = (
        CheckConstraint("status IN ('pending', 'done', 'error')", name="transcription_jobs_status_check"),
        Index("transcription_jobs_meeting_id_org_id_idx", "meeting_id", "org_id"),
    )


# =============================================================================
# 12. Love Call / Conversation Channel
# =============================================================================
class LoveCall(Base):
    """Love Call 1건 — 공개 단방향 신호(행의 존재) + 러브콜 **메일** 발송 이력(#13).

    두 사건이 한 행에 산다: Step1 의 Love Call 토글은 신호 행만 만들고(email_* 는 NULL),
    회의록 화면의 러브콜 메일 발송이 같은 행에 본문·발송시각을 채운다. 그래서 중복 발송 판정은
    "행이 있는가"가 아니라 ``email_sent_at IS NOT NULL`` 이다.
    """

    __tablename__ = "love_calls"

    id: Mapped[str] = mapped_column(UUID(as_uuid=False), primary_key=True, server_default=_UUID_PK)
    meeting_id: Mapped[str | None] = mapped_column(ForeignKey("meetings.id", ondelete="SET NULL"))
    event_id: Mapped[str] = mapped_column(ForeignKey("events.id", ondelete="CASCADE"), nullable=False)
    from_org_id: Mapped[str] = mapped_column(ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False)
    to_org_id: Mapped[str] = mapped_column(ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False)
    created_at: Mapped[str] = mapped_column(DateTime(timezone=True), nullable=False, server_default=_NOW)
    # 러브콜 메일(#13) — 발송에 성공한 뒤에만 채워진다. 발송 실패는 아무것도 남기지 않아 재시도 가능.
    email_subject: Mapped[str | None] = mapped_column(Text)  # 사용자가 검수·수정해 실제로 보낸 제목
    email_body: Mapped[str | None] = mapped_column(Text)  # 실제로 보낸 본문(한/영 병기 그대로)
    email_recipient_count: Mapped[int | None] = mapped_column(Integer)  # 수신한 담당자 수
    email_sent_at: Mapped[object | None] = mapped_column(DateTime(timezone=True))  # 중복 발송 판정 기준

    __table_args__ = (
        UniqueConstraint("meeting_id", "from_org_id", "to_org_id", name="love_calls_meeting_id_from_org_id_to_org_id_key"),
    )


class ConversationChannel(Base):
    __tablename__ = "conversation_channels"

    id: Mapped[str] = mapped_column(UUID(as_uuid=False), primary_key=True, server_default=_UUID_PK)
    event_id: Mapped[str] = mapped_column(ForeignKey("events.id", ondelete="CASCADE"), nullable=False)
    org_a_id: Mapped[str] = mapped_column(ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False)
    org_b_id: Mapped[str] = mapped_column(ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False)
    opened_at: Mapped[str] = mapped_column(DateTime(timezone=True), nullable=False, server_default=_NOW)

    __table_args__ = (
        UniqueConstraint("event_id", "org_a_id", "org_b_id", name="conversation_channels_event_id_org_a_id_org_b_id_key"),
    )


# =============================================================================
# 13. AI 매칭 제안
# =============================================================================
class AiMatchSuggestion(Base):
    __tablename__ = "ai_match_suggestions"

    id: Mapped[str] = mapped_column(UUID(as_uuid=False), primary_key=True, server_default=_UUID_PK)
    event_id: Mapped[str] = mapped_column(ForeignKey("events.id", ondelete="CASCADE"), nullable=False)
    for_org_id: Mapped[str] = mapped_column(ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False)
    target_org_id: Mapped[str] = mapped_column(ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False)
    # fit score(적합도) 정의 미확정(#48 HITL) → 점수 의존 컬럼은 nullable로 깔고 정의 확정 후 채운다.
    #   schema.sql은 NOT NULL이었으나 #48 AC#4(fit score 컬럼 nullable)에 맞춰 reconcile(schema.sql도 갱신).
    ai_score: Mapped[float | None] = mapped_column(Numeric)
    ai_score_reasons: Mapped[dict | None] = mapped_column(JSONB)
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("'pending'"))
    created_at: Mapped[str] = mapped_column(DateTime(timezone=True), nullable=False, server_default=_NOW)

    __table_args__ = (
        CheckConstraint(
            "status IN ('pending', 'requested', 'bookmarked', 'dismissed')",
            name="ai_match_suggestions_status_check",
        ),
        UniqueConstraint(
            "event_id", "for_org_id", "target_org_id", name="ai_match_suggestions_event_id_for_org_id_target_org_id_key"
        ),
    )


# =============================================================================
# 14. 관심기업(북마크)
# =============================================================================
class InterestedOrganization(Base):
    __tablename__ = "interested_organizations"

    id: Mapped[str] = mapped_column(UUID(as_uuid=False), primary_key=True, server_default=_UUID_PK)
    event_id: Mapped[str] = mapped_column(ForeignKey("events.id", ondelete="CASCADE"), nullable=False)
    owner_org_id: Mapped[str] = mapped_column(ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False)
    target_org_id: Mapped[str] = mapped_column(ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False)
    source: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[str] = mapped_column(DateTime(timezone=True), nullable=False, server_default=_NOW)

    __table_args__ = (
        CheckConstraint("source IN ('ai', 'all')", name="interested_organizations_source_check"),
        UniqueConstraint(
            "event_id", "owner_org_id", "target_org_id",
            name="interested_organizations_event_owner_target_key",
        ),
    )


# =============================================================================
# 15. Notification (ADR-0010)
# =============================================================================
class Notification(Base):
    __tablename__ = "notifications"

    id: Mapped[str] = mapped_column(UUID(as_uuid=False), primary_key=True, server_default=_UUID_PK)
    event_id: Mapped[str] = mapped_column(ForeignKey("events.id", ondelete="CASCADE"), nullable=False)
    recipient_org_id: Mapped[str] = mapped_column(ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False)
    type: Mapped[str] = mapped_column(Text, nullable=False)
    meeting_id: Mapped[str | None] = mapped_column(ForeignKey("meetings.id", ondelete="CASCADE"))
    due_at: Mapped[str | None] = mapped_column(DateTime(timezone=True))
    payload: Mapped[dict | None] = mapped_column(JSONB)
    created_at: Mapped[str] = mapped_column(DateTime(timezone=True), nullable=False, server_default=_NOW)
    read_at: Mapped[str | None] = mapped_column(DateTime(timezone=True))
    read_by_member_id: Mapped[str | None] = mapped_column(ForeignKey("members.id", ondelete="SET NULL"))

    __table_args__ = (
        CheckConstraint(
            _in("type", NOTIFICATION_TYPES),
            name="notifications_type_check",
        ),
        # 멱등 유니크 — due_at NULL(이벤트형)도 중복 제거되도록 NULLS NOT DISTINCT(RDS PG15+). ADR-0010
        UniqueConstraint(
            "type", "meeting_id", "recipient_org_id", "due_at",
            name="notifications_type_meeting_id_recipient_org_id_due_at_key",
            postgresql_nulls_not_distinct=True,
        ),
    )


# =============================================================================
# 16. Notification Dispatch (ADR-0010)
# =============================================================================
class NotificationDispatch(Base):
    __tablename__ = "notification_dispatches"

    id: Mapped[str] = mapped_column(UUID(as_uuid=False), primary_key=True, server_default=_UUID_PK)
    notification_id: Mapped[str] = mapped_column(ForeignKey("notifications.id", ondelete="CASCADE"), nullable=False)
    member_id: Mapped[str] = mapped_column(ForeignKey("members.id", ondelete="CASCADE"), nullable=False)
    channel: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False)
    sent_at: Mapped[str | None] = mapped_column(DateTime(timezone=True))
    error: Mapped[str | None] = mapped_column(Text)

    __table_args__ = (
        CheckConstraint("channel IN ('in_app', 'email', 'sms')", name="notification_dispatches_channel_check"),
        CheckConstraint(
            "status IN ('pending', 'sent', 'failed', 'skipped')", name="notification_dispatches_status_check"
        ),
        UniqueConstraint(
            "notification_id", "member_id", "channel",
            name="notification_dispatches_notification_id_member_id_channel_key",
        ),
    )


# =============================================================================
# 17. BM 프로필 부속 — 파일·기관유형 조인·담당자(복수)·추천바이어(복수) (bm-profile-fields §1·3·4·5)
# =============================================================================
class File(Base):
    """업로드 원본·메타·스캔·보관(bm-profile-fields §5). 프로필은 *_file_id로 참조. 방산문서 정책."""

    __tablename__ = "files"

    id: Mapped[str] = mapped_column(UUID(as_uuid=False), primary_key=True, server_default=_UUID_PK)
    s3_key: Mapped[str] = mapped_column(Text, nullable=False)
    s3_version_id: Mapped[str | None] = mapped_column(Text)
    original_filename: Mapped[str | None] = mapped_column(Text)
    content_type: Mapped[str | None] = mapped_column(Text)
    byte_size: Mapped[int | None] = mapped_column(BigInteger)
    checksum_sha256: Mapped[str | None] = mapped_column(Text)
    purpose: Mapped[str] = mapped_column(Text, nullable=False)
    owner_org_id: Mapped[str | None] = mapped_column(ForeignKey("organizations.id", ondelete="SET NULL"))
    uploaded_by_member_id: Mapped[str | None] = mapped_column(ForeignKey("members.id", ondelete="SET NULL"))
    scan_status: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("'pending'"))
    retention_until: Mapped[str | None] = mapped_column(Date)
    created_at: Mapped[str] = mapped_column(DateTime(timezone=True), nullable=False, server_default=_NOW)

    __table_args__ = (
        CheckConstraint(
            "purpose IN ('company_logo', 'company_profile', 'company_profile_doc', 'smartfill_source')",
            name="files_purpose_check",
        ),
        CheckConstraint(
            "scan_status IN ('pending', 'clean', 'infected')", name="files_scan_status_check"
        ),
    )


class OrgEventRoleOrgType(Base):
    """참가자 구분(기관유형 8종) N:M — 역할 단위(bm-profile-fields §1.1). keyword(category='org_type') 참조."""

    __tablename__ = "org_event_role_org_types"

    org_event_role_id: Mapped[str] = mapped_column(
        ForeignKey("organization_event_roles.id", ondelete="CASCADE"), primary_key=True
    )
    keyword_id: Mapped[str] = mapped_column(ForeignKey("keywords.id", ondelete="CASCADE"), primary_key=True)


class BuyerAttendee(Base):
    """바이어 참석자(복수, bm-profile-fields §3.2). member_id nullable=동일인 연결(폼값 스냅샷)."""

    __tablename__ = "buyer_attendees"

    id: Mapped[str] = mapped_column(UUID(as_uuid=False), primary_key=True, server_default=_UUID_PK)
    buyer_profile_id: Mapped[str] = mapped_column(ForeignKey("buyer_profiles.id", ondelete="CASCADE"), nullable=False)
    member_id: Mapped[str | None] = mapped_column(ForeignKey("members.id", ondelete="SET NULL"))
    first_name: Mapped[str | None] = mapped_column(Text)
    last_name: Mapped[str | None] = mapped_column(Text)
    division: Mapped[str | None] = mapped_column(Text)
    job_title: Mapped[str | None] = mapped_column(Text)
    email: Mapped[str | None] = mapped_column(Text)
    tel: Mapped[str | None] = mapped_column(Text)
    mobile: Mapped[str | None] = mapped_column(Text)
    whatsapp_id: Mapped[str | None] = mapped_column(Text)
    messenger_id: Mapped[str | None] = mapped_column(Text)  # KAKAO/LINE/TELEGRAM
    languages: Mapped[list[str] | None] = mapped_column(ARRAY(Text))
    interpreter_need: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("false"))
    interpreter_languages: Mapped[list[str] | None] = mapped_column(ARRAY(Text))
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text("0"))
    created_at: Mapped[str] = mapped_column(DateTime(timezone=True), nullable=False, server_default=_NOW)

    __table_args__ = (
        CheckConstraint(_array_subset("languages", MEETING_LANGUAGES), name="buyer_attendees_languages_check"),
        CheckConstraint(_array_subset("interpreter_languages", MEETING_LANGUAGES), name="buyer_attendees_interpreter_languages_check"),
        UniqueConstraint("buyer_profile_id", "email", name="buyer_attendees_buyer_profile_id_email_key"),
    )


class BuyerRecommendedBuyer(Base):
    """바이어가 추천하는 다른 바이어(복수, bm-profile-fields §3.3). resolved=후속 dedupe."""

    __tablename__ = "buyer_recommended_buyers"

    id: Mapped[str] = mapped_column(UUID(as_uuid=False), primary_key=True, server_default=_UUID_PK)
    buyer_profile_id: Mapped[str] = mapped_column(ForeignKey("buyer_profiles.id", ondelete="CASCADE"), nullable=False)
    continent: Mapped[str | None] = mapped_column(Text)
    country: Mapped[str | None] = mapped_column(Text)
    organization: Mapped[str | None] = mapped_column(Text)
    person_in_charge: Mapped[str | None] = mapped_column(Text)
    email: Mapped[str | None] = mapped_column(Text)
    tel: Mapped[str | None] = mapped_column(Text)
    resolved_organization_id: Mapped[str | None] = mapped_column(ForeignKey("organizations.id", ondelete="SET NULL"))
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text("0"))
    created_at: Mapped[str] = mapped_column(DateTime(timezone=True), nullable=False, server_default=_NOW)


class ExhibitorAttendee(Base):
    """셀러 담당자(복수, 국/영 이중, bm-profile-fields §4.3). member_id nullable=동일인 연결."""

    __tablename__ = "exhibitor_attendees"

    id: Mapped[str] = mapped_column(UUID(as_uuid=False), primary_key=True, server_default=_UUID_PK)
    exhibitor_profile_id: Mapped[str] = mapped_column(ForeignKey("exhibitor_profiles.id", ondelete="CASCADE"), nullable=False)
    member_id: Mapped[str | None] = mapped_column(ForeignKey("members.id", ondelete="SET NULL"))
    last_name_ko: Mapped[str | None] = mapped_column(Text)
    last_name_en: Mapped[str | None] = mapped_column(Text)
    first_name_ko: Mapped[str | None] = mapped_column(Text)
    first_name_en: Mapped[str | None] = mapped_column(Text)
    division_ko: Mapped[str | None] = mapped_column(Text)
    division_en: Mapped[str | None] = mapped_column(Text)
    title_ko: Mapped[str | None] = mapped_column(Text)
    title_en: Mapped[str | None] = mapped_column(Text)
    email: Mapped[str | None] = mapped_column(Text)
    tel: Mapped[str | None] = mapped_column(Text)
    mobile: Mapped[str | None] = mapped_column(Text)
    whatsapp_id: Mapped[str | None] = mapped_column(Text)
    languages: Mapped[list[str] | None] = mapped_column(ARRAY(Text))
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text("0"))
    created_at: Mapped[str] = mapped_column(DateTime(timezone=True), nullable=False, server_default=_NOW)

    __table_args__ = (
        CheckConstraint(_array_subset("languages", MEETING_LANGUAGES), name="exhibitor_attendees_languages_check"),
        UniqueConstraint("exhibitor_profile_id", "email", name="exhibitor_attendees_exhibitor_profile_id_email_key"),
    )


class ExhibitorRecommendedBuyer(Base):
    """셀러의 초청 바이어 추천(복수, bm-profile-fields §4.4)."""

    __tablename__ = "exhibitor_recommended_buyers"

    id: Mapped[str] = mapped_column(UUID(as_uuid=False), primary_key=True, server_default=_UUID_PK)
    exhibitor_profile_id: Mapped[str] = mapped_column(ForeignKey("exhibitor_profiles.id", ondelete="CASCADE"), nullable=False)
    continent: Mapped[str | None] = mapped_column(Text)
    country: Mapped[str | None] = mapped_column(Text)
    org_name_en: Mapped[str | None] = mapped_column(Text)
    person_name_en: Mapped[str | None] = mapped_column(Text)
    email: Mapped[str | None] = mapped_column(Text)
    contact: Mapped[str | None] = mapped_column(Text)
    resolved_organization_id: Mapped[str | None] = mapped_column(ForeignKey("organizations.id", ondelete="SET NULL"))
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text("0"))
    created_at: Mapped[str] = mapped_column(DateTime(timezone=True), nullable=False, server_default=_NOW)
