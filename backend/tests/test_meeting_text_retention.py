"""회의록 텍스트 보존기간 정리(2026-10-02 발주사 결정) — 행사 종료일 + 30일이 지나면 회의록 자유 텍스트를 지운다.

잠그는 것:
- 적격 판정: 그 행사의 exhibition_end·timezone 기준 현지 날짜가 종료일 + N일을 넘긴 순간부터(경계는 현지 자정).
  종료일 없는 행사는 대상이 아니고, 타임존이 잘못된 행사는 건너뛴다(조용히 UTC로 가정하지 않는다).
- 지우는 것: post_meeting_reviews의 transcript·fit_reason·transcript_turns·report_sections(NULL),
  transcription_jobs.draft의 문장 키(report·transcript·transcript_turns·fit_reason_seed → 빈 값).
  남기는 것: 만족도·후속의향·Fit 등급·사유 태그·노쇼·확정 시각·녹음 키, 초안의 fit_suggestion·태그·녹음 키,
  작업 행·status, 미팅 상태.
- 멱등(두 번째 실행은 0건·데이터 그대로), 다른 행사(아직 기간 안·종료일 없음·타임존 오류)는 건드리지 않는다.
- 스케줄러: 하루(UTC) 한 번만 돌고, 실패하면 1시간 뒤 다시 한다. 알림 tick이 실패해도 정리는 돈다. 로그엔 건수만.

DB 테스트의 행사 날짜는 2001년으로 둔다 — 공유 테스트 DB에 다른 테스트가 남긴 행사(2026년 날짜)가 섞여 있어도,
기준 시각(2001-03-01)에선 이 파일의 행사만 적격이라 건수를 정확히 잴 수 있다. 만든 행사·기업은 테스트가 끝나면
지운다(미팅·리뷰·작업은 CASCADE) — 공유 DB에 pending 작업 등을 남기면 다른 파일의 전역 건수 단언이 흔들린다.
"""

from __future__ import annotations

import itertools
import logging
import uuid
from datetime import date, datetime, timedelta, timezone

import pytest
from sqlalchemy import create_engine, func, select, text
from sqlalchemy.orm import sessionmaker

from app.config import Settings
from app.matching.slot_grid import SlotError
from app.models import Event, Meeting, Organization, PostMeetingReview, TranscriptionJob
from app.notifications import scheduler
from app.schemas import StructureDraftResponse
from app.services import meeting_text_retention as retention
from app.services.transcription_jobs import TRANSCRIPTION_FAILED_MESSAGE

_seq = itertools.count(1)

NOW = datetime(2001, 3, 1, 12, 0, tzinfo=timezone.utc)
ENDED_LONG_AGO = date(2001, 1, 10)  # +30일 = 2001-02-09 → NOW에 적격
ENDED_RECENTLY = date(2001, 2, 20)  # +30일 = 2001-03-22 → NOW엔 아직

SECRET_TRANSCRIPT = "전사 원문 — 단가 3달러 합의 기밀"
SECRET_FIT_REASON = "예산이 맞고 납기도 가능(자유 입력)"
SECRET_TURNS = [{"who": "us", "text": "단가는 3달러로 하죠"}, {"who": "them", "text": "좋습니다"}]
SECRET_REPORT = {"discussion": ["단가 협상"], "agreements": ["샘플 송부"], "actions": ["견적서 전달"]}


