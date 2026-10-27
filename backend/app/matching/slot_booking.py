"""slot-booking — 슬롯/장소 점유의 **락 + 겹침 술어 단일 봉인 지점** (F-MT-001).

이 모듈이 존재하는 이유는 하나다: **가용성 계산과 쓰기 가드가 같은 술어를 쓰게 만들기.** 두 곳이
"겹침"을 각자 구현하면 화면에는 비어 보이는 슬롯이 저장 시점에 409로 튕기는(혹은 그 반대의 이중
예약) 어긋남이 생긴다. 그래서 겹침 판정은 :func:`has_accepted_overlap` / :func:`has_venue_overlap`
**두 함수만** 존재하고, availability 응답도 create/accept 가드도 이 함수들을 호출한다.

⚠ **미래 경로에 대한 계약**: AI 전체 포화배정·단일기업 재트리거·운영자 강제배정(forced)·현장 생성
어느 경로든 미팅을 accepted로 만들거나 시간을 옮길 때는 반드시 :func:`meeting_write_lock`을 잡고
이 술어들을 통과해야 한다. 우회하면 DB의 EXCLUDE 제약이 최후 방어선으로 IntegrityError를 던지지만,
그건 사용자에게 500으로 보이기 쉬운 늦은 실패다 — 락·술어는 그걸 409라는 **의미 있는 실패**로
바꾸는 앞단이다.

점유의 정의(mt001meet01 EXCLUDE 제약과 동일):

- **accepted만 점유한다.** proposed는 겹쳐도 된다 — 같은 시간에 여러 신청을 받아두고 하나만
  수락하는 게 정상 흐름이고, **첫 수락이 이긴다**.
- 구간은 ``[)`` 반열림 — 09:00~09:30과 09:30~10:00은 겹치지 않는다.

락은 Postgres **트랜잭션 범위 advisory lock**(``pg_advisory_xact_lock``)이다. 세션 락과 달리 커밋/
롤백에서 자동 해제되므로 예외 경로에서 락이 새지 않는다. 키는 항상 **정렬해서** 잡는다 — 두
트랜잭션이 같은 두 org를 반대 순서로 잡아 서로를 기다리는 데드락을 구조적으로 없앤다.
"""

from __future__ import annotations

from datetime import datetime
from typing import Final, Iterable, Sequence

from sqlalchemy import text
from sqlalchemy.orm import Session

#: advisory lock 키 접두사. org 슬롯 키가 venue 키보다 항상 먼저 정렬되도록 접두사를 골랐다
#: ('mtslot' < 'mtvenue') — 장소 락을 나중에 따로 잡는 경로에서도 전역 획득 순서가 유지된다.
_ORG_KEY: Final = "mtslot:{event_id}:{org_id}"
_VENUE_KEY: Final = "mtvenue:{event_id}:{venue_id}"

#: 겹침 술어의 공통 WHERE — accepted + 시간이 채워진 행만 점유로 본다.
_OCCUPYING = (
    "status = 'accepted' AND scheduled_start IS NOT NULL AND scheduled_end IS NOT NULL"
)


def lock_keys(
    *, event_id: str, org_ids: Iterable[str] = (), venue_id: str | None = None
) -> list[str]:
    """이 쓰기가 잡아야 할 advisory lock 키들 — **정렬된** 순서로.

    별도 함수로 노출하는 건 테스트가 "정렬 순서로 잡는다"를 직접 검증할 수 있게 하기 위함이다.
    """
    keys = {_ORG_KEY.format(event_id=event_id, org_id=org_id) for org_id in org_ids}
    if venue_id is not None:
        keys.add(_VENUE_KEY.format(event_id=event_id, venue_id=venue_id))
    return sorted(keys)


def meeting_write_lock(
    db: Session,
    *,
    event_id: str,
    org_ids: Iterable[str] = (),
    venue_id: str | None = None,
) -> list[str]:
    """미팅 쓰기 임계구역 진입 — 관련 org(및 장소)의 트랜잭션 락을 정렬 순서로 잡는다.

    ``pg_advisory_xact_lock``은 트랜잭션 종료(커밋/롤백)에 자동 해제된다 — 해제 코드를 쓰지
    않으므로 예외 경로에서 락이 새지 않는다. 키는 ``hashtextextended(key, 0)``로 bigint에
    사상한다(advisory lock은 문자열 키를 받지 않는다).

    장소 락을 org 락보다 **나중에** 따로 잡아도 안전하다 — 접두사 정렬상 org 키가 항상
    앞서므로 전역 획득 순서가 깨지지 않는다(장소 후보를 여러 개 잡을 때도 정렬 순서를 지킬 것).

    Returns:
        실제로 잡은 키 목록(정렬 순서). 관측·테스트용.
    """
    keys = lock_keys(event_id=event_id, org_ids=org_ids, venue_id=venue_id)
    for key in keys:
        db.execute(
            text("SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))"), {"key": key}
        )
    return keys


