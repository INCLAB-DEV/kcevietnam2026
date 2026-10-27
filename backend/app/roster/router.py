"""OP-002 명단 적재 엔드포인트 — 업로드 원본 S3 보관 + 회원ID 키 멱등 적재(F-OP-002 D15).

화면(Next.js)은 이 API만 호출한다(경계 B). **구현은 이 파일의 ``import_members`` 하나**다 —
``/organizer/events/{event_id}/members/import``(여기)와 ``/api/admin/import/roster?event_id=``
(app.excel.router)가 같은 함수를 공유한다. 두 콘솔(/admin/organizations "명단 업로드",
/organizer/members "명단 업로드")이 같은 BFF·같은 핸들러를 타서 다시 갈라지지 않게 한 것이다
(예전엔 경로마다 핸들러가 따로 있었고, 화면·템플릿·파서 별칭이 서로 어긋나 어드민 템플릿이 400으로
전부 거부됐다 — 2026-09-16).

권한(발주자 지시 2026-09-16, ADR-0012 개정): 명단 업로드는 **이 행사의 운영자(master·sub)** 가 한다
(``require_event_operator``). master는 전역, sub는 자기 관할(자기 바이어)만 — 관할 검사는 적재 코어가
행 단위로 한다(app.roster.import_service). 예전엔 master 전용(require_event_master)이었다.

공통 비밀번호(``password``)는 회원가입과 같은 정책(app.auth.credentials)으로 먼저 검증하고(위반 시
데이터를 건드리기 전에 422), 해시만 적재 코어로 넘긴다. **평문은 로그·응답·원본 보관(S3)·미리보기
diff 어디에도 남기지 않는다** — 파일에 비밀번호 컬럼이 있으면 원본 보관 전에 400으로 거부한다.
"""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.admin.guard import EventOperatorPrincipal, require_event_operator
from app.auth.credentials import PASSWORD_POLICY_ERROR, check_password_policy, hash_password
from app.db import get_session
from app.models import Event
from app.roster.import_service import import_roster
from app.roster.parser import (
    VALID_ROLES,
    RosterParseError,
    RosterPasswordColumnError,
    normalize_role,
    parse_numbered_rows,
    to_records_detailed,
)
from app.storage import RosterStorage, get_storage

router = APIRouter(prefix="/organizer", tags=["roster"])

# 업로드 상한 — 전체 적재 전에 메모리/CPU 고갈(압축 워크북 팽창 포함)을 막는다. 스냅샷은 수만 행 규모.
MAX_UPLOAD_BYTES = 20 * 1024 * 1024


