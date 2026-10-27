"""러브콜 메일(#13) 외부 동작 테스트 — 회의록 기반 AI 초안 → 검수·수정 → 실제 발송.

잠그는 규칙(발주자 요구 + 이 코드베이스의 고질병 회귀 방지):
- 본문이 **그 미팅의 회의록**에서 나온다(템플릿에 이름만 끼우는 수준이 아니다).
- **비공개 항목(만족도·Follow-up Intent·Fit·전사 원문)이 AI 프롬프트 입력에도, 메일 본문에도
  없다.** 보고서 내보내기 D6 과 같은 원칙 — 여기서는 타입(LoveCallContext)이 구조적으로 막는다.
- 발송 성공 시 love_calls 에 이력이 남고, 두 번째 발송은 차단된다.
- **AI 실패가 사용자에게 보이고**, 그래도 직접 쓸 수 있는 경로(빈 편집기)가 열린다.
- **발송 실패가 사용자에게 보이고**, 아무것도 기록되지 않아 재시도할 수 있다(낙관적 UI 금지).

AI 는 FakeLoveCallMailDrafter, 이메일은 FakeEmailSender — 외부 호출 0건.
"""

import logging

import pytest
from fastapi.testclient import TestClient

from app.api.deps import (
    get_email_sender,
    get_love_call_drafter,
    get_org_directory,
    get_repository,
)
from app.auth.principal import get_current_principal
from app.domain.love_call_signal import PRIVATE_REVIEW_FIELDS
from app.main import app
from app.notifications.email import FakeEmailSender
from app.repositories.base import MeetingView
from app.repositories.memory import InMemoryRepository
from app.domain.review_provenance_binding import MatchingType
from app.config import settings
from app.services.love_call_mail import (
    FakeLoveCallMailDrafter,
    LoveCallContext,
    LoveCallMailError,
    build_love_call_context,
    compose_body,
    fallback_subject,
    normalize_subject,
    render_user_prompt,
)
from app.services.org_directory import StaticOrgDirectory
from tests.conftest import header_principal


class TestSubjectPrefixBrandName:
    """제목 접두 `[{brand}]`가 settings.email_brand_name을 따라가는지(기본값 Sales AI 보존)."""

    def _ctx(self) -> LoveCallContext:
        return LoveCallContext(
            sender_org_name="VinaContent",
            sender_role="참가사",
            recipient_org_name="한화",
            recipient_role="바이어",
        )

    def test_default_brand_name_prefix_is_sales_ai(self):
        subject = fallback_subject(self._ctx())
        assert subject.startswith("[Sales AI]")

    def test_custom_brand_name_prefix_reflected(self, monkeypatch):
        monkeypatch.setattr(settings, "email_brand_name", "KCE 2026")
        subject = fallback_subject(self._ctx())
        assert subject.startswith("[KCE 2026]")

    def test_normalize_subject_does_not_double_prefix(self, monkeypatch):
        monkeypatch.setattr(settings, "email_brand_name", "KCE 2026")
        ctx = self._ctx()
        already_prefixed = normalize_subject("[KCE 2026] 손으로 고친 제목", ctx)
        assert already_prefixed == "[KCE 2026] 손으로 고친 제목"

ORG_A = "org-exhibitor"  # 참가사 — 러브콜을 보내는 쪽
ORG_B = "org-buyer"  # 바이어 — 받는 쪽
ORG_C = "org-outsider"  # 비참석자
MEETING = "meeting-1"

BUYER_EMAILS = ["buyer.lead@example.com", "buyer.staff@example.com"]

# 회의록 3섹션(공개) — 본문에 반드시 반영돼야 하는 재료.
REPORT = {
    "discussion": ["애니메이션 IP 4편 동남아 배급 조건 논의"],
    "agreements": ["9월 중 파일럿 2편 선공개 합의"],
    "actions": ["10월 첫째 주까지 단가표 회신"],
}

# 비공개 항목 — 프롬프트에도 메일에도 절대 나오면 안 되는 값들.
PRIVATE_SATISFACTION = 5
PRIVATE_FIT_REASON = "내부판단_예산집행권한없음"
PRIVATE_TRANSCRIPT = "내부전사_상대가_가격을_후려쳤다"


class FailingDrafter:
    """AI 실패(크레딧 소진·API 오류) 재현."""

    def draft(self, ctx):
        raise LoveCallMailError("insufficient_quota: 크레딧이 소진되었습니다")


class FailingEmailSender:
    """SMTP 실패 재현."""

    def __init__(self) -> None:
        self.sent = []

    def send(self, message):
        raise RuntimeError("SMTPAuthenticationError: 535")


@pytest.fixture
def repo() -> InMemoryRepository:
    r = InMemoryRepository()
    r.add_meeting(
        MeetingView(
            meeting_id=MEETING,
            event_id="event-1",
            exhibitor_org_id=ORG_A,
            buyer_org_id=ORG_B,
            matching_type=MatchingType.AI,
            ai_score=0.9,
            ai_score_reasons=["제품 적합성"],
        )
    )
    return r


@pytest.fixture
def mailbox() -> FakeEmailSender:
    return FakeEmailSender()


@pytest.fixture
def directory() -> StaticOrgDirectory:
    return StaticOrgDirectory(
        names={ORG_A: "누리스튜디오", ORG_B: "VinaContent"},
        emails={ORG_A: ["exh@example.com"], ORG_B: list(BUYER_EMAILS)},
    )


