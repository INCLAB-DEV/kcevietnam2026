"""미팅 리뷰 API 테스트 — 외부 동작(FastAPI 응답 계약)으로 검증.

핵심 AC:
- 진행됨만 Step2, noshow 미도달
- 상대 응답에 Follow-up Intent·Fit·만족도·전사 절대 비노출(노출 규칙)
- 내보내기 PDF/DOCX 생성, 비공개 부재
- 권한: 참석자만, 인증 필수
"""

import time

import pytest
from fastapi.testclient import TestClient

from app.api.deps import (
    get_audio_preprocessor,
    get_job_store,
    get_repository,
    get_storage,
    get_structurer,
    get_transcriber,
)
from app.auth.principal import get_current_principal
from app.domain.review_provenance_binding import MatchingType
from app.main import app
from app.repositories.base import MeetingView
from app.repositories.memory import InMemoryRepository
from app.services.audio_preprocessing import PassthroughAudioPreprocessor
from app.services.storage import FakeStorage
from app.services.structuring import FakeStructurer
from app.services.transcription import FakeTranscriber
from app.services.transcription_jobs import InMemoryTranscriptionJobStore
from tests.conftest import header_principal

ORG_A = "org-exhibitor"  # 참가사 (리뷰어)
ORG_B = "org-buyer"  # 바이어 (상대)
ORG_C = "org-outsider"  # 비참석자
MEETING = "meeting-1"


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
def job_store() -> InMemoryTranscriptionJobStore:
    return InMemoryTranscriptionJobStore()


@pytest.fixture
def client(repo: InMemoryRepository, job_store: InMemoryTranscriptionJobStore) -> TestClient:
    # 어댑터를 fake 로 고정 — 개발자 로컬 .env(실 openai 토글)가 테스트로 새어들어
    # 외부 API 를 때리지 않게 한다(결정적·오프라인). 실 어댑터는 별도 통합테스트에서만.
    app.dependency_overrides[get_repository] = lambda: repo
    app.dependency_overrides[get_transcriber] = lambda: FakeTranscriber()
    app.dependency_overrides[get_structurer] = lambda: FakeStructurer()
    app.dependency_overrides[get_storage] = lambda: FakeStorage()
    # 업로드는 가짜 오디오 바이트라 ffmpeg 변환 대신 원본을 조각 하나로 넘기는 대역을 쓴다.
    app.dependency_overrides[get_audio_preprocessor] = lambda: PassthroughAudioPreprocessor()
    # job_store 도 fake 로 고정(단일 인스턴스를 재사용 — POST 접수와 GET 폴링이 매 요청 새
    # 인스턴스를 받으면 서로 다른 저장소를 보게 된다). repo(InMemoryRepository)의
    # meeting_id/org_id 는 UUID가 아닌 fixture 문자열이라(예: "meeting-1"), DB 백엔드
    # 기본(SqlTranscriptionJobStore)을 그대로 두면 FK 제약(transcription_jobs.meeting_id →
    # meetings.id)에 걸려 500이 난다.
    app.dependency_overrides[get_job_store] = lambda: job_store
    # 인증은 override로 고정한다 — 이 파일이 검사하는 건 리뷰 노출 규칙이지 인증 방식이 아니다.
    # (헤더만으로는 통과하지 못한다는 사실은 아래 test_forged_org_header_rejected가 지킨다.)
    app.dependency_overrides[get_current_principal] = header_principal
    yield TestClient(app)
    app.dependency_overrides.clear()


def _h(org: str) -> dict:
    """테스트 주체 지정 — override된 principal 의존성이 이 헤더를 읽는다(실 인증 경로 아님)."""
    return {"X-Org-Id": org}


