"""명단 업로드 → 자동 회원가입(공통 비밀번호) HTTP 계약 — 2026-09-16 발주자 요청.

"슈퍼관리자가 엑셀 명단 템플릿 csv에 참가기업 정보들을 작성해서 올리면 데이터베이스에 자동으로
올라가고(자동 회원가입) 비밀번호는 … 다 통일되게" + "/admin/organizations '명단 임포트'가 CSV 관련
이슈로 작동을 안 한다 — 슈퍼관리자든 행사 운영이든 동일하게 작동하도록 통합".

두 업로드 경로(/api/admin/import/roster · /organizer/events/{id}/members/import)는 같은 핸들러다.
가드는 실 배선(require_event_operator)에 데모 인증 스텁 + 인메모리 운영자 디렉터리만 끼워 master/sub/
다른 행사 운영자/참가자를 토큰으로 구분한다. DB는 conftest의 롤백 세션(db_session)이다.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select

from app.auth.credentials import hash_password
from app.auth.dx_korea_verify import VerifyOk, VerifyRejected
from app.auth.local_verify import LocalCredentialVerifier, LocalRegistrantDirectory
from app.auth.organizer_guard import (
    InMemoryEventOperatorDirectory,
    StubSessionAuthenticator,
    get_authenticator,
    get_operator_directory,
)
from app.config import settings
from app.db import get_session
from app.main import app
from app.models import Member, Organization, OrganizationEventRole, Organizer, Registrant
from app.storage import get_storage

# UTF-8 BOM(Excel 한글 CSV) — 편집 훅이 보이지 않는 문자를 지우므로 코드포인트로 만든다.
BOM = chr(0xFEFF)
COMMON_PASSWORD = "Nabi2026Roster"  # 정책 통과(8자+영문+숫자) — 응답·보관 어디에도 나오면 안 되는 문자열
MASTER = {"Authorization": "Bearer access-mbr-master-1"}
SUB = {"Authorization": "Bearer access-mbr-sub-1"}
OTHER_EVENT_MASTER = {"Authorization": "Bearer access-mbr-other-master-1"}
PARTICIPANT = {"Authorization": "Bearer access-mbr-buyer-1"}
OTHER_EVENT_ID = "22222222-2222-2222-2222-222222222222"

# 새 다운로드 템플릿 헤더(frontend lib/roster/template.ts와 동일) — 회원가입 필드 키.
NEW_HEADER = "id,role,name_ko,name_en,country,contact_name,contact_email,contact_phone,content_category"

# /admin/organizations가 내려주던 옛 템플릿(frontend lib/admin/export.ts rosterTemplateCsv, 2026-09-16 이전)
# 그대로. name_ko가 백엔드 기업명 별칭에 없어 400("기업명 컬럼을 찾을 수 없습니다")으로 전부 거부됐다.
OLD_ADMIN_TEMPLATE = BOM + (
    "id,role,name_ko,name_en,country,contact_name,contact_email,contact_phone,category,registered_by\r\n"
    "adm-ex-999,exhibitor,예시기업,Example Corp,대한민국,홍길동,hong@example.com,010-0000-0000,콘텐츠 제작,직접등록"
)

# /organizer/members가 내려주던 옛 템플릿(frontend lib/organizer/roster-import.ts rosterTemplateCsv) 헤더.
OLD_ORGANIZER_TEMPLATE = BOM + (
    "id,name,name_en,tab,담당자,전화번호,이메일,사업분야,카테고리\r\n"
    "ex-100,새빛스튜디오,Saebit Studio,exhibitor,김담당 부장,010-1000-2000,kim@saebit.example.com,게임 제작,방송\r\n"
    "by-100,Global Media Group,Global Media Group,buyer,John Doe,+1-202-555-0100,jdoe@globalmedia.example.com,콘텐츠 제작,"
)


class RecordingStorage:
    """원본 보관 호출을 기록하는 더블 — 평문 비밀번호가 원본 보관으로 새지 않는지 확인용."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, str, bytes, str | None]] = []

    def put_original(self, event_id: str, filename: str, data: bytes, content_type: str | None) -> str | None:
        self.calls.append((event_id, filename, data, content_type))
        return None


