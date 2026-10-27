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
import os
import time
import unicodedata
from typing import BinaryIO
from uuid import UUID, uuid4

from fastapi import (
    APIRouter,
    Depends,
    File,
    Form,
    HTTPException,
    Query,
    UploadFile,
    status,
)
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import (
    get_audio_preprocessor,
    get_job_store,
    get_repository,
    get_storage,
    get_structurer,
    get_transcriber,
)
from app.auth.principal import Principal, get_current_principal
from app.config import settings
from app.db import get_session, release_connection
from app.display_locale import (
    DEFAULT_LOCALE,
    localized_booth_venue_label,
    localized_org_name,
    normalize_locale,
)
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
from app.models import Event, Hall, Meeting, MeetingVenue, Organization
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
from app.services.ai_concurrency import (
    AiBusyError,
    ai_chat_slot,
    reserve_transcription_job,
    transcription_upload_slot,
)
from app.services.audio_preprocessing import AudioPreprocessor, AudioTooLongError
from app.services.export import ReportMeta, render_docx, render_pdf
from app.services.recording_transcription import (
    TranscriptionDeadlineExceeded,
    transcribe_recording,
)
from app.services.structuring import for_full_transcript
from app.services.transcription_jobs import (
    TRANSCRIPTION_FAILED_MESSAGE,
    TranscriptionJobStore,
    audio_too_long_message,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/meetings/{meeting_id}", tags=["reviews"])

# 녹음 원본 키의 파일명 부분 길이 상한(글자). 키 전체는 S3 상한 1024바이트 안이어야 한다 — 예전엔 파일명을
# 그대로 붙여, 아주 긴 이름(휴대폰 공유 앱이 붙이는 긴 이름 등)이면 S3가 거절해 500이 났다. 80자면 한글·이모지
# (글자당 최대 4바이트)여도 앞부분(meetings/{event}/{meeting}/{org}/{uuid}-, 약 150바이트)과 합쳐 한참 남는다.
_MAX_AUDIO_FILENAME_CHARS = 80
_MAX_AUDIO_EXTENSION_CHARS = 10

# 전사 작업이 대기열에서 기다린 시간·실행 마감을 재는 시계(단조) — 테스트가 가짜 시계로 갈아끼운다(벽시계 변경과 무관).
_clock = time.monotonic


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


def _role_label(meeting: MeetingView, org_id: str, locale: str = DEFAULT_LOCALE) -> str:
    """보고서 표시용 역할 라벨 — 기존 용어(참가사/바이어)를 그대로 쓴다. en은 화면 용어집과 같다."""
    is_exhibitor = org_id == meeting.exhibitor_org_id
    if locale == "en":
        return "Exhibitor" if is_exhibitor else "Buyer"
    return "참가사" if is_exhibitor else "바이어"


def _report_org_name(db: Session, org_id: str, locale: str) -> str:
    """보고서에 찍는 기업명 — ko는 기존 헬퍼 그대로(국문 우선), en은 영문명 우선(없으면 국문명).

    org_id가 UUID가 아니면(테스트 픽스처 등) 조회 없이 id 그대로다 — ``org_display_name``과 같은 규칙.
    """
    if locale != "en" or not _is_uuid(org_id):
        return notification_service.org_display_name(db, org_id)
    return localized_org_name(db.get(Organization, org_id), locale, fallback=org_id)


def _report_venue_label(db: Session, meeting_row: Meeting, locale: str) -> str:
    """보고서에 찍는 장소 — ko는 저장 라벨 그대로, en은 부스 라벨만 영문 표기로 옮긴다.

    미팅 목록·알림과 같은 변환이다(``localized_booth_venue_label``): 시스템이 만든 부스 라벨
    (``"7홀 A-12"``·``"{기업명} 부스"``)만 옮기고, 운영자가 이름 붙인 매칭존·비즈니스룸은 그대로 둔다.
    """
    label = notification_service.venue_label(db, meeting_row.venue_id) or ""
    if locale != "en" or not label:
        return label
    venue = db.get(MeetingVenue, meeting_row.venue_id)
    if venue is None or venue.venue_type != "booth":
        return label
    exhibitor = db.get(Organization, meeting_row.exhibitor_org_id)
    halls = db.execute(
        select(Hall.hall_no, Hall.hall_name).where(Hall.event_id == meeting_row.event_id)
    ).all()
    return localized_booth_venue_label(
        label,
        exhibitor_name_en=exhibitor.name_en if exhibitor is not None else None,
        halls=[(hall_no, hall_name) for hall_no, hall_name in halls],
        locale=locale,
    )


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
    db: Session = Depends(get_session),
) -> StructureDraftResponse:
    """텍스트 폴백 — 녹음 없이 메모로 AI 구조화 초안 생성(사용자 검수 전).

    OpenAI 실패는 500으로 새지 않게 502 ``ai_failed``로, 동시 호출 상한에 걸리면 503 ``ai_busy``로
    돌려준다 — 화면이 둘을 구분해 "잠시 후 다시"를 안내한다(원인 문자열은 로그에만 남긴다).
    """
    org_id = principal.organization_id
    meeting = _require_meeting(repo, meeting_id)
    _require_participant(meeting, org_id)
    counterpart = meeting.counterpart_of(org_id)
    # 인증·권한 확인으로 필요한 건 다 읽었다 — OpenAI를 기다리는 동안(자리 대기 포함) 요청 세션의
    # 커넥션을 쥐고 있지 않게 지금 돌려준다(release_connection 독스트링 참고).
    release_connection(db)
    try:
        with ai_chat_slot():
            result = structurer.structure(body.text, counterpart_org=counterpart)
    except AiBusyError:
        logger.warning("텍스트 구조화 거절 — AI 동시 호출 상한 (meeting_id=%s, org_id=%s)", meeting_id, org_id)
        raise _ai_busy() from None
    except Exception:  # noqa: BLE001 - 외부 AI 실패(타임아웃·API 오류·응답 파싱) 전부를 같은 응답으로
        logger.exception("텍스트 구조화 실패 (meeting_id=%s, org_id=%s)", meeting_id, org_id)
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail={"code": "ai_failed", "message": "회의록 정리에 실패했어요. 잠시 후 다시 시도해 주세요."},
        ) from None
    return _draft_response(result, transcript=body.text)