class TestAuth:
    def test_unauthenticated_401(self, client):
        resp = client.post(f"/meetings/{MEETING}/review/step1", json={"proceeded": "proceeded"})
        assert resp.status_code == 401

    def test_non_participant_403(self, client):
        resp = client.post(
            f"/meetings/{MEETING}/review/step1",
            json={"proceeded": "proceeded"},
            headers=_h(ORG_C),
        )
        assert resp.status_code == 403

    def test_unknown_meeting_404(self, client):
        resp = client.post(
            "/meetings/nope/review/step1", json={"proceeded": "proceeded"}, headers=_h(ORG_A)
        )
        assert resp.status_code == 404

    def test_forged_org_header_rejected(self, repo):
        """``X-Org-Id`` 위조만으로는 남의 회의록에 닿을 수 없다(인증 이관 회귀 방지).

        이 슬라이스는 한때 그 헤더를 그대로 믿었다 — 임의 org로 가장해 상대 기업의 비공개
        평가(follow_up_intent·fit_*)를 열람할 수 있었다. 지금은 서명된 세션(Principal)에서만
        org가 나오므로, 헤더만 실은 요청은 **당사자 org를 정확히 맞혀도** 401이어야 한다.

        ⚠ 다른 테스트와 달리 principal override를 **끼우지 않는다** — 실 인증 경로를 태워야
        위조가 막히는지 알 수 있다.
        """
        app.dependency_overrides[get_repository] = lambda: repo
        try:
            unauthenticated = TestClient(app)
            for method, path in (
                ("post", f"/meetings/{MEETING}/review/step1"),
                ("get", f"/meetings/{MEETING}/review"),
                ("get", f"/meetings/{MEETING}/review/counterpart"),
                ("get", f"/meetings/{MEETING}/review/export"),
            ):
                resp = getattr(unauthenticated, method)(
                    path, headers=_h(ORG_A), **({"json": {"proceeded": "proceeded"}} if method == "post" else {})
                )
                assert resp.status_code == 401, f"{method.upper()} {path} 가 헤더 위조를 통과했다"
        finally:
            app.dependency_overrides.clear()


class TestStep1AndNoshow:
    def test_proceeded_saves_intake(self, client):
        resp = client.post(
            f"/meetings/{MEETING}/review/step1",
            json={
                "proceeded": "proceeded",
                "satisfaction": 5,
                "follow_up_intent": "yes",
                "love_call": False,
            },
            headers=_h(ORG_A),
        )
        assert resp.status_code == 200
        review = resp.json()["review"]
        assert review["is_noshow"] is False
        assert review["satisfaction"] == 5
        assert review["follow_up_intent"] == "yes"

    def test_counterpart_noshow_skips_followups(self, client):
        resp = client.post(
            f"/meetings/{MEETING}/review/step1",
            json={
                "proceeded": "counterpart_noshow",
                "satisfaction": 5,
                "follow_up_intent": "yes",
                "love_call": True,
            },
            headers=_h(ORG_A),
        )
        review = resp.json()["review"]
        assert review["is_noshow"] is True
        assert review["counterpart_noshow"] is True
        assert review["satisfaction"] is None
        assert review["follow_up_intent"] is None
        assert review["love_call"] is False

    def test_step2_blocked_on_noshow(self, client):
        client.post(
            f"/meetings/{MEETING}/review/step1",
            json={"proceeded": "counterpart_noshow"},
            headers=_h(ORG_A),
        )
        resp = client.post(
            f"/meetings/{MEETING}/review/step2",
            json={"report": {"discussion": ["x"], "agreements": [], "actions": []}},
            headers=_h(ORG_A),
        )
        assert resp.status_code == 409

    def test_step2_requires_step1(self, client):
        resp = client.post(
            f"/meetings/{MEETING}/review/step2",
            json={"report": {"discussion": ["x"], "agreements": [], "actions": []}},
            headers=_h(ORG_A),
        )
        assert resp.status_code == 409