@pytest.fixture
def client(repo, mailbox, directory, participant_email_forced_on) -> TestClient:
    # 외부 어댑터는 전부 fake 로 고정 — 개발자 로컬 .env(실 openai/smtp 토글)가 테스트로 새어
    # 들어가 실제 API 를 때리거나 메일을 발송하지 않게 한다.
    # 행사 메일 스위치는 켠 상태다(participant_email_forced_on) — 기본이 꺼짐이라 켜지 않으면 발송이 409다.
    # 이 픽스처의 미팅은 InMemory 리포지토리·비-UUID 행사 id라 설정 행을 만들 수 없다. 꺼짐·켜짐을 실제 설정
    # 행으로 검증하는 테스트는 맨 아래 TestEventEmailSwitch(실 DB)다.
    app.dependency_overrides[get_repository] = lambda: repo
    app.dependency_overrides[get_love_call_drafter] = lambda: FakeLoveCallMailDrafter()
    app.dependency_overrides[get_email_sender] = lambda: mailbox
    app.dependency_overrides[get_org_directory] = lambda: directory
    app.dependency_overrides[get_current_principal] = header_principal
    yield TestClient(app)
    app.dependency_overrides.clear()


def _h(org_id: str) -> dict:
    return {"X-Org-Id": org_id}


def _seed_review(client, *, noshow=False, report=REPORT):
    """Step1 + Step2 를 태워 확정된 회의록과 **비공개 평가**를 함께 저장한다."""
    client.post(
        f"/meetings/{MEETING}/review/step1",
        json={
            "proceeded": "counterpart_noshow" if noshow else "proceeded",
            "satisfaction": PRIVATE_SATISFACTION,
            "follow_up_intent": "yes",
        },
        headers=_h(ORG_A),
    )
    if noshow:
        return
    client.post(
        f"/meetings/{MEETING}/review/step2",
        json={
            "report": report,
            "fit_rating": "good",
            "fit_reason": PRIVATE_FIT_REASON,
            "fit_reason_tags": ["예산"],
            "transcript": PRIVATE_TRANSCRIPT,
            "transcript_turns": [{"who": "them", "text": PRIVATE_TRANSCRIPT}],
            "finalize": True,
        },
        headers=_h(ORG_A),
    )


def _draft(client, org=ORG_A):
    return client.post(f"/meetings/{MEETING}/love-call/mail/draft", headers=_h(org))


def _send(client, subject: str, body: str, org=ORG_A):
    return client.post(
        f"/meetings/{MEETING}/love-call/mail/send",
        json={"subject": subject, "body": body},
        headers=_h(org),
    )


# =============================================================================
# 비공개 배제 — 구조적 보장(타입) + 실제 응답 검증
# =============================================================================
class TestPrivacyBoundary:
    def test_context_has_no_private_fields_at_all(self):
        """AI 입력 타입에 비공개 필드가 **존재조차 하지 않는다**(구조적 배제)."""
        fields = set(LoveCallContext.__dataclass_fields__)
        assert not (fields & PRIVATE_REVIEW_FIELDS), f"비공개 필드가 AI 입력 타입에 있음: {fields}"

    def test_context_builder_drops_private_keys_from_report(self):
        """보고문서 dict 에 비공개 키가 섞여 들어와도 화이트리스트 추출이 버린다."""
        polluted = {
            **REPORT,
            "satisfaction": PRIVATE_SATISFACTION,
            "fit_reason": PRIVATE_FIT_REASON,
            "transcript": PRIVATE_TRANSCRIPT,
        }
        ctx = build_love_call_context(
            polluted,
            sender_org_name="누리스튜디오",
            sender_role="참가사",
            recipient_org_name="VinaContent",
            recipient_role="바이어",
        )
        assert ctx.discussion == REPORT["discussion"]
        assert PRIVATE_FIT_REASON not in render_user_prompt(ctx)

    def test_prompt_contains_report_but_never_private_values(self):
        """AI 에 실제로 실리는 user 메시지 = 유출 경계. 회의록만 있고 비공개는 없다."""
        ctx = build_love_call_context(
            REPORT,
            sender_org_name="누리스튜디오",
            sender_role="참가사",
            recipient_org_name="VinaContent",
            recipient_role="바이어",
        )
        prompt = render_user_prompt(ctx)
        assert REPORT["discussion"][0] in prompt
        assert REPORT["agreements"][0] in prompt
        assert REPORT["actions"][0] in prompt
        for leaked in (PRIVATE_FIT_REASON, PRIVATE_TRANSCRIPT, str(PRIVATE_SATISFACTION)):
            assert leaked not in prompt, f"비공개 값 {leaked} 가 프롬프트에 실렸다"

    def test_drafted_mail_has_no_private_values(self, client):
        """저장된 리뷰에 비공개 평가가 다 들어 있어도 메일 초안에는 한 글자도 안 나온다."""
        _seed_review(client)
        body = _draft(client).json()
        text = f"{body['subject']}\n{body['body']}"
        for leaked in (PRIVATE_FIT_REASON, PRIVATE_TRANSCRIPT):
            assert leaked not in text, f"비공개 값 {leaked} 가 메일에 노출됨"

    def test_sent_mail_has_no_private_values(self, client, mailbox):
        """발송본에도 비공개가 없다 — 초안뿐 아니라 실제로 나간 메일까지 확인."""
        _seed_review(client)
        d = _draft(client).json()
        _send(client, d["subject"], d["body"])
        sent = mailbox.sent[0]
        for leaked in (PRIVATE_FIT_REASON, PRIVATE_TRANSCRIPT):
            assert leaked not in sent.body
            assert leaked not in sent.subject


