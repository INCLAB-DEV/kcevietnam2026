"""DB 엔진·세션·선언적 Base. 모든 DB 접근은 여기를 거친다(FastAPI가 DB 소유 — ADR-0008)."""

from sqlalchemy import create_engine, event
from sqlalchemy.orm import (
    DeclarativeBase,
    ORMExecuteState,
    Session,
    SessionTransaction,
    sessionmaker,
)

from app.config import settings

# 풀 크기·대기 시간은 설정에서 받는다(config.db_pool_* 주석 참고) — 기본 풀(5+10, 30초)은 행사 당일
# 동시 요청에서 고갈되고, 고갈되면 요청이 30초씩 묶인 뒤에야 실패했다.
engine = create_engine(
    settings.database_url,
    future=True,
    pool_size=settings.db_pool_size,
    max_overflow=settings.db_max_overflow,
    pool_timeout=settings.db_pool_timeout,
    pool_pre_ping=settings.db_pool_pre_ping,
)
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)


class Base(DeclarativeBase):
    """모든 ORM 모델의 베이스. Alembic이 이 metadata로 마이그레이션을 자동생성/비교한다."""


def get_session():
    """FastAPI 의존성 — 요청당 세션."""
    db = SessionLocal()
    try:
        yield db
    except Exception:
        db.rollback()  # 적재 중 예외 시 미커밋 트랜잭션을 명시적으로 폐기(close()의 암묵 롤백에 의존하지 않음)
        raise
    finally:
        db.close()


# --- "커밋하지 않은 쓰기" 표시(release_connection 가드용) ------------------------------------------------
# flush(ORM 변경을 DB에 반영)나 세션으로 실행한 INSERT/UPDATE/DELETE 문이 표시를 켜고, **바깥(최상위) 트랜잭션**이
# 끝나면(commit·rollback·close) 끈다. 세이브포인트(begin_nested)의 commit/rollback으로는 끄지 않는다 — 세이브포인트를
# 풀어도 바깥 트랜잭션의 쓰기는 아직 커밋 전이다(세이브포인트를 되돌려 그 안의 쓰기가 사라졌어도 바깥이 끝날 때까지는
# 켜 둔다 — 보수적으로). ``after_commit``/``after_rollback``은 세이브포인트에서도 불려 쓰지 않는다.
# 이벤트는 SessionLocal이 아니라 Session 클래스에 건다 — sessionmaker_like가 만든 세션·테스트 세션에도 같은 표시가
# 붙어야 가드가 어느 세션에서든 같은 뜻을 가진다(표시는 세션마다 따로인 ``Session.info``에 둔다).
_UNSAVED_WRITES = "nabi_unsaved_writes"


@event.listens_for(Session, "after_flush")
def _mark_flushed_writes(session: Session, _flush_context) -> None:
    session.info[_UNSAVED_WRITES] = True


@event.listens_for(Session, "do_orm_execute")
def _mark_executed_dml(state: ORMExecuteState) -> None:
    # insert()/update()/delete() 문(ORM·Core 모두)만 잡는다. text()로 쓴 DML은 종류를 알 수 없어 못 잡는다 — 이
    # 코드베이스는 세션으로 text DML을 실행하지 않는다(새로 쓴다면 insert()/update()/delete()로 쓴다).
    if state.is_insert or state.is_update or state.is_delete:
        state.session.info[_UNSAVED_WRITES] = True


@event.listens_for(Session, "after_transaction_end")
def _clear_when_outermost_transaction_ends(session: Session, transaction: SessionTransaction) -> None:
    if transaction.parent is None:
        session.info.pop(_UNSAVED_WRITES, None)


def _has_unsaved_writes(db: Session) -> bool:
    """닫으면(close = 롤백) 사라질 작업이 있는가 — 아직 flush 안 한 변경, 또는 이번 트랜잭션에서 flush·실행한 쓰기.

    dirty는 같은 값을 다시 넣어도 잡히는 낙관적 표시라 ``is_modified``로 값이 실제로 바뀐 객체만 센다.
    """
    if db.new or db.deleted:
        return True
    if any(db.is_modified(obj) for obj in db.dirty):
        return True
    return bool(db.info.get(_UNSAVED_WRITES))


def release_connection(db: Session) -> None:
    """요청 세션이 쥔 커넥션을 지금 풀에 돌려준다 — 외부 호출(OpenAI·S3·Cognito)·bcrypt를 기다리기 직전에 부른다.

    FastAPI(0.138)는 yield 의존성(``get_session``)을 **응답과 BackgroundTasks가 다 끝난 뒤에야** 정리한다.
    그래서 인증(``get_current_principal``)이 SELECT 한 번만 해도 그 커넥션은 'idle in transaction'으로
    요청이 끝날 때까지 묶인다 — OpenAI를 수십 초 기다리는 요청이 몰리면 풀이 통째로 잠기고, DB를 잠깐만
    쓰는 다른 모든 API까지 풀 대기로 멈춘다.

    전제: 여기까지 이 세션으로는 **읽기만** 했다. 커밋하지 않은 쓰기(아직 flush 안 한 변경, 또는 flush·실행했지만
    커밋 전인 쓰기)가 있으면 놓지 않고 ``RuntimeError``를 던진다 — close()는 그 쓰기를 조용히 롤백해 버려서,
    호출부가 나중에 커밋할 생각이던 작업(예: 가드가 flush만 해 둔 운영자 신원 행)을 소리 없이 잃는다. 그런 경로는
    먼저 commit하거나, 쓰기 전에 놓도록 순서를 바꾼다. 닫힌 세션은 다시 써도 된다 — 다음 쿼리에서 새 커넥션을
    받는다 — 그리고 ``get_session`` 정리 단계의 close()는 두 번 불려도 무해하다.
    """
    if _has_unsaved_writes(db):
        raise RuntimeError(
            "release_connection: 이 세션에 커밋하지 않은 쓰기가 있다 — 지금 놓으면(close) 롤백돼 사라진다. "
            "먼저 commit하거나, 쓰기 전에 커넥션을 놓도록 순서를 바꿔라."
        )
    db.close()


def sessionmaker_like(db: Session) -> sessionmaker:
    """요청 세션과 **같은 DB 엔진**에 붙는 새 세션 팩토리 — 백그라운드 스레드가 자기 세션을 열 때 쓴다.

    Session은 thread-safe가 아니라 요청 세션을 다른 스레드에 넘기면 안 된다. 그렇다고 백그라운드가 무조건
    ``SessionLocal``을 쓰면, ``get_session``을 다른 DB로 갈아끼운 환경(격리 테스트 DB 등)에서 요청과 다른
    DB에 기록하게 된다 — 그래서 요청 세션의 엔진에서 새로 판다(프로덕션에선 SessionLocal과 같은 엔진).
    bind가 Connection이어도 그 ``.engine``을 쓴다 — 진행 중인 커넥션 자체는 스레드 간에 공유하지 않는다.
    """
    return sessionmaker(bind=db.get_bind().engine, autoflush=False, autocommit=False, future=True)