# =============================================================================
# 적격 판정 — 순수 함수(그 행사 타임존의 현지 날짜)
# =============================================================================
class TestIsTextExpired:
    @pytest.mark.parametrize(
        ("tz", "last_kept_utc", "first_purged_utc"),
        [
            # 종료 2026-10-22 + 30일 = 11-21 → 현지 11-22 0시부터 적격.
            ("Asia/Seoul", "2026-11-21T14:59:59+00:00", "2026-11-21T15:00:00+00:00"),
            ("Asia/Ho_Chi_Minh", "2026-11-21T16:59:59+00:00", "2026-11-21T17:00:00+00:00"),
            ("America/New_York", "2026-11-22T04:59:59+00:00", "2026-11-22T05:00:00+00:00"),
        ],
    )
    def test_boundary_is_local_midnight_after_end_plus_n_days(self, tz, last_kept_utc, first_purged_utc):
        end = date(2026, 10, 22)
        assert not retention.is_text_expired(end, tz, datetime.fromisoformat(last_kept_utc), 30)
        assert retention.is_text_expired(end, tz, datetime.fromisoformat(first_purged_utc), 30)

    def test_retention_days_shift_the_boundary(self):
        end = date(2026, 10, 22)
        now = datetime(2026, 11, 1, tzinfo=timezone.utc)
        assert retention.is_text_expired(end, "UTC", now, 5)
        assert not retention.is_text_expired(end, "UTC", now, 30)

    def test_event_without_end_date_is_never_expired(self):
        assert not retention.is_text_expired(None, "Asia/Seoul", datetime(2100, 1, 1, tzinfo=timezone.utc), 30)

    def test_invalid_timezone_raises_instead_of_assuming_utc(self):
        with pytest.raises(SlotError):
            retention.is_text_expired(date(2000, 1, 1), "Mars/Olympus_Mons", NOW, 30)

    def test_naive_now_is_rejected(self):
        with pytest.raises(ValueError):
            retention.is_text_expired(date(2000, 1, 1), "UTC", datetime(2001, 3, 1), 30)

    def test_setting_default_and_env_name(self, monkeypatch):
        assert Settings(_env_file=None).meeting_text_retention_days_after_event == 30
        monkeypatch.setenv("MEETING_TEXT_RETENTION_DAYS_AFTER_EVENT", "45")
        assert Settings(_env_file=None).meeting_text_retention_days_after_event == 45


# =============================================================================
# DB — 지우는 칸 / 남기는 칸 / 멱등 / 행사 격리
# =============================================================================
@pytest.fixture()
def db_factory(migrated_db: str):
    engine = create_engine(migrated_db, future=True)
    factory = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)
    yield factory
    engine.dispose()


@pytest.fixture()
def seed(db_factory):
    """``seed(exhibition_end=..., tz=...)``로 행사를 만들고, 테스트가 끝나면 만든 행사·기업을 지운다."""
    created: list[dict] = []

    def _seed(**kwargs) -> dict:
        seeded = _seed_event(db_factory, **kwargs)
        created.append(seeded)
        return seeded

    yield _seed
    with db_factory() as db:
        for seeded in created:
            db.execute(text("DELETE FROM events WHERE id = :e"), {"e": seeded["event_id"]})
            db.execute(
                text("DELETE FROM organizations WHERE id IN (:a, :b)"),
                {"a": seeded["exhibitor_org_id"], "b": seeded["buyer_org_id"]},
            )
        db.commit()


def _full_draft(audio_key: str) -> dict:
    return StructureDraftResponse(
        report=SECRET_REPORT,
        fit_suggestion="good",
        fit_reason_seed="AI가 본 적합 근거(초안)",
        fit_reason_tags=["예산"],
        transcript=SECRET_TRANSCRIPT,
        transcript_turns=SECRET_TURNS,
        audio_s3_key=audio_key,
    ).model_dump(mode="json")


