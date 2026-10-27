"""roster-import 적재 코어 — 회원ID 키 멱등 upsert + eager 생성(org/member/role) + raw 보존.

외부에서 관찰 가능한 동작(신규/갱신/무변경 집계)만 보장한다(F-OP-002 Testing Decisions):
  - 같은 스냅샷 2회 적재 → 레코드 수 불변(1회차 신규 N, 2회차 무변경 N).
  - 한 레코드 흡수 시 registrants+organizations+members+organization_event_roles 함께 upsert.
  - 같은 회사 다중 멤버가 org 중복을 만들지 않음(import 내 org 캐시 — eager 레이스 방지, ADR-0009 D3).
  - 적재된 role의 application_status 기본값=registered(매칭/배정 비노출 게이트, ADR-0009 D6).

멤버는 이메일이 아니라 **registrant_id로 키잉**한다(1:1). 이메일 정정(A→B)이 들어와도 같은
registrant의 멤버를 갱신하지, 두 번째 멤버를 만들지 않는다. 다른 registrant가 이미 쓰는 이메일은
조용히 재배정하지 않고 건너뛴다(소유권 진동 방지).

**명단 계정(자동 회원가입, 2026-09-16 발주자 요청)**: 운영자가 공통 비밀번호를 함께 올리면
(``password_hash``) 이번 적재로 만든 멤버와, 파일에 있는 기존 멤버 중 **아직 비밀번호가 없는** 멤버에게
같은 해시를 넣어 로컬 로그인(app.auth.local_verify)이 되게 한다. **이미 비밀번호가 있으면 절대 덮어쓰지
않는다**(본인이 바꾼 비밀번호·자체가입 계정 보호 — "비밀번호 유지"로 보고). 전화번호는 회원가입과 같은
자리(members.phone)에 싣는다. 해시는 요청당 1회만 계산해 대상 계정에 같이 쓴다 — 수백 행 × bcrypt
비용을 요청 안에서 치르지 않기 위해서다(계정이 각자 비밀번호를 바꾸면 그때 새 salt가 생긴다).

**sub 운영자 관할(ADR-0012)**: ``jurisdiction_organizer_id``가 있으면(sub) 자기 바이어만 다룬다 —
바이어가 아닌 행, 다른 운영자가 관리하거나 이미 있는 기업(참가사 포함)을 건드리는 행은 통째로 건너뛰고
사유를 보고한다. sub가 새로 만든 바이어 참가(role)는 그 sub가 관리·최초등록 운영자로 기록된다.
(공통 비밀번호가 붙는 경로라 관할 밖 계정에 비밀번호를 심어 로그인하는 우회를 여기서 막는다.)

행별 결과(``ImportResult.rows``)는 요청이 원할 때만 응답에 싣는다(as_dict(detailed=True)) — 기존
응답 계약(added/updated/unchanged/skipped/changes/warnings)은 그대로다.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Session

from app.auth.credentials import is_valid_email
from app.models import ExhibitorProfile, Member, Organization, OrganizationEventRole, Registrant
from app.roster.parser import RosterRecord, RowIssue

# 계정 집계 키 — FE lib/roster/types.ts(RosterAccountSummary)와 1:1.
_ACCOUNT_COUNTERS = ("created", "password_set", "password_kept", "password_missing", "no_account")


@dataclass(frozen=True)
class AccountOutcome:
    """한 행의 계정(멤버) 처리 결과 — 행별 보고의 account/password/reason 칸."""

    account: str  # 'created' | 'existing' | 'none'
    password: str | None = None  # 'set' | 'kept' | 'missing' — account가 none이면 None
    reason: str | None = None  # 'no_email' | 'invalid_email' | 'duplicate_email_in_file' | 'email_in_use'


@dataclass
class ImportResult:
    """업로드 결과 패널 데이터(F-OP-002 관리지표: 멱등 결과). 단위 = 회원ID(registrant) 레코드."""

    added: int = 0  # 신규 적재
    updated: int = 0  # 명단 필드/raw 변경
    unchanged: int = 0  # 동일 → 무변경
    skipped: int = 0  # 회원ID·기업명 결측·파일 내 중복 회원ID·관할 밖 등 무효 행
    # 갱신 건의 컬럼별 old→new diff(미리보기 모달용). dry_run 시 적용 전 검토에 쓴다.
    changes: list[dict] = field(default_factory=list)
    warnings: list[dict] = field(default_factory=list)
    # 행별 결과(행 번호·결과·계정·비밀번호·사유) — 평문 비밀번호는 싣지 않는다(상태 코드만).
    rows: list[dict] = field(default_factory=list)
    accounts: dict[str, int] = field(default_factory=lambda: dict.fromkeys(_ACCOUNT_COUNTERS, 0))

    def as_dict(self, *, detailed: bool = False) -> dict:
        body = {
            "added": self.added,
            "updated": self.updated,
            "unchanged": self.unchanged,
            "skipped": self.skipped,
            "changes": self.changes,
            **({"warnings": self.warnings} if self.warnings else {}),
        }
        if detailed:
            body["accounts"] = dict(self.accounts)
            body["rows"] = sorted(self.rows, key=lambda r: (r["row"] is None, r["row"] or 0))
        return body

    def skip(
        self,
        reason: str,
        *,
        row_number: int | None,
        organizer_member_id: str | None,
        org_name: str | None,
        email: str | None,
    ) -> None:
        """적재하지 않은 행 — skipped 집계 + 사유 보고."""
        self.skipped += 1
        self.rows.append(
            _row_report(row_number, organizer_member_id, org_name, email, "skipped", AccountOutcome("none"), reason)
        )

    def record(self, record: RosterRecord, outcome: str, account: AccountOutcome) -> dict:
        """적재한 행의 보고 + 계정 집계. 반환한 dict는 이후 결과 보정(카테고리 보강)에 쓴다."""
        if account.account == "none":
            self.accounts["no_account"] += 1
        else:
            if account.account == "created":
                self.accounts["created"] += 1
            self.accounts[f"password_{account.password}"] += 1
        entry = _row_report(
            record.row_number,
            record.organizer_member_id,
            record.org_name,
            record.contact_email,
            outcome,
            account,
            account.reason,
        )
        self.rows.append(entry)
        return entry


def _row_report(
    row_number: int | None,
    organizer_member_id: str | None,
    org_name: str | None,
    email: str | None,
    result: str,
    account: AccountOutcome,
    reason: str | None,
) -> dict:
    return {
        "row": row_number,
        "organizer_member_id": organizer_member_id,
        "org_name": org_name,
        "email": email,
        "result": result,  # 'added' | 'updated' | 'unchanged' | 'skipped'
        "account": account.account,
        "password": account.password,
        "reason": reason,
    }


# registrant 변경 판정에 쓰는 명단 레벨 필드(파생 organization_id는 제외).
_REGISTRANT_FIELDS = ("name", "org_name", "contact_email", "contact_phone", "business_number", "role_hint")


def _role_flags(role_hint: str | None) -> tuple[bool, bool]:
    """role_hint → (is_exhibitor, is_buyer). 'both'는 양쪽, 미상은 양쪽 false(잠정)."""
    return (role_hint in ("exhibitor", "both"), role_hint in ("buyer", "both"))


class _OrgResolver:
    """import 1회 동안 기업명 → organization을 dedup. 같은 회사 다중 멤버가 중복 org를 만들지 않게 한다.

    단일 세션·단일 트랜잭션이라 import 내부 동시성은 없다. 첫 등장 시 flush해 같은 import 내 후속
    조회·FK가 방금 만든 행을 보게 한다(eager 레이스 방지, ADR-0009 D3). 교차-import 멱등은 name_ko 조회로 닫는다.
    명단 업체명은 국문 기준이라 name_ko에 적재(영문명은 name_en 컬럼이 있으면 새 기업에 싣고, 기존 기업은 빈 값만 보강).
    ⚠ organizations.name_ko에 unique 제약이 없어 '동시 import'에서는 같은 신규 회사가 분리될 수 있다(#50 후속:
       org 자연키 확정 — 사업자번호 결측·동명 회사 때문에 name unique는 위험, 주관사 식별자 합의에 묶임).
    """

    def __init__(self, session: Session):
        self._session = session
        self._cache: dict[str, Organization] = {}

    def peek(self, org_name: str) -> Organization | None:
        """만들지 않고 기존 기업만 찾는다(sub 관할 검사용). 찾으면 resolve가 같은 행을 쓰도록 캐시한다."""
        key = org_name.strip().lower()
        if key in self._cache:
            return self._cache[key]
        org = self._session.scalars(select(Organization).where(Organization.name_ko == org_name)).first()
        if org is not None:
            self._cache[key] = org
        return org

    def resolve(self, org_name: str, business_number: str | None, name_en: str | None = None) -> Organization:
        key = org_name.strip().lower()
        if key in self._cache:
            org = self._cache[key]
        else:
            org = self._session.scalars(select(Organization).where(Organization.name_ko == org_name)).first()
            if org is None:
                org = Organization(name_ko=org_name, name_en=name_en, business_reg_no=business_number)
                self._session.add(org)
                self._session.flush()  # org.id 확보 → 같은 import 내 후속 조회·FK에 즉시 사용
            self._cache[key] = org
        # 사업자번호·영문명은 부가속성 — 비어 있던 행이 채워주면 보강(키로는 안 씀, ADR-0007 D2).
        # 기존 값은 덮어쓰지 않는다(기업이 신청서에서 고친 영문명 보호).
        if business_number and not org.business_reg_no:
            org.business_reg_no = business_number
        if name_en and not org.name_en:
            org.name_en = name_en
        return org


def _apply_password(member: Member, password_hash: str | None) -> str:
    """공통 비밀번호 적용 — 이미 비밀번호가 있으면 절대 덮어쓰지 않는다('kept')."""
    if member.password_hash:
        return "kept"
    if password_hash:
        member.password_hash = password_hash
        return "set"
    return "missing"  # 계정은 있지만 비밀번호가 없어 로컬 로그인 불가


def _upsert_member(
    session: Session,
    record: RosterRecord,
    org: Organization,
    registrant: Registrant,
    *,
    password_hash: str | None = None,
    duplicate_email: bool = False,
) -> AccountOutcome:
    """담당자 멤버 eager upsert. registrant_id로 키잉(1:1) — 이메일 정정·중복에도 abort/재배정하지 않는다.

    이메일 형식 오류·파일 내 중복 이메일은 이메일 배정(생성·변경)만 막고 사유로 보고한다. registrant에
    연결된 기존 멤버는 이메일과 무관하게 이 행의 계정이므로 이름·전화·비밀번호 처리는 그대로 한다.
    """
    raw_email = record.contact_email
    # strip+lower — 로그인 검증자(app.auth.local_verify)가 lower()로 조회하므로 여기서 안 맞추면
    # 대문자 섞인 이메일로 명단에 올라간 계정이 로그인을 못 한다(단건 등록과 같은 규칙으로 정렬).
    email = raw_email.strip().lower() if raw_email and is_valid_email(raw_email) else None
    email_issue: str | None = None
    if raw_email and email is None:
        email_issue = "invalid_email"
    elif email and duplicate_email:
        email_issue = "duplicate_email_in_file"
        email = None

    member = session.scalars(select(Member).where(Member.registrant_id == registrant.id)).first()

    if member is not None:
        member.organization_id = org.id
        if record.name:
            member.name = record.name
        if record.contact_phone:
            member.phone = record.contact_phone  # 회원가입과 같은 자리(members.phone) — 명단 최신값
        if record.title and not member.title:
            member.title = record.title  # 비어 있을 때만 보강(org_name_en과 같은 규칙) — 기존 값 보호
        # 이메일 변경: 다른 멤버가 이미 그 이메일을 쓰면 충돌이므로 건드리지 않는다(소유권 진동 방지).
        if email and email != member.email:
            holder = session.scalars(select(Member).where(Member.email == email)).first()
            if holder is None:
                member.email = email
            else:
                email_issue = "email_in_use"
        password = _apply_password(member, password_hash)
        session.flush()  # 이메일 변경을 즉시 반영 → 같은 import 내 후속 행의 충돌 검사가 본다(autoflush 무관)
        return AccountOutcome("existing", password, email_issue)

    # 이 registrant의 멤버가 아직 없음 — 유효한 이메일이 있어야 생성(이메일=멤버 NOT NULL UNIQUE 자연키).
    if email_issue:
        return AccountOutcome("none", reason=email_issue)
    if not email:
        return AccountOutcome("none", reason="no_email")
    holder = session.scalars(select(Member).where(Member.email == email)).first()
    if holder is not None:
        if holder.registrant_id is None and holder.organization_id == org.id:
            # 같은 기업의 명단 밖 계정(단건 등록·자체가입) — 연결(registrant_id)은 하지 않는다(다음 적재가
            # 그 계정의 이름·이메일을 명단값으로 덮지 않게). 비밀번호만 없으면 채운다.
            password = _apply_password(holder, password_hash)
            session.flush()
            return AccountOutcome("existing", password)
        # 같은 이메일을 다른 registrant(또는 다른 기업)가 이미 점유 — 조용히 재배정하면 첫 registrant가 분리된다.
        return AccountOutcome("none", reason="email_in_use")
    session.add(
        Member(
            organization_id=org.id,
            registrant_id=registrant.id,
            name=record.name or record.org_name,
            email=email,
            phone=record.contact_phone,
            title=record.title,
            password_hash=password_hash,
        )
    )
    session.flush()  # 같은 import 내 후속 행의 이메일 충돌 검사가 방금 추가분을 보게 함(autoflush 무관)
    return AccountOutcome("created", "set" if password_hash else "missing")


def _upsert_role(
    session: Session,
    event_id: str,
    org: Organization,
    role_hint: str | None,
    *,
    owner_organizer_id: str | None = None,
) -> None:
    """organization_event_roles eager upsert. role 플래그는 OR-in(한 기업이 둘 다일 수 있음 — ADR-0001).

    application_status는 server default 'registered'로 깔고, 기존 행이 이미 submitted면 끌어내리지 않는다.
    ``owner_organizer_id``(sub 적재)가 있으면 새 참가의 관리·최초등록 운영자로 기록한다(ADR-0012 관할).
    """
    is_exhibitor, is_buyer = _role_flags(role_hint)
    role = session.scalars(
        select(OrganizationEventRole).where(
            OrganizationEventRole.organization_id == org.id,
            OrganizationEventRole.event_id == event_id,
        )
    ).first()
    if role is None:
        session.add(
            OrganizationEventRole(
                organization_id=org.id,
                event_id=event_id,
                is_exhibitor=is_exhibitor,
                is_buyer=is_buyer,
                managing_organizer_id=owner_organizer_id,
                created_by_organizer_id=owner_organizer_id,
                # application_status는 server_default('registered')에 맡긴다(D6 게이트).
            )
        )
        session.flush()  # 같은 import 내 같은 org 후속 행이 방금 만든 role을 보게 함(중복 role 방지)
    else:
        role.is_exhibitor = role.is_exhibitor or is_exhibitor
        role.is_buyer = role.is_buyer or is_buyer


def _jurisdiction_denial(
    session: Session, event_id: str, record: RosterRecord, orgs: _OrgResolver, organizer_id: str
) -> str | None:
    """sub 적재 행의 관할 검사 — 위반 사유 코드, 통과면 None. 아무것도 만들거나 바꾸기 전에 부른다.

    sub는 **자기 바이어만** 등록·관리한다(ADR-0012, CONTEXT.md master/sub): 바이어 행이어야 하고, 이 행이
    건드릴 기존 기업(회원ID로 이미 적재된 기업·같은 이름의 기존 기업)은 이 행사에서 그 sub가 관리하는
    바이어 전용 참가여야 한다. 이 행사에 참가가 없는 기존 기업도 거부한다(보수적 — master가 처리).
    """
    if record.role_hint != "buyer":
        return "buyer_only"
    org_ids: set[str] = set()
    registrant = session.scalars(
        select(Registrant).where(
            Registrant.event_id == event_id,
            Registrant.organizer_member_id == record.organizer_member_id,
        )
    ).first()
    if registrant is not None:
        if registrant.organization_id is None:
            return "out_of_jurisdiction"
        org_ids.add(str(registrant.organization_id))
    existing = orgs.peek(record.org_name)
    if existing is not None:
        org_ids.add(str(existing.id))
    for org_id in org_ids:
        role = session.scalars(
            select(OrganizationEventRole).where(
                OrganizationEventRole.organization_id == org_id,
                OrganizationEventRole.event_id == event_id,
            )
        ).first()
        if role is None or role.is_exhibitor or not role.is_buyer or role.managing_organizer_id != organizer_id:
            return "out_of_jurisdiction"
    return None


def _diff_raw(old: dict, new: dict) -> dict:
    """원본 컬럼 단위 old→new diff(운영자 스프레드시트 헤더 그대로라 가장 알아보기 쉽다)."""
    cols: dict[str, dict] = {}
    for k in set(old) | set(new):
        o, n = old.get(k), new.get(k)
        if o != n:
            cols[k] = {"old": o, "new": n}
    return cols


def _upsert_registrant(
    session: Session, event_id: str, org: Organization, record: RosterRecord
) -> tuple[Registrant, str, dict | None]:
    """registrant를 (event_id, organizer_member_id)로 멱등 upsert. 반환=(행, outcome, 변경 diff|None).

    outcome ∈ {'added','updated','unchanged'}. diff는 updated일 때 컬럼별 old→new(미리보기용), 그 외 None.
    INSERT ... ON CONFLICT DO NOTHING으로 신규 여부를 원자적으로 판정한다 — 동시 import에서도 진 쪽이
    unique 위반으로 500 나지 않고 기존 행으로 합류한다(#50 codex P1).
    """
    insert_stmt = (
        pg_insert(Registrant)
        .values(
            event_id=event_id,
            organizer_member_id=record.organizer_member_id,
            organization_id=org.id,
            name=record.name,
            org_name=record.org_name,
            contact_email=record.contact_email,
            contact_phone=record.contact_phone,
            business_number=record.business_number,
            role_hint=record.role_hint,
            raw=record.raw,
        )
        .on_conflict_do_nothing(index_elements=["event_id", "organizer_member_id"])
        .returning(Registrant.id)
    )
    inserted_id = session.scalar(insert_stmt)
    if inserted_id is not None:
        return session.get(Registrant, inserted_id), "added", None

    # 이미 존재 — 명단 필드/raw 비교 후 변경분만 덮어쓴다(최신값, ADR-0007 D2).
    registrant = session.scalars(
        select(Registrant).where(
            Registrant.event_id == event_id,
            Registrant.organizer_member_id == record.organizer_member_id,
        )
    ).one()
    changed = any(getattr(registrant, f) != getattr(record, f) for f in _REGISTRANT_FIELDS)
    changed = changed or registrant.raw != record.raw
    if not changed:
        return registrant, "unchanged", None
    diff = _diff_raw(dict(registrant.raw), record.raw)  # 덮어쓰기 전 old→new 캡처
    for f in _REGISTRANT_FIELDS:
        setattr(registrant, f, getattr(record, f))
    registrant.raw = record.raw
    registrant.organization_id = org.id
    registrant.updated_at = datetime.now(timezone.utc)  # 정정 시각 박제(server default는 생성값에 고정)
    return registrant, "updated", diff


def import_roster(
    session: Session,
    event_id: str,
    records: list[RosterRecord],
    *,
    password_hash: str | None = None,
    jurisdiction_organizer_id: str | None = None,
    rejected: Sequence[RowIssue] = (),
) -> ImportResult:
    """정규 레코드 목록을 회원ID 키로 멱등 적재한다. 호출부가 commit을 소유(요청당 트랜잭션).

    ``password_hash``: 공통 비밀번호 해시(평문 아님) — 비밀번호 없는 대상 계정에만 적용.
    ``jurisdiction_organizer_id``: sub 운영자면 그 organizer id(관할 검사), master는 None(전역).
    ``rejected``: 파서가 이미 걸러낸 행(RowIssue) — skipped 집계와 행별 보고에 합친다.
    """
    result = ImportResult()
    orgs = _OrgResolver(session)
    for issue in rejected:
        result.skip(
            issue.reason,
            row_number=issue.row_number,
            organizer_member_id=issue.organizer_member_id,
            org_name=issue.org_name,
            email=issue.contact_email,
        )

    # 파일 내 중복 회원ID는 마지막 값으로 정리(intra-file 중복이 집계를 왜곡하지 않게 — FE와 동일).
    # 대체된 앞 행은 사유(duplicate_id_in_file)와 함께 건너뛴 행으로 보고한다.
    deduped: dict[str, RosterRecord] = {}
    for record in records:
        previous = deduped.get(record.organizer_member_id)
        if previous is not None:
            result.skip(
                "duplicate_id_in_file",
                row_number=previous.row_number,
                organizer_member_id=previous.organizer_member_id,
                org_name=previous.org_name,
                email=previous.contact_email,
            )
        deduped[record.organizer_member_id] = record

    category_inputs: dict[str, list[RosterRecord]] = {}
    outcomes: dict[str, str] = {}
    row_entries: dict[str, dict] = {}
    # 파일 안에서 한 이메일을 먼저 쓴 회원ID — 뒤 행은 duplicate_email_in_file(계정은 먼저 행만).
    email_claims: dict[str, str] = {}
    for record in deduped.values():
        if jurisdiction_organizer_id is not None:
            denial = _jurisdiction_denial(session, event_id, record, orgs, jurisdiction_organizer_id)
            if denial:
                result.skip(
                    denial,
                    row_number=record.row_number,
                    organizer_member_id=record.organizer_member_id,
                    org_name=record.org_name,
                    email=record.contact_email,
                )
                continue
        org = orgs.resolve(record.org_name, record.business_number, record.org_name_en)
        registrant, outcome, diff = _upsert_registrant(session, event_id, org, record)
        setattr(result, outcome, getattr(result, outcome) + 1)
        if diff:
            result.changes.append(
                {"organizer_member_id": record.organizer_member_id, "org_name": record.org_name, "columns": diff}
            )
        duplicate_email = False
        if record.contact_email and is_valid_email(record.contact_email):
            claimed_by = email_claims.setdefault(record.contact_email, record.organizer_member_id)
            duplicate_email = claimed_by != record.organizer_member_id
        account = _upsert_member(
            session, record, org, registrant, password_hash=password_hash, duplicate_email=duplicate_email
        )
        _upsert_role(session, event_id, org, record.role_hint, owner_organizer_id=jurisdiction_organizer_id)
        outcomes[record.organizer_member_id] = outcome
        row_entries[record.organizer_member_id] = result.record(record, outcome, account)
        if record.role_hint in ("exhibitor", "both"):
            category_inputs.setdefault(org.id, []).append(record)
        if record.category_invalid:
            result.warnings.append({"organizer_member_id": record.organizer_member_id, "reason": "invalid_category"})
        if record.contact_source == "applicant":
            # 전시회 담당자 이메일이 비어 신청자 단위로 폴백한 행 — 운영자가 알아보도록 경고로 노출한다.
            result.warnings.append({"organizer_member_id": record.organizer_member_id, "reason": "contact_fallback_to_applicant"})

    session.flush()
    for org_id, group in category_inputs.items():
        values = {r.content_category for r in group if r.content_category}
        if not values:
            continue
        role = session.scalars(select(OrganizationEventRole).where(
            OrganizationEventRole.event_id == event_id, OrganizationEventRole.organization_id == org_id,
        ).with_for_update()).one()
        profile = session.scalars(select(ExhibitorProfile).where(ExhibitorProfile.org_event_role_id == role.id)).first()
        if len(values) > 1 or (profile and profile.content_category and profile.content_category not in values):
            result.warnings.append({"organization_id": org_id, "reason": "category_conflict",
                "organizer_member_ids": [r.organizer_member_id for r in group]})
            continue
        if profile is None:
            profile = ExhibitorProfile(org_event_role_id=role.id)
            session.add(profile)
        if not profile.content_category:
            profile.content_category = next(iter(values))
            # 기존 raw가 같아도 이번에 처음 구조화 저장되면 갱신으로 센다.
            first = group[0].organizer_member_id
            if outcomes[first] == "unchanged":
                result.unchanged -= 1
                result.updated += 1
                row_entries[first]["result"] = "updated"
        session.flush()

    return result