@pytest.fixture
def api(db_session, event):
    storage = RecordingStorage()
    app.dependency_overrides[get_session] = lambda: db_session
    app.dependency_overrides[get_storage] = lambda: storage
    app.dependency_overrides[get_authenticator] = StubSessionAuthenticator
    app.dependency_overrides[get_operator_directory] = lambda: InMemoryEventOperatorDirectory(
        {
            ("mbr-master", event.id): "master",
            ("mbr-sub", event.id): "sub",
            ("mbr-sub-2", event.id): "sub",
            ("mbr-other-master", OTHER_EVENT_ID): "master",
        }
    )
    yield SimpleNamespace(client=TestClient(app), event_id=event.id, storage=storage, db=db_session)
    app.dependency_overrides.clear()


def _upload(api, content: str | bytes, *, headers=MASTER, via: str = "admin", filename: str = "roster.csv", **form):
    body = content.encode("utf-8") if isinstance(content, str) else content
    files = {"file": (filename, body, "text/csv")}
    data = {k: str(v).lower() if isinstance(v, bool) else v for k, v in form.items()}
    if via == "admin":
        return api.client.post(
            "/api/admin/import/roster", params={"event_id": api.event_id}, files=files, data=data, headers=headers
        )
    return api.client.post(
        f"/organizer/events/{api.event_id}/members/import", files=files, data=data, headers=headers
    )


def _csv(*rows: str, header: str = NEW_HEADER) -> str:
    return BOM + "\r\n".join([header, *rows])


def _count(db, model, *where) -> int:
    return db.scalar(select(func.count()).select_from(model).where(*where))


def _member(db, email: str) -> Member | None:
    return db.scalars(select(Member).where(Member.email == email)).first()


# =============================================================================
# 근본 원인 회귀 — 어드민 템플릿(name_ko 헤더)이 400으로 거부되던 결함
# =============================================================================
def test_old_admin_template_is_accepted_not_rejected_400(api):
    resp = _upload(api, OLD_ADMIN_TEMPLATE)
    assert resp.status_code == 200, resp.text  # 수정 전: 400 "기업명 컬럼을 찾을 수 없습니다(org eager 생성 필수)."
    assert resp.json()["added"] == 1
    org = api.db.scalars(select(Organization).where(Organization.name_ko == "예시기업")).one()
    assert org.name_en == "Example Corp"
    member = _member(api.db, "hong@example.com")
    assert member is not None and member.phone == "010-0000-0000"
    reg = api.db.scalars(select(Registrant).where(Registrant.organizer_member_id == "adm-ex-999")).one()
    assert reg.raw["registered_by"] == "직접등록" and reg.raw["country"] == "대한민국"  # 비매핑 컬럼은 raw 보존


def test_old_organizer_template_still_works(api):
    resp = _upload(api, OLD_ORGANIZER_TEMPLATE, row_report=True)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert (body["added"], body["skipped"]) == (2, 0)
    assert api.db.scalars(select(Organization).where(Organization.name_ko == "새빛스튜디오")).one().name_en == "Saebit Studio"
    assert _member(api.db, "kim@saebit.example.com").phone == "010-1000-2000"


def test_new_template_header_with_korean_values_and_cp949_encoding(api):
    # 한글 Windows Excel "CSV(쉼표로 분리)" 저장 = CP949. 템플릿을 고쳐 저장하면 흔히 이 인코딩이 된다.
    content = "\r\n".join(
        [
            NEW_HEADER,
            "ex-1,참가기업,콘텐츠랩,Content Lab,대한민국,김담당,lab@contents.example.com,010-1111-2222,방송",
            "by-1,바이어,하노이미디어,Hanoi Media,베트남,Tran,tran@hanoi.example.com,+84-24-0000-0000,",
        ]
    ).encode("cp949")
    resp = _upload(api, content)
    assert resp.status_code == 200, resp.text
    assert resp.json()["added"] == 2
    buyer_org = api.db.scalars(select(Organization).where(Organization.name_ko == "하노이미디어")).one()
    role = api.db.scalars(select(OrganizationEventRole).where(OrganizationEventRole.organization_id == buyer_org.id)).one()
    assert (role.is_exhibitor, role.is_buyer, role.application_status) == (False, True, "registered")