class TestStep2Structure:
    def test_text_structuring_returns_draft(self, client):
        resp = client.post(
            f"/meetings/{MEETING}/review/step2/structure",
            json={"text": "사거리 연장 논의\n기술제안서 송부 합의\n8월말 회신 예정"},
            headers=_h(ORG_A),
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["report"]["discussion"]
        assert body["fit_suggestion"] in ("good", "normal", "bad")
        assert "transcript" in body

    def test_draft_carries_speaker_labeled_turns(self, client):
        # #97 — 구조화 초안에 화자별(us/them) 전사 turns 가 동봉된다(AI 추정).
        resp = client.post(
            f"/meetings/{MEETING}/review/step2/structure",
            json={"text": "사거리 연장 논의\n기술제안서 송부 합의\n8월말 회신 예정"},
            headers=_h(ORG_A),
        )
        turns = resp.json()["transcript_turns"]
        assert turns and all(t["who"] in ("us", "them") and t["text"] for t in turns)

    def _submit_transcribe(self, client, org=ORG_A):
        # 녹음 전사는 비동기 접수(202) → 작업은 전사 전용 풀 스레드에서 응답과 독립적으로 돈다(예전
        # BackgroundTask처럼 TestClient가 응답 직후 동기 실행해 주지 않는다). 이 클래스의 테스트들은
        # "끝난 작업"의 폴링 결과를 보므로, 접수 응답을 받은 뒤 작업이 끝날 때까지 기다린다(fake라 즉시).
        resp = client.post(
            f"/meetings/{MEETING}/review/step2/transcribe",
            files={"audio": ("meeting.m4a", b"\x00\x01fake-audio", "audio/m4a")},
            headers=_h(org),
        )
        assert resp.status_code == 202
        job = resp.json()
        self._wait_settled(client, job["job_id"], org)
        return job

    @staticmethod
    def _wait_settled(client, job_id, org, timeout=5.0):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            polled = client.get(
                f"/meetings/{MEETING}/review/step2/transcribe/{job_id}", headers=_h(org)
            ).json()
            if polled["status"] != "pending":
                return
            time.sleep(0.01)
        raise AssertionError("전사 작업이 제한 시간 안에 끝나지 않았다")

    def test_transcribe_accepts_job_and_completes_on_poll(self, client):
        job = self._submit_transcribe(client)
        assert job["status"] == "pending"
        assert job["job_id"]
        status_res = client.get(
            f"/meetings/{MEETING}/review/step2/transcribe/{job['job_id']}",
            headers=_h(ORG_A),
        ).json()
        assert status_res["status"] == "done"
        assert "transcript" in status_res["draft"]

    def test_transcribe_job_carries_audio_key_and_text_path_does_not(self, client):
        # 녹음 경로 초안은 원본 보관용 audio_s3_key 를 담는다(저장 시 레코드에 기록).
        job = self._submit_transcribe(client)
        draft = client.get(
            f"/meetings/{MEETING}/review/step2/transcribe/{job['job_id']}",
            headers=_h(ORG_A),
        ).json()["draft"]
        assert draft["audio_s3_key"]
        # 텍스트 폴백 경로는 녹음이 없으므로 키가 없다(동기 그대로).
        text = client.post(
            f"/meetings/{MEETING}/review/step2/structure",
            json={"text": "메모만 있음"},
            headers=_h(ORG_A),
        ).json()
        assert text["audio_s3_key"] is None

    def test_transcribe_status_404_for_unknown_job(self, client):
        resp = client.get(
            f"/meetings/{MEETING}/review/step2/transcribe/does-not-exist",
            headers=_h(ORG_A),
        )
        assert resp.status_code == 404

    def test_transcribe_status_hidden_from_counterpart(self, client):
        # 본인이 접수한 작업만 폴링 가능 — 상대 org 는 404(작업 격리).
        job = self._submit_transcribe(client, org=ORG_A)
        resp = client.get(
            f"/meetings/{MEETING}/review/step2/transcribe/{job['job_id']}",
            headers=_h(ORG_B),
        )
        assert resp.status_code == 404


class TestStep2SaveAndExposure:
    def _do_step1(self, client, org=ORG_A):
        return client.post(
            f"/meetings/{MEETING}/review/step1",
            json={"proceeded": "proceeded", "satisfaction": 4, "follow_up_intent": "reviewing"},
            headers=_h(org),
        )

    def _do_step2(self, client, org=ORG_A):
        return client.post(
            f"/meetings/{MEETING}/review/step2",
            json={
                "report": {
                    "discussion": ["155mm 사거리 60km 연장 요구"],
                    "agreements": ["8월 중순 기술제안서 송부"],
                    "actions": ["8월말 소요검토 회신"],
                },
                "fit_rating": "good",
                "fit_reason": "기술 성숙도 높음",
                "fit_reason_tags": ["기술 성숙도"],
                "finalize": True,
            },
            headers=_h(org),
        )

    def test_finalize_saves_report_and_fit(self, client):
        self._do_step1(client)
        resp = self._do_step2(client)
        assert resp.status_code == 200
        review = resp.json()["review"]
        assert review["report_confirmed"] is True
        assert review["fit_rating"] == "good"
        assert review["report_sections"]["actions"] == ["8월말 소요검토 회신"]

    def test_finalize_without_ai_structuring_or_transcription(self, client):
        # QA C1 회귀 잠금 — AI 정리(/step2/structure, /step2/transcribe)를 단 한 번도 부르지 않고
        # 직접 입력한 report 만으로 Step1→Step2 확정이 성공해야 한다(AI 는 보조 수단, 필수 관문 아님).
        self._do_step1(client)
        resp = self._do_step2(client)
        assert resp.status_code == 200
        assert resp.json()["review"]["report_confirmed"] is True

    def test_owner_sees_full_review(self, client):
        self._do_step1(client)
        self._do_step2(client)
        resp = client.get(f"/meetings/{MEETING}/review", headers=_h(ORG_A))
        review = resp.json()["review"]
        assert review["fit_rating"] == "good"
        assert review["follow_up_intent"] == "reviewing"

    def test_audio_key_persists_to_owner_record(self, client):
        # Step2 로 전달한 audio_s3_key 가 본인 레코드에 기록되어 본인 열람에 보인다.
        self._do_step1(client)
        key = "meetings/meeting-1/org-exhibitor/rec.m4a"
        client.post(
            f"/meetings/{MEETING}/review/step2",
            json={
                "report": {"discussion": ["x"], "agreements": [], "actions": []},
                "fit_rating": "good",
                "audio_s3_key": key,
                "finalize": True,
            },
            headers=_h(ORG_A),
        )
        review = client.get(f"/meetings/{MEETING}/review", headers=_h(ORG_A)).json()["review"]
        assert review["audio_s3_key"] == key

    def test_transcript_turns_persist_to_owner_record(self, client):
        # Step2 로 전달한 화자별 전사가 본인 레코드에 기록되어 본인 열람에 보인다(#97).
        self._do_step1(client)
        turns = [{"who": "us", "text": "사거리 60km 가능?"}, {"who": "them", "text": "MPF 신관으로 가능"}]
        client.post(
            f"/meetings/{MEETING}/review/step2",
            json={
                "report": {"discussion": ["x"], "agreements": [], "actions": []},
                "fit_rating": "good",
                "transcript_turns": turns,
                "finalize": True,
            },
            headers=_h(ORG_A),
        )
        review = client.get(f"/meetings/{MEETING}/review", headers=_h(ORG_A)).json()["review"]
        assert review["transcript_turns"] == turns

    def test_counterpart_never_sees_private(self, client):
        self._do_step1(client)
        self._do_step2(client)
        # ORG_B 가 ORG_A 의 리뷰를 상대 관점으로 조회.
        resp = client.get(f"/meetings/{MEETING}/review/counterpart", headers=_h(ORG_B))
        assert resp.status_code == 200
        body = resp.json()
        # 껍데기 Love Call 토글(Step1)은 삭제됐다 — 신호는 이제 러브콜 메일을 실제로 보내야만
        # 남는다(app.api.love_call). Step1만으로는 아무 신호도 생기지 않는다.
        assert body["love_call_received"] is False
        review = body["review"]
        for forbidden in (
            "fit_rating",
            "fit_reason",
            "fit_reason_tags",
            "follow_up_intent",
            "satisfaction",
            "transcript",
            "transcript_turns",
            "audio_s3_key",
            "counterpart_noshow",
        ):
            assert forbidden not in review, f"비공개 {forbidden} 노출됨"
        assert "report_sections" in review  # 보고 본문은 비공개 아님

class TestExport:
    def _prep(self, client):
        client.post(
            f"/meetings/{MEETING}/review/step1",
            json={"proceeded": "proceeded", "satisfaction": 4},
            headers=_h(ORG_A),
        )
        client.post(
            f"/meetings/{MEETING}/review/step2",
            json={
                "report": {"discussion": ["사거리 연장"], "agreements": ["제안서 송부"], "actions": ["회신"]},
                "fit_rating": "good",
                "fit_reason": "비공개 사유",
                "finalize": True,
            },
            headers=_h(ORG_A),
        )

    def test_export_pdf(self, client):
        self._prep(client)
        resp = client.get(f"/meetings/{MEETING}/review/export?fmt=pdf", headers=_h(ORG_A))
        assert resp.status_code == 200
        assert resp.headers["content-type"] == "application/pdf"
        assert resp.content[:4] == b"%PDF"

    def test_export_docx(self, client):
        self._prep(client)
        resp = client.get(f"/meetings/{MEETING}/review/export?fmt=docx", headers=_h(ORG_A))
        assert resp.status_code == 200
        assert resp.content[:2] == b"PK"

    def test_export_without_report_404(self, client):
        client.post(
            f"/meetings/{MEETING}/review/step1",
            json={"proceeded": "proceeded", "satisfaction": 4},
            headers=_h(ORG_A),
        )
        resp = client.get(f"/meetings/{MEETING}/review/export?fmt=pdf", headers=_h(ORG_A))
        assert resp.status_code == 404


# =============================================================================
# Task B — SQL 리포지토리 round-trip (실 Postgres). "내가 불참"이 counterpart_noshow만
# 보던 시절엔 저장 후 다시 읽으면 is_noshow=False로 되돌아갔다(회귀 버그) — self_noshow 컬럼을
# 추가한 뒤 그대로 왕복되는지 실 DB로 검증한다. InMemoryRepository는 이 버그가 애초에 없어서
# (StoredReview.is_noshow를 그대로 들고 있음) 여기서 못 잡는다 — 반드시 SqlAlchemyRepository다.
# =============================================================================
class TestSqlRepositorySelfNoshowRoundTrip:
    @pytest.fixture
    def sql_meeting(self, migrated_db, monkeypatch):
        """migrated_db(격리 Postgres)에 SqlAlchemyRepository가 실제로 쓰도록 SessionLocal을 갈아끼운다.

        app.repositories.sql은 ``from app.db import SessionLocal``로 이름을 복사해 왔으므로
        app.db.SessionLocal을 바꿔도 이 모듈은 그대로다 — sql 모듈의 바인딩 자체를 patch한다.
        """
        from sqlalchemy import create_engine
        from sqlalchemy.orm import sessionmaker

        import uuid

        from app.models import Event, Organization, Meeting
        from app.domain.review_provenance_binding import MatchingType

        engine = create_engine(migrated_db, future=True)
        TestSession = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)
        monkeypatch.setattr("app.repositories.sql.SessionLocal", TestSession)

        db = TestSession()
        try:
            # migrated_db는 세션 스코프(테스트 간 공유) — slug UNIQUE라 매 테스트 고유값이 필요하다.
            event = Event(name="DX Korea 2026", slug=f"sql-self-noshow-{uuid.uuid4().hex[:8]}")
            org_a = Organization(name_ko="참가사")
            org_b = Organization(name_ko="바이어")
            db.add_all([event, org_a, org_b])
            db.flush()
            meeting = Meeting(
                event_id=event.id,
                exhibitor_org_id=org_a.id,
                buyer_org_id=org_b.id,
                matching_type=MatchingType.AI.value,
            )
            db.add(meeting)
            db.commit()
            yield {"meeting_id": str(meeting.id), "org_a": str(org_a.id), "org_b": str(org_b.id)}
        finally:
            db.close()
            engine.dispose()

    @pytest.fixture
    def sql_client(self, sql_meeting):
        from app.repositories.sql import SqlAlchemyRepository

        repo = SqlAlchemyRepository()
        app.dependency_overrides[get_repository] = lambda: repo
        app.dependency_overrides[get_current_principal] = header_principal
        yield TestClient(app)
        app.dependency_overrides.clear()

    def test_self_noshow_round_trips_as_noshow(self, sql_client, sql_meeting):
        meeting_id = sql_meeting["meeting_id"]
        resp = sql_client.post(
            f"/meetings/{meeting_id}/review/step1",
            json={"proceeded": "self_noshow"},
            headers=_h(sql_meeting["org_a"]),
        )
        assert resp.status_code == 200
        assert resp.json()["review"]["is_noshow"] is True  # 저장 직후 응답부터 참이어야 한다

        got = sql_client.get(f"/meetings/{meeting_id}/review", headers=_h(sql_meeting["org_a"]))
        review = got.json()["review"]
        assert review["is_noshow"] is True  # ⚠ 회귀 지점 — 다시 읽었을 때도 참이어야 한다
        assert review["counterpart_noshow"] is False  # 상대가 불참한 게 아니다 — 내가 불참했다
        assert "self_noshow" not in review  # 본인 열람 응답에도 이 키 자체가 없다(아래 참고)

    def test_self_noshow_never_leaks_to_counterpart(self, sql_client, sql_meeting):
        """self_noshow는 love_call_signal.PRIVATE_REVIEW_FIELDS에 없지만 새지 않는다 — 애초에

        StoredReview.to_dict()가 만드는 평탄 dict에 그 키 자체가 없기 때문이다(app/repositories/
        base.py: self_noshow 필드가 없다). sql.py가 DB의 self_noshow 컬럼을 읽어 is_noshow로
        접어 넣을 뿐, self_noshow라는 이름으로는 API 응답에 한 번도 실리지 않는다 — 그래서
        비공개 필드 차단목록(PRIVATE_REVIEW_FIELDS)에 추가할 대상이 아니다(추가해도 아무 키도
        안 걸러지는 무의미한 항목이 될 뿐). 이 테스트는 그 "애초에 안 실림"을 실제 SQL 저장소로
        검증한다 — 본인 열람(own) 응답에도, 상대 열람(counterpart) 응답에도 없어야 한다.
        """
        meeting_id = sql_meeting["meeting_id"]
        sql_client.post(
            f"/meetings/{meeting_id}/review/step1",
            json={"proceeded": "self_noshow"},
            headers=_h(sql_meeting["org_a"]),
        )

        own = sql_client.get(f"/meetings/{meeting_id}/review", headers=_h(sql_meeting["org_a"])).json()["review"]
        assert "self_noshow" not in own

        counterpart = sql_client.get(
            f"/meetings/{meeting_id}/review/counterpart", headers=_h(sql_meeting["org_b"])
        ).json()["review"]
        assert "self_noshow" not in counterpart
        # 자기 리포트 self_noshow는 상대에게 counterpart_noshow로 둔갑해 보이지도 않는다.
        assert "counterpart_noshow" not in counterpart  # PRIVATE_REVIEW_FIELDS가 걸러낸다

    def test_counterpart_noshow_still_round_trips(self, sql_client, sql_meeting):
        """기존 경로(상대 불참) 회귀 방지 — self_noshow 컬럼 추가가 이 경로를 깨지 않는다."""
        meeting_id = sql_meeting["meeting_id"]
        sql_client.post(
            f"/meetings/{meeting_id}/review/step1",
            json={"proceeded": "counterpart_noshow"},
            headers=_h(sql_meeting["org_a"]),
        )
        got = sql_client.get(f"/meetings/{meeting_id}/review", headers=_h(sql_meeting["org_a"]))
        review = got.json()["review"]
        assert review["is_noshow"] is True
        assert review["counterpart_noshow"] is True

    def test_proceeded_round_trips_as_not_noshow(self, sql_client, sql_meeting):
        meeting_id = sql_meeting["meeting_id"]
        sql_client.post(
            f"/meetings/{meeting_id}/review/step1",
            json={"proceeded": "proceeded", "satisfaction": 5, "follow_up_intent": "yes"},
            headers=_h(sql_meeting["org_a"]),
        )
        got = sql_client.get(f"/meetings/{meeting_id}/review", headers=_h(sql_meeting["org_a"]))
        review = got.json()["review"]
        assert review["is_noshow"] is False
        assert review["counterpart_noshow"] is False


