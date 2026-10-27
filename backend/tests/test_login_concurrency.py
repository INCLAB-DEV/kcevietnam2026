"""로그인 몰림 하드닝 외부 동작 테스트 — 2026-10-02 부하 테스트의 실패 모드를 잠근다.

그날(운영과 같은 t4g.medium, uvicorn 1개, DB 풀 10+20·대기 10초) 첫 로그인 100명이 한꺼번에 들어오자 9건이 500
(``QueuePool limit ... timed out``)으로 끝났고 p95가 20초였다. 원인: 로그인 요청이 회원 조회로 잡은 커넥션을
bcrypt(1회 0.2~0.3초 CPU — CPU 2개를 수십 건이 나눠 쓰니 건당 수 초)와 Cognito 호출 내내 쥐고 있었다.

잠그는 것:
- bcrypt(비밀번호 대조) 동안 요청 커넥션을 쥐지 않는다 — 일부러 느리게 만든 bcrypt가 불리는 순간 풀 체크아웃 0.
- Cognito 호출(계정 조회·발급·토큰) 동안에도 쥐지 않는다 — 재방문·최초(start→complete)·실 운영자 세 갈래 모두.
  호출 순서도 예전 그대로다(결과 계약은 test_login_transaction·test_local_login_integration이 지킨다).
- bcrypt 자리가 꽉 차면 제한 시간 안에 503 ``login_busy``(500 아님) — 기다리는 동안에도 커넥션 0이고, 자리가
  나면 같은 요청이 그대로 통과한다(거절 경로가 자리를 새지 않는다).
- 대기 상한(2026-10-03 교차리뷰 HIGH): 이미 상한만큼 기다리는 중이면 줄을 서지 않고 **즉시** 503(로그인
  ``login_busy``·그 밖 ``server_busy``) — 기다리는 요청이 AnyIO 스레드를 다 먹지 않게. 대기 수는 자리를 얻든·
  시간이 다 되든·예외가 나든 0으로 돌아온다(모든 테스트가 끝날 때 0인지 autouse 픽스처가 다시 본다).
- 사건 재현: 커넥션 1개짜리 풀에서 느린 bcrypt 로그인 여러 건이 동시에 와도 풀 대기 시간 초과 없이 끝난다.
- 그 밖의 해시 경로 — 셀프 비밀번호 변경·자체가입도 해시 동안 커넥션 0이고, 자리 시간 초과는 503 ``server_busy``.
- 교차리뷰 MEDIUM: 72바이트를 넘는 비밀번호는 500이 아니라 평범한 불일치(로그인 거부·변경 403)이고, 깨진 저장
  해시만 로그를 남기고 500. 없는 계정·비밀번호 없는 계정도 더미 해시로 bcrypt 1회를 같은 자리에서 치른다(응답
  시간으로 계정 존재를 떠볼 수 없게).

외부 호출은 0건이다(Cognito는 호출 시점의 체크아웃 수를 적는 인메모리 가짜). 커넥션 점유는 격리
Postgres(``migrated_db``) 위의 테스트 전용 엔진으로 잰다(test_ai_concurrency.TestNoConnectionHeldWhileWaitingOnAi와
같은 방식). Postgres가 없으면 conftest 규칙대로 skip.
"""

from __future__ import annotations

import logging
import os
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace

import bcrypt
import pytest
from fastapi import Depends
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event, select, text
from sqlalchemy.orm import Session, sessionmaker

from app.auth import credentials
from app.auth.consent_gate import InMemoryConsentGate
from app.auth.credentials import (
    PasswordHashBusyError,
    check_password,
    password_hash_slot,
    password_hash_waiters,
    reset_password_hash_slots,
)
from app.auth.dx_korea_verify import VerifyOk
from app.auth.local_verify import _DUMMY_PASSWORD_HASH, LocalCredentialVerifier
from app.auth.login_router import (
    _DEMO_CONSENT_DOCUMENTS,
    get_cognito_pool,
    get_consent_gate,
    get_ticket_service,
)
from app.auth.login_ticket import LoginTicketService
from app.auth.principal import Principal, get_current_principal
from app.auth.session_issue import InMemoryCognitoUserPool
from app.auth.signup_router import get_email_verify_ticket_service
from app.config import settings
from app.db import get_session
from app.main import app
from app.models import (
    Event,
    EventOrganizer,
    Member,
    Organization,
    OrganizationEventRole,
    Organizer,
)

START = "/api/auth/login/start"
COMPLETE = "/api/auth/login/complete"
CHANGE_PASSWORD = "/api/me/change-password"

# 정책 통과(8자+영문+숫자). 테스트 안에서만 쓰는 값.
PASSWORD = "LoginSurge2026"
NEW_PASSWORD = "LoginSurge2027"
REQUIRED_DOCS = ["tos", "privacy", "sensitive"]
# bcrypt 상한(72바이트)을 넘는 입력 — 한글 25자 = 75바이트(문자 수로는 짧아 보여도 바이트로는 넘는다).
OVERLONG_PASSWORD = "가" * 25
BUSY_LOGIN = {"detail": {"code": "login_busy", "message": "로그인 요청이 많아요. 잠시 후 다시 시도해 주세요."}}

