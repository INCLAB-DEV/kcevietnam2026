"""API 요청/응답 스키마 (Pydantic)."""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

from app.domain.review_capture import FitRating, FollowUpIntent, MeetingProceeded


class Step1Request(BaseModel):
    """Step1 intake. proceeded 만 필수. noshow 면 나머지는 서버가 비운다."""

    proceeded: MeetingProceeded
    satisfaction: int | None = Field(default=None, ge=1, le=5)
    follow_up_intent: FollowUpIntent | None = None
    # ⚠ 껍데기 Love Call 토글(FE Step1)이 삭제되며 이 필드도 제거했다. extra="forbid"를 쓰지
    # 않으므로(pydantic 기본 = 무시) 캐시된 구버전 FE 번들이 여전히 love_call을 보내도 그냥
    # 무시된다 — 구버전 호환을 위해 필드를 남겨둘 필요가 없다.


class ReportSectionsModel(BaseModel):
    discussion: list[str] = Field(default_factory=list)
    agreements: list[str] = Field(default_factory=list)
    actions: list[str] = Field(default_factory=list)


class TranscriptTurnModel(BaseModel):
    """화자별 전사 한 발화. who 는 AI 텍스트 추정. 비공개(업로더 전용, 상대·보고문서 비노출)."""

    who: Literal["us", "them"]
    text: str


class StructureRequest(BaseModel):
    """녹음이 없거나 텍스트 폴백일 때 raw 텍스트로 구조화 요청."""

    text: str


class StructureDraftResponse(BaseModel):
    """AI 초안 — 사용자 검수 전. report 본문 + Fit 제안(비공개, 본인에게만).

    audio_s3_key 는 녹음 업로드 경로에서만 채워진다(텍스트 폴백은 None). Step2 저장 시 이 키를
    그대로 돌려보내 리뷰 레코드(meeting_review.audio_s3_key, 비공개 원천)에 기록한다.
    """

    report: ReportSectionsModel
    fit_suggestion: FitRating | None
    fit_reason_seed: str
    fit_reason_tags: list[str]
    transcript: str
    transcript_turns: list[TranscriptTurnModel] = Field(default_factory=list)
    audio_s3_key: str | None = None


class TranscribeJobResponse(BaseModel):
    """녹음 전사 접수 응답(202). 30분 분량은 동기로 못 묶어 작업만 접수하고 폴링으로 완료를 확인한다."""

    job_id: str
    status: Literal["pending", "done", "error"]


class TranscribeStatusResponse(BaseModel):
    """전사 작업 폴링 응답. done 이면 검수용 초안(draft) 동봉, error 면 사유.

    ``error``는 한국어 고정 문구다(기존 계약). 화면이 언어를 고를 수 있게 같은 사유를 기계가 읽는
    ``error_code``로도 싣는다 — 문구를 로케일별로 서버에서 만들지 않고, 화면이 카탈로그에서 뽑는다.
    """

    status: Literal["pending", "done", "error"]
    draft: StructureDraftResponse | None = None
    error: str | None = None
    #: error 일 때만 채워진다. ``audio_too_long``은 다시 올려도 또 실패하므로(나눠 올려야 한다) 일반
    #: 실패(``failed``)와 화면 안내가 달라야 한다.
    error_code: Literal["audio_too_long", "failed"] | None = None


class Step2Request(BaseModel):
    """Step2 저장 — 검수·수정한 보고문서 + Fit. finalize=True 면 보고문서 확정."""

    report: ReportSectionsModel
    fit_rating: FitRating | None = None
    fit_reason: str = ""
    fit_reason_tags: list[str] = Field(default_factory=list)
    transcript: str | None = None
    transcript_turns: list[TranscriptTurnModel] = Field(default_factory=list)
    audio_s3_key: str | None = None
    finalize: bool = True


class LoveCallRequest(BaseModel):
    pass  # 수신자는 미팅 상대로 서버가 결정(단방향).


class ReviewResponse(BaseModel):
    """본인 리뷰 열람(전체). 상대 조회는 별도 엔드포인트에서 비공개 제거 후 반환."""

    review: dict


class CounterpartViewResponse(BaseModel):
    """상대 관점 응답 — 비공개 필드 제거됨. love_call 여부만 신호로 노출."""

    love_call_received: bool
    review: dict | None


# =============================================================================
# 러브콜 메일 (#13) — 회의록 기반 AI 초안 → 사용자 검수·수정 → 발송
# =============================================================================
class LoveCallMailStateResponse(BaseModel):
    """러브콜 메일 화면 상태. 이미 보냈으면 발송본 그대로 되돌려 화면에 표시한다."""

    recipient_org_name: str
    recipient_count: int  # 수신 가능한 상대 기업 담당자 수 — 0 이면 발송 자체가 불가(미리 경고)
    report_ready: bool  # 확정된 회의록 내용이 있는지 — 없으면 AI 초안을 만들 수 없다
    sent: bool
    sent_at: datetime | None = None
    subject: str | None = None
    body: str | None = None
    # 이 미팅 행사의 메일 스위치(행사 설정 "참가사·바이어 알림 메일", F-NT-001). false면 발송 API가 409
    # (PARTICIPANT_EMAIL_DISABLED)로 막는다 — 화면은 이 값으로 '발송하기'를 미리 잠그고 안내한다.
    participant_email_enabled: bool


class LoveCallMailDraftResponse(BaseModel):
    """AI 초안. **실패해도 200 이다** — ai_generated=False + error 로 실패를 드러내고 수동 작성
    경로(빈 body + 정형 subject)를 함께 준다. 조용히 성공한 척하지 않는다(#13)."""

    subject: str
    body: str
    ai_generated: bool
    error: str | None = None
    recipient_org_name: str
    recipient_count: int


class LoveCallMailSendRequest(BaseModel):
    """발송 요청 — 화면 편집기의 내용 그대로. 서버가 본문을 다시 손대지 않는다(미리보기=발송본)."""

    subject: str
    body: str
