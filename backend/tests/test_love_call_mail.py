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
    """제목 접두 `[{brand}]`가 settings.email_brand_name을 따라가는지(기본값 NABI 보존)."""

    def _ctx(self) -> LoveCallContext:
        return LoveCallContext(
            sender_org_name="VinaContent",
            sender_role="참가사",
            recipient_org_name="한화",
            recipient_role="바이어",
        )

    def test_default_brand_name_prefix_is_nabi(self):
        subject = fallback_subject(self._ctx())
        assert subject.startswith("[NABI]")

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
def client(repo, mailbox, directory) -> TestClient:
    # 외부 어댑터는 전부 fake 로 고정 — 개발자 로컬 .env(실 openai/smtp 토글)가 테스트로 새어
    # 들어가 실제 API 를 때리거나 메일을 발송하지 않게 한다.
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
    def test_send_failure_surfaces_as_error(self, client):
        _seed_review(client)
        app.dependency_overrides[get_email_sender] = lambda: FailingEmailSender()
        resp = _send(client, "제목", "본문")

        assert resp.status_code == 502
        assert "SMTPAuthenticationError" in resp.json()["detail"]

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