# 일부러 느리게 만든 bcrypt 한 번의 길이 — "해시하는 동안"을 사람 눈에 보이는 구간으로 늘린다.
SLOW_HASH_SECONDS = 0.2

# 패치하기 전의 진짜 bcrypt — 시드 해시를 만들 때 쓴다(느린 가짜·체크아웃 기록을 타지 않게, cost 4로 빠르게).
_REAL_HASHPW = bcrypt.hashpw
_REAL_CHECKPW = bcrypt.checkpw


def _fast_hash(password: str) -> str:
    return _REAL_HASHPW(password.encode("utf-8"), bcrypt.gensalt(rounds=4)).decode("utf-8")


# =============================================================================
# 공통 배선
# =============================================================================
@pytest.fixture(autouse=True)
def _fresh_hash_slots():
    """해시 자리는 지연 생성 싱글턴이다 — 설정을 바꾼 테스트의 세마포어를 다음 테스트로 넘기지 않는다.

    끝날 때 대기 수가 0인지도 본다 — 어떤 경로(성공·시간 초과·예외·즉시 거절)로 끝난 테스트든 대기 셈이 새면
    다음 요청들이 아무도 기다리지 않는데도 "대기열이 꽉 찼다"로 거절된다.
    """
    reset_password_hash_slots()
    yield
    reset_password_hash_slots()
    assert password_hash_waiters() == 0


def _wait_until(predicate, timeout: float = 5.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.005)
    return predicate()


class _BlockedWaiter:
    """다른 스레드에서 해시 자리를 기다리는 요청 하나 — 자리가 나면 잡았다가 바로 놓는다."""

    def __init__(self) -> None:
        self.outcome: str | None = None
        self._thread = threading.Thread(target=self._run, daemon=True)

    def _run(self) -> None:
        try:
            with password_hash_slot():
                self.outcome = "acquired"
        except PasswordHashBusyError:
            self.outcome = "busy"

    def start(self) -> _BlockedWaiter:
        self._thread.start()
        return self

    def join(self) -> None:
        self._thread.join(timeout=10)
        assert not self._thread.is_alive()


def _session_override(factory):
    """운영 ``get_session``과 같은 모양(예외면 롤백, 끝나면 close) — 테스트 전용 엔진에 붙는다."""

    def _get_session():
        db = factory()
        try:
            yield db
        except Exception:
            db.rollback()
            raise
        finally:
            db.close()

    return _get_session


@pytest.fixture
def pg(migrated_db):
    """격리 DB 위의 테스트 전용 엔진 — 이 엔진의 풀 체크아웃 수가 곧 '요청이 쥔 커넥션 수'다.

    ``checkouts``는 체크아웃 이벤트마다 쌓인다 — 요청이 실제로 이 엔진을 썼다는 증거(0이라는 측정이 엉뚱한
    엔진을 본 공허한 값이 아니라는 확인)로 쓴다. 시드도 같은 엔진을 쓰므로 테스트는 요청 직전에 비운다.
    """
    engine = create_engine(migrated_db, future=True)
    factory = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)
    checkouts: list[int] = []
    event.listen(engine, "checkout", lambda *_args: checkouts.append(1))
    try:
        yield SimpleNamespace(engine=engine, factory=factory, checkouts=checkouts)
    finally:
        app.dependency_overrides.clear()
        engine.dispose()


class _ProbePool(InMemoryCognitoUserPool):
    """Cognito 호출이 불리는 순간 풀 체크아웃 수를 적는 가짜 유저풀(네트워크 0건, 동작은 인메모리 그대로)."""

    def __init__(self, engine) -> None:
        super().__init__()
        self._engine = engine
        self.calls: list[tuple[str, int]] = []

    def _record(self, name: str) -> None:
        self.calls.append((name, self._engine.pool.checkedout()))

    def find_account(self, member_id):
        self._record("find_account")
        return super().find_account(member_id)

    def get_or_create_account(self, member_id):
        self._record("get_or_create_account")
        return super().get_or_create_account(member_id)

    def issue_tokens(self, account):
        self._record("issue_tokens")
        return super().issue_tokens(account)


def _wire_login(engine, factory) -> _ProbePool:
    """운영 배선(cognito 모드: 검증 체인 = LocalCredentialVerifier 하나)으로 로그인 두 단계를 띄운다.

    세션만 테스트 엔진으로, Cognito는 기록용 가짜로, 상태를 공유하는 동의 게이트·티켓은 테스트마다 새 인스턴스로
    바꾼다. 검증자·디렉터리는 실 배선(login_router.get_verifier/get_directory) 그대로다.
    """
    pool = _ProbePool(engine)
    gate = InMemoryConsentGate(_DEMO_CONSENT_DOCUMENTS)
    tickets = LoginTicketService()
    app.dependency_overrides[get_session] = _session_override(factory)
    app.dependency_overrides[get_cognito_pool] = lambda: pool
    app.dependency_overrides[get_consent_gate] = lambda: gate
    app.dependency_overrides[get_ticket_service] = lambda: tickets
    return pool


