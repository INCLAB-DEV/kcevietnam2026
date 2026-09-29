"""DB 엔진·세션·선언적 Base. 모든 DB 접근은 여기를 거친다(FastAPI가 DB 소유 — ADR-0008)."""

from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, sessionmaker

from app.config import settings

engine = create_engine(settings.database_url, future=True)
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
