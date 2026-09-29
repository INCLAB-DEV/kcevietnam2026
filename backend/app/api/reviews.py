"""미팅 리뷰 API (F-MY-002, #40 Step1 + #42 Step2).

라우트는 참가사·바이어 공용 단일 경로(`/meetings/{id}`). 본인이 참석한 미팅의 본인측 리뷰만
작성·열람. 비공개/공개 노출 규칙은 FastAPI 가 강제(상대 응답에서 Follow-up Intent·Fit 비노출).

주체는 ``get_current_principal``(Cognito JWT / 데모 토큰)이 도출한다 — 미팅·BM 슬라이스와 같은
단일 인증 경로다. 예전에는 ``X-Org-Id`` 헤더를 그대로 믿는 placeholder(``deps.current_org_id``)를
썼는데, 그 헤더는 누구나 위조할 수 있어 **임의 org로 가장해 남의 회의록·비공개 평가를 열람**할 수
있었다(docs/backlog/reviews-api-auth-migration.md). ``_require_participant``는 "그 미팅의 당사자
인가"만 보므로, org_id 자체가 자기신고면 그 검사는 아무것도 지키지 못한다 — 그래서 org는 반드시
서명된 세션에서 나와야 한다.
"""

from __future__ import annotations

import io
import logging
from uuid import UUID

from fastapi import (
    APIRouter,
    BackgroundTasks,
    Depends,
    File,
    Form,
    HTTPException,
    UploadFile,
    status,
)
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from app.api.deps import (
    get_job_store,
    get_repository,
    get_storage,
    get_structurer,
    get_transcriber,
)
from app.auth.principal import Principal, get_current_principal
from app.db import get_session
from app.domain import love_call_signal
from app.domain.love_call_signal import serialize_review_for
from app.domain.review_capture import (
    MeetingProceeded,
    ReportSections,
    ReviewValidationError,
    Step1Intake,
    Step2Compose,
    build_review,
)
from app.domain.review_provenance_binding import ProvenanceError, bind_fit
from app.matching.slot_grid import resolve_zone
from app.models import Event, Meeting
from app.notifications import service as notification_service
from app.repositories.base import MeetingView, Repository, StoredReview
from app.schemas import (
    CounterpartViewResponse,
    ReviewResponse,
    Step1Request,
    Step2Request,
    StructureDraftResponse,
    StructureRequest,
    TranscribeJobResponse,
    TranscribeStatusResponse,
)
from app.services.export import ReportMeta, render_docx, render_pdf
from app.services.transcription_jobs import TranscriptionJobStore

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/meetings/{meeting_id}", tags=["reviews"])


def _require_meeting(repo: Repository, meeting_id: str) -> MeetingView:
    meeting = repo.get_meeting(meeting_id)
    if meeting is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="미팅 없음")
    return meeting


def _is_uuid(value: str) -> bool:
    try:
        UUID(str(value))
        return True
    except (ValueError, AttributeError, TypeError):
        return False


def _role_label(meeting: MeetingView, org_id: str) -> str:
    """보고서 표시용 역할 라벨 — 기존 용어(참가사/바이어)를 그대로 쓴다."""
    return "참가사" if org_id == meeting.exhibitor_org_id else "바이어"


def _require_participant(meeting: MeetingView, org_id: str) -> None:
    # 권한검사 단일 지점: 본인이 참석한 미팅만.
    if not meeting.is_participant(org_id):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="이 미팅의 참석자가 아닙니다")


def _intake_from_stored(stored: StoredReview) -> Step1Intake:
    return Step1Intake(
        proceeded=MeetingProceeded.PROCEEDED,  # noshow 가 아니어야 Step2 도달
        satisfaction=stored.satisfaction,
        follow_up_intent=stored.follow_up_intent,
    )


@router.post("/review/step1", response_model=ReviewResponse)
def save_step1(
    meeting_id: str,
    body: Step1Request,
    principal: Principal = Depends(get_current_principal),
    repo: Repository = Depends(get_repository),
) -> ReviewResponse:
    org_id = principal.organization_id
    meeting = _require_meeting(repo, meeting_id)
    _require_participant(meeting, org_id)
    try:
        review = build_review(
            Step1Intake(
                proceeded=body.proceeded,
                satisfaction=body.satisfaction,
                follow_up_intent=body.follow_up_intent,
            )
        )
    except ReviewValidationError as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc))

    stored = repo.save_review(meeting_id, org_id, review)

    return ReviewResponse(review=stored.to_dict())