@pytest.fixture
def login(pg, monkeypatch) -> SimpleNamespace:
    monkeypatch.setattr(settings, "auth_backend", "cognito")
    pool = _wire_login(pg.engine, pg.factory)
    return SimpleNamespace(client=TestClient(app), pool=pool)


@pytest.fixture
def slow_bcrypt(pg, monkeypatch) -> SimpleNamespace:
    """bcrypt를 일부러 느리게 — 불리는 순간 풀 체크아웃 수를 적는다(대조·해시 결과는 진짜 그대로).

    ``checked_against``는 대조에 쓰인 저장 해시 — 없는 계정이 더미 해시로 대조됐는지 보는 데 쓴다.
    """
    seen = SimpleNamespace(checkpw=[], hashpw=[], checked_against=[])

    def checkpw(password, hashed):
        seen.checkpw.append(pg.engine.pool.checkedout())
        seen.checked_against.append(hashed.decode("utf-8"))
        time.sleep(SLOW_HASH_SECONDS)
        return _REAL_CHECKPW(password, hashed)

    def hashpw(password, salt):
        seen.hashpw.append(pg.engine.pool.checkedout())
        time.sleep(SLOW_HASH_SECONDS)
        return _REAL_HASHPW(password, salt)

    monkeypatch.setattr(bcrypt, "checkpw", checkpw)
    monkeypatch.setattr(bcrypt, "hashpw", hashpw)
    return seen


# =============================================================================
# 시드 — 전부 커밋된 실 레코드(태그로 유일하게: migrated_db는 세션 스코프 공유 DB다)
# =============================================================================
def _seed_event(factory) -> str:
    db = factory()
    try:
        ev = Event(name="로그인 몰림 행사", slug=f"login-surge-{uuid.uuid4().hex[:12]}")
        db.add(ev)
        db.commit()
        return str(ev.id)
    finally:
        db.close()


def _seed_member(
    factory, *, role: str | None, event_id: str | None = None, password: str | None = PASSWORD
) -> SimpleNamespace:
    """기업 + 담당자(기본 비밀번호 PASSWORD, None이면 해시 없음) — ``role``이 있으면 그 행사 역할까지(로그인 매핑 대상)."""
    tag = uuid.uuid4().hex[:10]
    email = f"login-surge-{tag}@example.com"
    db = factory()
    try:
        org = Organization(name_ko=f"로그인몰림기업-{tag}")
        db.add(org)
        db.flush()
        member = Member(
            organization_id=org.id,
            name="김담당",
            email=email,
            password_hash=_fast_hash(password) if password is not None else None,
        )
        db.add(member)
        if role is not None:
            db.add(
                OrganizationEventRole(
                    organization_id=org.id,
                    event_id=event_id or _seed_event(factory),
                    is_exhibitor=(role == "exhibitor"),
                    is_buyer=(role == "buyer"),
                )
            )
        db.commit()
        return SimpleNamespace(member_id=str(member.id), org_id=str(org.id), email=email)
    finally:
        db.close()


def _seed_operator(factory) -> SimpleNamespace:
    """organizers(member_id 연결) + event_organizers(master 배정)까지 가진 실 운영자."""
    account = _seed_member(factory, role=None)
    event_id = _seed_event(factory)
    db = factory()
    try:
        organizer = Organizer(
            name="실운영자", email=f"operator-{account.member_id}@example.com", member_id=account.member_id
        )
        db.add(organizer)
        db.flush()
        db.add(EventOrganizer(event_id=event_id, organizer_id=organizer.id, permission_level="master"))
        db.commit()
        return account
    finally:
        db.close()


def _stored_hash(factory, member_id: str) -> str | None:
    db = factory()
    try:
        return db.scalars(select(Member.password_hash).where(Member.id == member_id)).one()
    finally:
        db.close()


def _set_stored_hash(factory, member_id: str, password_hash: str) -> None:
    db = factory()
    try:
        db.get(Member, member_id).password_hash = password_hash
        db.commit()
    finally:
        db.close()


def _start(client: TestClient, email: str, password: str = PASSWORD):
    return client.post(START, json={"username": email, "password": password})