@router.post("/events/{event_id}/members/import")
def import_members(
    event_id: str,
    file: UploadFile = File(...),
    default_role: str | None = Form(None),  # 파일 출처(참가기업/바이어 명단) — 명시 컬럼 없을 때 role 유추
    dry_run: bool = Form(False),  # True면 적용하지 않고 갱신 미리보기(컬럼별 diff)만 반환
    # 명단 계정 공통 비밀번호(선택) — 비밀번호 없는 대상 계정에만 적용. 빈 값 = 미입력.
    password: str | None = Form(None),
    # 행별 결과(rows)·계정 집계(accounts)를 응답에 싣는다. 공통 비밀번호를 보내면 자동으로 켜진다.
    row_report: bool = Form(False),
    session: Session = Depends(get_session),
    storage: RosterStorage = Depends(get_storage),
    operator: EventOperatorPrincipal = Depends(require_event_operator),  # 이 행사 master·sub — 401/403
) -> dict:
    """전체 신청자 스냅샷을 업로드 → (적용 전 dry_run 미리보기) → 회원ID 키 멱등 적재 → 신규/갱신/무변경+diff 반환.

    dry_run=True: 같은 적재 로직을 savepoint 안에서 돌려 갱신 건의 old→new·행별 결과를 모으고 롤백(아무것도
    영속 안 됨, S3 원본도 보관 안 함). 운영자가 미리보기 확인 후 dry_run=False로 재호출하면 실제 적용한다(멱등).

    ``async def``가 아니라 ``def``다 — 파일 파싱·비밀번호 해시·수만 행 적재는 전부 동기 작업이라 async
    핸들러에서 돌리면 그동안 이벤트 루프(서버 전체)가 멈췄다. ``def``면 FastAPI가 스레드풀에서 돌린다.
    """
    try:
        uuid.UUID(event_id)  # 비-UUID는 PG UUID 비교에서 변환 에러(500) 나기 전에 400으로 거른다.
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="유효하지 않은 이벤트 ID입니다.") from exc

    if default_role is not None and normalize_role(default_role) is None:
        raise HTTPException(status_code=400, detail=f"default_role은 {sorted(VALID_ROLES)} 중 하나여야 합니다.")

    if password is not None:
        try:
            check_password_policy(password)
        except ValueError as exc:
            # 메시지는 정책 문구뿐(입력값 미포함). 원인 체인도 끊어 평문이 트레이스로 새지 않게 한다.
            raise HTTPException(
                status_code=422, detail={"code": PASSWORD_POLICY_ERROR, "message": str(exc)}
            ) from None

    if session.scalars(select(Event).where(Event.id == event_id)).first() is None:
        raise HTTPException(status_code=404, detail="이벤트를 찾을 수 없습니다.")

    # 상한 + 1바이트까지만 읽는다 — 넘는지 알기엔 충분하고, 상한을 크게 넘는 파일을 통째로 메모리에 올리지
    # 않는다(예전엔 전부 읽은 뒤에야 길이를 봤다). 응답(413·문구)은 그대로다.
    data = file.file.read(MAX_UPLOAD_BYTES + 1)
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail=f"파일이 너무 큽니다(상한 {MAX_UPLOAD_BYTES // (1024 * 1024)}MB).")

    try:
        headers, rows, row_numbers = parse_numbered_rows(file.filename or "", data)
        records, rejected = to_records_detailed(headers, rows, default_role, row_numbers)
    except RosterPasswordColumnError as exc:
        raise HTTPException(status_code=400, detail={"code": exc.code, "message": str(exc)}) from exc
    except RosterParseError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    # 해시는 요청당 1회(검증 통과 후) — 평문은 이 지점 이후 어디로도 넘기지 않는다. 계정 수백 개에 같은 해시를
    # 쓰므로 bcrypt는 행 수와 무관하게 한 번이다. 로그인·가입과 달리 요청 커넥션을 쥔 채 해시한다 — 가드
    # (require_event_operator → resolve_organizer_id)가 운영자 신원 행을 get-or-create로 flush만 해 둔 상태일 수
    # 있어 release_connection(=close)으로 놓으면 그 쓰기가 롤백되고, 업로드 1건당 1회라 풀 부담도 작다(로그인이
    # 몰려 해시 자리를 기다리면 그동안 커넥션 1개를 계속 쥔다. 대기열 가득·대기 시간 초과는 503 server_busy — app.main).
    password_hash = hash_password(password) if password is not None else None
    jurisdiction = None if operator.is_master else operator.organizer_id
    detailed = row_report or password is not None

    if dry_run:
        # 미리보기 — 실제 적재 로직을 savepoint에서 돌려 diff·행별 결과를 모으고 통째 롤백. 원본 S3 보관 안 함.
        nested = session.begin_nested()
        result = import_roster(
            session,
            event_id,
            records,
            password_hash=password_hash,
            jurisdiction_organizer_id=jurisdiction,
            rejected=rejected,
        )
        nested.rollback()
        return result.as_dict(detailed=detailed)

    # 원본 박제는 적재 전에 — 손실 없는 보존이 우선(ADR-0009 D4). 적재 실패해도 원본은 남는다.
    storage.put_original(event_id, file.filename or "roster", data, file.content_type)

    result = import_roster(
        session,
        event_id,
        records,
        password_hash=password_hash,
        jurisdiction_organizer_id=jurisdiction,
        rejected=rejected,
    )
    session.commit()
    return result.as_dict(detailed=detailed)
