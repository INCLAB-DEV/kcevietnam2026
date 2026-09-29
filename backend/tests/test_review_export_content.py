"""보고서 export 콘텐츠 회귀 테스트 (#12) — 기업명/역할/일시/장소가 UUID 대신 표시된다.

과거 버그: ``api/reviews.py``의 ``export_report``가 조직 **id**를 표시용 문자열 자리에 그대로
넣어(``ReportMeta(counterpart_org=..., own_org=...)``), 내보낸 DOCX/PDF 본문에 UUID가 그대로
찍혔다. 이 테스트는 실 DB(격리된 ``migrated_db``)에 조직·미팅·장소를 심어 두고 export 응답의
DOCX 본문을 열어 다음을 검증한다:

- UUID 패턴이 본문에 전혀 없다
- 상대/본인 기업명 + 역할("참가사"/"바이어")이 함께 나온다
- 일시(행사 타임존 기준)·장소가 나온다

PDF는 reportlab이 내부 스트림을 압축해 바이트 레벨 텍스트 검증이 불가능하다(별도 PDF 파서 미설치
— tests/test_export.py도 동일 이유로 PDF 본문을 직접 파싱하지 않는다). 대신 같은 ``ReportMeta``를
공유하는 코드 경로(``app/api/reviews.py`` — fmt 분기만 다르고 meta 조립은 공통)임을 근거로,
PDF 는 정상 생성(매직바이트)만 확인한다.
"""

from __future__ import annotations

import io
import re
import uuid
from datetime import datetime, timedelta, timezone as dt_timezone

import pytest
from docx import Document
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.api.deps import get_repository
from app.auth.principal import Principal, get_current_principal
from app.db import get_session
from app.domain.review_provenance_binding import MatchingType
from app.main import app
from app.models import Event, Meeting, MeetingVenue, Organization
from app.repositories.base import MeetingView
from app.repositories.memory import InMemoryRepository

UUID_RE = re.compile(
    r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
)


@pytest.fixture()
def db_factory(migrated_db: str):
    engine = create_engine(migrated_db, future=True)
    TestSession = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)
    yield TestSession
    engine.dispose()


@pytest.fixture()
def world(db_factory):
    """행사(호치민 타임존) + 참가사·바이어 + 장소 + 미팅(일정 확정) 을 격리 DB에 심는다."""
    db = db_factory()
    try:
        event = Event(
            name="KADEX with DX Korea 2026",
            slug=f"export-test-{uuid.uuid4().hex[:8]}",
            timezone="Asia/Ho_Chi_Minh",
        )
        db.add(event)
        db.flush()

        exhibitor = Organization(name_ko="잉크주식회사")
        buyer = Organization(name_ko="글로벌마린")
        db.add_all([exhibitor, buyer])
        db.flush()

        venue = MeetingVenue(event_id=event.id, venue_type="zone_table", label="T-07")
        db.add(venue)
        db.flush()

        scheduled_start = datetime.now(dt_timezone.utc) + timedelta(days=3)
        scheduled_end = scheduled_start + timedelta(minutes=30)
        meeting = Meeting(
            event_id=event.id,
            exhibitor_org_id=exhibitor.id,
            buyer_org_id=buyer.id,
            venue_id=venue.id,
            matching_type=MatchingType.AI.value,
            ai_score=0.9,
            ai_score_reasons=["제품 적합성"],
            status="accepted",
            scheduled_start=scheduled_start,
            scheduled_end=scheduled_end,
        )
        db.add(meeting)
        db.flush()
        db.commit()

        return {
            "event_id": str(event.id),
            "exhibitor_org": str(exhibitor.id),
            "buyer_org": str(buyer.id),
            "meeting_id": str(meeting.id),
            "venue_label": venue.label,
            "scheduled_start": scheduled_start,
            "timezone": event.timezone,
        }
    finally:
        db.close()


@pytest.fixture()
def repo(world) -> InMemoryRepository:
    """리뷰 저장/조회는 InMemoryRepository — meeting_id/org_id는 world와 동일한 실 UUID를 쓴다."""
    r = InMemoryRepository()
    r.add_meeting(
        MeetingView(
            meeting_id=world["meeting_id"],
            event_id=world["event_id"],
            exhibitor_org_id=world["exhibitor_org"],
            buyer_org_id=world["buyer_org"],
            matching_type=MatchingType.AI,
            ai_score=0.9,
            ai_score_reasons=["제품 적합성"],
        )
    )
    return r


@pytest.fixture()
def client(db_factory, repo):
    def _override_session():
        db = db_factory()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_session] = _override_session
    app.dependency_overrides[get_repository] = lambda: repo
    yield TestClient(app)
    app.dependency_overrides.clear()


def _login_as(org_id: str) -> None:
    app.dependency_overrides[get_current_principal] = lambda: Principal(
        member_id=str(uuid.uuid4()), organization_id=org_id
    )


def _docx_text(data: bytes) -> str:
    doc = Document(io.BytesIO(data))
    return "\n".join(p.text for p in doc.paragraphs)


class TestExportContentNoUuid:
    def _finalize_report(self, client, org_id: str, meeting_id: str) -> None:
        r1 = client.post(
            f"/meetings/{meeting_id}/review/step1",
            json={"proceeded": "proceeded", "satisfaction": 5},
            headers={},
        )
        assert r1.status_code == 200, r1.text
        r2 = client.post(
            f"/meetings/{meeting_id}/review/step2",
            json={
                "report": {
                    "discussion": ["사거리 연장 요구"],
                    "agreements": ["제안서 송부"],
                    "actions": ["회신"],
                },
                "fit_rating": "good",
                "finalize": True,
            },
            headers={},
        )
        assert r2.status_code == 200, r2.text

    def test_docx_export_has_no_uuid_and_shows_name_role_datetime_venue(self, client, world):
        _login_as(world["exhibitor_org"])
        self._finalize_report(client, world["exhibitor_org"], world["meeting_id"])

        resp = client.get(
            f"/meetings/{world['meeting_id']}/review/export?fmt=docx",
        )
        assert resp.status_code == 200
        text = _docx_text(resp.content)

        # 과거 버그의 핵심: UUID가 문자 그대로 찍혔다.
        assert not UUID_RE.search(text), f"본문에 UUID 패턴이 남아있음:\n{text}"

        # 상대(바이어) 기업명 + 역할
        assert "글로벌마린" in text
        assert "바이어" in text
        # 작성자(참가사) 기업명 + 역할
        assert "잉크주식회사" in text
        assert "참가사" in text

        # 일시(행사 타임존 기준) — 벽시계 시각이 KST와 다른 Ho_Chi_Minh 기준으로 들어갔는지 확인.
        local_start = world["scheduled_start"].astimezone(
            __import__("zoneinfo").ZoneInfo(world["timezone"])
        )
        assert local_start.strftime("%Y-%m-%d %H:%M") in text
        assert world["timezone"] in text

        # 장소
        assert world["venue_label"] in text

    def test_pdf_export_still_renders(self, client, world):
        """PDF는 압축 스트림이라 바이트로 본문 검증은 못 하지만(README 참고), 같은 meta 조립
        경로(app/api/reviews.py)를 타므로 정상 생성만 확인 — DOCX 테스트가 meta 값 자체를 지킨다."""
        _login_as(world["exhibitor_org"])
        self._finalize_report(client, world["exhibitor_org"], world["meeting_id"])

        resp = client.get(f"/meetings/{world['meeting_id']}/review/export?fmt=pdf")
        assert resp.status_code == 200
        assert resp.content[:4] == b"%PDF"
        assert len(resp.content) > 800