def _run_transcription_job(
    job_store: TranscriptionJobStore,
    job_id: str,
    *,
    storage,
    audio_key: str,
    filename: str,
    language: str,
    transcriber,
    structurer,
    preprocessor: AudioPreprocessor,
    counterpart_org: str,
    queued_at: float,
) -> None:
    """전사 전용 풀(``ai_concurrency.submit_transcription``)에서 도는 본체 — 응답(202) 이후 실행된다.

    DB는 job_store가 메서드마다 짧게 열고 닫는 세션으로만 만진다(complete/fail) — OpenAI를 기다리는
    수 분 동안 커넥션을 쥐지 않는다. 요청 세션은 여기로 넘어오지 않는다(세션은 스레드 간 공유 금지).

    녹음은 인자로 들고 오지 않고 **시작할 때** 방금 보관한 저장소에서 임시 파일로 내려받는다 — 큐에서 기다리는
    작업들이 각자 원본(최대 200MB)을 쥐고 있지 않게. 키는 업로드마다 고유하므로(transcribe_and_structure) 같은
    이름으로 다시 올린 파일이 기다리던 작업의 원본을 바꿔치지 않는다. 그다음 ffmpeg로 줄이고 5분 조각으로 나눠
    조각마다 전사한다(``recording_transcription.transcribe_recording`` — 통째 전사는 긴 녹음을 조용히 잘랐다).

    대기열에서 ``settings.transcription_job_max_age_seconds``(기본 600초 — 산정은 config 주석)보다 오래
    기다렸으면 OpenAI를 부르지 않고 실패로 끝낸다 — 화면 폴링(1800초)이 결과를 받기 전에 끝날 수 있어 비용·슬롯만 쓴다.
    시작하면 실행 마감(``transcription_job_deadline_seconds``)을 조각을 보내기 전마다 확인한다. 전사가 끝까지 끝났으면
    마감과 무관하게 구조화한다 — 다 만든 전사문을 버리지 않는다(구조화는 자체 타임아웃이 있다, 교차리뷰 H4).

    실패 문구는 고정이다: 녹음이 길이 상한을 넘으면 그 사실과 상한(분)을, 그 밖(만료·마감·저장소·ffmpeg·OpenAI
    실패)은 일반 문구를 남긴다. 원인은 서버 로그에만.
    """
    waited = _clock() - queued_at
    if waited > settings.transcription_job_max_age_seconds:
        logger.warning("전사 작업 만료 — 대기열에서 %.0f초 기다려 시작하지 않는다 (job_id=%s)", waited, job_id)
        job_store.fail(job_id, TRANSCRIPTION_FAILED_MESSAGE)
        return
    deadline = _clock() + settings.transcription_job_deadline_seconds
    try:
        transcript = transcribe_recording(
            storage,
            audio_key,
            filename=filename,
            language=language,
            transcriber=transcriber,
            preprocessor=preprocessor,
            chunk_seconds=settings.transcription_chunk_seconds,
            max_audio_seconds=settings.transcription_max_audio_seconds,
            deadline=deadline,
            clock=_clock,
            job_id=job_id,
        )
        result = structurer.structure(transcript, counterpart_org=counterpart_org)
        draft = _draft_response(result, transcript=transcript, audio_s3_key=audio_key)
        job_store.complete(job_id, draft)
    except AudioTooLongError as exc:
        logger.warning("전사 작업 거절 — %s (job_id=%s)", exc, job_id)
        job_store.fail(job_id, audio_too_long_message(settings.transcription_max_audio_seconds))
    except TranscriptionDeadlineExceeded as exc:
        logger.warning("%s", exc)
        job_store.fail(job_id, TRANSCRIPTION_FAILED_MESSAGE)
    except Exception:  # noqa: BLE001 - 외부 전사/구조화/보관/변환 실패 전부를 같은 사용자 문구로(원인은 로그에만)
        logger.exception("전사 작업 실패 (job_id=%s)", job_id)
        job_store.fail(job_id, TRANSCRIPTION_FAILED_MESSAGE)