# =============================================================================
# (a) bcrypt·Cognito 동안 커넥션 0 — 로그인의 세 갈래
# =============================================================================
class TestNoConnectionHeldDuringHashOrCognito:
    def test_returning_member(self, pg, login, slow_bcrypt):
        account = _seed_member(pg.factory, role="buyer")
        login.pool.get_or_create_account(account.member_id)  # 재방문 — Cognito 계정이 이미 있다
        login.pool.calls.clear()
        pg.checkouts.clear()

        resp = _start(login.client, account.email)

        assert resp.status_code == 200
        body = resp.json()
        assert body["outcome"] == "succeeded"
        assert body["role"] == "buyer"
        assert body["access_token"]
        assert pg.checkouts  # 요청이 이 엔진의 커넥션을 실제로 썼다
        assert slow_bcrypt.checkpw == [0]  # 대조하는 동안엔 놓았다
        # 재방문 판정 → 세션 발급(계정 조회·토큰) — 순서는 예전 그대로, 셋 다 커넥션 없이.
        assert login.pool.calls == [("find_account", 0), ("find_account", 0), ("issue_tokens", 0)]
        assert pg.engine.pool.checkedout() == 0

    def test_first_login_start_then_complete(self, pg, login, slow_bcrypt):
        account = _seed_member(pg.factory, role="exhibitor")

        start = _start(login.client, account.email)

        assert start.status_code == 200
        assert start.json()["outcome"] == "consent_required"
        assert slow_bcrypt.checkpw == [0]
        assert login.pool.calls == [("find_account", 0)]

        login.pool.calls.clear()
        complete = login.client.post(
            COMPLETE,
            json={"login_ticket": start.json()["login_ticket"], "accepted_doc_ids": REQUIRED_DOCS},
        )

        assert complete.status_code == 200
        body = complete.json()
        assert body["outcome"] == "succeeded"
        assert body["role"] == "exhibitor"
        assert login.pool.calls == [
            ("find_account", 0),
            ("get_or_create_account", 0),
            ("issue_tokens", 0),
        ]
        assert pg.engine.pool.checkedout() == 0

    def test_registered_operator(self, pg, login, slow_bcrypt):
        account = _seed_operator(pg.factory)

        resp = _start(login.client, account.email)

        assert resp.status_code == 200
        body = resp.json()
        assert body["outcome"] == "succeeded"
        assert body["role"] == "organizer"
        assert body["route"] == "/organizer"
        assert slow_bcrypt.checkpw == [0]
        # 운영자 판정(DB 조회) 뒤 곧장 세션 발급 — 그 호출들도 커넥션 없이.
        assert login.pool.calls == [
            ("find_account", 0),
            ("get_or_create_account", 0),
            ("issue_tokens", 0),
        ]
        assert pg.engine.pool.checkedout() == 0

    def test_rejections_and_not_found_hold_nothing(self, pg, login, slow_bcrypt):
        account = _seed_member(pg.factory, role="buyer")

        wrong = _start(login.client, account.email, "WrongPass2026")
        assert wrong.json() == {"outcome": "rejected", "reason": "invalid_credentials"}
        assert slow_bcrypt.checkpw == [0]

        # 없는 계정도 더미 해시로 bcrypt를 한 번 치른다(응답 시간으로 계정 존재를 못 떠보게) — 역시 커넥션 없이.
        unknown = _start(login.client, f"nobody-{uuid.uuid4().hex[:8]}@example.com")
        assert unknown.json() == {"outcome": "rejected", "reason": "invalid_credentials"}
        assert slow_bcrypt.checkpw == [0, 0]
        assert slow_bcrypt.checked_against[-1] == _DUMMY_PASSWORD_HASH

        # 비밀번호는 맞지만 행사 역할이 없다 — 명단 매핑 실패(not_found), Cognito는 부르지 않는다.
        orphan = _seed_member(pg.factory, role=None)
        not_found = _start(login.client, orphan.email)
        assert not_found.json() == {"outcome": "not_found"}
        assert slow_bcrypt.checkpw == [0, 0, 0]
        assert login.pool.calls == []
        assert pg.engine.pool.checkedout() == 0


# =============================================================================
# (a-2) 계정 존재 여부가 응답 시간으로 드러나지 않는다 — 없는 계정·비밀번호 없는 계정도 bcrypt 1회(같은 자리)
# =============================================================================
class TestUnknownAccountsCostOneBcryptToo:
    def test_unknown_email_and_passwordless_member_are_checked_against_the_dummy_hash(
        self, pg, login, slow_bcrypt
    ):
        passwordless = _seed_member(pg.factory, role="buyer", password=None)  # 명단만 있고 비밀번호 미설정
        emails = [f"nobody-{uuid.uuid4().hex[:8]}@example.com", passwordless.email]

        for email in emails:
            resp = _start(login.client, email)
            assert resp.json() == {"outcome": "rejected", "reason": "invalid_credentials"}

        # 진짜 계정의 틀린 비밀번호와 똑같이 bcrypt 1회씩 — 대조 대상만 더미 해시다(결과는 버린다).
        assert slow_bcrypt.checkpw == [0, 0]
        assert slow_bcrypt.checked_against == [_DUMMY_PASSWORD_HASH, _DUMMY_PASSWORD_HASH]

    def test_dummy_hash_costs_the_same_as_real_hashes(self):
        # 운영 해시는 gensalt() 기본(cost 12)이다 — 더미도 같은 cost여야 걸리는 시간이 같다.
        assert _DUMMY_PASSWORD_HASH.startswith("$2b$12$")
        assert bcrypt.gensalt().startswith(b"$2b$12$")
        assert _REAL_CHECKPW(PASSWORD.encode(), _DUMMY_PASSWORD_HASH.encode()) is False

    def test_unknown_email_goes_through_the_same_hash_slot(self, pg, login, monkeypatch):
        """없는 계정도 같은 자리를 거친다 — 자리가 꽉 차면 있는 계정과 똑같이 503(빠른 거절로 구분되지 않는다)."""
        monkeypatch.setattr(settings, "password_hash_max_concurrency", 1)
        monkeypatch.setattr(settings, "password_hash_acquire_timeout_seconds", 0.05)
        existing = _seed_member(pg.factory, role="buyer")

        with password_hash_slot():
            unknown = _start(login.client, f"nobody-{uuid.uuid4().hex[:8]}@example.com")
            known = _start(login.client, existing.email)

        assert unknown.status_code == known.status_code == 503
        assert unknown.json() == known.json() == BUSY_LOGIN


