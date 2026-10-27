"""알림 채널 포트(ADR-0010) — 알림 생성 시 활성 채널 전체에 디스패치.

DB·이메일 세부(SMTP 등)를 모르는 순수 포트 계층: ``NotificationChannel.send()``는 발신에
필요한 값만 담은 ``NotificationEnvelope``와 수신자 목록을 받아 결과(``DispatchResult``)를
돌려준다 — DB 기록(``notification_dispatches`` upsert)은 호출부(service.py)가 담당한다.

새 채널(예: 메신저) 추가는 이 파일에 클래스 1개를 더하고 ``build_channels``에 등록하는
것으로 끝난다 — service.py·router.py는 건드리지 않는다.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

from app.config import settings as _SETTINGS
from app.models import DEFAULT_PARTICIPANT_MENU, PARTICIPANT_MENUS
from app.notifications.email import EmailMessage, EmailSender


@dataclass(frozen=True)
class ChannelRecipient:
    """발송 대상 Member 1인 — org 공유 인박스와 별개로 외부 발송은 멤버 연락처로 팬아웃(ADR-0010)."""

    member_id: str
    email: str | None = None


@dataclass(frozen=True)
class NotificationEnvelope:
    """채널이 발신에 필요로 하는 값만 담은 DTO — DB row(ORM)에 의존하지 않아 채널 단위 테스트가 쉽다."""

    notification_id: str
    type: str
    event_id: str
    meeting_id: str | None
    payload: dict
    #: 이 알림이 속한 행사의 참가자 메뉴(``app.models.PARTICIPANT_MENUS``). 메일 본문이 "어느 화면에서
    #: 확인하라"고 안내할 때 메뉴에 없는 화면을 가리키지 않게 하려고 싣는다. 봉투를 만드는 쪽
    #: (service.py)이 행사 설정에서 읽어 넣고, 안 넣으면 기본값(미팅만)이다 — 값을 모를 때 메뉴에 없을
    #: 수 있는 화면(알림함·기업 탐색)을 가리키는 것보다, 어느 메뉴에나 있는 미팅 화면을 가리키는 쪽이 안전하다.
    participant_menu: str = DEFAULT_PARTICIPANT_MENU


@dataclass(frozen=True)
class DispatchResult:
    """채널 발송 결과 1건 — notification_dispatches 한 행에 그대로 대응(member_id, channel, status)."""

    member_id: str
    channel: str  # 'in_app' | 'email' | 'sms' — notification_dispatches.channel CHECK와 일치
    status: str  # 'sent' | 'skipped' | 'failed'
    error: str | None = None


class NotificationChannel(Protocol):
    name: str

    def send(
        self, envelope: NotificationEnvelope, recipients: list[ChannelRecipient]
    ) -> list[DispatchResult]:
        """수신자별 발송 결과를 돌려준다. 개별 수신자 실패가 다른 수신자 발송을 막지 않는다(우아한 열화)."""
        ...


class InAppChannel:
    """인앱 인박스 — notifications 행 생성 자체가 발신이다(전 6종 단일 진실원천, ADR-0010).

    별도 외부 호출 없음: 실패할 일이 없어 전원 즉시 'sent' — dispatch 기록은 감사 목적.
    """

    name = "in_app"

    def send(
        self, envelope: NotificationEnvelope, recipients: list[ChannelRecipient]
    ) -> list[DispatchResult]:
        return [DispatchResult(member_id=r.member_id, channel=self.name, status="sent") for r in recipients]


# 알림 타입별 한/영 병기 제목(간단 템플릿 — 과도한 템플릿 엔진 없이 dict lookup 수준으로 유지).
_EMAIL_TITLES: dict[str, tuple[str, str]] = {
    "meeting_requested": ("미팅 신청이 도착했어요", "New meeting request"),
    "meeting_accepted": ("미팅 신청이 수락됐어요", "Your meeting request was accepted"),
    "meeting_cancelled": ("미팅이 취소됐어요", "A meeting was cancelled"),
    "meeting_rejected": ("미팅 신청이 거절됐어요", "Your meeting request was declined"),
    "meeting_reminder": ("미팅 시작 10분 전이에요", "Your meeting starts in 10 minutes"),
    "review_prompt": ("미팅 회의록을 입력해 주세요", "Please submit your meeting review"),
    "review_ready": ("회의록 정리가 끝났어요", "Your meeting report is ready"),
    "application_approved": ("비즈매칭 승인이 완료되었습니다", "Your application has been approved"),
}


def _effective_participant_menu(value: str) -> str:
    """봉투에 실린 참가자 메뉴 → 어휘 안의 값. 모르는 값은 기본값으로 접는다(폴백은 상수 하나만 본다)."""
    return value if value in PARTICIPANT_MENUS else DEFAULT_PARTICIPANT_MENU


def render_email(envelope: NotificationEnvelope) -> tuple[str, str]:
    """알림 payload 스냅샷으로 이메일 제목·본문을 만든다. 한국어 제목 + 영어 부제 수준(간단 템플릿).

    본문의 "어디서 확인하라" 안내 두 곳(승인 메일의 탐색·신청 안내, 그 밖의 알림함 안내)은 행사의
    참가자 메뉴를 따른다 — 미팅만 보이는 행사(``meetings_only``, 기본)에서는 메뉴에 없는 화면(기업 탐색·
    알림함) 대신 미팅 화면을 가리킨다. 전체 메뉴(``full``)로 설정한 행사의 문구는 이 설정이 생기기 전과
    바이트 단위로 같다.
    """
    brand = _SETTINGS.email_brand_name
    title_ko, title_en = _EMAIL_TITLES.get(envelope.type, (f"{brand} 알림", f"{brand} notification"))
    subject = f"[{brand}] {title_ko} / {title_en}"
    meetings_only = _effective_participant_menu(envelope.participant_menu) == "meetings_only"
    if envelope.type == "application_approved":
        # 상대 기업 개념이 없는 이벤트형 통지 — 승인 사실 + 서비스 접속 안내만.
        if meetings_only:
            body = (
                f"{title_ko} ({title_en})\n\n"
                f"이제 {brand} 비즈매칭 서비스에 로그인해 미팅 화면에서 일정을 확인할 수 있어요.\n"
                f"You can now log in to {brand} and check your schedule on the Meetings screen.\n"
            )
            return subject, body
        body = (
            f"{title_ko} ({title_en})\n\n"
            f"이제 {brand} 비즈매칭 서비스에서 바이어/참가사를 탐색하고 미팅을 신청할 수 있어요.\n"
            f"You can now log in to {brand} to explore matches and request meetings.\n"
        )
        return subject, body
    counterpart = envelope.payload.get("counterpart_org_name", "")
    if envelope.type == "meeting_rejected":
        # 거절 사유는 담지 않는다(GitHub #4 권고) — 다음 행동 안내만.
        body = (
            f"{title_ko} ({title_en})\n\n"
            f"상대 기업 / Counterpart: {counterpart}\n\n"
            "다른 시간으로 다시 신청해 보세요.\n"
            "Feel free to send a new request for a different time.\n"
        )
        return subject, body
    if meetings_only:
        body = (
            f"{title_ko} ({title_en})\n\n"
            f"상대 기업 / Counterpart: {counterpart}\n\n"
            f"{brand}에 로그인해 미팅 화면에서 자세히 확인하세요.\n"
            f"Log in to {brand} and check the details on the Meetings screen.\n"
        )
        return subject, body
    body = (
        f"{title_ko} ({title_en})\n\n"
        f"상대 기업 / Counterpart: {counterpart}\n\n"
        f"{brand} 알림함에서 자세히 확인하세요.\n"
        f"Check the details in your {brand} notification inbox.\n"
    )
    return subject, body


class EmailChannel:
    """이메일 — 대상 Organization 소속 Member 이메일로 팬아웃(EmailSender 포트 경유).

    연락처 없는 멤버는 'skipped', 발송 실패는 'failed'(우아한 열화 — 한 멤버 실패가 다른
    멤버 발송을 막지 않는다). 읽음(read_at)은 이 발송 성공 여부와 완전히 분리(ADR-0010).
    """

    name = "email"

    def __init__(self, sender: EmailSender) -> None:
        self._sender = sender

    def send(
        self, envelope: NotificationEnvelope, recipients: list[ChannelRecipient]
    ) -> list[DispatchResult]:
        subject, body = render_email(envelope)
        results: list[DispatchResult] = []
        for r in recipients:
            if not r.email:
                results.append(DispatchResult(member_id=r.member_id, channel=self.name, status="skipped"))
                continue
            try:
                self._sender.send(EmailMessage(to=[r.email], subject=subject, body=body))
                results.append(DispatchResult(member_id=r.member_id, channel=self.name, status="sent"))
            except Exception as exc:  # noqa: BLE001 - 개별 수신자 발송 실패를 격리(우아한 열화)
                results.append(
                    DispatchResult(member_id=r.member_id, channel=self.name, status="failed", error=str(exc))
                )
        return results


#: dispatch ``error`` 칸에 남기는 사유 코드 — 행사 설정 "참가자 알림 메일"(``event_schedule_settings.
#: participant_email_enabled``)이 꺼져 있어 외부 채널로 **보내지 않았다**(실패가 아니다). 어드민 알림 콘솔이
#: 이 코드를 보고 "보내지 않음 (참가자 알림 메일 꺼짐)"으로 읽는다(admin 응답의 ``skip_reason``).
EVENT_EMAIL_DISABLED = "event_email_disabled"


def suppressed_dispatch_results(
    channel_name: str, recipients: list[ChannelRecipient]
) -> list[DispatchResult]:
    """행사 설정으로 외부 채널을 끈 알림의 dispatch 결과 — 채널을 부르지 않고(아무것도 보내지 않고) 만든다.

    채널이 원래 보냈을 수신자마다 ``skipped`` + :data:`EVENT_EMAIL_DISABLED`. 이메일 채널에서 주소가 없는
    멤버는 스위치와 무관하게 원래도 안 보냈을 수신자라 :class:`EmailChannel` 과 같은 모양(``skipped``, 사유
    없음)으로 남긴다 — 켜져 있을 때와 같은 행 집합이 생기고 상태·사유만 다르다(유니크 notification×member×
    channel 그대로).
    """
    results: list[DispatchResult] = []
    for r in recipients:
        if channel_name == EmailChannel.name and not r.email:
            results.append(DispatchResult(member_id=r.member_id, channel=channel_name, status="skipped"))
        else:
            results.append(
                DispatchResult(
                    member_id=r.member_id,
                    channel=channel_name,
                    status="skipped",
                    error=EVENT_EMAIL_DISABLED,
                )
            )
    return results


def send_isolated(
    channel: NotificationChannel, envelope: NotificationEnvelope, recipients: list[ChannelRecipient]
) -> list[DispatchResult]:
    """채널 하나로 보낸다 — 채널이 스스로 격리하지 못한 예외(렌더 실패 등)도 수신자별 'failed'로 바꿔 돌려준다.

    알림 행을 커밋한 **뒤에** 보내는 경로(service._emit_notification·bulk_dispatch)에서 쓴다 — 거기서는 예외를
    위로 올려도 이미 커밋된 알림을 되돌릴 수 없으니, 실패를 dispatch 행으로 남기는 게 맞다.
    """
    try:
        return channel.send(envelope, recipients)
    except Exception as exc:  # noqa: BLE001 - 한 채널의 실패가 기록·다른 채널을 막지 않는다
        return [
            DispatchResult(member_id=r.member_id, channel=channel.name, status="failed", error=str(exc))
            for r in recipients
        ]


def build_channels(email_sender: EmailSender) -> list[NotificationChannel]:
    """활성 채널 레지스트리(v1: 인앱 + 이메일, ADR-0010). SMS/푸시는 backlog.

    추가 채널(메신저 등)은 여기에 인스턴스를 append하는 것으로 끝난다 — 외부 채널이면
    :data:`DEFAULT_EXTERNAL_CHANNEL_NAMES` 에도 이름을 더한다.
    """
    return [InAppChannel(), EmailChannel(email_sender)]


#: :func:`build_channels` 가 만드는 외부(인앱이 아닌) 채널의 이름. 참가자 알림 메일이 꺼진 행사는 이 채널들을
#: **만들지 않고**(SMTP sender 생성도 없이) 이 이름들로 ``skipped``(``event_email_disabled``) 기록만 남긴다 —
#: 메일 설정이 깨져 채널 구성이 실패해도 꺼진 행사의 인앱 알림은 남아야 한다(service._emit_notification).
DEFAULT_EXTERNAL_CHANNEL_NAMES: tuple[str, ...] = (EmailChannel.name,)