def _ai_busy() -> HTTPException:
    # 화면(lib/review/api-error)이 503·ai_busy를 "AI 요청이 많아요"로 안내한다 — 원인(어느 상한인지)은 로그에만.
    return HTTPException(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        detail={"code": "ai_busy", "message": "AI 요청이 많아요. 잠시 후 다시 시도해 주세요."},
    )


def _audio_too_large(limit: int) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_413_CONTENT_TOO_LARGE,
        detail={
            "code": "audio_too_large",
            "message": f"녹음 파일이 너무 커요(최대 {limit // (1024 * 1024)}MB).",
        },
    )


class _UploadTooLarge(Exception):
    """스트리밍 중 상한을 넘었다 — 저장소 쓰기를 중단시키고 413으로 바뀐다."""


class _CappedUpload:
    """업로드 파일을 상한까지만 내주는 읽기 래퍼 — 저장소(S3 멀티파트·FakeStorage)가 ``read(n)``으로 조금씩 당겨 간다.

    크기는 받기 전에 이미 확인하지만(``_upload_size``), 그 값이 없거나 틀려도 상한 + 1바이트를 넘게 읽는 순간
    멈춘다. ``read()``(크기 없음)도 남은 전부가 아니라 상한 + 1바이트까지만 꺼낸다 — 통째로 메모리에 올리지 않는다.
    seek를 일부러 노출하지 않는다(s3transfer가 비-seekable 경로로 조각을 차례로 읽는다).
    """

    def __init__(self, file: BinaryIO, limit: int) -> None:
        self._file = file
        self._limit = limit
        self.bytes_read = 0

    def readable(self) -> bool:
        return True

    def read(self, size: int | None = -1) -> bytes:
        remaining_allowance = self._limit - self.bytes_read + 1
        if size is None or size < 0 or size > remaining_allowance:
            size = remaining_allowance
        chunk = self._file.read(size)
        self.bytes_read += len(chunk)
        if self.bytes_read > self._limit:
            raise _UploadTooLarge()
        return chunk