def _seed_event(factory, *, exhibition_end: date | None, tz: str = "Asia/Seoul") -> dict:
    """행사 1개 + 미팅 1건 + 양측 리뷰(본문 있음/노쇼) + 전사 작업 3건(done/error/pending)."""
    n = next(_seq)
    with factory() as db:
        event = Event(
            name=f"보존기간 테스트 행사 {n}",
            slug=f"retention-{n}-{uuid.uuid4().hex[:8]}",
            exhibition_start=exhibition_end - timedelta(days=2) if exhibition_end else None,
            exhibition_end=exhibition_end,
            timezone=tz,
        )
        exhibitor = Organization(name_ko=f"참가사 {n}")
        buyer = Organization(name_ko=f"바이어 {n}")
        db.add_all([event, exhibitor, buyer])
        db.flush()
        start = datetime.combine(exhibition_end or date(2001, 1, 8), datetime.min.time(), tzinfo=timezone.utc)
        meeting = Meeting(
            event_id=event.id,
            exhibitor_org_id=exhibitor.id,
            buyer_org_id=buyer.id,
            matching_type="open",
            status="completed",
            requested_by="buyer",
            request_reason="미팅 신청 사유(보존기간 정리 대상 아님)",
            scheduled_start=start + timedelta(hours=3),
            scheduled_end=start + timedelta(hours=3, minutes=30),
        )
        db.add(meeting)
        db.flush()
        audio_key = f"meetings/{event.id}/{meeting.id}/{exhibitor.id}/{uuid.uuid4().hex}-rec.m4a"
        written = PostMeetingReview(
            meeting_id=meeting.id,
            reviewer_org_id=exhibitor.id,
            satisfaction_rating=4,
            follow_up_intent="yes",
            fit_rating="good",
            fit_reason=SECRET_FIT_REASON,
            fit_reason_tags=["예산", "도입 시기"],
            audio_s3_key=audio_key,
            transcript=SECRET_TRANSCRIPT,
            transcript_turns=SECRET_TURNS,
            report_sections=SECRET_REPORT,
            report_confirmed_at=start + timedelta(hours=5),
        )
        noshow = PostMeetingReview(meeting_id=meeting.id, reviewer_org_id=buyer.id, counterpart_noshow=True)
        done = TranscriptionJob(
            meeting_id=meeting.id, org_id=exhibitor.id, status="done", draft=_full_draft(audio_key)
        )
        failed = TranscriptionJob(
            meeting_id=meeting.id, org_id=exhibitor.id, status="error", error=TRANSCRIPTION_FAILED_MESSAGE
        )
        pending = TranscriptionJob(meeting_id=meeting.id, org_id=exhibitor.id)
        db.add_all([written, noshow, done, failed, pending])
        db.commit()
        return {
            "event_id": str(event.id),
            "exhibitor_org_id": str(exhibitor.id),
            "buyer_org_id": str(buyer.id),
            "meeting_id": str(meeting.id),
            "written_review_id": str(written.id),
            "noshow_review_id": str(noshow.id),
            "done_job_id": str(done.id),
            "failed_job_id": str(failed.id),
            "pending_job_id": str(pending.id),
            "audio_key": audio_key,
        }


def _snapshot(factory, seeded: dict) -> dict:
    """이 행사 행들의 지금 값(비교용)."""
    with factory() as db:
        reviews = {
            r.id: {
                "transcript": r.transcript,
                "fit_reason": r.fit_reason,
                "transcript_turns": r.transcript_turns,
                "report_sections": r.report_sections,
                "satisfaction_rating": r.satisfaction_rating,
                "follow_up_intent": r.follow_up_intent,
                "fit_rating": r.fit_rating,
                "fit_reason_tags": r.fit_reason_tags,
                "audio_s3_key": r.audio_s3_key,
                "counterpart_noshow": r.counterpart_noshow,
                "self_noshow": r.self_noshow,
                "report_confirmed_at": r.report_confirmed_at,
            }
            for r in db.scalars(
                select(PostMeetingReview).where(PostMeetingReview.meeting_id == seeded["meeting_id"])
            )
        }
        jobs = {
            j.id: {"status": j.status, "draft": j.draft, "error": j.error, "created_at": j.created_at}
            for j in db.scalars(select(TranscriptionJob).where(TranscriptionJob.meeting_id == seeded["meeting_id"]))
        }
        meeting = db.get(Meeting, seeded["meeting_id"])
        return {
            "reviews": reviews,
            "jobs": jobs,
            "meeting": (meeting.status, meeting.request_reason, meeting.scheduled_start),
        }