# =============================================================================
# AI 초안 — 회의록 기반 생성
# =============================================================================
class TestDraft:
    def test_draft_is_built_from_this_meetings_report(self, client):
        _seed_review(client)
        resp = _draft(client)
        assert resp.status_code == 200
        body = resp.json()
        assert body["ai_generated"] is True
        assert body["error"] is None
        # 템플릿에 이름만 끼운 게 아니라 회의록 3섹션이 실제로 반영된다.
        for line in REPORT["discussion"] + REPORT["agreements"] + REPORT["actions"]:
            assert line in body["body"], f"회의록 항목이 본문에 없음: {line}"
        assert "VinaContent" in body["body"]  # 상대 기업명(id 아님)
        assert body["recipient_org_name"] == "VinaContent"
        assert body["recipient_count"] == len(BUYER_EMAILS)

    def test_draft_is_bilingual(self, client):
        """상대가 해외 바이어일 수 있어 한/영 병기로 만든다(알림 메일과 같은 하우스 스타일)."""
        _seed_review(client)
        body = _draft(client).json()["body"]
        assert "안녕하세요" in body
        assert "Dear" in body

    def test_draft_requires_participant(self, client):
        _seed_review(client)
        assert _draft(client, org=ORG_C).status_code == 403

    def test_draft_blocked_on_noshow(self, client):
        _seed_review(client, noshow=True)
        resp = _draft(client)
        assert resp.status_code == 409

    def test_draft_without_report_opens_manual_editor(self, client):
        """회의록이 없으면 AI 를 부르지 않고, 이유를 알린 뒤 직접 쓰게 연다."""
        resp = _draft(client)
        assert resp.status_code == 200
        body = resp.json()
        assert body["ai_generated"] is False
        assert "회의록" in body["error"]
        assert body["body"] == ""  # 빈 편집기
        assert body["subject"]  # 제목은 정형 템플릿으로 채워 준다


# =============================================================================
# AI 실패 — 사용자에게 보이고, 수동 작성 경로가 열린다
# =============================================================================
class TestDraftFailureIsVisible:
    def test_ai_failure_returns_error_and_empty_editor(self, client):
        _seed_review(client)
        app.dependency_overrides[get_love_call_drafter] = lambda: FailingDrafter()
        resp = _draft(client)

        assert resp.status_code == 200  # 사용자는 막히지 않고 직접 쓰기로 이어진다
        body = resp.json()
        assert body["ai_generated"] is False  # 성공한 척하지 않는다
        assert "insufficient_quota" in body["error"]  # 원인을 그대로 보여준다
        assert body["body"] == ""  # 빈 편집기
        assert "VinaContent" in body["subject"]  # 정형 제목은 채워 줌

    def test_manual_body_can_still_be_sent_after_ai_failure(self, client, mailbox):
        """AI 가 죽어도 사용자가 직접 쓴 본문은 정상 발송된다."""
        _seed_review(client)
        app.dependency_overrides[get_love_call_drafter] = lambda: FailingDrafter()
        d = _draft(client).json()

        resp = _send(client, d["subject"], "직접 쓴 제안 본문입니다.")
        assert resp.status_code == 200
        assert resp.json()["sent"] is True
        assert mailbox.sent[0].body == "직접 쓴 제안 본문입니다."


# =============================================================================
# 발송 — 실제 수신자·이력·중복 방지
# =============================================================================
class TestSend:
    def test_send_delivers_to_counterpart_members(self, client, mailbox):
        _seed_review(client)
        d = _draft(client).json()
        resp = _send(client, d["subject"], d["body"])

        assert resp.status_code == 200
        assert len(mailbox.sent) == 1
        message = mailbox.sent[0]
        assert message.to == BUYER_EMAILS  # 상대 기업 담당자 전원
        assert message.subject == d["subject"]
        assert message.body == d["body"]

    def test_send_uses_user_edited_text_verbatim(self, client, mailbox):
        """미리보기=발송본. 서버가 사용자가 고친 문장을 다시 손대지 않는다."""
        _seed_review(client)
        _draft(client)
        edited_subject = "[NABI] 손으로 고친 제목"
        edited_body = "손으로 고친 본문입니다.\n두 번째 줄."
        _send(client, edited_subject, edited_body)

        assert mailbox.sent[0].subject == edited_subject
        assert mailbox.sent[0].body == edited_body

    def test_send_records_history_in_love_calls(self, client, repo):
        _seed_review(client)
        d = _draft(client).json()
        _send(client, d["subject"], d["body"])

        record = repo.get_love_call(MEETING, ORG_A, ORG_B)
        assert record is not None
        assert record.email_sent is True
        assert record.email_subject == d["subject"]
        assert record.email_body == d["body"]
        assert record.email_recipient_count == len(BUYER_EMAILS)

    def test_send_also_leaves_public_love_call_signal(self, client, repo):
        """메일 발송은 공개 단방향 신호도 함께 성립시킨다(Step1엔 더 이상 그런 토글이 없다)."""
        _seed_review(client)
        d = _draft(client).json()
        _send(client, d["subject"], d["body"])

        signals = repo.list_love_calls(MEETING)
        assert [(s.from_org_id, s.to_org_id) for s in signals] == [(ORG_A, ORG_B)]

    def test_send_requires_subject_and_body(self, client, mailbox):
        _seed_review(client)
        assert _send(client, "  ", "본문").status_code == 422
        assert _send(client, "제목", "   ").status_code == 422
        assert mailbox.sent == []

    def test_send_requires_participant(self, client):
        _seed_review(client)
        assert _send(client, "제목", "본문", org=ORG_C).status_code == 403

    def test_send_blocked_on_noshow(self, client, mailbox):
        _seed_review(client, noshow=True)
        assert _send(client, "제목", "본문").status_code == 409
        assert mailbox.sent == []

    def test_send_fails_loudly_when_no_recipient_email(self, client, mailbox):
        """수신 주소가 없으면 '보냈다'고 말하지 않는다 — 조용한 무발송 금지."""
        _seed_review(client)
        app.dependency_overrides[get_org_directory] = lambda: StaticOrgDirectory(
            names={ORG_B: "VinaContent"}, emails={ORG_B: []}
        )
        resp = _send(client, "제목", "본문")
        assert resp.status_code == 422
        assert "담당자 이메일" in resp.json()["detail"]
        assert mailbox.sent == []