def _upload_size(audio: UploadFile) -> int | None:
    """업로드 크기(바이트). multipart 파서가 기록한 값을 쓰고, 없으면 파일 끝으로 이동해 잰다(읽지 않는다)."""
    if audio.size is not None:
        return audio.size
    try:
        position = audio.file.tell()
        audio.file.seek(0, os.SEEK_END)
        size = audio.file.tell()
        audio.file.seek(position)
        return size
    except (AttributeError, OSError, ValueError):
        return None  # 잴 수 없으면 스트리밍 중 상한(_CappedUpload)에 맡긴다


def _safe_audio_filename(filename: str | None) -> str:
    """S3 키에 붙일 파일명 — 경로 구분자·제어문자를 '_'로 바꾸고 80자로 자른다(확장자는 남긴다)."""
    name = unicodedata.normalize("NFC", (filename or "").strip())
    # '/'·'\\'는 키 경로가 갈라지지 않게, 제어문자(줄바꿈 등)는 로그·콘솔이 깨지지 않게 바꾼다.
    name = "".join("_" if ch in "/\\" or not ch.isprintable() else ch for ch in name)
    if not name:
        return "recording"
    if len(name) <= _MAX_AUDIO_FILENAME_CHARS:
        return name
    stem, dot, extension = name.rpartition(".")
    if dot and stem and 0 < len(extension) <= _MAX_AUDIO_EXTENSION_CHARS:
        return f"{stem[: _MAX_AUDIO_FILENAME_CHARS - len(extension) - 1]}.{extension}"
    return name[:_MAX_AUDIO_FILENAME_CHARS]


def _audio_key(*, event_id: str, meeting_id: str, org_id: str, filename: str | None) -> str:
    """녹음 원본 키 ``meetings/{event_id}/{meeting_id}/{org_id}/{uuid}-{파일명}``.

    행사 ID가 맨 앞이라 행사별 S3 수명주기 규칙(접두사 ``meetings/{event_id}/``, 행사 종료 30일 뒤 삭제)을 걸 수
    있다 — 여러 행사를 한 버킷에서 운영하므로 행사 날짜를 코드에 박지 않고 접두사로 가른다(ADR-0012).
    uuid는 업로드마다 새로 — 같은 파일명으로 다시 올려도 기다리던 작업의 원본을 덮어쓰지 않는다.
    """
    return f"meetings/{event_id}/{meeting_id}/{org_id}/{uuid4().hex}-{_safe_audio_filename(filename)}"


