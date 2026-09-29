"""어드민 엑셀 import 별칭(/api/admin/import/roster) HTTP 계약.

핵심: roster/router.py의 /organizer/.../members/import와 **같은 적재 코어**(roster.import_service.
import_roster)를 공유한다는 것을 확인한다 — 각자 안 건드리고 재사용만 하므로, 두 경로가 서로
간섭 없이 같은 회원ID에 대해 멱등하게 합류해야 한다.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select

from app.admin.guard import EventOperatorPrincipal, require_event_operator
from app.auth.organizer_guard import (
    InMemoryEventOperatorDirectory,
    StubSessionAuthenticator,
    get_authenticator,
    get_operator_directory,
)
from app.db import get_session
from app.main import app
from app.models import Registrant
from app.storage import NullStorage, get_storage

CSV = "﻿회원ID,기업명,이메일,구분\nm-1,새한방산,a@a.com,참가기업\nm-2,한울디펜스,b@b.com,참가기업\n"
CSV_CHANGED = "﻿회원ID,기업명,이메일,구분\nm-1,새한방산(정정),a@a.com,참가기업\nm-2,한울디펜스,b@b.com,참가기업\n"


@pytest.fixture
def client(db_session, event):
    app.dependency_overrides[get_session] = lambda: db_session
    app.dependency_overrides[get_storage] = lambda: NullStorage()
    # 명단 업로드는 이 행사의 운영자(master·sub) 가드 — 적재 동작 테스트는 master로 통과시킨다.
    app.dependency_overrides[require_event_operator] = lambda: EventOperatorPrincipal(
        member_id="mbr-test-master", event_id=event.id, permission_level="master", organizer_id="org-test-master"
    )
    yield TestClient(app), event.id
    app.dependency_overrides.clear()


def test_upload_returns_counts(client):
    tc, event_id = client
    resp = tc.post(
        "/api/admin/import/roster",
        params={"event_id": event_id},
        files={"file": ("roster.csv", CSV.encode("utf-8"), "text/csv")},
        data={"default_role": "exhibitor"},
    )
    assert resp.status_code == 200
    assert resp.json() == {"added": 2, "updated": 0, "unchanged": 0, "skipped": 0, "changes": []}


def test_admin_import_roster_calls_service(client, db_session):
    # 별칭이 기존 적재 코어(roster.import_service.import_roster)를 실제로 호출하는지 —
    # 응답 집계뿐 아니라 회원ID 키 레코드(registrants)가 DB에 materialize되는 것으로 확인.
    tc, event_id = client
    resp = tc.post(
        "/api/admin/import/roster",
        params={"event_id": event_id},
        files={"file": ("roster.csv", CSV.encode("utf-8"), "text/csv")},
        data={"default_role": "exhibitor"},
    )
    assert resp.status_code == 200
    assert resp.json() == {"added": 2, "updated": 0, "unchanged": 0, "skipped": 0, "changes": []}

    count = db_session.scalar(
        select(func.count()).select_from(Registrant).where(Registrant.event_id == event_id)
    )
    assert count == 2  # import_service 경유 없이 이 행들이 생길 수 없다


def test_dry_run_previews_changes_without_persisting(client):
    tc, event_id = client
    files = {"file": ("roster.csv", CSV.encode("utf-8"), "text/csv")}
    files_changed = {"file": ("roster.csv", CSV_CHANGED.encode("utf-8"), "text/csv")}

    tc.post(
        "/api/admin/import/roster",
        params={"event_id": event_id},
        files=files,
        data={"default_role": "exhibitor"},
    )
    resp = tc.post(
        "/api/admin/import/roster",
        params={"event_id": event_id},
        files=files_changed,
        data={"default_role": "exhibitor", "dry_run": "true"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert (body["added"], body["updated"], body["unchanged"]) == (0, 1, 1)
    (change,) = body["changes"]
    assert change["organizer_member_id"] == "m-1"
    assert change["columns"]["기업명"] == {"old": "새한방산", "new": "새한방산(정정)"}

    apply = tc.post(
        "/api/admin/import/roster",
        params={"event_id": event_id},
        files=files,
        data={"default_role": "exhibitor"},
    )
    assert apply.json()["unchanged"] == 2  # dry_run이 영속 안 됨 — 이어서 원본 적용해도 여전히 무변경


def test_unknown_event_404(client):
    tc, _ = client
    resp = tc.post(
        "/api/admin/import/roster",
        params={"event_id": "00000000-0000-0000-0000-000000000000"},
        files={"file": ("roster.csv", CSV.encode("utf-8"), "text/csv")},
    )
    assert resp.status_code == 404


def test_bad_file_400(client):
    tc, event_id = client
    resp = tc.post(
        "/api/admin/import/roster",
        params={"event_id": event_id},
        files={"file": ("roster.csv", b"\xff\xfe garbage no header", "text/csv")},
    )
    assert resp.status_code == 400


def test_invalid_event_id_400(client):
    tc, _ = client
    resp = tc.post(
        "/api/admin/import/roster",
        params={"event_id": "not-a-uuid"},
        files={"file": ("roster.csv", CSV.encode("utf-8"), "text/csv")},
    )
    assert resp.status_code == 400


def test_invalid_default_role_400(client):
    # roster/router.py(/organizer/.../members/import)와 동일 계약 — 이 어드민 별칭도 무효
    # default_role을 조용히 무시하지 않고 400으로 거부해야 한다(계약 동일성).
    tc, event_id = client
    resp = tc.post(
        "/api/admin/import/roster",
        params={"event_id": event_id},
        files={"file": ("roster.csv", CSV.encode("utf-8"), "text/csv")},
        data={"default_role": "not-a-role"},
    )
    assert resp.status_code == 400


def test_file_too_large_413(client):
    tc, event_id = client
    big = b"x" * (20 * 1024 * 1024 + 1)
    resp = tc.post(
        "/api/admin/import/roster",
        params={"event_id": event_id},
        files={"file": ("roster.csv", big, "text/csv")},
    )
    assert resp.status_code == 413


def test_shares_import_core_with_organizer_roster_route(client):
    # /organizer/... 경로로 먼저 적재하고, /api/admin/... 경로로 같은 스냅샷을 재적재하면
    # 같은 registrant(회원ID) 키로 합류해 전부 unchanged여야 한다 — 적재 코어가 진짜 공유되는지 확인.
    tc, event_id = client
    organizer_resp = tc.post(
        f"/organizer/events/{event_id}/members/import",
        files={"file": ("roster.csv", CSV.encode("utf-8"), "text/csv")},
        data={"default_role": "exhibitor"},
    )
    assert organizer_resp.status_code == 200
    assert organizer_resp.json()["added"] == 2

    admin_resp = tc.post(
        "/api/admin/import/roster",
        params={"event_id": event_id},
        files={"file": ("roster.csv", CSV.encode("utf-8"), "text/csv")},
        data={"default_role": "exhibitor"},
    )
    assert admin_resp.status_code == 200
    assert admin_resp.json() == {"added": 0, "updated": 0, "unchanged": 2, "skipped": 0, "changes": []}


def test_unauthenticated_401():
    # 가드 자체의 거부 계약은 test_organizer_guard.py가 커버 — 여기선 이 라우트가 실제로
    # require_event_master에 묶여있는지(배선 회귀)만 확인한다(test_roster_import_rejects_non_master_token와
    # 동일 패턴 — 인증/인가 포트만 데모 스텁으로 override, DB는 건드리지 않는다).
    app.dependency_overrides[get_authenticator] = StubSessionAuthenticator
    app.dependency_overrides[get_operator_directory] = lambda: InMemoryEventOperatorDirectory({})
    try:
        tc = TestClient(app)
        resp = tc.post(
            "/api/admin/import/roster",
            params={"event_id": "00000000-0000-0000-0000-0000000000de"},
            files={"file": ("roster.csv", CSV.encode("utf-8"), "text/csv")},
        )
        assert resp.status_code == 401
    finally:
        app.dependency_overrides.clear()


def test_admin_import_roster_requires_auth():
    # require_event_operator 가드 배선 — 토큰 없으면 401, 이 행사의 운영자(master·sub)가 아니면(다른 행사
    # 운영자·참가자) 403으로 적재 전에 거부된다(거부는 DB 접근 전이라 픽스처 불필요). sub 허용은 발주자
    # 지시(2026-09-16)로 바뀐 정책이며 DB가 필요한 통과 계약은 test_roster_account_import.py가 검증한다.
    event_id = "11111111-1111-1111-1111-111111111111"
    other_event_id = "22222222-2222-2222-2222-222222222222"
    app.dependency_overrides[get_authenticator] = StubSessionAuthenticator
    app.dependency_overrides[get_operator_directory] = lambda: InMemoryEventOperatorDirectory(
        {("mbr-other-master", other_event_id): "master"}
    )
    try:
        tc = TestClient(app)
        files = {"file": ("roster.csv", CSV.encode("utf-8"), "text/csv")}
        no_token = tc.post("/api/admin/import/roster", params={"event_id": event_id}, files=files)
        assert no_token.status_code == 401
        other_event_operator = tc.post(
            "/api/admin/import/roster",
            params={"event_id": event_id},
            files=files,
            headers={"Authorization": "Bearer access-mbr-other-master-1"},
        )
        assert other_event_operator.status_code == 403
        participant = tc.post(
            "/api/admin/import/roster",
            params={"event_id": event_id},
            files=files,
            headers={"Authorization": "Bearer access-mbr-buyer-1"},
        )
        assert participant.status_code == 403
    finally:
        app.dependency_overrides.clear()