@router.post("/review/step2/structure", response_model=StructureDraftResponse)
def structure_text(
    meeting_id: str,
    body: StructureRequest,
    principal: Principal = Depends(get_current_principal),
    repo: Repository = Depends(get_repository),
    structurer=Depends(get_structurer),
) -> StructureDraftResponse:
    """텍스트 폴백 — 녹음 없이 메모로 AI 구조화 초안 생성(사용자 검수 전)."""
    org_id = principal.organization_id
    meeting = _require_meeting(repo, meeting_id)
    _require_participant(meeting, org_id)
    result = structurer.structure(body.text, counterpart_org=meeting.counterpart_of(org_id))
    return _draft_response(result, transcript=body.text)


def _run_transcription_job(
    job_store: TranscriptionJobStore,
    job_id: str,
    *,
    data: bytes,
    filename: str,
    language: str,
    transcriber,
    structurer,
    counterpart_org: str,
    audio_key: str | None,
) -> None:
    """BackgroundTask 본체 — 전사·구조화를 돌리고 작업 상태를 갱신한다(응답 이후 실행)."""
    try:
        transcript = transcriber.transcribe(data, filename=filename, language=language)
        result = structurer.structure(transcript, counterpart_org=counterpart_org)
        draft = _draft_response(result, transcript=transcript, audio_s3_key=audio_key)
        job_store.complete(job_id, draft)
    except Exception as exc:  # pragma: no cover - 외부 전사/구조화 실패 경로
        job_store.fail(job_id, str(exc))


@router.post(
    "/review/step2/transcribe",
    response_model=TranscribeJobResponse,
    status_code=status.HTTP_202_ACCEPTED,
)
async def transcribe_and_structure(
    meeting_id: str,
    background_tasks: BackgroundTasks,
    audio: UploadFile = File(...),
    language: str = Form(default="ko"),
    principal: Principal = Depends(get_current_principal),
    repo: Repository = Depends(get_repository),
    transcriber=Depends(get_transcriber),
    structurer=Depends(get_structurer),
    storage=Depends(get_storage),
    job_store: TranscriptionJobStore = Depends(get_job_store),
) -> TranscribeJobResponse:
    """녹음 업로드(주 입력) → S3 보관 → 비동기 전사·OpenAI 구조화 접수(202). 키는 backend(ADR-0008).

    30분 분량은 동기로 못 묶어 작업을 접수하고 BackgroundTask 로 처리한다. 완료는 폴링
    (GET .../transcribe/{job_id})으로 확인하고, FE 가 "회의록 정리 완료" 알림을 띄운다.
    """
    org_id = principal.organization_id
    meeting = _require_meeting(repo, meeting_id)
    _require_participant(meeting, org_id)

    data = await audio.read()
    filename = audio.filename or "recording"
    audio_key = storage.put(
        f"meetings/{meeting_id}/{org_id}/{filename}",
        data,
        content_type=audio.content_type or "application/octet-stream",
    )
    job = job_store.create(meeting_id, org_id)
    background_tasks.add_task(
        _run_transcription_job,
        job_store,
        job.job_id,
        data=data,
        filename=filename,
        language=language,
        transcriber=transcriber,
        structurer=structurer,
        counterpart_org=meeting.counterpart_of(org_id),
        audio_key=audio_key,
    )
    return TranscribeJobResponse(job_id=job.job_id, status=job.status)


@router.get(
    "/review/step2/transcribe/{job_id}",
    response_model=TranscribeStatusResponse,
)
def transcribe_status(
    meeting_id: str,
    job_id: str,
    principal: Principal = Depends(get_current_principal),
    repo: Repository = Depends(get_repository),
    job_store: TranscriptionJobStore = Depends(get_job_store),
) -> TranscribeStatusResponse:
    """전사 작업 상태 폴링. done 이면 검수용 초안 동봉. 본인이 접수한 작업만 조회 가능."""
    org_id = principal.organization_id
    meeting = _require_meeting(repo, meeting_id)
    _require_participant(meeting, org_id)
    job = job_store.get(job_id)
    if job is None or job.meeting_id != meeting_id or job.org_id != org_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="전사 작업 없음")
    return TranscribeStatusResponse(status=job.status, draft=job.draft, error=job.error)