# =============================================================================
# 중복 발송 차단
# =============================================================================
class TestDuplicateGuard:
    def test_second_send_is_blocked(self, client, mailbox):
        _seed_review(client)
        d = _draft(client).json()
        assert _send(client, d["subject"], d["body"]).status_code == 200

        again = _send(client, d["subject"], d["body"])
        assert again.status_code == 409
        assert len(mailbox.sent) == 1  # 두 번 나가지 않았다

    def test_draft_blocked_after_send(self, client):
        """이미 보냈으면 초안도 다시 만들지 않는다(불필요한 AI 호출·오해 방지)."""
        _seed_review(client)
        d = _draft(client).json()
        _send(client, d["subject"], d["body"])
        assert _draft(client).status_code == 409

    def test_existing_signal_row_does_not_count_as_sent(self, client, mailbox, repo):
        """신호만 있는 love_calls 행(메일 본문·발송시각 없음)은 그것만으로 발송됨 취급하면 안 된다.

        (예전엔 Step1의 껍데기 Love Call 토글이 이런 신호-only 행을 만들었다 — 그 토글은 삭제됐지만
        "신호 행이 있다" != "메일을 보냈다"는 불변식은 여전히 지켜야 한다. 그래서 여기선 그 행을
        토글이 아니라 리포지토리에 직접 만들어 같은 상황을 재현한다.)
        """
        from app.domain.love_call_signal import LoveCall

        _seed_review(client)
        repo.add_love_call(LoveCall(meeting_id=MEETING, from_org_id=ORG_A, to_org_id=ORG_B))
        state = client.get(f"/meetings/{MEETING}/love-call/mail", headers=_h(ORG_A)).json()
        assert state["sent"] is False

        d = _draft(client).json()
        assert _send(client, d["subject"], d["body"]).status_code == 200
        assert len(mailbox.sent) == 1


# =============================================================================
# 발송 실패 — 사용자에게 보이고, 기록되지 않아 재시도 가능
# =============================================================================
class TestSendFailureIsVisible:
    def test_send_failure_surfaces_as_error(self, client, caplog, monkeypatch):
        """실패는 숨기지 않되(502) 화면에는 고정 문구만 — SMTP 오류 본문에는 수신자 주소·서버 응답이 섞여 나온다.
        원인은 서버 로그에 그대로 남는다."""

        class _RecipientLeakingSender:
            def send(self, message):
                raise RuntimeError(f"SMTPRecipientsRefused: {message.to} — 550 5.1.1 user unknown")

        # 앞선 테스트의 마이그레이션(fileConfig)이 app.* 로거를 꺼 둘 수 있다 — 이 테스트 동안만 다시 켠다.
        monkeypatch.setattr(logging.getLogger("app.api.love_call"), "disabled", False)
        caplog.set_level(logging.ERROR, logger="app.api.love_call")
        _seed_review(client)
        app.dependency_overrides[get_email_sender] = lambda: _RecipientLeakingSender()
        resp = _send(client, "제목", "본문")

        assert resp.status_code == 502
        assert resp.json()["detail"] == "메일 발송에 실패했어요. 잠시 후 다시 시도해 주세요."
        for leaked in (*BUYER_EMAILS, "SMTPRecipientsRefused", "550"):
            assert leaked not in resp.text
        assert any(
            r.exc_info and "SMTPRecipientsRefused" in str(r.exc_info[1]) for r in caplog.records
        ), "원인 예외가 서버 로그에 남지 않았다"

    def test_failed_send_is_not_recorded_and_can_be_retried(self, client, repo, mailbox):
        _seed_review(client)
        app.dependency_overrides[get_email_sender] = lambda: FailingEmailSender()
        _send(client, "제목", "본문")

        record = repo.get_love_call(MEETING, ORG_A, ORG_B)
        assert record is None or record.email_sent is False  # 실패는 '보냄'으로 남지 않는다

        # 복구 후 재시도가 막히지 않는다.
        app.dependency_overrides[get_email_sender] = lambda: mailbox
        assert _send(client, "제목", "본문").status_code == 200
        assert len(mailbox.sent) == 1