# =============================================================================
# (b) 해시 자리 포화 — 503 login_busy, 기다리는 동안 커넥션 0
# =============================================================================
class _ProbeSlots(threading.BoundedSemaphore):
    """요청이 해시 자리를 기다리기 시작하는 순간 풀 체크아웃 수를 적는다.

    제한 시간을 건 대기(``password_hash_slot``이 하는 것)만 적는다 — 테스트가 자리를 직접 쥐는 ``acquire()``는
    적지 않는다.
    """

    def __init__(self, value: int, engine) -> None:
        super().__init__(value)
        self._engine = engine
        self.checked_out_when_waiting: list[int] = []

    def acquire(self, blocking=True, timeout=None):
        if timeout is not None:
            self.checked_out_when_waiting.append(self._engine.pool.checkedout())
        return super().acquire(blocking, timeout)


class TestHashSlotsUnderLoad:
    def test_full_slots_return_503_login_busy_quickly_and_waiters_hold_no_connection(
        self, pg, login, monkeypatch
    ):
        monkeypatch.setattr(settings, "password_hash_acquire_timeout_seconds", 0.05)
        slots = _ProbeSlots(1, pg.engine)
        monkeypatch.setattr(credentials, "_hash_slots", lambda: slots)
        account = _seed_member(pg.factory, role="buyer")

        assert slots.acquire()  # 다른 로그인이 마지막 자리를 쥐고 해시 중인 상황
        try:
            started = time.monotonic()
            resp = _start(login.client, account.email)
            elapsed = time.monotonic() - started
        finally:
            slots.release()

        assert resp.status_code == 503
        assert resp.json() == BUSY_LOGIN
        assert elapsed < 2  # 제한 시간(0.05초) 근처에서 바로 거절 — 무한정 줄 서지 않는다
        assert slots.checked_out_when_waiting == [0]  # 자리를 기다리는 동안 커넥션을 쥐지 않았다
        assert login.pool.calls == []
        assert pg.engine.pool.checkedout() == 0

        # 자리가 나면 같은 요청이 그대로 통과한다 — 거절 경로가 자리를 새지 않았다.
        again = _start(login.client, account.email)
        assert again.status_code == 200
        assert again.json()["outcome"] == "consent_required"

    def test_slot_is_released_when_bcrypt_raises(self, monkeypatch):
        monkeypatch.setattr(settings, "password_hash_max_concurrency", 1)
        with pytest.raises(ValueError):
            check_password("whatever1", "not-a-bcrypt-hash")  # 깨진 해시 — bcrypt가 ValueError
        # 자리 1개짜리인데도 바로 다시 잡힌다 — 예외 경로가 자리를 돌려줬다.
        with password_hash_slot(timeout=0.01):
            pass

    def test_defaults_are_2_slots_10_second_wait_and_12_waiters(self, monkeypatch):
        """기본값 자체를 본다 — 프로세스 환경변수가 끼어들지 않게 해당 변수를 지운다(대소문자 무관하게 읽히므로 모두)."""
        from app.config import Settings

        fields = {
            "password_hash_max_concurrency",
            "password_hash_acquire_timeout_seconds",
            "password_hash_max_waiters",
        }
        for key in list(os.environ):
            if key.lower() in fields:
                monkeypatch.delenv(key)

        defaults = Settings(_env_file=None)
        assert defaults.password_hash_max_concurrency == 2
        assert defaults.password_hash_acquire_timeout_seconds == 10
        # 24 → 12(2026-10-06) — AI 채팅·업로드 자리와 합친 스레드 예산을 40 아래로(test_ai_concurrency의 예산 테스트).
        assert defaults.password_hash_max_waiters == 12


