"""``app.db.release_connection`` 가드 — 커밋하지 않은 쓰기가 있는 세션은 조용히 닫지(=롤백) 않고 멈춘다.

배경(2026-10-03 교차리뷰 MEDIUM): ``release_connection``은 외부 호출·bcrypt를 기다리기 전에 요청 세션을 close()한다.
close()는 커밋 안 한 쓰기를 롤백하므로, 쓰기가 남은 세션에서 부르면 호출부가 나중에 커밋할 생각이던 작업이 소리 없이
사라진다(예: 운영자 가드가 flush만 해 둔 신원 행). 그래서 그런 세션이면 놓지 않고 RuntimeError를 던진다.

잠그는 것:
- 읽기만 한 세션·커밋을 마친 세션은 그대로 놓는다(커넥션 반납).
- 아직 flush 안 한 변경(add·delete·값이 바뀐 객체), flush만 한 쓰기, 세션으로 실행한 UPDATE 문은 거부한다 — 거부할 때
  세션을 닫지 않는다(작업이 그대로 남아 호출부가 커밋·롤백을 고를 수 있다).
- 같은 값을 다시 넣은 객체(dirty지만 바뀐 게 없음)는 쓰기로 치지 않는다.
- 세이브포인트 안의 쓰기는 세이브포인트를 풀거나 되돌려도 바깥 트랜잭션이 끝날 때까지 쓰기로 본다(보수적으로).

격리 Postgres(``migrated_db``) 위의 테스트 전용 엔진으로 잰다 — 없으면 conftest 규칙대로 skip.
"""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import create_engine, text, update
from sqlalchemy.orm import sessionmaker

from app.db import release_connection
from app.models import Organization


@pytest.fixture
def pg(migrated_db):
    engine = create_engine(migrated_db, future=True)
    factory = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)
    yield factory, engine
    engine.dispose()


def _org() -> Organization:
    return Organization(name_ko=f"가드테스트기업-{uuid.uuid4().hex[:10]}")


def _committed_org(factory) -> str:
    db = factory()
    try:
        org = _org()
        db.add(org)
        db.commit()
        return str(org.id)
    finally:
        db.close()


def test_read_only_session_is_released(pg):
    factory, engine = pg
    db = factory()
    db.execute(text("SELECT 1"))
    assert engine.pool.checkedout() == 1

    release_connection(db)

    assert engine.pool.checkedout() == 0


def test_session_is_released_after_its_writes_are_committed(pg):
    factory, engine = pg
    db = factory()
    db.add(_org())
    db.commit()
    db.execute(text("SELECT 1"))  # 커밋 뒤 새 트랜잭션은 읽기만

    release_connection(db)

    assert engine.pool.checkedout() == 0


def test_pending_add_is_refused(pg):
    factory, _ = pg
    db = factory()
    try:
        db.add(_org())  # autoflush=False — 아직 DB에 가지 않은 변경
        with pytest.raises(RuntimeError, match="커밋하지 않은 쓰기"):
            release_connection(db)
        assert len(db.new) == 1  # 닫지 않았다 — 작업이 그대로 남아 있다
    finally:
        db.rollback()
        db.close()


def test_flushed_but_uncommitted_write_is_refused_and_the_connection_kept(pg):
    factory, engine = pg
    db = factory()
    try:
        org = _org()
        db.add(org)
        db.flush()
        assert not db.new  # flush 뒤라 보류 중인 변경은 없다 — 남은 건 DB 트랜잭션 안의 쓰기다

        with pytest.raises(RuntimeError, match="커밋하지 않은 쓰기"):
            release_connection(db)

        assert engine.pool.checkedout() == 1  # 놓지 않았다 — 커밋할지 되돌릴지는 호출부가 고른다
        db.commit()
        assert db.get(Organization, org.id) is not None  # 거부가 작업을 날리지 않았다
    finally:
        db.close()


def test_update_statement_executed_through_the_session_is_refused(pg):
    factory, _ = pg
    org_id = _committed_org(factory)
    db = factory()
    try:
        db.execute(update(Organization).where(Organization.id == org_id).values(name_ko="바뀐이름"))
        with pytest.raises(RuntimeError, match="커밋하지 않은 쓰기"):
            release_connection(db)
    finally:
        db.rollback()
        db.close()


def test_modified_object_is_refused_but_rewriting_the_same_value_is_not(pg):
    factory, engine = pg
    org_id = _committed_org(factory)

    db = factory()
    try:
        org = db.get(Organization, org_id)
        org.name_ko = org.name_ko  # 같은 값 — dirty로 잡히지만 바뀐 게 없다
        assert db.dirty
        release_connection(db)
        assert engine.pool.checkedout() == 0

        org = db.get(Organization, org_id)  # 닫힌 세션은 새 커넥션으로 다시 읽는다
        org.name_ko = f"{org.name_ko}-바뀜"
        with pytest.raises(RuntimeError, match="커밋하지 않은 쓰기"):
            release_connection(db)
    finally:
        db.rollback()
        db.close()


def test_savepoint_writes_count_until_the_outer_transaction_ends(pg):
    """세이브포인트를 풀어도 바깥 트랜잭션은 아직 커밋 전이고, 되돌려도 바깥이 끝날 때까지는 보수적으로 쓰기로 본다."""
    factory, engine = pg
    db = factory()
    try:
        nested = db.begin_nested()
        db.add(_org())
        db.flush()
        nested.commit()  # 세이브포인트 해제 — 바깥 트랜잭션의 쓰기는 아직 커밋 전
        with pytest.raises(RuntimeError, match="커밋하지 않은 쓰기"):
            release_connection(db)

        db.rollback()  # 바깥 트랜잭션이 끝나면 표시도 사라진다
        db.execute(text("SELECT 1"))
        release_connection(db)
        assert engine.pool.checkedout() == 0
    finally:
        db.close()