class TestPurge:
    def test_eligible_event_text_is_purged_and_structured_outcomes_are_kept(self, db_factory, seed):
        seeded = seed(exhibition_end=ENDED_LONG_AGO)
        before = _snapshot(db_factory, seeded)

        with db_factory() as db:
            result = retention.purge_expired_meeting_text(db, NOW, retention_days=30)

        assert result.eligible_events >= 1
        assert (result.reviews_purged, result.drafts_purged) == (1, 1)  # 본문 있는 리뷰 1건, 완료 초안 1건
        after = _snapshot(db_factory, seeded)

        written = after["reviews"][seeded["written_review_id"]]
        # 지움 — 사람이 쓴 문장·AI가 쓴 문장
        assert written["transcript"] is None
        assert written["fit_reason"] is None
        assert written["transcript_turns"] is None
        assert written["report_sections"] is None
        # 남김 — 효과 입증에 쓰는 정형 결과
        kept = ("satisfaction_rating", "follow_up_intent", "fit_rating", "fit_reason_tags", "audio_s3_key",
                "counterpart_noshow", "self_noshow", "report_confirmed_at")
        for key in kept:
            assert written[key] == before["reviews"][seeded["written_review_id"]][key], key
        assert written["report_confirmed_at"] is not None
        # 노쇼 리뷰(문장 없음)는 그대로
        assert after["reviews"][seeded["noshow_review_id"]] == before["reviews"][seeded["noshow_review_id"]]

        draft = after["jobs"][seeded["done_job_id"]]["draft"]
        assert draft["report"] == {"discussion": [], "agreements": [], "actions": []}
        assert draft["transcript"] == "" and draft["transcript_turns"] == [] and draft["fit_reason_seed"] == ""
        assert draft["fit_suggestion"] == "good"  # AI 제안 등급(정형)은 남는다
        assert draft["fit_reason_tags"] == ["예산"]
        assert draft["audio_s3_key"] == seeded["audio_key"]
        # 오래된 작업을 폴링해도 응답 스키마 검증이 깨지지 않는다
        StructureDraftResponse.model_validate(draft)
        # 작업 행·status·시각, 실패 문구, 미팅 상태·신청 사유는 그대로
        for job_id in (seeded["done_job_id"], seeded["failed_job_id"], seeded["pending_job_id"]):
            assert after["jobs"][job_id]["status"] == before["jobs"][job_id]["status"]
            assert after["jobs"][job_id]["created_at"] == before["jobs"][job_id]["created_at"]
        assert after["jobs"][seeded["failed_job_id"]] == before["jobs"][seeded["failed_job_id"]]
        assert after["jobs"][seeded["pending_job_id"]] == before["jobs"][seeded["pending_job_id"]]
        assert after["meeting"] == before["meeting"]

        # 지운 문장이 DB 어디에도 남지 않는다(이 미팅의 리뷰·작업 행 전체 텍스트 기준)
        with db_factory() as db:
            dump = db.execute(
                text(
                    "SELECT coalesce(string_agg(t::text, ' '), '') FROM ("
                    " SELECT r.*::text AS t FROM post_meeting_reviews r WHERE r.meeting_id = :m"
                    " UNION ALL SELECT j.*::text FROM transcription_jobs j WHERE j.meeting_id = :m) s"
                ),
                {"m": seeded["meeting_id"]},
            ).scalar_one()
        for secret in (SECRET_TRANSCRIPT, SECRET_FIT_REASON, "단가는 3달러로 하죠", "샘플 송부", "AI가 본 적합 근거"):
            assert secret not in dump

    def test_second_run_is_a_no_op(self, db_factory, seed):
        seeded = seed(exhibition_end=ENDED_LONG_AGO)
        with db_factory() as db:
            retention.purge_expired_meeting_text(db, NOW, retention_days=30)
        once = _snapshot(db_factory, seeded)

        with db_factory() as db:
            again = retention.purge_expired_meeting_text(db, NOW, retention_days=30)

        assert (again.reviews_purged, again.drafts_purged) == (0, 0)
        assert _snapshot(db_factory, seeded) == once

    def test_only_expired_events_are_touched(self, db_factory, seed):
        expired = seed(exhibition_end=ENDED_LONG_AGO)
        recent = seed(exhibition_end=ENDED_RECENTLY)
        no_end = seed(exhibition_end=None)
        broken_tz = seed(exhibition_end=ENDED_LONG_AGO, tz="Not/A_Zone")
        untouched = {name: _snapshot(db_factory, s) for name, s in
                     (("recent", recent), ("no_end", no_end), ("broken_tz", broken_tz))}

        with db_factory() as db:
            result = retention.purge_expired_meeting_text(db, NOW, retention_days=30)

        with db_factory() as db:
            assert expired["event_id"] in retention.find_expired_events(db, NOW, retention_days=30).event_ids
        assert result.skipped_invalid_timezone >= 1  # 타임존을 못 읽는 행사는 건너뛰고 센다
        assert _snapshot(db_factory, expired)["reviews"][expired["written_review_id"]]["transcript"] is None
        for name, seeded in (("recent", recent), ("no_end", no_end), ("broken_tz", broken_tz)):
            assert _snapshot(db_factory, seeded) == untouched[name], name

        # 기간이 지나면 그 행사도 지운다(행사마다 자기 종료일 기준).
        later = datetime(2001, 3, 23, tzinfo=timezone.utc)
        with db_factory() as db:
            retention.purge_expired_meeting_text(db, later, retention_days=30)
        assert _snapshot(db_factory, recent)["reviews"][recent["written_review_id"]]["transcript"] is None

    def test_text_written_again_after_purge_is_purged_on_the_next_run(self, db_factory, seed):
        seeded = seed(exhibition_end=ENDED_LONG_AGO)
        with db_factory() as db:
            retention.purge_expired_meeting_text(db, NOW, retention_days=30)
            review = db.get(PostMeetingReview, seeded["written_review_id"])
            review.transcript = "정리 뒤에 다시 쓴 메모"
            db.commit()

        with db_factory() as db:
            result = retention.purge_expired_meeting_text(db, NOW + timedelta(days=1), retention_days=30)

        assert result.reviews_purged == 1
        assert _snapshot(db_factory, seeded)["reviews"][seeded["written_review_id"]]["transcript"] is None

    def test_json_null_is_not_counted_as_text(self, db_factory, seed):
        """ORM이 JSONB 칸에 None을 넣으면 JSON null이 저장될 수 있다 — 그런 행을 '지울 것'으로 세지 않는다."""
        seeded = seed(exhibition_end=ENDED_LONG_AGO)
        with db_factory() as db:
            db.execute(
                text(
                    "UPDATE post_meeting_reviews SET transcript = NULL, fit_reason = NULL,"
                    " transcript_turns = 'null'::jsonb, report_sections = 'null'::jsonb WHERE id = :r"
                ),
                {"r": seeded["written_review_id"]},
            )
            db.execute(text("UPDATE transcription_jobs SET draft = NULL WHERE meeting_id = :m"),
                       {"m": seeded["meeting_id"]})
            db.commit()

        with db_factory() as db:
            result = retention.purge_expired_meeting_text(db, NOW, retention_days=30)

        assert (result.reviews_purged, result.drafts_purged) == (0, 0)

    def test_purge_is_scoped_to_the_given_events(self, db_factory, seed):
        a = seed(exhibition_end=ENDED_LONG_AGO)
        b = seed(exhibition_end=ENDED_LONG_AGO)
        b_before = _snapshot(db_factory, b)
        with db_factory() as db:
            assert retention.purge_event_meeting_text(db, [a["event_id"]]) == (1, 1)
            assert retention.purge_event_meeting_text(db, []) == (0, 0)
        assert _snapshot(db_factory, b) == b_before