# =============================================================================
# (b-2) 대기 상한 — 이미 상한만큼 기다리면 줄을 서지 않고 즉시 503, 대기 수는 모든 경로에서 0으로 돌아온다
# =============================================================================
class _ExplodingSlots(threading.BoundedSemaphore):
    """빈 자리는 없고, 기다리기 시작하면 예외가 나는 자리 — '기다리는 도중 예외' 경로를 만든다."""

    def acquire(self, blocking=True, timeout=None):
        if not blocking:
            return False
        raise RuntimeError("대기 중 예외(테스트)")


class TestWaiterCap:
    @pytest.fixture
    def one_slot_one_waiter(self, monkeypatch):
        """자리 1개 · 대기 상한 1명 · 대기 제한 5초(즉시 거절이면 이보다 훨씬 빨라야 한다)."""
        monkeypatch.setattr(settings, "password_hash_max_concurrency", 1)
        monkeypatch.setattr(settings, "password_hash_max_waiters", 1)
        monkeypatch.setattr(settings, "password_hash_acquire_timeout_seconds", 5)
        reset_password_hash_slots()

    def test_full_waiting_line_rejects_login_immediately_without_blocking(
        self, pg, login, one_slot_one_waiter
    ):
        account = _seed_member(pg.factory, role="buyer")

        with password_hash_slot():  # 자리 1개는 해시 중
            waiter = _BlockedWaiter().start()  # 대기 상한 1명이 이미 줄을 섰다
            assert _wait_until(lambda: password_hash_waiters() == 1)

            started = time.monotonic()
            resp = _start(login.client, account.email)
            elapsed = time.monotonic() - started

            assert resp.status_code == 503
            assert resp.json() == BUSY_LOGIN
            assert elapsed < 1  # 대기 제한(5초)을 기다리지 않고 바로 거절 — 스레드를 붙잡지 않는다
            assert password_hash_waiters() == 1  # 거절된 요청은 대기 수에 남지 않는다
            assert pg.engine.pool.checkedout() == 0
        waiter.join()

        assert waiter.outcome == "acquired"  # 줄 서 있던 요청은 자리가 나자 그대로 진행됐다
        assert password_hash_waiters() == 0

    def test_full_waiting_line_rejects_other_hash_paths_with_server_busy(self, pg, one_slot_one_waiter):
        account = _seed_member(pg.factory, role="buyer")
        before = _stored_hash(pg.factory, account.member_id)

        with password_hash_slot():
            waiter = _BlockedWaiter().start()
            assert _wait_until(lambda: password_hash_waiters() == 1)
            started = time.monotonic()
            resp = _change_password(pg, account)
            elapsed = time.monotonic() - started
        waiter.join()

        assert resp.status_code == 503
        assert resp.json()["detail"]["code"] == "server_busy"
        assert elapsed < 1
        assert _stored_hash(pg.factory, account.member_id) == before

    def test_free_slot_is_taken_without_queueing_even_with_no_waiting_allowed(self, monkeypatch):
        monkeypatch.setattr(settings, "password_hash_max_waiters", 0)
        with password_hash_slot():  # 빈 자리는 대기 상한과 무관하게 바로 잡힌다
            assert password_hash_waiters() == 0

    def test_waiter_count_returns_to_zero_after_success(self, one_slot_one_waiter):
        with password_hash_slot():
            waiter = _BlockedWaiter().start()
            assert _wait_until(lambda: password_hash_waiters() == 1)
        waiter.join()

        assert waiter.outcome == "acquired"
        assert password_hash_waiters() == 0

    def test_waiter_count_returns_to_zero_after_timeout(self, one_slot_one_waiter):
        with password_hash_slot():
            with pytest.raises(PasswordHashBusyError):
                with password_hash_slot(timeout=0.05):
                    pass
            assert password_hash_waiters() == 0

    def test_waiter_count_returns_to_zero_when_waiting_raises(self, monkeypatch):
        monkeypatch.setattr(credentials, "_hash_slots", lambda: _ExplodingSlots(1))

        with pytest.raises(RuntimeError, match="대기 중 예외"):
            with password_hash_slot(timeout=1):
                pass

        assert password_hash_waiters() == 0

    def test_waiter_count_stays_zero_when_the_hash_itself_raises(self, one_slot_one_waiter):
        with pytest.raises(ValueError):
            check_password("whatever1", "not-a-bcrypt-hash")
        assert password_hash_waiters() == 0
        with password_hash_slot(timeout=0.01):  # 자리도 돌려줬다
            pass


