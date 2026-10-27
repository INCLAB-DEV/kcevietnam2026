"""의존성 — 리포지토리·서비스 주입.

**인증은 여기 없다.** 신원 도출은 ``app.auth.principal.get_current_principal`` 한 곳이다
(Cognito JWT/JWKS + 데모 토큰 분기, ADR-0008/0014). 예전에는 ``X-Org-Id`` 헤더를 그대로 믿는
``current_org_id`` placeholder 가 여기 있었지만, 위조 가능한 자기신고라 리뷰·알림 API를 Principal로
이관하면서 걷어냈다(docs/backlog/reviews-api-auth-migration.md) — 다시 만들지 말 것.

리포지토리는 DB 미설정 시 InMemory(데모/로컬), 설정 시 SqlAlchemy(미구현 시 InMemory fallback).
앱 구동 1회만 생성해 재사용.
"""

from __future__ import annotations

from functools import lru_cache
from typing import Callable

from fastapi import Depends, Request
from sqlalchemy.orm import Session

from app.config import settings
from app.db import get_session
from app.notifications.email import EmailSender, build_email_sender
from app.repositories.base import Repository
from app.repositories.memory import InMemoryRepository
from app.services.audio_preprocessing import AudioPreprocessor
from app.services.factory import (
    build_audio_preprocessor,
    build_storage,
    build_structurer,
    build_transcriber,
)
from app.services.love_call_mail import LoveCallMailDrafter, build_love_call_mail_drafter
from app.services.org_directory import OrgDirectory, SqlOrgDirectory
from app.services.transcription_jobs import InMemoryTranscriptionJobStore, TranscriptionJobStore


@lru_cache
def get_repository() -> Repository:
    if settings.database_url:
        try:
            from app.repositories.sql import SqlAlchemyRepository

            return SqlAlchemyRepository()
        except Exception:  # pragma: no cover - 미구현/연결불가 시 안전 폴백
            pass
    if settings.demo_seed:
        from app.repositories.demo import DemoInMemoryRepository

        return DemoInMemoryRepository()
    return InMemoryRepository()


def get_transcriber():
    return build_transcriber()


def get_structurer():
    return build_structurer()


def get_storage():
    return build_storage()


def get_audio_preprocessor() -> AudioPreprocessor:
    """녹음 전처리기(ffprobe·ffmpeg). 테스트는 가짜 오디오 바이트를 쓰므로 override로 대역을 꽂는다."""
    return build_audio_preprocessor()


def get_love_call_drafter() -> LoveCallMailDrafter:
    """러브콜 메일 AI 초안 어댑터(#13). 구조화와 같은 토글(STRUCTURER_BACKEND)을 공유한다."""
    return build_love_call_mail_drafter()


def get_email_sender() -> EmailSender:
    """러브콜 메일 발송 포트. 알림과 같은 EMAIL_BACKEND 토글(fake/smtp)을 쓴다(ADR-0010).

    테스트는 이 함수를 override 한다(FakeEmailSender). 라우트는 이걸 ``Depends``로 바로 받지 않고
    ``get_email_sender_provider``로 **필요할 때** 만든다 — 아래 설명 참고.
    """
    return build_email_sender()


#: 부르면 그때 sender를 만드는 함수(인자 없음).
EmailSenderProvider = Callable[[], EmailSender]


def get_email_sender_provider(request: Request) -> EmailSenderProvider:
    """``get_email_sender``를 **지금 만들지 않고**, 라우트가 발송 직전에 부를 함수로 넘긴다.

    ``Depends(get_email_sender)``로 받으면 FastAPI가 핸들러보다 먼저 sender를 만든다. SMTP 설정이 깨져 있으면
    (``SmtpEmailSender`` 생성 실패) 행사 메일 스위치가 꺼진 미팅에서도 409가 아니라 500이 난다 — 러브콜 발송은
    스위치를 본 뒤에, 켜진 행사에서만 sender를 만든다(app/api/love_call.py).

    override는 FastAPI와 같은 규칙으로 찾는다(``app.dependency_overrides``에서 원래 함수로) — 테스트가
    ``get_email_sender``에 꽂은 FakeEmailSender가 그대로 쓰인다. 인자 없는 override만 지원한다(지금 전부 그렇다).
    """
    overrides = getattr(request.app, "dependency_overrides", None) or {}
    return overrides.get(get_email_sender, get_email_sender)


def get_org_directory(db: Session = Depends(get_session)) -> OrgDirectory:
    """기업명·담당자 이메일 해석. 테스트는 이 의존성을 override 해 DB 없이 발송 흐름을 검증한다."""
    return SqlOrgDirectory(db)


@lru_cache
def get_job_store() -> TranscriptionJobStore:
    """전사 작업 저장소(앱 1회 생성, 요청 간 공유) — get_repository 와 동일한 backend 분기.

    DB 설정 시 SqlTranscriptionJobStore(프로덕션 기본): 메서드마다 세션을 열고 닫는 상태없는
    객체라 프로세스가 여러 개(ECS 다중 태스크)여도, 접수(POST)와 폴링(GET)이 다른 프로세스에
    떨어져도 DB로 상태가 공유된다. DB 미설정이면 InMemory(로컬/단위테스트) — 접수·폴링이
    같은 프로세스일 때만 안전.
    """
    if settings.database_url:
        try:
            from app.services.transcription_jobs import SqlTranscriptionJobStore

            return SqlTranscriptionJobStore()
        except Exception:  # pragma: no cover - 미구현/연결불가 시 안전 폴백
            pass
    return InMemoryTranscriptionJobStore()