# =============================================================================
# 스케줄러 — 하루 한 번, 실패 시 1시간 뒤, 알림 tick 실패와 무관, 로그엔 건수만
# =============================================================================
@pytest.fixture(autouse=True)
def _fresh_gate():
    scheduler.reset_text_retention_gate()
    yield
    scheduler.reset_text_retention_gate()


class _FakeSession:
    def __init__(self) -> None:
        self.rollbacks = 0

    def rollback(self) -> None:
        self.rollbacks += 1


class TestDailyGate:
    def _spy(self, monkeypatch, *, fail_first: int = 0):
        calls: list[datetime] = []

        def fake_purge(db, now, *, retention_days):
            calls.append(now)
            if len(calls) <= fail_first:
                raise RuntimeError("DB 일시 장애(테스트)")
            return retention.RetentionResult(1, 2, 3)

        monkeypatch.setattr(scheduler, "purge_expired_meeting_text", fake_purge)
        return calls

    def test_runs_at_most_once_per_utc_day(self, monkeypatch):
        calls = self._spy(monkeypatch)
        db = _FakeSession()
        day1 = datetime(2026, 11, 22, 0, 0, 30, tzinfo=timezone.utc)

        assert scheduler.run_daily_text_retention(db, day1) is not None
        for minute in range(1, 120):  # 같은 날 1분 tick 119번 — DB를 건드리지 않는다
            assert scheduler.run_daily_text_retention(db, day1 + timedelta(minutes=minute)) is None
        assert len(calls) == 1 and db.rollbacks == 1

        assert scheduler.run_daily_text_retention(db, day1 + timedelta(days=1)) is not None
        assert len(calls) == 2

    def test_failure_backs_off_an_hour_then_retries(self, monkeypatch, caplog):
        monkeypatch.setattr(logging.getLogger("app.notifications.scheduler"), "disabled", False)
        calls = self._spy(monkeypatch, fail_first=1)
        db = _FakeSession()
        t0 = datetime(2026, 11, 22, 3, 0, tzinfo=timezone.utc)

        assert scheduler.run_daily_text_retention(db, t0) is None  # 실패는 삼키고
        assert scheduler.run_daily_text_retention(db, t0 + timedelta(minutes=59)) is None  # 1시간은 쉬고
        assert len(calls) == 1
        assert scheduler.run_daily_text_retention(db, t0 + timedelta(minutes=61)) is not None  # 다시 한다
        assert len(calls) == 2
        assert any("보존기간 정리 실패" in r.getMessage() for r in caplog.records)

    def test_broken_connection_during_retention_does_not_mask_the_tick_error(self, monkeypatch):
        """연결이 끊겨 정리도 롤백도 실패해도, 루프로 올라가는 건 알림 tick의 원래 예외다."""
        monkeypatch.setattr(logging.getLogger("app.notifications.scheduler"), "disabled", False)

        class _DeadSession:
            def rollback(self):
                raise ConnectionError("연결 끊김(테스트)")

        class _Ctx:
            def __enter__(self):
                return _DeadSession()

            def __exit__(self, *exc):
                return False

        def broken_reminder(db, now, **kw):
            raise RuntimeError("리마인더 tick 실패(테스트)")

        monkeypatch.setattr(scheduler, "SessionLocal", lambda: _Ctx())
        monkeypatch.setattr(scheduler, "run_reminder_tick", broken_reminder)
        monkeypatch.setattr(scheduler, "run_completion_tick", lambda db, now, **kw: [])

        with pytest.raises(RuntimeError, match="리마인더 tick 실패"):
            scheduler._run_ticks_once()
        assert scheduler._text_retention_retry_at is not None  # 정리는 실패로 기록돼 1시간 뒤 다시 한다

    def test_runs_even_when_a_notification_tick_fails(self, monkeypatch):
        calls = self._spy(monkeypatch)
        db = _FakeSession()

        class _Ctx:
            def __enter__(self):
                return db

            def __exit__(self, *exc):
                return False

        def broken_reminder(db, now, **kw):
            raise RuntimeError("리마인더 tick 실패(테스트)")

        monkeypatch.setattr(scheduler, "SessionLocal", lambda: _Ctx())
        monkeypatch.setattr(scheduler, "run_reminder_tick", broken_reminder)
        monkeypatch.setattr(scheduler, "run_completion_tick", lambda db, now, **kw: [])

        with pytest.raises(RuntimeError, match="리마인더 tick 실패"):
            scheduler._run_ticks_once()  # 알림 tick의 예외는 그대로 루프로 올라간다(기존처럼 로그)
        assert len(calls) == 1  # 그래도 정리는 돌았다

    def test_logs_counts_only(self, db_factory, seed, monkeypatch, caplog):
        monkeypatch.setattr(logging.getLogger("app.notifications.scheduler"), "disabled", False)
        caplog.set_level(logging.INFO)
        monkeypatch.setattr(scheduler.settings, "meeting_text_retention_days_after_event", 30)
        seed(exhibition_end=ENDED_LONG_AGO)

        with db_factory() as db:
            result = scheduler.run_daily_text_retention(db, NOW)

        assert result is not None and result.reviews_purged >= 1
        messages = [r.getMessage() for r in caplog.records if r.name.startswith("app.")]
        assert any("리뷰" in m and "건" in m for m in messages)
        for secret in (SECRET_TRANSCRIPT, SECRET_FIT_REASON, "단가는 3달러로 하죠", "단가 협상"):
            assert all(secret not in m for m in messages)

    def test_purged_review_count_matches_rows_with_text(self, db_factory, seed):
        """두 행사(적격) — 행사마다 본문 리뷰 1건·초안 1건이 지워진다(합계로 확인)."""
        seeded = [seed(exhibition_end=ENDED_LONG_AGO) for _ in range(2)]
        with db_factory() as db:
            remaining = db.execute(
                select(func.count())
                .select_from(PostMeetingReview)
                .where(
                    PostMeetingReview.meeting_id.in_([s["meeting_id"] for s in seeded]),
                    PostMeetingReview.transcript.isnot(None),
                )
            ).scalar_one()
            assert remaining == 2
            reviews, drafts = retention.purge_event_meeting_text(db, [s["event_id"] for s in seeded])
        assert (reviews, drafts) == (2, 2)