# =============================================================================
# 상태 조회 — 이미 보낸 미팅이면 화면에 그 사실이 보인다
# =============================================================================
class TestState:
    def test_state_before_send(self, client):
        _seed_review(client)
        state = client.get(f"/meetings/{MEETING}/love-call/mail", headers=_h(ORG_A)).json()
        assert state["sent"] is False
        assert state["sent_at"] is None
        assert state["report_ready"] is True
        assert state["recipient_org_name"] == "VinaContent"
        assert state["recipient_count"] == len(BUYER_EMAILS)

    def test_state_without_report_is_not_ready(self, client):
        state = client.get(f"/meetings/{MEETING}/love-call/mail", headers=_h(ORG_A)).json()
        assert state["report_ready"] is False

    def test_state_after_send_shows_what_was_sent(self, client):
        _seed_review(client)
        d = _draft(client).json()
        _send(client, d["subject"], d["body"])

        state = client.get(f"/meetings/{MEETING}/love-call/mail", headers=_h(ORG_A)).json()
        assert state["sent"] is True
        assert state["sent_at"] is not None
        assert state["subject"] == d["subject"]
        assert state["body"] == d["body"]

    def test_state_requires_participant(self, client):
        assert client.get(
            f"/meetings/{MEETING}/love-call/mail", headers=_h(ORG_C)
        ).status_code == 403


# =============================================================================
# 화면 로케일(?locale=en) — 화면에 띄우는 값만 바뀌고, 상대에게 가는 메일 내용은 그대로다
# =============================================================================
class TestLocale:
    @pytest.fixture
    def directory(self) -> StaticOrgDirectory:
        """받는 쪽(바이어)만 영문명이 있다 — 보내는 쪽은 en에서도 국문명으로 내려가야 한다."""
        return StaticOrgDirectory(
            names={ORG_A: "누리스튜디오", ORG_B: "비나콘텐츠"},
            names_en={ORG_B: "VinaContent"},
            emails={ORG_A: ["exh@example.com"], ORG_B: list(BUYER_EMAILS)},
        )

    def _state(self, client, org=ORG_A, **params):
        return client.get(f"/meetings/{MEETING}/love-call/mail", headers=_h(org), params=params)

    def _draft(self, client, org=ORG_A, **params):
        return client.post(
            f"/meetings/{MEETING}/love-call/mail/draft", headers=_h(org), params=params
        )

    def _send(self, client, subject: str, body: str, org=ORG_A, **params):
        return client.post(
            f"/meetings/{MEETING}/love-call/mail/send",
            json={"subject": subject, "body": body},
            headers=_h(org),
            params=params,
        )

    def test_state_recipient_name_follows_locale(self, client):
        _seed_review(client)

        assert self._state(client).json()["recipient_org_name"] == "비나콘텐츠"
        assert self._state(client, locale="en").json()["recipient_org_name"] == "VinaContent"
        # 모르는 값은 422가 아니라 ko로 수렴한다.
        assert self._state(client, locale="ja").json()["recipient_org_name"] == "비나콘텐츠"

    def test_draft_display_name_follows_locale_but_mail_content_does_not(self, client):
        """보는 사람의 화면 언어가 상대에게 가는 편지를 바꾸면 안 된다 — 제목·본문은 로케일과 무관하다."""
        _seed_review(client)

        korean = self._draft(client).json()
        english = self._draft(client, locale="en").json()

        assert korean["recipient_org_name"] == "비나콘텐츠"
        assert english["recipient_org_name"] == "VinaContent"
        assert english["subject"] == korean["subject"]
        assert english["body"] == korean["body"]
        assert english["error"] is None

    def test_draft_without_report_explains_in_english(self, client):
        body = self._draft(client, locale="en").json()

        assert body["ai_generated"] is False
        assert body["error"] == (
            "There are no finalized meeting notes, so AI can't write a draft. Please write it yourself."
        )
        assert body["recipient_org_name"] == "VinaContent"

    def test_ai_failure_reason_is_shown_only_in_korean(self, client):
        """어댑터의 실패 사유는 한국어 문구다 — en 화면에는 일반 실패 문구만 낸다(원인은 로그)."""
        _seed_review(client)
        app.dependency_overrides[get_love_call_drafter] = lambda: FailingDrafter()

        assert "insufficient_quota" in self._draft(client).json()["error"]
        english = self._draft(client, locale="en").json()
        assert english["ai_generated"] is False
        assert english["error"] == (
            "AI couldn't create the draft. Try again shortly or write it yourself."
        )

    def test_rejections_are_localized(self, client, mailbox):
        _seed_review(client)

        assert self._state(client, org=ORG_C, locale="en").json()["detail"] == (
            "You aren't a participant in this meeting"
        )
        assert client.get(
            "/meetings/no-such-meeting/love-call/mail", headers=_h(ORG_A), params={"locale": "en"}
        ).json()["detail"] == "Meeting not found"
        assert self._send(client, "  ", "body", locale="en").json()["detail"] == (
            "Enter both a subject and a message"
        )

        # 발송 뒤에는 초안·재발송 모두 '이미 보냈다'로 거절된다.
        assert self._send(client, "Subject", "Body", locale="en").status_code == 200
        again = self._send(client, "Subject", "Body", locale="en")
        assert again.status_code == 409
        assert again.json()["detail"] == "A Love Call email has already been sent for this meeting"
        assert len(mailbox.sent) == 1

    def test_noshow_rejection_is_localized(self, client):
        _seed_review(client, noshow=True)

        resp = self._draft(client, locale="en")

        assert resp.status_code == 409
        assert resp.json()["detail"] == (
            "A Love Call email can't be sent for a meeting the other party didn't attend"
        )

    def test_no_recipient_rejection_names_the_company_in_english(self, client, mailbox):
        _seed_review(client)
        app.dependency_overrides[get_org_directory] = lambda: StaticOrgDirectory(
            names={ORG_B: "비나콘텐츠"}, names_en={ORG_B: "VinaContent"}, emails={ORG_B: []}
        )

        resp = self._send(client, "Subject", "Body", locale="en")

        assert resp.status_code == 422
        assert resp.json()["detail"] == (
            "VinaContent has no registered contact email, so this can't be sent"
        )
        assert mailbox.sent == []

    def test_send_failure_is_localized_and_still_leaks_nothing(self, client):
        _seed_review(client)
        app.dependency_overrides[get_email_sender] = lambda: FailingEmailSender()

        resp = self._send(client, "Subject", "Body", locale="en")

        assert resp.status_code == 502
        assert resp.json()["detail"] == "The email couldn't be sent. Please try again shortly."
        assert "SMTPAuthenticationError" not in resp.text

    def test_send_result_names_the_recipient_in_english(self, client, mailbox):
        """발송 결과 화면의 기업명은 en이고, 나간 메일은 사용자가 편집한 그대로다."""
        _seed_review(client)

        resp = self._send(client, "Subject", "본문은 그대로 나간다.", locale="en")

        assert resp.status_code == 200
        assert resp.json()["recipient_org_name"] == "VinaContent"
        assert mailbox.sent[0].body == "본문은 그대로 나간다."


