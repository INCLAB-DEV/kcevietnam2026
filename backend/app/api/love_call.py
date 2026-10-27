"""러브콜 메일 API (#13) — 회의록 기반 AI 초안 → 사용자 검수·수정 → 실제 발송.

기존 ``POST /meetings/{id}/love-call``(app/api/reviews.py)은 **공개 단방향 신호**를 남기는 것이
전부였다(love_calls 행 1개, Mutual 격상 판정). 발주자 확인대로 그 버튼은 바깥으로 아무것도
내보내지 않았다 — 이 라우터가 그 위에 "상대 기업 담당자에게 실제로 가는 메일"을 얹는다.

세 엔드포인트가 **미리보기 → 수정 → 발송** 순서를 강제한다. 버튼 한 번에 바로 쏘지 않는다:
- ``GET  /love-call/mail``       현재 상태(수신자 수·회의록 유무·이미 보냈는지 + 발송본)
- ``POST /love-call/mail/draft`` AI 초안 생성(실패해도 200 — 사용자에게 알리고 수동 작성 개방)
- ``POST /love-call/mail/send``  화면에서 편집한 제목·본문 **그대로** 발송

실패를 숨기지 않는 것이 이 슬라이스의 핵심 규약이다(이 코드베이스의 고질병 —
docs/backlog 의 write 계통 버그 참고):
- AI 실패 → 200 + ``ai_generated=False`` + ``error`` + 빈 본문(빈 편집기). 조용한 템플릿 폴백 없음.
- 발송 실패 → 502 + 고정 문구(원인은 서버 로그에만 — SMTP 오류 본문에는 수신자 주소가 섞여 나온다).
  **love_calls 에 아무것도 기록하지 않는다** → 그대로 재시도 가능.
- 수신 이메일 0건 → 422. "보냈다"고 말하고 아무 데도 안 가는 상태를 만들지 않는다.

행사 설정 "참가사·바이어 알림 메일"(``event_schedule_settings.participant_email_enabled``, F-NT-001)이 꺼진
행사의 미팅에서는 **보내지 않는다** — 409 ``{"code": "PARTICIPANT_EMAIL_DISABLED", "message": ...}``, 메일 0통,
love_calls 기록 없음(2026-10-16 발주사 요구 "참가기업·바이어에게 어떠한 메일도 가지 않게" — 운영 담당자가
참가자 계정으로 대신 작업하다 '보내기'를 누를 수 있다). 스위치는 기존 거절(404·403·409·422)을 다 지난 뒤,
SMTP sender를 만들기 **전에** 본다. 메일을 보내지 않는 상태 조회·AI 초안은 그대로 열려 있고, 상태 조회가
스위치 값(``participant_email_enabled``)을 함께 내려 화면이 '발송하기'를 미리 잠근다.

권한·주체는 리뷰 API 와 같다(``get_current_principal`` + 그 미팅의 참석자만).
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from app.api.deps import (
    EmailSenderProvider,
    get_email_sender_provider,
    get_love_call_drafter,
    get_org_directory,
    get_repository,
)
from app.auth.principal import Principal, get_current_principal
from app.db import get_session, release_connection
from app.display_locale import DEFAULT_LOCALE, normalize_locale
from app.domain.love_call_signal import send_love_call
from app.notifications import service as notification_service
from app.notifications.email import EmailMessage
from app.repositories.base import MeetingView, Repository
from app.schemas import (
    LoveCallMailDraftResponse,
    LoveCallMailSendRequest,
    LoveCallMailStateResponse,
)
from app.services.ai_concurrency import AiBusyError, ai_chat_slot
from app.services.love_call_mail import (
    LoveCallContext,
    LoveCallMailDrafter,
    LoveCallMailError,
    build_love_call_context,
    fallback_subject,
    role_label,
)
from app.services.org_directory import OrgDirectory

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/meetings/{meeting_id}/love-call/mail", tags=["love-call"])

#: 화면에 **그대로 띄우는** 고정 문구(이 슬라이스의 화면은 detail/error 문자열을 그대로 보여준다).
#: ko는 기존 문구 그대로고, en은 요청의 ``?locale=en``일 때만 나간다(탐색·미팅과 같은 규약).
#: 어느 쪽이든 우리가 쓴 문구만 내보낸다 — 예외 원문(SDK 메시지·SMTP 응답)은 서버 로그에만 남긴다.
_MESSAGES: dict[str, dict[str, str]] = {
    "meeting_not_found": {"ko": "미팅 없음", "en": "Meeting not found"},
    "not_participant": {
        "ko": "이 미팅의 참석자가 아닙니다",
        "en": "You aren't a participant in this meeting",
    },
    "noshow": {
        "ko": "상대방 불참(noshow) 미팅에는 러브콜 메일을 보낼 수 없습니다",
        "en": "A Love Call email can't be sent for a meeting the other party didn't attend",
    },
    "already_sent": {
        "ko": "이 미팅의 러브콜 메일은 이미 발송했습니다",
        "en": "A Love Call email has already been sent for this meeting",
    },
    "no_report": {
        "ko": "확정된 회의록이 없어 AI 초안을 만들 수 없어요. 직접 작성해 주세요.",
        "en": "There are no finalized meeting notes, so AI can't write a draft. Please write it yourself.",
    },
    "ai_busy": {
        "ko": "AI 요청이 많아 초안을 만들지 못했어요. 잠시 후 다시 시도하거나 직접 작성해 주세요.",
        "en": "AI is busy right now, so the draft wasn't created. Try again shortly or write it yourself.",
    },
    "ai_failed": {
        "ko": "AI 초안 생성에 실패했어요. 잠시 후 다시 시도하거나 직접 작성해 주세요.",
        "en": "AI couldn't create the draft. Try again shortly or write it yourself.",
    },
    # 어댑터의 도메인 에러 문구({reason})는 한국어로 쓰여 있다 — ko에서만 이어 붙인다.
    "ai_failed_with_reason": {
        "ko": "AI 초안 생성에 실패했어요: {reason}",
        "en": "AI couldn't create the draft. Try again shortly or write it yourself.",
    },
    "subject_and_body_required": {
        "ko": "메일 제목과 본문을 모두 입력하세요",
        "en": "Enter both a subject and a message",
    },
    "no_recipients": {
        "ko": "{org} 에 등록된 담당자 이메일이 없어 발송할 수 없습니다",
        "en": "{org} has no registered contact email, so this can't be sent",
    },
    "send_failed": {
        "ko": "메일 발송에 실패했어요. 잠시 후 다시 시도해 주세요.",
        "en": "The email couldn't be sent. Please try again shortly.",
    },
    "email_disabled": {
        "ko": "이 행사는 메일 발송이 꺼져 있어 러브콜 메일을 보낼 수 없습니다.",
        "en": "Email is turned off for this event, so a Love Call email can't be sent.",
    },
}

#: 행사 메일 스위치가 꺼져 거절할 때의 코드 — 알림 재발송 409(app/admin/router.py)와 같은 코드다.
#: 이 거절만 ``detail`` 이 ``{"code", "message"}`` 다(화면이 코드로 알아보고 '발송하기'를 잠근다).
PARTICIPANT_EMAIL_DISABLED = "PARTICIPANT_EMAIL_DISABLED"


def _message(key: str, locale: str, **values: str) -> str:
    return _MESSAGES[key][locale].format(**values)


def _require_meeting(repo: Repository, meeting_id: str, locale: str) -> MeetingView:
    meeting = repo.get_meeting(meeting_id)
    if meeting is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail=_message("meeting_not_found", locale)
        )
    return meeting


def _require_participant(meeting: MeetingView, org_id: str, locale: str) -> None:
    if not meeting.is_participant(org_id):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail=_message("not_participant", locale)
        )


def _context(
    repo: Repository, directory: OrgDirectory, meeting: MeetingView, org_id: str
) -> LoveCallContext:
    """AI 입력 문맥을 만든다 — 보고문서 3섹션 + 양측 기업명·역할만(비공개는 필드 자체가 없다).

    여기 기업명은 **메일 내용의 재료**라 화면 로케일을 타지 않는다(국문 우선, 기존 그대로). 보는 사람의
    화면 언어가 상대에게 가는 편지를 바꾸면 안 된다 — 화면에 띄울 이름은 호출부가 로케일을 넘겨 따로
    읽는다(``directory.display_name(counterpart, locale)``).
    """
    counterpart = meeting.counterpart_of(org_id)
    stored = repo.get_review(meeting.meeting_id, org_id)
    return build_love_call_context(
        stored.report if stored else None,
        sender_org_name=directory.display_name(org_id),
        sender_role=role_label(org_id == meeting.exhibitor_org_id),
        recipient_org_name=directory.display_name(counterpart),
        recipient_role=role_label(counterpart == meeting.exhibitor_org_id),
    )


def _guard_noshow(repo: Repository, meeting_id: str, org_id: str, locale: str) -> None:
    """상대가 오지 않은 미팅에는 러브콜을 보내지 않는다(Step1 이 love_call 을 비우는 것과 같은 규칙)."""
    stored = repo.get_review(meeting_id, org_id)
    if stored is not None and stored.is_noshow:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail=_message("noshow", locale)
        )


def _guard_already_sent(
    repo: Repository, meeting_id: str, org_id: str, counterpart: str, locale: str
) -> None:
    """중복 발송 차단 — 같은 (미팅, 보낸기업, 받은기업)에 두 번 보내지 않는다."""
    record = repo.get_love_call(meeting_id, org_id, counterpart)
    if record is not None and record.email_sent:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail=_message("already_sent", locale)
        )


@router.get("", response_model=LoveCallMailStateResponse)
def get_love_call_mail_state(
    meeting_id: str,
    locale: str = Query(default=DEFAULT_LOCALE),
    principal: Principal = Depends(get_current_principal),
    repo: Repository = Depends(get_repository),
    directory: OrgDirectory = Depends(get_org_directory),
    db: Session = Depends(get_session),
) -> LoveCallMailStateResponse:
    """화면 진입 상태 — 이미 보냈으면 발송본을 그대로 돌려줘 "언제 뭐라고 보냈는지"를 보여준다.

    ``locale``(ko|en)은 화면에 띄우는 값만 고른다 — 상대 기업명(en이면 영문명 우선)과 거절 문구.
    발송본(subject/body)은 보낸 그대로다. 이 슬라이스의 세 엔드포인트가 같은 규칙을 쓴다.

    ``participant_email_enabled`` 는 이 미팅 행사의 메일 스위치다 — false면 화면이 '발송하기'를 잠그고
    안내한다(발송 API도 409로 막는다 — 화면 잠금은 편의일 뿐 막는 곳은 발송 API다).
    """
    locale = normalize_locale(locale)
    org_id = principal.organization_id
    meeting = _require_meeting(repo, meeting_id, locale)
    _require_participant(meeting, org_id, locale)
    counterpart = meeting.counterpart_of(org_id)

    ctx = _context(repo, directory, meeting, org_id)
    record = repo.get_love_call(meeting_id, org_id, counterpart)
    sent = record is not None and record.email_sent
    # 보내기 전에는 "지금 받을 수 있는 담당자 수", 보낸 뒤에는 "그때 실제로 받은 수"를 준다 —
    # 발송 후 멤버가 늘거나 줄어도 화면에 뜨는 숫자는 발송 당시 사실로 고정된다.
    recipient_count = (
        (record.email_recipient_count or 0)
        if sent and record is not None
        else len(directory.member_emails(counterpart))
    )
    return LoveCallMailStateResponse(
        recipient_org_name=directory.display_name(counterpart, locale),
        recipient_count=recipient_count,
        report_ready=ctx.has_report(),
        sent=sent,
        sent_at=record.email_sent_at if sent else None,
        subject=record.email_subject if sent else None,
        body=record.email_body if sent else None,
        participant_email_enabled=notification_service.participant_email_enabled_for_event(
            db, str(meeting.event_id)
        ),
    )


@router.post("/draft", response_model=LoveCallMailDraftResponse)
def draft_love_call_mail(
    meeting_id: str,
    locale: str = Query(default=DEFAULT_LOCALE),
    principal: Principal = Depends(get_current_principal),
    repo: Repository = Depends(get_repository),
    directory: OrgDirectory = Depends(get_org_directory),
    drafter: LoveCallMailDrafter = Depends(get_love_call_drafter),
    db: Session = Depends(get_session),
) -> LoveCallMailDraftResponse:
    """회의록을 근거로 AI 초안을 만든다. 실패는 200 + error 로 **드러내고** 수동 작성을 연다.

    502 로 떨어뜨리지 않는 이유: 사용자는 여기서 멈추면 안 되고 "직접 쓰기"로 이어져야 한다.
    실패 사실은 ``ai_generated=False`` + ``error`` 로 응답에 명시되고 화면이 그걸 그대로 띄운다.

    ``error`` 문구는 우리가 쓴 것만 내보낸다: 초안 어댑터의 도메인 에러(``LoveCallMailError`` — 회의록
    없음·빈 본문 등 사용자용 문구)는 그대로, 그 밖의 예외(OpenAI SDK·네트워크)는 일반 문구로 바꾸고 원인은
    로그에만 남긴다 — SDK 예외 문자열에는 요청 ID·마스킹된 키 일부 같은 내부 정보가 섞여 나온다.
    """
    locale = normalize_locale(locale)
    org_id = principal.organization_id
    meeting = _require_meeting(repo, meeting_id, locale)
    _require_participant(meeting, org_id, locale)
    counterpart = meeting.counterpart_of(org_id)
    _guard_noshow(repo, meeting_id, org_id, locale)
    _guard_already_sent(repo, meeting_id, org_id, counterpart, locale)

    ctx = _context(repo, directory, meeting, org_id)
    recipient_count = len(directory.member_emails(counterpart))
    # 화면에 띄울 상대 기업명 — 메일 내용의 재료(ctx)와 달리 화면 로케일을 따른다.
    recipient_display_name = directory.display_name(counterpart, locale)

    def _manual(error: str) -> LoveCallMailDraftResponse:
        return LoveCallMailDraftResponse(
            subject=fallback_subject(ctx),
            body="",  # 빈 편집기 — 사용자가 직접 쓸 수 있게 연다
            ai_generated=False,
            error=error,
            recipient_org_name=recipient_display_name,
            recipient_count=recipient_count,
        )

    if not ctx.has_report():
        return _manual(_message("no_report", locale))

    # AI 입력(ctx)과 수신자 수는 다 읽었다 — OpenAI를 기다리는 동안(자리 대기 포함) 요청 세션의
    # 커넥션을 쥐고 있지 않게 지금 돌려준다(app.db.release_connection 독스트링 참고).
    release_connection(db)
    try:
        with ai_chat_slot():
            draft = drafter.draft(ctx)
    except AiBusyError:
        logger.warning("러브콜 메일 AI 초안 거절 — AI 동시 호출 상한 (meeting_id=%s, org_id=%s)", meeting_id, org_id)
        return _manual(_message("ai_busy", locale))
    except LoveCallMailError as exc:
        # 어댑터가 사용자에게 보여주려고 쓴 문구다(회의록 없음·빈 본문 등) — ko에서는 그대로 전달한다.
        # 그 문구는 한국어라 en 화면에는 일반 실패 문구만 낸다(원인은 아래 로그에 남는다).
        logger.warning("러브콜 메일 AI 초안 실패 (meeting_id=%s, org_id=%s): %s", meeting_id, org_id, exc)
        return _manual(_message("ai_failed_with_reason", locale, reason=str(exc)))
    except Exception:  # noqa: BLE001 - 외부 AI 실패 전부를 수동 작성 경로로(원인은 로그에만)
        logger.exception("러브콜 메일 AI 초안 실패 (meeting_id=%s, org_id=%s)", meeting_id, org_id)
        return _manual(_message("ai_failed", locale))

    return LoveCallMailDraftResponse(
        subject=draft.subject,
        body=draft.body,
        ai_generated=True,
        error=None,
        recipient_org_name=recipient_display_name,
        recipient_count=recipient_count,
    )


@router.post("/send", response_model=LoveCallMailStateResponse)
def send_love_call_mail(
    meeting_id: str,
    body: LoveCallMailSendRequest,
    locale: str = Query(default=DEFAULT_LOCALE),
    principal: Principal = Depends(get_current_principal),
    repo: Repository = Depends(get_repository),
    directory: OrgDirectory = Depends(get_org_directory),
    sender_provider: EmailSenderProvider = Depends(get_email_sender_provider),
    db: Session = Depends(get_session),
) -> LoveCallMailStateResponse:
    """화면에서 검토·수정한 내용 **그대로** 상대 기업 담당자 전원에게 한 통 보낸다.

    수신자별로 쪼개지 않고 한 통에 담는다: 기업 앞으로 가는 편지 한 통이고, 부분 성공이 없어
    성공/실패가 명확해진다(알림 팬아웃과 다른 점 — 저기는 개인별 dispatch 기록이 목적이다).
    기록은 **발송 성공 이후에만** 한다 — 실패하면 아무것도 남지 않아 그대로 다시 시도할 수 있다.

    행사 메일 스위치가 꺼져 있으면 409(``PARTICIPANT_EMAIL_DISABLED``) — 아무것도 보내지도 기록하지도 않는다.
    스위치는 기존 거절(404·403·409·422)을 모두 지난 뒤, 발송 직전에 본다(꺼진 행사에서도 다른 거절의 응답과
    순서는 예전 그대로다). sender는 스위치를 본 **뒤에** 만든다(``get_email_sender_provider``) — SMTP 설정이
    깨져 있어도 꺼진 행사는 409다. 켜진 행사의 sender 생성 실패는 예전처럼 그대로 올라간다(500).
    """
    locale = normalize_locale(locale)
    org_id = principal.organization_id
    meeting = _require_meeting(repo, meeting_id, locale)
    _require_participant(meeting, org_id, locale)
    counterpart = meeting.counterpart_of(org_id)
    _guard_noshow(repo, meeting_id, org_id, locale)
    _guard_already_sent(repo, meeting_id, org_id, counterpart, locale)

    subject = body.subject.strip()
    mail_body = body.body.strip()
    if not subject or not mail_body:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=_message("subject_and_body_required", locale),
        )

    recipients = directory.member_emails(counterpart)
    # 화면에 띄우는 이름이다(거절 문구·발송 결과) — 메일 본문은 사용자가 편집한 그대로 나간다.
    recipient_org_name = directory.display_name(counterpart, locale)
    if not recipients:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=_message("no_recipients", locale, org=recipient_org_name),
        )

    # 행사 메일 스위치 — 커넥션을 돌려주기 전에(요청 세션으로) 읽는다. 읽기가 실패하면 예외가 그대로 올라가
    # 보내지 않는다(fail-closed). 꺼져 있으면 sender를 만들지도 않는다.
    if not notification_service.participant_email_enabled_for_event(db, str(meeting.event_id)):
        logger.info(
            "러브콜 메일 거절 — 행사 메일 스위치 꺼짐 (meeting_id=%s, org_id=%s)", meeting_id, org_id
        )
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "code": PARTICIPANT_EMAIL_DISABLED,
                "message": _message("email_disabled", locale),
            },
        )
    # 켜진 행사만 여기 온다. 생성 실패(SMTP 미설정)는 try 밖이라 예전처럼 그대로 올라간다(502로 바꾸지 않는다).
    sender = sender_provider()

    # 수신자·기업명까지 다 읽었다 — SMTP를 기다리는 동안 요청 세션의 커넥션을 쥐고 있지 않게 지금 돌려준다
    # (app.db.release_connection — 아래 _context가 다시 쓰면 새 커넥션을 받는다).
    release_connection(db)
    try:
        sender.send(EmailMessage(to=recipients, subject=subject, body=mail_body))
    except Exception:  # noqa: BLE001 - 발송 실패는 숨기지 않되(낙관적 UI 금지) 원문은 서버 로그에만
        logger.exception("러브콜 메일 발송 실패 (meeting_id=%s, org_id=%s)", meeting_id, org_id)
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=_message("send_failed", locale),
        ) from None

    # 발송 성공 — 공개 신호 행을 보장하고(Step1 토글을 안 켰을 수 있다) 같은 행에 발송본을 남긴다.
    repo.add_love_call(send_love_call(meeting_id, org_id, counterpart))
    record = repo.record_love_call_email(
        meeting_id,
        org_id,
        counterpart,
        subject=subject,
        body=mail_body,
        recipient_count=len(recipients),
        sent_at=datetime.now(timezone.utc),
    )

    return LoveCallMailStateResponse(
        recipient_org_name=recipient_org_name,
        recipient_count=len(recipients),
        report_ready=_context(repo, directory, meeting, org_id).has_report(),
        sent=True,
        sent_at=record.email_sent_at,
        subject=record.email_subject,
        body=record.email_body,
        participant_email_enabled=True,  # 위에서 켜져 있음을 확인하고 보냈다
    )