@router.post(
    "/review/step2/transcribe",
    response_model=TranscribeJobResponse,
    status_code=status.HTTP_202_ACCEPTED,
)
def transcribe_and_structure(
    meeting_id: str,
    audio: UploadFile = File(...),
    language: str = Form(default="ko"),
    principal: Principal = Depends(get_current_principal),
    repo: Repository = Depends(get_repository),
    transcriber=Depends(get_transcriber),
    structurer=Depends(get_structurer),
    storage=Depends(get_storage),
    preprocessor: AudioPreprocessor = Depends(get_audio_preprocessor),
    job_store: TranscriptionJobStore = Depends(get_job_store),
    db: Session = Depends(get_session),
) -> TranscribeJobResponse:
    """녹음 업로드(주 입력) → S3 보관 → 비동기 전사·OpenAI 구조화 접수(202). 키는 backend(ADR-0008).

    30분 분량은 동기로 못 묶어 작업을 접수하고 전사 전용 풀에서 처리한다. 완료는 폴링
    (GET .../transcribe/{job_id})으로 확인하고, FE 가 "회의록 정리 완료" 알림을 띄운다.

    ``async def``가 아니라 ``def``다 — 예전엔 async 핸들러 안에서 동기 DB 조회·boto3 업로드·작업 행 INSERT를
    그대로 돌려 업로드 하나가 이벤트 루프(=서버 전체)를 멈췄다. 이제 핸들러 전체가 스레드풀에서 돈다.

    접수 순서(거절은 전부 S3에 올리기 전): 크기 상한(413) → 대기열 깊이(503 ai_busy) → 업로드 동시 처리 자리
    (503 ai_busy) → S3로 스트리밍 → 작업 행 → 전사 풀. 파일은 Starlette가 디스크에 받아 둔 것을 그대로 흘려
    보낸다 — 예전엔 ``bytes``로 읽어 업로드마다 파일 크기의 두 배가 메모리에 올라왔다.
    """
    org_id = principal.organization_id
    meeting = _require_meeting(repo, meeting_id)
    _require_participant(meeting, org_id)
    # 인증·권한 확인이 끝났다 — 이후(S3 업로드·작업 접수)는 요청 세션을 다시 쓰지 않으므로 커넥션을
    # 지금 돌려준다. 작업 행 INSERT는 job_store가 자기 짧은 세션으로 한다.
    release_connection(db)

    # 상한은 저장·접수 전에 본다. 크기는 본문을 읽지 않고 안다(multipart 파서가 기록 — 없으면 파일 끝 위치).
    limit = settings.transcription_max_upload_bytes
    size = _upload_size(audio)
    if size is not None and size > limit:
        raise _audio_too_large(limit)

    try:
        reservation = reserve_transcription_job()
    except AiBusyError:
        logger.warning("녹음 접수 거절 — 전사 대기열이 꽉 찼다 (meeting_id=%s, org_id=%s)", meeting_id, org_id)
        raise _ai_busy() from None

    filename = audio.filename or "recording"
    try:
        audio_key = _audio_key(
            event_id=meeting.event_id, meeting_id=meeting_id, org_id=org_id, filename=filename
        )
        try:
            with transcription_upload_slot():
                storage.put_fileobj(
                    audio_key,
                    _CappedUpload(audio.file, limit),
                    content_type=audio.content_type or "application/octet-stream",
                )
        except AiBusyError:
            logger.warning("녹음 접수 거절 — 업로드 동시 처리 상한 (meeting_id=%s, org_id=%s)", meeting_id, org_id)
            raise _ai_busy() from None
        except _UploadTooLarge:
            raise _audio_too_large(limit) from None
        job = job_store.create(meeting_id, org_id)
        queued_at = _clock()
        # 응답은 넣기 **전에** 만든다 — 인메모리 저장소는 같은 작업 객체를 돌려줘서, 넣자마자 끝난 작업이면
        # 접수 응답이 pending이 아니라 done으로 나갈 수 있다(접수 응답 계약은 항상 pending).
        accepted = TranscribeJobResponse(job_id=job.job_id, status=job.status)
        # 큐에 넣고 바로 202 — 풀이 차 있으면 작업은 pending 인 채로 순서를 기다린다. 대기열 칸은 작업이 끝날 때
        # 돌려준다. 넣기(와 그 인자 계산)까지 이 try 안에 둔다 — 예전엔 밖에 있어서 여기서 예외가 나면 칸이 영영
        # 돌아오지 않았다(12번 새면 재시작 전까지 모든 업로드가 503, 교차리뷰 LOW). 넣은 뒤엔 예외가 날 문장이 없다.
        reservation.submit(
            _run_transcription_job,
            job_store,
            job.job_id,
            storage=storage,
            audio_key=audio_key,
            filename=filename,
            language=language,
            transcriber=transcriber,
            # 전사 원문 전체를 다시 출력하는 긴 구조화라 응답 대기는 텍스트 구조화(180초)가 아니라 전사 작업용 상한
            # (300초)을 쓴다. 재시도는 구조화 호출 공통(0회) — 오디오 조각 전사 호출의 재시도(1회)와는 따로다(config 주석).
            structurer=for_full_transcript(
                structurer,
                timeout=settings.openai_transcription_timeout_seconds,
                max_retries=settings.openai_structuring_max_retries,
            ),
            preprocessor=preprocessor,
            counterpart_org=meeting.counterpart_of(org_id),
            queued_at=queued_at,
        )
    except BaseException:
        reservation.release()  # 작업이 풀에 들어가기 전에 실패했다 — 잡아 둔 대기열 칸을 돌려준다(여러 번 불려도 한 번만)
        raise
    return accepted