class TestAuth:
    def test_forged_org_header_rejected_without_session(self, repo, mailbox, directory):
        """실 인증 경로에서는 헤더만으로 통과하지 못한다(리뷰 API 와 같은 회귀 잠금)."""
        app.dependency_overrides[get_repository] = lambda: repo
        app.dependency_overrides[get_love_call_drafter] = lambda: FakeLoveCallMailDrafter()
        app.dependency_overrides[get_email_sender] = lambda: mailbox
        app.dependency_overrides[get_org_directory] = lambda: directory
        try:
            with TestClient(app) as unauthenticated:
                for method, path, payload in (
                    ("get", f"/meetings/{MEETING}/love-call/mail", None),
                    ("post", f"/meetings/{MEETING}/love-call/mail/draft", None),
                    (
                        "post",
                        f"/meetings/{MEETING}/love-call/mail/send",
                        {"subject": "s", "body": "b"},
                    ),
                ):
                    resp = getattr(unauthenticated, method)(
                        path, headers=_h(ORG_A), **({"json": payload} if payload else {})
                    )
                    assert resp.status_code == 401, f"{method.upper()} {path} 가 헤더 위조를 통과했다"
        finally:
            app.dependency_overrides.clear()


# =============================================================================
# 초안 생성기 단위 — 어댑터 계약
# =============================================================================
class TestDrafterUnit:
    def test_fake_drafter_refuses_empty_report(self):
        ctx = LoveCallContext(
            sender_org_name="A", sender_role="참가사", recipient_org_name="B", recipient_role="바이어"
        )
        with pytest.raises(LoveCallMailError):
            FakeLoveCallMailDrafter().draft(ctx)

    def test_compose_body_keeps_single_language_when_other_is_empty(self):
        assert compose_body("한국어만", "") == "한국어만"
        assert compose_body("", "English only") == "English only"

    def test_compose_body_joins_both_with_divider(self):
        joined = compose_body("한국어", "English")
        assert "한국어" in joined and "English" in joined
        assert joined.index("한국어") < joined.index("English")

    def test_state_keeps_recipient_count_from_send_time(self, client, repo):
        """발송 후 멤버가 늘어도 화면 숫자는 발송 당시 사실로 고정된다."""
        _seed_review(client)
        d = _draft(client).json()
        _send(client, d["subject"], d["body"])

        # 발송 뒤 상대 기업에 담당자가 한 명 더 생긴 상황.
        app.dependency_overrides[get_org_directory] = lambda: StaticOrgDirectory(
            names={ORG_A: "누리스튜디오", ORG_B: "VinaContent"},
            emails={ORG_B: [*BUYER_EMAILS, "new.hire@example.com"]},
        )
        state = client.get(f"/meetings/{MEETING}/love-call/mail", headers=_h(ORG_A)).json()
        assert state["recipient_count"] == len(BUYER_EMAILS)


# =============================================================================
# 행사 설정 "참가사·바이어 알림 메일"(participant_email_enabled) — 꺼진 행사에서는 러브콜 메일도 나가지 않는다
#
# 2026-10-16 발주사 요구 "참가기업·바이어에게 어떠한 메일도 가지 않게": 운영 담당자가 참가자 계정으로 대신
# 작업하다 '보내기'를 누를 수 있다. 꺼짐·켜짐은 실 DB의 행사 설정 행으로 만든다(InMemory 미팅이 그 행사를 가리킨다).
# =============================================================================
MEETING_OFF = "meeting-mail-off"  # 스위치를 끈 행사
MEETING_ON = "meeting-mail-on"  # 스위치를 켠 행사
MEETING_BARE = "meeting-mail-bare"  # 설정 행이 없는 행사(기본값 = 꺼짐)
DISABLED_KO = "이 행사는 메일 발송이 꺼져 있어 러브콜 메일을 보낼 수 없습니다."
DISABLED_EN = "Email is turned off for this event, so a Love Call email can't be sent."


