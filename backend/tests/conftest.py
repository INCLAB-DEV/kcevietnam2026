"""통합 테스트 인프라 — 격리된 Postgres 테스트 DB에 마이그레이션을 적용해 검증한다.

공유 개발 DB(병렬 잡이 함께 쓰는)를 건드리지 않도록 전용 DB(nabi_consent_test)를 만들고,
Alembic upgrade head로 스키마+시드를 올린다. Postgres에 못 붙으면 통합 테스트 전체를 skip한다
(순수 규칙 테스트는 DB 없이도 항상 돈다).

roster-import 통합 테스트(F-OP-002)는 이 격리 DB 위에서 `db_session`(트랜잭션+롤백) 픽스처로 돈다 —
공유 dev DB가 아니라 migrated_db라 기존 커밋 데이터 오염 없이 매 테스트가 빈 상태에서 시작한다.
"""

from __future__ import annotations

import pytest
from fastapi import Header, HTTPException, status
from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url
from sqlalchemy.orm import Session

from app.auth.principal import Principal
from app.config import settings
from app.models import Event
from app.notifications.bulk_dispatch import shutdown_bulk_email

TEST_DB_NAME = "nabi_consent_test"

# 앱 lifespan의 고아 전사 작업 정리(시작 시 이전 프로세스가 남긴 pending → error)는 설정된 DB에 바로 쓴다.
# 테스트가 ``with TestClient(app)``로 lifespan을 띄울 때 공유 개발 DB(다른 작업자의 서버가 쓰는)의 작업을
# 건드리지 않게 테스트 세션 전체에서 기본으로 끈다. 이 동작을 검증하는 테스트는 monkeypatch로 켜고 저장소를
# 격리한다(test_ai_concurrency.TestOrphanedJobsOnStartup).
settings.transcription_fail_orphans_on_startup = False


@pytest.fixture(autouse=True)
def _fresh_bulk_email_worker():
    """일괄 메일 발송 스레드(프로세스 싱글턴)를 테스트마다 비운다 — 앞 테스트가 남긴 발송 묶음이 다음 테스트의
    DB·smtplib 대역에 섞이지 않게. 진행 중인 발송은 끝까지 기다린다(테스트가 게이트를 쥔 채 끝나면 그 게이트의
    타임아웃만큼만 기다린다)."""
    yield
    shutdown_bulk_email(wait=True)


def header_principal(
    x_org_id: str | None = Header(default=None),
    x_member_id: str | None = Header(default=None),
) -> Principal:
    """테스트 전용 ``get_current_principal`` 대체 — 헤더로 주체를 고정한다.

    ``app.dependency_overrides[get_current_principal] = header_principal``로 끼운다. 실 인증
    (JWT 검증·데모 토큰·DB 조회)을 타지 않으므로 도메인 동작만 검사할 수 있고, 요청마다 다른
    주체로 부르는 테스트(내 리뷰 vs 남의 리뷰)를 헤더 하나로 표현할 수 있다.

    ⚠ **프로덕션 경로가 헤더를 믿는다는 뜻이 아니다.** 실제 라우트는 서명된 세션에서만 주체를
    도출한다 — 헤더만으로는 401이라는 사실은 각 슬라이스의 위조 회귀 테스트가 따로 지킨다.

    ``X-Member-Id``는 생략 가능하다. 생략하면 UUID가 아닌 값이 실려, member FK 기록 경로
    (알림 ``read_by_member_id``)가 "기록할 수 없는 주체"로 흐른다 — 데모 토큰 subject와 같은 상태.
    """
    if not x_org_id:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="인증 정보(Organization) 없음"
        )
    return Principal(member_id=x_member_id or f"member-of-{x_org_id}", organization_id=x_org_id)


# =============================================================================
# 참가자 알림 메일 스위치(nt004mail0001) — 기본값이 **꺼짐**이다(2026-10-16 발주사 결정).
# 자동 알림 메일이 나가는 것을 검증하는 테스트는 아래 헬퍼로 그 행사의 스위치를 먼저 켠다 — 운영에서 마스터가
# 행사 설정에서 켜는 것과 같은 상태(event_schedule_settings.participant_email_enabled = true)다.
# =============================================================================
def set_participant_email(db: Session, event_id: str, enabled: bool) -> None:
    """행사 설정 "참가자 알림 메일"을 정한다(설정 행이 없으면 만든다) — 어드민 PATCH가 하는 일을 DB에 직접."""
    from sqlalchemy import select

    from app.models import EventScheduleSettings

    row = db.execute(
        select(EventScheduleSettings).where(EventScheduleSettings.event_id == event_id)
    ).scalar_one_or_none()
    if row is None:
        db.add(EventScheduleSettings(event_id=event_id, participant_email_enabled=enabled))
    else:
        row.participant_email_enabled = enabled
    db.commit()


def enable_participant_email(db_factory, event_id: str) -> None:
    """그 행사의 참가자 알림 메일을 켠다(새 세션으로) — ``db_factory``만 들고 있는 API 테스트용."""
    db = db_factory()
    try:
        set_participant_email(db, str(event_id), True)
    finally:
        db.close()


