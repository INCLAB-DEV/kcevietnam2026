"""업로드 엔드포인트 HTTP 계약(AC: 업로드→건수 표시, 실패 시 에러).

get_session/get_storage 의존성을 롤백 세션·NullStorage로 오버라이드해 DB를 더럽히지 않는다.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.admin.guard import EventOperatorPrincipal, require_event_operator
from app.db import get_session
from app.main import app
from app.storage import NullStorage, get_storage

CSV = "﻿회원ID,기업명,이메일,구분\nm-1,새한방산,a@a.com,참가기업\nm-2,한울디펜스,b@b.com,참가기업\n"


@pytest.fixture
def client(db_session, event):
    app.dependency_overrides[get_session] = lambda: db_session
    app.dependency_overrides[get_storage] = lambda: NullStorage()
    # 인증 가드는 이 행사의 운영자(master·sub)를 요구한다(명단 업로드 개방, 발주자 지시 2026-09-16) —
    # 적재 동작 테스트는 master로 통과시킨다. (거부·sub 관할 계약은 test_roster_account_import.py가 검증.)
    app.dependency_overrides[require_event_operator] = lambda: EventOperatorPrincipal(
        member_id="mbr-test-master", event_id=event.id, permission_level="master", organizer_id="org-test-master"
    )
    yield TestClient(app), event.id
    app.dependency_overrides.clear()


def test_upload_returns_counts(client):
    tc, event_id = client
    resp = tc.post(
        f"/organizer/events/{event_id}/members/import",
        files={"file": ("roster.csv", CSV.encode("utf-8"), "text/csv")},
        data={"default_role": "exhibitor"},
    )
    assert resp.status_code == 200
    assert resp.json() == {"added": 2, "updated": 0, "unchanged": 0, "skipped": 0, "changes": []}


CSV_CHANGED = "﻿회원ID,기업명,이메일,구분\nm-1,새한방산(정정),a@a.com,참가기업\nm-2,한울디펜스,b@b.com,참가기업\n"


def test_dry_run_previews_changes_without_persisting(client):
    tc, event_id = client
    url = f"/organizer/events/{event_id}/members/import"
    files = {"file": ("roster.csv", CSV.encode("utf-8"), "text/csv")}
    files_changed = {"file": ("roster.csv", CSV_CHANGED.encode("utf-8"), "text/csv")}

    tc.post(url, files=files, data={"default_role": "exhibitor"})  # 실제 적용
    # m-1 기업명만 바뀐 스냅샷을 dry_run으로 미리보기
    resp = tc.post(url, files=files_changed, data={"default_role": "exhibitor", "dry_run": "true"})
    assert resp.status_code == 200
    body = resp.json()
    assert (body["added"], body["updated"], body["unchanged"]) == (0, 1, 1)
    (change,) = body["changes"]
    assert change["organizer_member_id"] == "m-1"
    assert change["columns"]["기업명"] == {"old": "새한방산", "new": "새한방산(정정)"}

    # dry_run은 영속되지 않는다 — 이어서 무변경 원본을 실제 적용하면 m-1은 여전히 옛 이름.
    apply = tc.post(url, files=files, data={"default_role": "exhibitor"})
    assert apply.json()["unchanged"] == 2  # 둘 다 무변경 = 미리보기가 DB를 안 건드렸다는 증거


def test_unknown_event_404(client):
    tc, _ = client
    resp = tc.post(
        "/organizer/events/00000000-0000-0000-0000-000000000000/members/import",
        files={"file": ("roster.csv", CSV.encode("utf-8"), "text/csv")},
    )
    assert resp.status_code == 404


def test_bad_file_400(client):
    tc, event_id = client
    resp = tc.post(
        f"/organizer/events/{event_id}/members/import",
        files={"file": ("roster.csv", b"\xff\xfe garbage no header", "text/csv")},
    )
    assert resp.status_code == 400


def test_invalid_event_id_400(client):
    # 비-UUID event_id는 PG 변환 에러(500) 전에 400으로 거른다(codex P2).
    tc, _ = client
    resp = tc.post(
        "/organizer/events/not-a-uuid/members/import",
        files={"file": ("roster.csv", CSV.encode("utf-8"), "text/csv")},
    )
    assert resp.status_code == 400


def test_invalid_default_role_400(client):
    # 오타/미지원 default_role은 양쪽 플래그 false role을 만들기 전에 400(codex P2).
    tc, event_id = client
    resp = tc.post(
        f"/organizer/events/{event_id}/members/import",
        files={"file": ("roster.csv", CSV.encode("utf-8"), "text/csv")},
        data={"default_role": "구매담당자"},
    )
    assert resp.status_code == 400