class TestNoshowExclusiveCheckConstraint:
    """post_meeting_reviews_noshow_exclusive(my002slf0001) — DB 레벨 불변식.

    애플리케이션 코드(review_capture.build_review)는 proceeded 값 하나로만 두 플래그를 결정하므로
    이미 상호 배타적이지만, 그걸 DB 제약으로도 강제해 어떤 경로(수기 UPDATE·버그 있는 마이그레이션
    등)로도 둘 다 true인 행이 만들어질 수 없게 잠근다.
    """

    def test_both_true_raises_integrity_error(self, migrated_db):
        import uuid

        from sqlalchemy import create_engine
        from sqlalchemy.exc import IntegrityError
        from sqlalchemy.orm import sessionmaker

        from app.domain.review_provenance_binding import MatchingType
        from app.models import Event, Meeting, Organization, PostMeetingReview

        engine = create_engine(migrated_db, future=True)
        TestSession = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)
        db = TestSession()
        try:
            event = Event(name="DX Korea 2026", slug=f"noshow-exclusive-{uuid.uuid4().hex[:8]}")
            org_a = Organization(name_ko="참가사")
            org_b = Organization(name_ko="바이어")
            db.add_all([event, org_a, org_b])
            db.flush()
            meeting = Meeting(
                event_id=event.id,
                exhibitor_org_id=org_a.id,
                buyer_org_id=org_b.id,
                matching_type=MatchingType.AI.value,
            )
            db.add(meeting)
            db.flush()

            db.add(
                PostMeetingReview(
                    meeting_id=meeting.id,
                    reviewer_org_id=org_a.id,
                    counterpart_noshow=True,
                    self_noshow=True,
                )
            )
            with pytest.raises(IntegrityError, match="post_meeting_reviews_noshow_exclusive"):
                db.commit()
        finally:
            db.rollback()
            db.close()
            engine.dispose()

    def test_migration_up_down_up_roundtrip(self, empty_db_url):
        """my002slf0001이 깨끗이 내려갔다 다시 올라오는지 — 컬럼 + CHECK 제약 둘 다."""
        from alembic import command
        from alembic.config import Config
        from sqlalchemy import create_engine, text

        from app.config import settings

        original = settings.database_url
        settings.database_url = empty_db_url
        cfg = Config("alembic.ini")
        engine = create_engine(empty_db_url, future=True)
        try:
            command.upgrade(cfg, "head")
            with engine.connect() as c:
                assert c.execute(
                    text(
                        "SELECT column_default FROM information_schema.columns"
                        " WHERE table_name = 'post_meeting_reviews' AND column_name = 'self_noshow'"
                    )
                ).scalar_one() == "false"
                assert c.execute(
                    text(
                        "SELECT conname FROM pg_constraint WHERE conrelid ="
                        " 'post_meeting_reviews'::regclass AND conname ="
                        " 'post_meeting_reviews_noshow_exclusive'"
                    )
                ).scalar_one_or_none() == "post_meeting_reviews_noshow_exclusive"

            command.downgrade(cfg, "proxyapp0001")
            with engine.connect() as c:
                assert c.execute(
                    text(
                        "SELECT count(*) FROM information_schema.columns"
                        " WHERE table_name = 'post_meeting_reviews' AND column_name = 'self_noshow'"
                    )
                ).scalar_one() == 0
                assert c.execute(
                    text(
                        "SELECT conname FROM pg_constraint WHERE conrelid ="
                        " 'post_meeting_reviews'::regclass AND conname ="
                        " 'post_meeting_reviews_noshow_exclusive'"
                    )
                ).scalar_one_or_none() is None

            command.upgrade(cfg, "head")  # 다시 올라와야 한다(왕복 검증).
            with engine.connect() as c:
                assert c.execute(
                    text(
                        "SELECT count(*) FROM information_schema.columns"
                        " WHERE table_name = 'post_meeting_reviews' AND column_name = 'self_noshow'"
                    )
                ).scalar_one() == 1
        finally:
            settings.database_url = original
            engine.dispose()