def _draft_response(result, *, transcript: str, audio_s3_key: str | None = None) -> StructureDraftResponse:
    return StructureDraftResponse(
        report={
            "discussion": result.report.discussion,
            "agreements": result.report.agreements,
            "actions": result.report.actions,
        },
        fit_suggestion=result.fit_suggestion,
        fit_reason_seed=result.fit_reason_seed,
        fit_reason_tags=result.fit_reason_tags,
        transcript=transcript,
        transcript_turns=[{"who": t.who, "text": t.text} for t in result.transcript_turns],
        audio_s3_key=audio_s3_key,
    )


@router.post("/review/step2", response_model=ReviewResponse)
def save_step2(
    meeting_id: str,
    body: Step2Request,
    principal: Principal = Depends(get_current_principal),
    repo: Repository = Depends(get_repository),
    db: Session = Depends(get_session),
) -> ReviewResponse:
    """검수·수정한 보고문서 + Fit 저장. provenance 결합(ADR-0004). noshow 는 도달 불가."""
    org_id = principal.organization_id
    meeting = _require_meeting(repo, meeting_id)
    _require_participant(meeting, org_id)

    step1 = repo.get_review(meeting_id, org_id)
    if step1 is None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="Step1(미팅 후기)을 먼저 저장하세요"
        )
    if step1.is_noshow:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="상대방 불참(noshow) 미팅은 Step2 보고문서를 작성하지 않습니다",
        )

    compose = Step2Compose(
        report=ReportSections(
            discussion=body.report.discussion,
            agreements=body.report.agreements,
            actions=body.report.actions,
        ),
        fit_rating=body.fit_rating,
        fit_reason=body.fit_reason,
    )
    try:
        review = build_review(_intake_from_stored(step1), compose, finalize_step2=body.finalize)
        # provenance 결합 — 발생 시점 출처 불변식 검증 + (ai_score, fit) 분석군 분류.
        bind_fit(meeting.provenance(), review.fit_rating)
    except ReviewValidationError as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc))
    except ProvenanceError as exc:  # pragma: no cover - 데이터 무결성 위반
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(exc))

    stored = repo.save_review(
        meeting_id,
        org_id,
        review,
        fit_reason_tags=body.fit_reason_tags,
        transcript=body.transcript,
        transcript_turns=[{"who": t.who, "text": t.text} for t in body.transcript_turns],
        audio_s3_key=body.audio_s3_key,
    )

    # 회의록 정리 완료 알림(F-NT-001/ADR-0010) — 녹음을 업로드한(=Step2를 저장한) org에 발화.
    # 알림은 리뷰 저장에 종속된 부가 효과라 실패해도 리뷰 저장 자체는 막지 않는다(우아한 열화 —
    # InMemoryRepository 기반 테스트처럼 알림 DB가 없는 경로에서도 리뷰 저장은 그대로 성공해야 한다).
    # 이 "커밋 이후 알림, 실패는 삼킴" 규약은 notifications.service.notify_after_commit이 소유한다.
    notification_service.notify_after_commit(
        db,
        lambda: notification_service.notify_review_ready(
            db,
            event_id=meeting.event_id,
            meeting_id=meeting_id,
            recipient_org_id=org_id,
            counterpart_org_name=notification_service.org_display_name(
                db, meeting.counterpart_of(org_id)
            ),
        ),
        description=f"review_ready (meeting_id={meeting_id}, org_id={org_id})",
    )

    return ReviewResponse(review=stored.to_dict())


@router.get("/review", response_model=ReviewResponse)
def get_own_review(
    meeting_id: str,
    principal: Principal = Depends(get_current_principal),
    repo: Repository = Depends(get_repository),
) -> ReviewResponse:
    org_id = principal.organization_id
    meeting = _require_meeting(repo, meeting_id)
    _require_participant(meeting, org_id)
    stored = repo.get_review(meeting_id, org_id)
    if stored is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="리뷰 없음")
    return ReviewResponse(review=stored.to_dict())