@pytest.fixture()
def participant_email_forced_on(monkeypatch):
    """스위치를 행사 설정 행 없이 켠 것으로 본다 — **설정 행을 만들 수 없는** 테스트 전용이다.

    DB 없이 도는 단위 테스트(비-UUID 행사 id — 러브콜 메일 API 테스트의 InMemory 미팅도 여기 든다)와 "설정 행이
    없는 행사"가 전제인 테스트는 행을 만들어 켜면 전제가 깨진다. 그것들만 스위치를 읽는 함수 하나를 켜짐으로
    바꾼다 — 나머지는 ``enable_participant_email``. 호출부는 모듈 속성으로 불러야 이 교체가 닿는다
    (``notification_service.participant_email_enabled_for_event(...)`` — 이름을 직접 import하면 안 된다).
    """
    from app.notifications import service as notification_service

    monkeypatch.setattr(
        notification_service, "participant_email_enabled_for_event", lambda _db, _event_id: True
    )


def _postgres_reachable() -> bool:
    try:
        eng = create_engine(settings.database_url)
        with eng.connect() as c:
            c.execute(text("select 1"))
        eng.dispose()
        return True
    except Exception:
        return False


@pytest.fixture(scope="session")
def test_db_url() -> str:
    """격리 테스트 DB를 만들고(있으면 재생성) URL을 돌려준다. 세션 끝에 drop."""
    if not _postgres_reachable():
        pytest.skip("Postgres 미가용 — 통합 테스트 skip")

    base_url = make_url(settings.database_url)
    admin_url = base_url.set(database="postgres")
    test_url = base_url.set(database=TEST_DB_NAME)

    admin = create_engine(admin_url, isolation_level="AUTOCOMMIT")
    with admin.connect() as c:
        c.execute(text(f"DROP DATABASE IF EXISTS {TEST_DB_NAME} WITH (FORCE)"))
        c.execute(text(f"CREATE DATABASE {TEST_DB_NAME}"))
    admin.dispose()

    yield test_url.render_as_string(hide_password=False)

    admin = create_engine(admin_url, isolation_level="AUTOCOMMIT")
    with admin.connect() as c:
        c.execute(text(f"DROP DATABASE IF EXISTS {TEST_DB_NAME} WITH (FORCE)"))
    admin.dispose()


@pytest.fixture(scope="session")
def migrated_db(test_db_url: str) -> str:
    """테스트 DB에 alembic upgrade head(스키마 + v1 시드)를 적용한다.

    env.py가 app.config.settings.database_url을 읽으므로 그 값을 테스트 DB로 바꿔 마이그레이션을
    격리 DB로 보낸다. (up/down 왕복 검증은 데이터 없는 별도 DB에서 — empty_db_url 참고. 동의
    데이터가 쌓인 DB에서 시드를 되돌리면 FK상 막히는 게 정상이라 여기선 downgrade하지 않는다.)
    """
    from alembic import command
    from alembic.config import Config

    original = settings.database_url
    settings.database_url = test_db_url
    cfg = Config("alembic.ini")
    try:
        command.upgrade(cfg, "head")
        yield test_db_url
    finally:
        settings.database_url = original


@pytest.fixture()
def empty_db_url() -> str:
    """데이터 없는 빈 격리 DB(스키마 미적용). 마이그레이션 up/down 왕복 검증용."""
    if not _postgres_reachable():
        pytest.skip("Postgres 미가용 — 통합 테스트 skip")

    base_url = make_url(settings.database_url)
    admin_url = base_url.set(database="postgres")
    db_name = "nabi_consent_migr_test"
    url = base_url.set(database=db_name)

    admin = create_engine(admin_url, isolation_level="AUTOCOMMIT")
    with admin.connect() as c:
        c.execute(text(f"DROP DATABASE IF EXISTS {db_name} WITH (FORCE)"))
        c.execute(text(f"CREATE DATABASE {db_name}"))
    admin.dispose()

    yield url.render_as_string(hide_password=False)

    admin = create_engine(admin_url, isolation_level="AUTOCOMMIT")
    with admin.connect() as c:
        c.execute(text(f"DROP DATABASE IF EXISTS {db_name} WITH (FORCE)"))
    admin.dispose()


@pytest.fixture
def db_session(migrated_db: str):
    """roster-import용 롤백 격리 세션. 격리 DB(migrated_db)에 커넥션 트랜잭션을 열고,

    import_roster의 flush/commit이 savepoint 안에서 일어나며 끝에 통째로 롤백된다 — 매 테스트가
    빈 상태에서 시작하고 서로 간섭하지 않는다.
    """
    eng = create_engine(migrated_db)
    connection = eng.connect()
    transaction = connection.begin()
    session = Session(bind=connection, join_transaction_mode="create_savepoint")
    try:
        yield session
    finally:
        session.close()
        transaction.rollback()
        connection.close()
        eng.dispose()


@pytest.fixture
def event(db_session: Session) -> Event:
    """적재 대상 이벤트 한 건(롤백 범위 내)."""
    ev = Event(name="DX Korea 2026", slug="dx-korea-2026")
    db_session.add(ev)
    db_session.flush()
    return ev
