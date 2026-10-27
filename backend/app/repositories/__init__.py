"""리포지토리 — DB 접근 경계. 도메인/서비스는 이 인터페이스만 본다(ADR-0008).

InMemoryRepository: 테스트·로컬·데모(DB 미설정 시 기본). SqlAlchemyRepository: 실 RDS.
원자성(provenance 보존 + Fit 결합)은 SQL 구현이 트랜잭션으로 보장한다.
"""

from app.repositories.base import MeetingView, Repository, StoredReview  # noqa: F401
from app.repositories.memory import InMemoryRepository  # noqa: F401
