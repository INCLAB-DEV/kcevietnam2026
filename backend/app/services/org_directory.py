"""조직 디렉터리 포트 — 기업 표시명 + 소속 담당자 이메일 해석.

러브콜 메일(#13)은 "상대 Organization 의 담당자들에게" 보낸다. 알림(ADR-0010)의
``_recipients_for_org`` 가 하는 일과 같은 조회지만, 알림은 ``ChannelRecipient``(member_id 포함,
notification_dispatches 기록용)가 필요한 반면 러브콜 메일은 **주소 목록 하나**만 있으면 된다
(기업 앞으로 가는 편지 한 통을 담당자 전원 수신으로 보낸다 — 부분 성공이 없어 실패가 명확하다).

포트로 분리한 이유는 테스트다: 리뷰 API 테스트는 ``InMemoryRepository`` 로 도는데 DB 세션이
없다. 라우터가 Session 을 직접 들고 Member 를 조회하면 그 경로는 테스트할 수 없다 —
``get_org_directory`` 를 override 하면 DB 없이 수신자 해석까지 포함한 발송 흐름을 검증할 수 있다.
"""

from __future__ import annotations

from typing import Protocol
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import Member, Organization


def _is_uuid(value: str) -> bool:
    try:
        UUID(str(value))
        return True
    except (ValueError, AttributeError, TypeError):
        return False


class OrgDirectory(Protocol):
    def display_name(self, org_id: str) -> str:
        """표시용 기업명. 없으면 id 그대로(빈 화면 방지)."""
        ...

    def member_emails(self, org_id: str) -> list[str]:
        """그 기업 소속 담당자 이메일. 중복은 제거하고 입력 순서를 유지한다."""
        ...


class SqlOrgDirectory:
    """실 DB 구현. org_id 가 UUID 형식이 아니면 조회를 건너뛴다 — PG uuid 컬럼 비교는 비-UUID
    문자열에 DataError(500)로 터지므로, 데모/픽스처 id 는 여기서 조용히 걸러 빈 결과로 수렴시킨다.
    """

    def __init__(self, db: Session) -> None:
        self._db = db

    def display_name(self, org_id: str) -> str:
        if not _is_uuid(org_id):
            return org_id
        org = self._db.get(Organization, org_id)
        if org is None:
            return org_id
        return org.name_ko or org.name_en or org_id

    def member_emails(self, org_id: str) -> list[str]:
        if not _is_uuid(org_id):
            return []
        rows = self._db.execute(
            select(Member.email).where(Member.organization_id == org_id)
        ).scalars().all()
        seen: set[str] = set()
        emails: list[str] = []
        for raw in rows:
            email = (raw or "").strip()
            if email and email not in seen:
                seen.add(email)
                emails.append(email)
        return emails


class StaticOrgDirectory:
    """주입식 구현 — 테스트/데모용. DB 없이 이름·수신자를 고정한다."""

    def __init__(
        self,
        names: dict[str, str] | None = None,
        emails: dict[str, list[str]] | None = None,
    ) -> None:
        self._names = dict(names or {})
        self._emails = {k: list(v) for k, v in (emails or {}).items()}

    def display_name(self, org_id: str) -> str:
        return self._names.get(org_id, org_id)

    def member_emails(self, org_id: str) -> list[str]:
        return list(self._emails.get(org_id, []))
