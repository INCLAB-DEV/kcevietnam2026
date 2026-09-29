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
- 발송 실패 → 502 + 사유. **love_calls 에 아무것도 기록하지 않는다** → 그대로 재시도 가능.
- 수신 이메일 0건 → 422. "보냈다"고 말하고 아무 데도 안 가는 상태를 만들지 않는다.

권한·주체는 리뷰 API 와 같다(``get_current_principal`` + 그 미팅의 참석자만).
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status

from app.api.deps import (
    get_email_sender,
    get_love_call_drafter,
    get_org_directory,
    get_repository,
)
from app.auth.principal import Principal, get_current_principal
from app.domain.love_call_signal import send_love_call
from app.notifications.email import EmailMessage, EmailSender
from app.repositories.base import MeetingView, Repository
from app.schemas import (
    LoveCallMailDraftResponse,
    LoveCallMailSendRequest,
    LoveCallMailStateResponse,
)
from app.services.love_call_mail import (
    LoveCallContext,
    LoveCallMailDrafter,
    build_love_call_context,
    fallback_subject,
    role_label,
)
from app.services.org_directory import OrgDirectory

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/meetings/{meeting_id}/love-call/mail", tags=["love-call"])


def _require_meeting(repo: Repository, meeting_id: str) -> MeetingView:
    meeting = repo.get_meeting(meeting_id)
    if meeting is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="미팅 없음")
    return meeting


def _require_participant(meeting: MeetingView, org_id: str) -> None:
    if not meeting.is_participant(org_id):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="이 미팅의 참석자가 아닙니다"
        )


def _context(
    repo: Repository, directory: OrgDirectory, meeting: MeetingView, org_id: str
) -> LoveCallContext:
    """AI 입력 문맥을 만든다 — 보고문서 3섹션 + 양측 기업명·역할만(비공개는 필드 자체가 없다)."""
    counterpart = meeting.counterpart_of(org_id)
    stored = repo.get_review(meeting.meeting_id, org_id)
    return build_love_call_context(
        stored.report if stored else None,
        sender_org_name=directory.display_name(org_id),
        sender_role=role_label(org_id == meeting.exhibitor_org_id),
        recipient_org_name=directory.display_name(counterpart),
        recipient_role=role_label(counterpart == meeting.exhibitor_org_id),
    )


def _guard_noshow(repo: Repository, meeting_id: str, org_id: str) -> None:
    """상대가 오지 않은 미팅에는 러브콜을 보내지 않는다(Step1 이 love_call 을 비우는 것과 같은 규칙)."""
    stored = repo.get_review(meeting_id, org_id)
    if stored is not None and stored.is_noshow:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="상대방 불참(noshow) 미팅에는 러브콜 메일을 보낼 수 없습니다",
        )


def _guard_already_sent(repo: Repository, meeting_id: str, org_id: str, counterpart: str) -> None:
    """중복 발송 차단 — 같은 (미팅, 보낸기업, 받은기업)에 두 번 보내지 않는다."""
    record = repo.get_love_call(meeting_id, org_id, counterpart)
    if record is not None and record.email_sent:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="이 미팅의 러브콜 메일은 이미 발송했습니다",
        )


@router.get("", response_model=LoveCallMailStateResponse)
def get_love_call_mail_state(
    meeting_id: str,
    principal: Principal = Depends(get_current_principal),
    repo: Repository = Depends(get_repository),
    directory: OrgDirectory = Depends(get_org_directory),
) -> LoveCallMailStateResponse:
    """화면 진입 상태 — 이미 보냈으면 발송본을 그대로 돌려줘 "언제 뭐라고 보냈는지"를 보여준다."""
    org_id = principal.organization_id
    meeting = _require_meeting(repo, meeting_id)
    _require_participant(meeting, org_id)
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
        recipient_org_name=ctx.recipient_org_name,
        recipient_count=recipient_count,
        report_ready=ctx.has_report(),
        sent=sent,
        sent_at=record.email_sent_at if sent else None,
        subject=record.email_subject if sent else None,
        body=record.email_body if sent else None,
    )