def has_accepted_overlap(
    db: Session,
    *,
    event_id: str,
    org_ids: Sequence[str],
    start: datetime,
    end: datetime,
    exclude_meeting_id: str | None = None,
) -> bool:
    """주어진 org들 중 누구라도 그 구간에 이미 **확정** 미팅이 있는가.

    availability의 슬롯 available 판정과 create/accept의 쓰기 가드가 **같은 이 함수**를 쓴다.

    Args:
        org_ids: 검사 대상 org들(보통 참가사·바이어 두 개).
        exclude_meeting_id: 자기 자신 제외(수락 시점 재검증에서 이 미팅은 아직 proposed라
            사실 안 걸리지만, 시간 이동 같은 미래 경로가 자기 행을 제외해야 한다).
    """
    if not org_ids:
        return False
    sql = f"""
        SELECT 1 FROM meetings
        WHERE event_id = :event_id
          AND {_OCCUPYING}
          AND (exhibitor_org_id = ANY(:org_ids) OR buyer_org_id = ANY(:org_ids))
          AND scheduled_start < :end AND scheduled_end > :start
          {"AND id <> :exclude_id" if exclude_meeting_id else ""}
        LIMIT 1
    """
    params: dict = {
        "event_id": event_id,
        "org_ids": list(org_ids),
        "start": start,
        "end": end,
    }
    if exclude_meeting_id:
        params["exclude_id"] = exclude_meeting_id
    return db.execute(text(sql), params).first() is not None


def has_venue_overlap(
    db: Session,
    *,
    venue_id: str,
    start: datetime,
    end: datetime,
    exclude_meeting_id: str | None = None,
) -> bool:
    """그 장소가 해당 구간에 이미 **확정** 미팅으로 잡혀 있는가.

    장소는 행사에 매인 자원(``meeting_venues.event_id``)이라 event 스코프를 따로 걸지 않는다 —
    ``venue_id``만으로 행사가 결정된다(DB의 venue EXCLUDE 제약과 같은 범위).
    """
    sql = f"""
        SELECT 1 FROM meetings
        WHERE venue_id = :venue_id
          AND {_OCCUPYING}
          AND scheduled_start < :end AND scheduled_end > :start
          {"AND id <> :exclude_id" if exclude_meeting_id else ""}
        LIMIT 1
    """
    params: dict = {"venue_id": venue_id, "start": start, "end": end}
    if exclude_meeting_id:
        params["exclude_id"] = exclude_meeting_id
    return db.execute(text(sql), params).first() is not None


def accepted_busy_slot_starts(
    db: Session, *, event_id: str, org_ids: Sequence[str], start: datetime, end: datetime
) -> list[tuple[datetime, datetime]]:
    """구간 안에서 org들이 이미 점유한 (시작, 끝) 목록 — availability 그리드 색칠용.

    슬롯마다 :func:`has_accepted_overlap`를 N번 부르면 하루 그리드에 수십 쿼리가 나간다.
    이 함수는 **같은 점유 정의**로 구간을 한 번에 긁어와 메모리에서 겹침을 본다 — 술어가
    갈라지지 않도록 WHERE 절(:data:`_OCCUPYING`)을 그대로 공유한다.
    """
    if not org_ids:
        return []
    rows = db.execute(
        text(
            f"""
            SELECT scheduled_start, scheduled_end FROM meetings
            WHERE event_id = :event_id
              AND {_OCCUPYING}
              AND (exhibitor_org_id = ANY(:org_ids) OR buyer_org_id = ANY(:org_ids))
              AND scheduled_start < :end AND scheduled_end > :start
            """
        ),
        {"event_id": event_id, "org_ids": list(org_ids), "start": start, "end": end},
    ).all()
    return [(row[0], row[1]) for row in rows]


def busy_venue_ids(
    db: Session, *, venue_ids: Sequence[str], start: datetime, end: datetime
) -> set[str]:
    """구간에 이미 잡힌 장소 id 집합 — 장소 목록의 available 판정용(1쿼리)."""
    if not venue_ids:
        return set()
    rows = db.execute(
        text(
            f"""
            SELECT DISTINCT venue_id FROM meetings
            WHERE venue_id = ANY(:venue_ids)
              AND {_OCCUPYING}
              AND scheduled_start < :end AND scheduled_end > :start
            """
        ),
        {"venue_ids": list(venue_ids), "start": start, "end": end},
    ).scalars().all()
    return {str(v) for v in rows}


def overlaps(start_a: datetime, end_a: datetime, start_b: datetime, end_b: datetime) -> bool:
    """반열림 구간 ``[)`` 겹침 — SQL 술어와 같은 규칙의 파이썬 판. 그리드 색칠에 쓴다."""
    return start_a < end_b and end_a > start_b