def _user_facing_error(stored: str | None) -> tuple[str, str]:
    """저장된 실패 사유 → (사용자 문구, 사유 코드).

    코드가 만든 고정 문구(길이 초과)만 그대로 통과시키고, 나머지는 일반 실패 문구로 낸다. 코드는 같은
    판정의 기계용 표현이다 — 문구는 한국어 고정이라 en 화면은 코드로 자기 카탈로그 문구를 고른다.
    """
    if stored == audio_too_long_message(settings.transcription_max_audio_seconds):
        return stored, "audio_too_long"
    return TRANSCRIPTION_FAILED_MESSAGE, "failed"


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
    # 실패 사유는 저장값을 그대로 내보내지 않는다 — 이 패치 이전에 기록된 작업 행에는 예외 원문(공급자 오류 본문
    # 등)이 남아 있을 수 있다. 코드가 만든 고정 문구(녹음 길이 초과)만 통과시키고 나머지는 일반 문구로 낸다.
    error, error_code = _user_facing_error(job.error) if job.status == "error" else (None, None)
    return TranscribeStatusResponse(
        status=job.status, draft=job.draft, error=error, error_code=error_code
    )


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
    locale: str = Query(default=DEFAULT_LOCALE),
    principal: Principal = Depends(get_current_principal),
    repo: Repository = Depends(get_repository),
    db: Session = Depends(get_session),
) -> StreamingResponse:
    """본인 보고문서를 PDF/DOCX 로 내보낸다. 본문=AI 구조화+미팅 메타, 비공개 제외(D6).

    ``locale``(ko|en)은 문서의 **항목 이름·역할·기업명·부스 라벨**만 고른다 — 본문(회의록 문장)은
    사용자가 쓴 그대로다. 생략·모르는 값은 ko(기존 문서)다.
    """
    locale = normalize_locale(locale)
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
        f"{_report_org_name(db, counterpart_org_id, locale)}"
        f" ({_role_label(meeting, counterpart_org_id, locale)})"
    )
    own_org = f"{_report_org_name(db, org_id, locale)} ({_role_label(meeting, org_id, locale)})"

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
        venue = _report_venue_label(db, meeting_row, locale)

    meta = ReportMeta(
        counterpart_org=counterpart_org,
        own_org=own_org,
        meeting_datetime=meeting_datetime,
        venue=venue,
    )

    if fmt == "docx":
        data = render_docx(report, meta, locale=locale)
        media = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        name = "meeting-report.docx"
    elif fmt == "pdf":
        data = render_pdf(report, meta, locale=locale)
        media = "application/pdf"
        name = "meeting-report.pdf"
    else:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="fmt 은 pdf 또는 docx")

    return StreamingResponse(
        io.BytesIO(data),
        media_type=media,
        headers={"Content-Disposition": f'attachment; filename="{name}"'},
    )