@router.get("/review/counterpart", response_model=CounterpartViewResponse)
def get_counterpart_view(
    meeting_id: str,
    principal: Principal = Depends(get_current_principal),
    repo: Repository = Depends(get_repository),
) -> CounterpartViewResponse:
    """상대가 작성한 리뷰를 '내가' 조회. 비공개 항목은 절대 노출되지 않는다(핵심 노출 규칙).

    상대에게 보이는 공개 신호는 Love Call 뿐. Follow-up Intent·Fit·만족도·전사는 제거된다.
    """
    org_id = principal.organization_id
    meeting = _require_meeting(repo, meeting_id)
    _require_participant(meeting, org_id)
    counterpart = meeting.counterpart_of(org_id)

    # 상대가 나에게 보낸 Love Call(공개 신호) 여부.
    love_call_received = any(
        lc.from_org_id == counterpart and lc.to_org_id == org_id
        for lc in repo.list_love_calls(meeting_id)
    )

    stored = repo.get_review(meeting_id, counterpart)
    public_review: dict | None = None
    if stored is not None:
        public_review = serialize_review_for(
            stored.to_dict(), reviewer_org_id=counterpart, requesting_org_id=org_id
        )
        # 마지막 게이트: 비공개 필드가 한 개라도 남으면 즉시 실패(회귀 방지).
        love_call_signal.assert_no_private_fields(public_review)

    return CounterpartViewResponse(love_call_received=love_call_received, review=public_review)


@router.get("/review/export")
def export_report(
    meeting_id: str,
    fmt: str = "pdf",
    principal: Principal = Depends(get_current_principal),
    repo: Repository = Depends(get_repository),
    db: Session = Depends(get_session),
) -> StreamingResponse:
    """본인 보고문서를 PDF/DOCX 로 내보낸다. 본문=AI 구조화+미팅 메타, 비공개 제외(D6)."""
    org_id = principal.organization_id
    meeting = _require_meeting(repo, meeting_id)
    _require_participant(meeting, org_id)
    stored = repo.get_review(meeting_id, org_id)
    if stored is None or stored.report is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="확정된 보고문서 없음")

    report = ReportSections(
        discussion=stored.report.get("discussion", []),
        agreements=stored.report.get("agreements", []),
        actions=stored.report.get("actions", []),
    )

    # ReportMeta 에는 공개 메타만 넣는다 — 비공개 평가는 구조적으로 들어가지 않음.
    # id 를 그대로 넣지 않고 기업명(org_display_name — 기존 알림 경로가 쓰는 헬퍼 재사용) + 역할
    # (참가사/바이어)을 함께 표시한다(#12).
    counterpart_org_id = meeting.counterpart_of(org_id)
    counterpart_org = (
        f"{notification_service.org_display_name(db, counterpart_org_id)}"
        f" ({_role_label(meeting, counterpart_org_id)})"
    )
    own_org = f"{notification_service.org_display_name(db, org_id)} ({_role_label(meeting, org_id)})"

    meeting_datetime = ""
    venue = ""
    # meeting_id 가 UUID 형식이 아니면(테스트 픽스처 등) 조회를 건너뛴다 — org_display_name과
    # 같은 이유(PG UUID 컬럼에 비-UUID를 보내면 500).
    meeting_row = db.get(Meeting, meeting_id) if _is_uuid(meeting_id) else None
    if meeting_row is not None:
        if meeting_row.scheduled_start is not None:
            event = db.get(Event, meeting.event_id) if _is_uuid(meeting.event_id) else None
            timezone_name = event.timezone if event is not None else "UTC"
            local_start = meeting_row.scheduled_start.astimezone(resolve_zone(timezone_name))
            meeting_datetime = f"{local_start.strftime('%Y-%m-%d %H:%M')} ({timezone_name})"
        venue = notification_service.venue_label(db, meeting_row.venue_id) or ""

    meta = ReportMeta(
        counterpart_org=counterpart_org,
        own_org=own_org,
        meeting_datetime=meeting_datetime,
        venue=venue,
    )

    if fmt == "docx":
        data = render_docx(report, meta)
        media = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        name = "meeting-report.docx"
    elif fmt == "pdf":
        data = render_pdf(report, meta)
        media = "application/pdf"
        name = "meeting-report.pdf"
    else:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="fmt 은 pdf 또는 docx")

    return StreamingResponse(
        io.BytesIO(data),
        media_type=media,
        headers={"Content-Disposition": f'attachment; filename="{name}"'},
    )