# =============================================================================
# 공통 비밀번호 — 적용/유지/정책 거부/미리보기/평문 비노출
# =============================================================================
def test_common_password_enables_login_for_imported_members(api):
    csv_text = _csv(
        "ex-1,참가기업,콘텐츠랩,,대한민국,김담당,lab@contents.example.com,010-1111-2222,",
        "by-1,바이어,하노이미디어,,베트남,Tran,tran@hanoi.example.com,,",
    )
    resp = _upload(api, csv_text, password=COMMON_PASSWORD)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["accounts"] == {
        "created": 2, "password_set": 2, "password_kept": 0, "password_missing": 0, "no_account": 0,
    }
    assert [(r["row"], r["result"], r["account"], r["password"]) for r in body["rows"]] == [
        (2, "added", "created", "set"),
        (3, "added", "created", "set"),
    ]

    # 로그인 검증자(app.auth.local_verify)가 공통 비밀번호로 통과시키고, 역할 디렉터리가 명단 참가를 찾는다.
    verifier = LocalCredentialVerifier(api.db)
    ok = verifier.verify("TRAN@hanoi.example.com ", COMMON_PASSWORD)
    assert isinstance(ok, VerifyOk)
    assert isinstance(verifier.verify("tran@hanoi.example.com", "wrong-pass-1"), VerifyRejected)
    ref = LocalRegistrantDirectory(api.db).find_by_member_id(ok.member_id)
    assert ref is not None and ref.is_buyer and ref.application_status == "registered"