# =============================================================================
# (c) 사건 재현 — 커넥션 1개짜리 풀에 느린 bcrypt 로그인이 동시에 몰려도 풀 대기 시간 초과가 없다
# =============================================================================
def test_one_connection_pool_survives_concurrent_slow_logins(migrated_db, monkeypatch):
    """예전 코드는 bcrypt 내내 커넥션을 쥐어, 풀 1개·대기 2초에서 0.5초짜리 대조 8건이 줄을 서면 5번째부터
    ``QueuePool limit ... timed out``(500)이 났다. 지금은 조회 구간(수 ms)에만 쥐므로 전부 통과한다."""
    engine = create_engine(migrated_db, future=True, pool_size=1, max_overflow=0, pool_timeout=2)
    factory = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)
    monkeypatch.setattr(settings, "auth_backend", "cognito")

    def slow_checkpw(password, hashed):
        time.sleep(0.5)
        return _REAL_CHECKPW(password, hashed)

    try:
        event_id = _seed_event(factory)
        accounts = [_seed_member(factory, role="buyer", event_id=event_id) for _ in range(8)]
        monkeypatch.setattr(bcrypt, "checkpw", slow_checkpw)
        _wire_login(engine, factory)

        with ThreadPoolExecutor(max_workers=len(accounts)) as executor:
            responses = list(
                executor.map(lambda account: _start(TestClient(app), account.email), accounts)
            )

        assert [r.status_code for r in responses] == [200] * len(accounts)
        assert {r.json()["outcome"] for r in responses} == {"consent_required"}
        assert engine.pool.checkedout() == 0
    finally:
        app.dependency_overrides.clear()
        engine.dispose()


# =============================================================================
# (d) 그 밖의 해시 경로 — 셀프 비밀번호 변경·자체가입
# =============================================================================
def _principal_via_session(member_id: str, organization_id: str):
    """실 ``get_current_principal``처럼 요청 세션으로 한 번 조회한다 — 이 SELECT가 요청 커넥션을 잡는다."""

    def principal(db: Session = Depends(get_session)) -> Principal:
        db.execute(text("SELECT 1"))
        return Principal(member_id=member_id, organization_id=organization_id)

    return principal


def _change_password(pg, account: SimpleNamespace, *, current: str = PASSWORD, new: str = NEW_PASSWORD):
    app.dependency_overrides[get_session] = _session_override(pg.factory)
    app.dependency_overrides[get_current_principal] = _principal_via_session(
        account.member_id, account.org_id
    )
    return TestClient(app).post(CHANGE_PASSWORD, json={"current_password": current, "new_password": new})


def _logs_in(factory, email: str, password: str) -> bool:
    db = factory()
    try:
        return isinstance(LocalCredentialVerifier(db).verify(email, password), VerifyOk)
    finally:
        db.close()


class TestOtherHashPaths:
    def test_change_password_holds_no_connection_while_hashing(self, pg, slow_bcrypt):
        account = _seed_member(pg.factory, role="buyer")
        pg.checkouts.clear()

        resp = _change_password(pg, account)

        assert resp.status_code == 200
        assert pg.checkouts
        assert slow_bcrypt.checkpw == [0]  # 현재 비밀번호 대조
        assert slow_bcrypt.hashpw == [0]  # 새 비밀번호 해시
        assert pg.engine.pool.checkedout() == 0
        # 쓰기는 다시 읽은 세션으로 커밋됐다 — 새 비밀번호로 들어오고 옛 비밀번호는 막힌다.
        assert _logs_in(pg.factory, account.email, NEW_PASSWORD)
        assert not _logs_in(pg.factory, account.email, PASSWORD)

    def test_change_password_does_not_overwrite_a_change_made_while_hashing(self, pg, monkeypatch):
        account = _seed_member(pg.factory, role="buyer")
        other_tab_hash = _fast_hash("OtherTab2026")

        def hashpw_while_another_tab_changes_it(password, salt):
            # 현재 비밀번호를 대조한 뒤 새 해시를 만드는 사이, 다른 탭(또는 운영자 재설정)이 먼저 바꿨다.
            _set_stored_hash(pg.factory, account.member_id, other_tab_hash)
            return _REAL_HASHPW(password, salt)

        monkeypatch.setattr(bcrypt, "hashpw", hashpw_while_another_tab_changes_it)

        resp = _change_password(pg, account)

        # 방금 확인한 "현재 비밀번호"는 더 이상 현재 값이 아니다 — 덮어쓰지 않고 불일치로 돌려보낸다.
        assert resp.status_code == 403
        assert resp.json()["detail"]["code"] == "INVALID_CREDENTIALS"
        assert _stored_hash(pg.factory, account.member_id) == other_tab_hash

    def test_change_password_busy_is_503_server_busy_not_500(self, pg, monkeypatch):
        monkeypatch.setattr(settings, "password_hash_max_concurrency", 1)
        monkeypatch.setattr(settings, "password_hash_acquire_timeout_seconds", 0.05)
        account = _seed_member(pg.factory, role="buyer")
        before = _stored_hash(pg.factory, account.member_id)

        with password_hash_slot():  # 로그인 몰림으로 자리가 꽉 찬 상황
            resp = _change_password(pg, account)

        assert resp.status_code == 503
        assert resp.json()["detail"]["code"] == "server_busy"
        assert _stored_hash(pg.factory, account.member_id) == before
        assert pg.engine.pool.checkedout() == 0

    def test_signup_hashes_before_touching_the_db(self, pg, slow_bcrypt):
        event_id = _seed_event(pg.factory)
        email = f"signup-surge-{uuid.uuid4().hex[:10]}@example.com"
        token = get_email_verify_ticket_service().issue({"email": email})
        app.dependency_overrides[get_session] = _session_override(pg.factory)
        pg.checkouts.clear()

        resp = TestClient(app).post(
            "/api/auth/signup",
            json={
                "email": email,
                "password": PASSWORD,
                "name": "가입자",
                "org_name_ko": f"가입몰림기업-{uuid.uuid4().hex[:8]}",
                "role": "buyer",
                "event_id": event_id,
                "email_verification_token": token,
            },
        )

        assert resp.status_code == 201, resp.text
        assert slow_bcrypt.hashpw == [0]  # 해시는 요청 세션이 커넥션을 잡기 전에 끝났다
        assert pg.checkouts
        assert pg.engine.pool.checkedout() == 0
        assert _logs_in(pg.factory, email, PASSWORD)