@router.post("/draft", response_model=LoveCallMailDraftResponse)
def draft_love_call_mail(
    meeting_id: str,
    principal: Principal = Depends(get_current_principal),
    repo: Repository = Depends(get_repository),
    directory: OrgDirectory = Depends(get_org_directory),
    drafter: LoveCallMailDrafter = Depends(get_love_call_drafter),
) -> LoveCallMailDraftResponse:
    """회의록을 근거로 AI 초안을 만든다. 실패는 200 + error 로 **드러내고** 수동 작성을 연다.

    502 로 떨어뜨리지 않는 이유: 사용자는 여기서 멈추면 안 되고 "직접 쓰기"로 이어져야 한다.
    실패 사실은 ``ai_generated=False`` + ``error`` 로 응답에 명시되고 화면이 그걸 그대로 띄운다.
    """
    org_id = principal.organization_id
    meeting = _require_meeting(repo, meeting_id)
    _require_participant(meeting, org_id)
    counterpart = meeting.counterpart_of(org_id)
    _guard_noshow(repo, meeting_id, org_id)
    _guard_already_sent(repo, meeting_id, org_id, counterpart)

    ctx = _context(repo, directory, meeting, org_id)
    recipient_count = len(directory.member_emails(counterpart))

    def _manual(error: str) -> LoveCallMailDraftResponse:
        return LoveCallMailDraftResponse(
            subject=fallback_subject(ctx),
            body="",  # 빈 편집기 — 사용자가 직접 쓸 수 있게 연다
            ai_generated=False,
            error=error,
            recipient_org_name=ctx.recipient_org_name,
            recipient_count=recipient_count,
        )

    if not ctx.has_report():
        return _manual("확정된 회의록이 없어 AI 초안을 만들 수 없어요. 직접 작성해 주세요.")

    try:
        draft = drafter.draft(ctx)
    except Exception as exc:  # noqa: BLE001 - 외부 AI 실패 전부를 사용자에게 그대로 전달
        logger.warning("러브콜 메일 AI 초안 실패 (meeting_id=%s, org_id=%s): %s", meeting_id, org_id, exc)
        return _manual(f"AI 초안 생성에 실패했어요: {exc}")

    return LoveCallMailDraftResponse(
        subject=draft.subject,
        body=draft.body,
        ai_generated=True,
        error=None,
        recipient_org_name=ctx.recipient_org_name,
        recipient_count=recipient_count,
    )


@router.post("/send", response_model=LoveCallMailStateResponse)
def send_love_call_mail(
    meeting_id: str,
    body: LoveCallMailSendRequest,
    principal: Principal = Depends(get_current_principal),
    repo: Repository = Depends(get_repository),
    directory: OrgDirectory = Depends(get_org_directory),
    sender: EmailSender = Depends(get_email_sender),
) -> LoveCallMailStateResponse:
    """화면에서 검토·수정한 내용 **그대로** 상대 기업 담당자 전원에게 한 통 보낸다.

    수신자별로 쪼개지 않고 한 통에 담는다: 기업 앞으로 가는 편지 한 통이고, 부분 성공이 없어
    성공/실패가 명확해진다(알림 팬아웃과 다른 점 — 저기는 개인별 dispatch 기록이 목적이다).
    기록은 **발송 성공 이후에만** 한다 — 실패하면 아무것도 남지 않아 그대로 다시 시도할 수 있다.
    """
    org_id = principal.organization_id
    meeting = _require_meeting(repo, meeting_id)
    _require_participant(meeting, org_id)
    counterpart = meeting.counterpart_of(org_id)
    _guard_noshow(repo, meeting_id, org_id)
    _guard_already_sent(repo, meeting_id, org_id, counterpart)

    subject = body.subject.strip()
    mail_body = body.body.strip()
    if not subject or not mail_body:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="메일 제목과 본문을 모두 입력하세요",
        )

    recipients = directory.member_emails(counterpart)
    recipient_org_name = directory.display_name(counterpart)
    if not recipients:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"{recipient_org_name} 에 등록된 담당자 이메일이 없어 발송할 수 없습니다",
        )

    try:
        sender.send(EmailMessage(to=recipients, subject=subject, body=mail_body))
    except Exception as exc:  # noqa: BLE001 - 발송 실패를 사용자에게 그대로 노출(낙관적 UI 금지)
        logger.warning("러브콜 메일 발송 실패 (meeting_id=%s, org_id=%s): %s", meeting_id, org_id, exc)
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"메일 발송에 실패했어요: {exc}",
        )

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
    )