def test_imported_member_passes_login_start_http(api, monkeypatch):
    # 실 로그인 트랜잭션(POST /api/auth/login/start)까지 — 최초 진입이라 약관 동의 게이트로 분기한다.
    monkeypatch.setattr(settings, "auth_backend", "demo")
    _upload(api, _csv("by-9,바이어,다낭바이어,,베트남,Le,le@danang.example.com,,"), password=COMMON_PASSWORD)
    resp = api.client.post(
        "/api/auth/login/start", json={"username": "le@danang.example.com", "password": COMMON_PASSWORD}
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["outcome"] == "consent_required"


def test_existing_password_is_never_overwritten_and_passwordless_member_gets_it(api):
    # 1차: 비밀번호 없이 적재(예전 방식) → 로그인 불가 계정 2개.
    first = _upload(
        api,
        _csv("m-1,바이어,바이어A,,,A,a@buyer.example.com,,", "m-2,바이어,바이어B,,,B,b@buyer.example.com,,"),
        row_report=True,
    )
    assert first.json()["accounts"]["password_missing"] == 2
    # 한 명은 이미 본인 비밀번호가 생겼다고 치자(자체 변경 등).
    _member(api.db, "a@buyer.example.com").password_hash = hash_password("OwnSecret99")
    api.db.flush()

    # 2차: 같은 명단 + 공통 비밀번호 → A는 유지, B만 설정.
    second = _upload(
        api,
        _csv("m-1,바이어,바이어A,,,A,a@buyer.example.com,,", "m-2,바이어,바이어B,,,B,b@buyer.example.com,,"),
        password=COMMON_PASSWORD,
    )
    body = second.json()
    assert (body["unchanged"], body["accounts"]["password_kept"], body["accounts"]["password_set"]) == (2, 1, 1)
    rows = {r["organizer_member_id"]: r for r in body["rows"]}
    assert (rows["m-1"]["account"], rows["m-1"]["password"]) == ("existing", "kept")
    assert (rows["m-2"]["account"], rows["m-2"]["password"]) == ("existing", "set")

    verifier = LocalCredentialVerifier(api.db)
    assert isinstance(verifier.verify("a@buyer.example.com", "OwnSecret99"), VerifyOk)  # 본인 비밀번호 그대로
    assert isinstance(verifier.verify("a@buyer.example.com", COMMON_PASSWORD), VerifyRejected)
    assert isinstance(verifier.verify("b@buyer.example.com", COMMON_PASSWORD), VerifyOk)


def test_same_org_member_outside_roster_gets_password_without_being_relinked(api):
    # 단건 등록(명단 밖)으로 만든 비밀번호 없는 담당자 — 같은 기업·같은 이메일 행이 오면 비밀번호만 채운다.
    org = Organization(name_ko="급한바이어")
    api.db.add(org)
    api.db.flush()
    api.db.add(Member(organization_id=org.id, name="급한담당", email="rush@buyer.example.com"))
    api.db.flush()

    resp = _upload(api, _csv("rush-1,바이어,급한바이어,,,급한담당,rush@buyer.example.com,,"), password=COMMON_PASSWORD)
    (row,) = resp.json()["rows"]
    assert (row["account"], row["password"], row["reason"]) == ("existing", "set", None)
    member = _member(api.db, "rush@buyer.example.com")
    assert member.registrant_id is None  # 연결하지 않는다(다음 적재가 그 계정 정보를 덮지 않게)
    assert isinstance(LocalCredentialVerifier(api.db).verify("rush@buyer.example.com", COMMON_PASSWORD), VerifyOk)


@pytest.mark.parametrize("bad_password", ["short1", "onlyletters", "12345678"])
def test_password_policy_violation_is_rejected_before_any_write(api, bad_password):
    resp = _upload(api, _csv("m-1,바이어,바이어A,,,A,a@buyer.example.com,,"), password=bad_password)
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "PASSWORD_POLICY"
    assert bad_password not in resp.text  # 에러 응답에도 입력값을 싣지 않는다
    assert _count(api.db, Registrant, Registrant.event_id == api.event_id) == 0
    assert api.storage.calls == []  # 원본 보관도 안 됨


def test_empty_password_field_means_no_password(api):
    resp = _upload(api, _csv("m-1,바이어,바이어A,,,A,a@buyer.example.com,,"), password="")
    assert resp.status_code == 200, resp.text
    assert "accounts" not in resp.json()  # 공통 비밀번호 미입력 = 예전 응답 그대로(행별 결과는 요청 시에만)
    assert _member(api.db, "a@buyer.example.com").password_hash is None


def test_dry_run_writes_nothing_but_reports_login_enabled_count(api):
    csv_text = _csv(
        "m-1,바이어,바이어A,,,A,a@buyer.example.com,,",
        "m-2,참가기업,참가사B,,,B,b@exh.example.com,,",
    )
    resp = _upload(api, csv_text, password=COMMON_PASSWORD, dry_run=True)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["added"] == 2
    assert body["accounts"]["password_set"] == 2  # 적용하면 로그인 가능해질 계정 수
    assert _count(api.db, Registrant, Registrant.event_id == api.event_id) == 0
    assert _member(api.db, "a@buyer.example.com") is None
    assert api.storage.calls == []


def test_plaintext_password_never_leaves_request(api):
    csv_text = _csv("m-1,바이어,바이어A,,,A,a@buyer.example.com,,")
    preview = _upload(api, csv_text, password=COMMON_PASSWORD, dry_run=True)
    applied = _upload(api, csv_text, password=COMMON_PASSWORD)
    for resp in (preview, applied):
        assert resp.status_code == 200
        assert COMMON_PASSWORD not in resp.text
    (call,) = api.storage.calls  # 적용 1회만 원본 보관
    assert COMMON_PASSWORD.encode() not in call[2] and COMMON_PASSWORD not in call[1]
    reg = api.db.scalars(select(Registrant).where(Registrant.organizer_member_id == "m-1")).one()
    assert COMMON_PASSWORD not in str(reg.raw)
    stored_hash = _member(api.db, "a@buyer.example.com").password_hash
    assert stored_hash and stored_hash.startswith("$2") and COMMON_PASSWORD not in stored_hash


def test_file_with_password_column_is_rejected_before_archive(api):
    resp = _upload(api, _csv("m-1,바이어,바이어A,a@buyer.example.com,Secret123", header="id,role,name_ko,email,비밀번호"))
    assert resp.status_code == 400
    assert resp.json()["detail"]["code"] == "ROSTER_PASSWORD_COLUMN"
    assert "Secret123" not in resp.text
    assert api.storage.calls == []
    assert _count(api.db, Registrant, Registrant.event_id == api.event_id) == 0


# =============================================================================
# 행별 결과 — 행 번호·사유
# =============================================================================
def test_row_report_explains_each_problem_row(api):
    csv_text = _csv(
        "d-1,바이어,중복이메일A,,,A,dup@buyer.example.com,,",  # 2행
        "d-2,바이어,중복이메일B,,,B,dup@buyer.example.com,,",  # 3행 — 파일 안 중복 이메일
        "bad-1,바이어,형식오류,,,C,not-an-email,,",  # 4행
        ",바이어,아이디없음,,,D,,,",  # 5행 — 회원ID·이메일 둘 다 결측(이메일이 있으면 자동 채워져 더는 결측이 아니다)
        "",  # 6행 — 빈 줄(번호는 센다)
        "twice,바이어,먼저행,,,E,e1@buyer.example.com,,",  # 7행 — 뒤 행으로 대체
        "noemail,바이어,이메일없음,,,F,,,",  # 8행
        "twice,바이어,나중행,,,E,e2@buyer.example.com,,",  # 9행
    )
    resp = _upload(api, csv_text, password=COMMON_PASSWORD)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    by_row = {r["row"]: r for r in body["rows"]}
    assert (by_row[2]["account"], by_row[2]["password"]) == ("created", "set")
    assert (by_row[3]["result"], by_row[3]["account"], by_row[3]["reason"]) == ("added", "none", "duplicate_email_in_file")
    assert (by_row[4]["account"], by_row[4]["reason"]) == ("none", "invalid_email")
    assert (by_row[5]["result"], by_row[5]["reason"]) == ("skipped", "missing_member_id")
    assert (by_row[7]["result"], by_row[7]["reason"]) == ("skipped", "duplicate_id_in_file")
    assert (by_row[8]["account"], by_row[8]["reason"]) == ("none", "no_email")
    assert (by_row[9]["result"], by_row[9]["account"]) == ("added", "created")
    assert 6 not in by_row
    assert (body["added"], body["skipped"]) == (5, 2)
    assert body["accounts"] == {
        "created": 2, "password_set": 2, "password_kept": 0, "password_missing": 0, "no_account": 3,
    }
    assert _member(api.db, "not-an-email") is None


def test_email_already_used_by_another_roster_member_is_reported(api):
    _upload(api, _csv("m-1,바이어,회사A,,,A,taken@buyer.example.com,,"))
    resp = _upload(api, _csv("m-2,바이어,회사B,,,B,taken@buyer.example.com,,"), password=COMMON_PASSWORD)
    (row,) = resp.json()["rows"]
    assert (row["result"], row["account"], row["reason"]) == ("added", "none", "email_in_use")
    assert _member(api.db, "taken@buyer.example.com").password_hash is None  # 남의 계정에 비밀번호를 심지 않는다


def test_both_paths_share_one_handler(api):
    csv_text = _csv("m-1,바이어,바이어A,,,A,a@buyer.example.com,,")
    admin = _upload(api, csv_text, via="admin", row_report=True)
    organizer = _upload(api, csv_text, via="organizer", row_report=True)
    assert admin.json()["added"] == 1 and organizer.json()["unchanged"] == 1
    assert set(admin.json()) == set(organizer.json())  # 같은 응답 계약


# =============================================================================
# 권한 — master·sub(이 행사) 허용, 다른 행사 운영자·참가자 거부, sub는 자기 바이어만
# =============================================================================
def test_master_and_sub_of_event_are_allowed(api):
    assert _upload(api, _csv("m-1,바이어,바이어A,,,A,a@buyer.example.com,,"), headers=MASTER).status_code == 200
    assert _upload(api, _csv("s-1,바이어,바이어S,,,S,s@buyer.example.com,,"), headers=SUB).status_code == 200


def test_operator_of_another_event_and_participant_are_forbidden(api):
    csv_text = _csv("m-1,바이어,바이어A,,,A,a@buyer.example.com,,")
    assert _upload(api, csv_text, headers=OTHER_EVENT_MASTER).status_code == 403
    assert _upload(api, csv_text, headers=PARTICIPANT).status_code == 403
    assert _upload(api, csv_text, headers={}).status_code == 401
    assert _count(api.db, Registrant, Registrant.event_id == api.event_id) == 0


def test_sub_registers_own_buyers_only(api):
    # master가 먼저 올린 바이어(관리 운영자 없음)와 참가사.
    _upload(
        api,
        _csv("master-by,바이어,마스터바이어,,,M,mb@buyer.example.com,,", "master-ex,참가기업,참가사X,,,X,x@exh.example.com,,"),
        headers=MASTER,
    )
    resp = _upload(
        api,
        _csv(
            "sub-by,바이어,서브바이어,,,S,sb@buyer.example.com,,",  # 2행 — 새 바이어: 허용
            "sub-ex,참가기업,서브참가사,,,E,se@exh.example.com,,",  # 3행 — 바이어 아님
            "master-by,바이어,마스터바이어,,,M,mb@buyer.example.com,,",  # 4행 — 관할 밖(회원ID로 기존)
            "sub-by-2,바이어,참가사X,,,Z,z@buyer.example.com,,",  # 5행 — 관할 밖(같은 이름 기존 참가사)
        ),
        headers=SUB,
        password=COMMON_PASSWORD,
    )
    assert resp.status_code == 200, resp.text
    by_row = {r["row"]: r for r in resp.json()["rows"]}
    assert (by_row[2]["result"], by_row[2]["password"]) == ("added", "set")
    assert (by_row[3]["result"], by_row[3]["reason"]) == ("skipped", "buyer_only")
    assert (by_row[4]["result"], by_row[4]["reason"]) == ("skipped", "out_of_jurisdiction")
    assert (by_row[5]["result"], by_row[5]["reason"]) == ("skipped", "out_of_jurisdiction")
    # 관할 밖 계정에는 비밀번호가 심기지 않았다.
    assert _member(api.db, "mb@buyer.example.com").password_hash is None
    assert _member(api.db, "x@exh.example.com").password_hash is None

    sub_org_id = api.db.scalars(select(Organizer.id).where(Organizer.member_id == "mbr-sub")).one()
    org = api.db.scalars(select(Organization).where(Organization.name_ko == "서브바이어")).one()
    role = api.db.scalars(select(OrganizationEventRole).where(OrganizationEventRole.organization_id == org.id)).one()
    assert role.managing_organizer_id == sub_org_id and role.created_by_organizer_id == sub_org_id

    # 같은 sub의 재업로드는 자기 바이어라 통과, 다른 sub에겐 관할 밖.
    again = _upload(api, _csv("sub-by,바이어,서브바이어,,,S,sb@buyer.example.com,,"), headers=SUB, row_report=True)
    assert again.json()["rows"][0]["result"] == "unchanged"
    other_sub = _upload(
        api, _csv("sub-by,바이어,서브바이어,,,S,sb@buyer.example.com,,"),
        headers={"Authorization": "Bearer access-mbr-sub-2-1"}, row_report=True,
    )
    assert other_sub.json()["rows"][0]["reason"] == "out_of_jurisdiction"


def test_master_import_keeps_ownership_fields_unset(api):
    # master 적재는 예전과 같다 — 관리/최초등록 운영자를 새로 박지 않는다(명단 스냅샷 = 기업 자가 신청 명단).
    _upload(api, _csv("m-1,바이어,바이어A,,,A,a@buyer.example.com,,"), headers=MASTER)
    org = api.db.scalars(select(Organization).where(Organization.name_ko == "바이어A")).one()
    # 같은 기업명이 다른 테스트의 행사에도 적재될 수 있어(기업은 이름으로 재사용) 이 행사로 좁힌다.
    role = api.db.scalars(
        select(OrganizationEventRole).where(
            OrganizationEventRole.organization_id == org.id,
            OrganizationEventRole.event_id == api.event_id,
        )
    ).one()
    assert (role.managing_organizer_id, role.created_by_organizer_id) == (None, None)