class TestEventEmailSwitch:
    @pytest.fixture
    def switch_factory(self, migrated_db):
        """세 행사(꺼짐·켜짐·설정 행 없음)를 실 DB에 만들고 (세션 팩토리, {미팅 id: 행사 id})를 준다."""
        import uuid

        from sqlalchemy import create_engine
        from sqlalchemy.orm import sessionmaker

        from app.models import Event
        from tests.conftest import set_participant_email

        engine = create_engine(migrated_db, future=True)
        factory = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)
        db = factory()
        try:
            suffix = uuid.uuid4().hex[:8]
            off = Event(name="메일 꺼진 행사", slug=f"love-call-off-{suffix}")
            on = Event(name="메일 켠 행사", slug=f"love-call-on-{suffix}")
            bare = Event(name="설정 없는 행사", slug=f"love-call-bare-{suffix}")
            db.add_all([off, on, bare])
            db.commit()
            event_ids = {
                MEETING_OFF: str(off.id),
                MEETING_ON: str(on.id),
                MEETING_BARE: str(bare.id),
            }
            set_participant_email(db, event_ids[MEETING_OFF], False)
            set_participant_email(db, event_ids[MEETING_ON], True)
        finally:
            db.close()
        yield factory, event_ids
        engine.dispose()

    @pytest.fixture
    def switch_repo(self, switch_factory) -> InMemoryRepository:
        _, event_ids = switch_factory
        r = InMemoryRepository()
        for meeting_id, event_id in event_ids.items():
            r.add_meeting(
                MeetingView(
                    meeting_id=meeting_id,
                    event_id=event_id,
                    exhibitor_org_id=ORG_A,
                    buyer_org_id=ORG_B,
                    matching_type=MatchingType.AI,
                    ai_score=0.9,
                    ai_score_reasons=["제품 적합성"],
                )
            )
        return r

    @pytest.fixture
    def switch_app(self, switch_factory, switch_repo, mailbox, directory):
        """스위치를 실제로 읽는 앱(``participant_email_forced_on`` 없음). 요청 세션은 격리 테스트 DB에 붙는다."""
        from app.db import get_session

        factory, _ = switch_factory

        def _session():
            s = factory()
            try:
                yield s
            finally:
                s.close()

        app.dependency_overrides[get_repository] = lambda: switch_repo
        app.dependency_overrides[get_love_call_drafter] = lambda: FakeLoveCallMailDrafter()
        app.dependency_overrides[get_email_sender] = lambda: mailbox
        app.dependency_overrides[get_org_directory] = lambda: directory
        app.dependency_overrides[get_current_principal] = header_principal
        app.dependency_overrides[get_session] = _session
        yield app
        app.dependency_overrides.clear()

    @staticmethod
    def _send(
        client,
        meeting_id: str,
        subject: str = "[Sales AI] 러브콜",
        body: str = "직접 쓴 제안 본문입니다.",
        org: str = ORG_A,
        **params,
    ):
        return client.post(
            f"/meetings/{meeting_id}/love-call/mail/send",
            json={"subject": subject, "body": body},
            headers=_h(org),
            params=params,
        )

    @staticmethod
    def _state(client, meeting_id: str, org: str = ORG_A):
        return client.get(f"/meetings/{meeting_id}/love-call/mail", headers=_h(org))

    def test_switch_off_refuses_with_409_and_sends_nothing(self, switch_app, switch_repo, mailbox):
        client = TestClient(switch_app)

        resp = self._send(client, MEETING_OFF)

        assert resp.status_code == 409, resp.text
        assert resp.json()["detail"] == {"code": "PARTICIPANT_EMAIL_DISABLED", "message": DISABLED_KO}
        assert mailbox.sent == []  # 메일 0통
        # 발송 기록도, 공개 신호 행도 남지 않는다 — 켠 뒤 그대로 다시 보낼 수 있다.
        assert switch_repo.get_love_call(MEETING_OFF, ORG_A, ORG_B) is None
        assert switch_repo.list_love_calls(MEETING_OFF) == []
        state = self._state(client, MEETING_OFF).json()
        assert state["sent"] is False
        assert state["participant_email_enabled"] is False

    def test_refusal_message_follows_locale(self, switch_app, mailbox):
        resp = self._send(TestClient(switch_app), MEETING_OFF, locale="en")

        assert resp.status_code == 409
        assert resp.json()["detail"] == {"code": "PARTICIPANT_EMAIL_DISABLED", "message": DISABLED_EN}
        assert mailbox.sent == []

    def test_event_without_settings_row_is_off_by_default(self, switch_app, switch_repo, mailbox):
        client = TestClient(switch_app)

        resp = self._send(client, MEETING_BARE)

        assert resp.status_code == 409
        assert resp.json()["detail"]["code"] == "PARTICIPANT_EMAIL_DISABLED"
        assert mailbox.sent == []
        assert switch_repo.get_love_call(MEETING_BARE, ORG_A, ORG_B) is None
        assert self._state(client, MEETING_BARE).json()["participant_email_enabled"] is False

    def test_switch_on_sends_as_before(self, switch_app, switch_repo, mailbox):
        client = TestClient(switch_app)

        resp = self._send(client, MEETING_ON)

        assert resp.status_code == 200, resp.text
        assert resp.json()["sent"] is True
        assert resp.json()["participant_email_enabled"] is True
        assert [m.to for m in mailbox.sent] == [BUYER_EMAILS]
        assert mailbox.sent[0].subject == "[Sales AI] 러브콜"
        assert mailbox.sent[0].body == "직접 쓴 제안 본문입니다."
        record = switch_repo.get_love_call(MEETING_ON, ORG_A, ORG_B)
        assert record is not None and record.email_sent is True
        assert record.email_recipient_count == len(BUYER_EMAILS)
        assert self._state(client, MEETING_ON).json()["participant_email_enabled"] is True

    def test_each_event_follows_its_own_switch(self, switch_app, switch_repo, mailbox):
        """같은 기업이라도 미팅이 속한 행사의 스위치를 따른다 — 다른 행사의 값에 끌려가지 않는다."""
        client = TestClient(switch_app)

        assert self._send(client, MEETING_OFF).status_code == 409
        assert self._send(client, MEETING_ON).status_code == 200
        assert self._send(client, MEETING_BARE).status_code == 409

        assert [m.to for m in mailbox.sent] == [BUYER_EMAILS]  # 켠 행사의 한 통만
        assert switch_repo.get_love_call(MEETING_OFF, ORG_A, ORG_B) is None
        assert switch_repo.get_love_call(MEETING_BARE, ORG_A, ORG_B) is None

    def test_broken_smtp_config_still_gives_409_when_off(self, switch_app, mailbox, monkeypatch):
        """sender는 스위치를 본 뒤에 만든다 — SMTP 설정이 깨져 있어도(생성 실패) 꺼진 행사는 500이 아니라 409다.

        켜진 행사는 예전처럼 sender 생성 실패가 그대로 올라간다(500) — 그쪽 동작은 바꾸지 않았다.
        """
        from app.config import settings as app_settings

        monkeypatch.setattr(app_settings, "email_backend", "smtp")
        monkeypatch.setattr(app_settings, "smtp_host", None)
        monkeypatch.setattr(app_settings, "smtp_from", None)
        # 진짜 get_email_sender(= build_email_sender → SmtpEmailSender 생성 실패)를 타게 override를 뺀다.
        app.dependency_overrides.pop(get_email_sender)
        client = TestClient(switch_app, raise_server_exceptions=False)

        off = self._send(client, MEETING_OFF)
        assert off.status_code == 409, off.text
        assert off.json()["detail"]["code"] == "PARTICIPANT_EMAIL_DISABLED"

        on = self._send(client, MEETING_ON)
        assert on.status_code == 500
        assert mailbox.sent == []

    def test_other_rejections_keep_their_answer_when_off(self, switch_app, switch_repo, mailbox):
        """꺼진 행사에서도 404·403·422(제목/본문)·409(이미 보냄·상대 불참)는 예전 그대로다 — 스위치는 그 뒤에 본다."""
        from datetime import datetime, timezone

        client = TestClient(switch_app)

        missing = self._send(client, "no-such-meeting")
        assert missing.status_code == 404
        assert missing.json()["detail"] == "미팅 없음"
        assert self._send(client, MEETING_OFF, org=ORG_C).status_code == 403
        assert self._send(client, MEETING_OFF, subject="  ").status_code == 422
        assert self._send(client, MEETING_OFF, body="  ").status_code == 422

        # 스위치를 끄기 전에 이미 보낸 미팅 — '이미 보냈다'가 먼저다.
        switch_repo.record_love_call_email(
            MEETING_OFF,
            ORG_A,
            ORG_B,
            subject="s",
            body="b",
            recipient_count=2,
            sent_at=datetime.now(timezone.utc),
        )
        already = self._send(client, MEETING_OFF)
        assert already.status_code == 409
        assert already.json()["detail"] == "이 미팅의 러브콜 메일은 이미 발송했습니다"

        # 상대 불참으로 기록된 미팅(설정 행 없는 행사) — 불참 거절이 먼저다.
        step1 = client.post(
            f"/meetings/{MEETING_BARE}/review/step1",
            json={"proceeded": "counterpart_noshow", "satisfaction": 3, "follow_up_intent": "yes"},
            headers=_h(ORG_A),
        )
        assert step1.status_code == 200, step1.text
        noshow = self._send(client, MEETING_BARE)
        assert noshow.status_code == 409
        assert noshow.json()["detail"] == "상대방 불참(noshow) 미팅에는 러브콜 메일을 보낼 수 없습니다"

        assert mailbox.sent == []

    def test_no_recipient_rejection_comes_before_the_switch(self, switch_app, mailbox):
        app.dependency_overrides[get_org_directory] = lambda: StaticOrgDirectory(
            names={ORG_B: "VinaContent"}, emails={ORG_B: []}
        )

        resp = self._send(TestClient(switch_app), MEETING_OFF)

        assert resp.status_code == 422
        assert "담당자 이메일" in resp.json()["detail"]
        assert mailbox.sent == []

    def test_state_and_ai_draft_stay_open_when_off(self, switch_app, mailbox):
        """메일을 보내지 않는 기능(상태 조회·AI 초안)은 꺼진 행사에서도 그대로다 — 초안을 보고 복사할 수 있다."""
        client = TestClient(switch_app)

        state = self._state(client, MEETING_OFF)
        assert state.status_code == 200
        assert state.json()["participant_email_enabled"] is False

        draft = client.post(f"/meetings/{MEETING_OFF}/love-call/mail/draft", headers=_h(ORG_A))
        assert draft.status_code == 200
        assert draft.json()["recipient_count"] == len(BUYER_EMAILS)
        assert mailbox.sent == []