# =============================================================================
# (e) 72바이트를 넘는 비밀번호는 평범한 불일치, 깨진 저장 해시만 로그 + 500(교차리뷰 MEDIUM)
# =============================================================================
class TestOverlongPasswordAndCorruptHash:
    def test_overlong_password_login_is_an_ordinary_rejection(self, pg, login, slow_bcrypt):
        account = _seed_member(pg.factory, role="buyer")
        assert len(OVERLONG_PASSWORD.encode("utf-8")) > 72

        known = _start(login.client, account.email, OVERLONG_PASSWORD)
        unknown = _start(login.client, f"nobody-{uuid.uuid4().hex[:8]}@example.com", OVERLONG_PASSWORD)

        # 예전엔 bcrypt ValueError로 500("로그인 요청이 많아요")이었다 — 이제 틀린 비밀번호와 같은 결과.
        assert known.status_code == unknown.status_code == 200
        assert known.json() == unknown.json() == {"outcome": "rejected", "reason": "invalid_credentials"}
        assert slow_bcrypt.checkpw == []  # 대조할 것도 없이 불일치 — bcrypt도 자리도 쓰지 않는다

    def test_overlong_current_password_on_change_is_403_not_500(self, pg):
        account = _seed_member(pg.factory, role="buyer")
        before = _stored_hash(pg.factory, account.member_id)

        resp = _change_password(pg, account, current=OVERLONG_PASSWORD)

        assert resp.status_code == 403
        assert resp.json()["detail"]["code"] == "INVALID_CREDENTIALS"
        assert _stored_hash(pg.factory, account.member_id) == before

    def test_overlong_input_is_false_without_taking_a_slot(self, monkeypatch):
        monkeypatch.setattr(settings, "password_hash_max_concurrency", 1)
        monkeypatch.setattr(settings, "password_hash_max_waiters", 0)
        stored = _fast_hash(PASSWORD)

        with password_hash_slot():  # 자리가 꽉 차 있어도(대기도 불가) 자리를 찾지 않으므로 바로 False
            assert check_password("a" * 73, stored) is False
            assert check_password(OVERLONG_PASSWORD, stored) is False

    def test_72_bytes_exactly_is_still_compared(self):
        password = "Ab1" + "x" * 69  # 정확히 72바이트 — 정책이 허용하는 최대 길이는 그대로 대조한다
        assert len(password.encode("utf-8")) == 72
        assert check_password(password, _fast_hash(password)) is True

    def test_corrupted_stored_hash_is_logged_and_raised(self, caplog, monkeypatch):
        # 같은 테스트 세션에서 migrated_db가 alembic을 돌리면 env.py의 fileConfig가 그 전에 만들어진 로거를 끈다
        # (disable_existing_loggers 기본값) — 테스트 실행 순서와 무관하게 이 로거의 출력을 보도록 다시 켠다.
        monkeypatch.setattr(logging.getLogger("app.auth.credentials"), "disabled", False)
        with caplog.at_level(logging.ERROR, logger="app.auth.credentials"):
            with pytest.raises(ValueError):
                check_password("whatever1", "corrupted-hash-value")

        messages = [record.getMessage() for record in caplog.records]
        assert any("bcrypt 형식이 아니다" in message for message in messages)
        # 로그에 평문·해시를 싣지 않는다.
        assert not any("whatever1" in message or "corrupted-hash-value" in message for message in messages)

    def test_login_against_a_corrupted_stored_hash_is_a_500(self, pg, monkeypatch):
        monkeypatch.setattr(settings, "auth_backend", "cognito")
        account = _seed_member(pg.factory, role="buyer")
        _set_stored_hash(pg.factory, account.member_id, "corrupted-hash-value")
        _wire_login(pg.engine, pg.factory)

        resp = _start(TestClient(app, raise_server_exceptions=False), account.email)

        # 데이터 손상은 불일치로 덮지 않는다 — 500으로 드러나 로그를 보고 고칠 일이다(로그는 위 테스트).
        assert resp.status_code == 500
        assert pg.engine.pool.checkedout() == 0
