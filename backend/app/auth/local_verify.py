"""local-verify — 자체 회원가입 계정의 email+password 검증자(개발계획서 §7.3, ADR-0007 supersede).

``DxKoreaVerifier`` 포트를 구현해 로그인 트랜잭션(``app.auth.login_router``)의 검증 체인 맨 앞에
얹는다. 성공 시 돌려주는 "회원ID"는 DX Korea 회원ID가 아니라 ``members.id``(UUID)다 — 두 네임스페이스는
섞이지 않는다(데모 DX Korea 회원ID는 "mbr-buyer-01" 같은 비-UUID 문자열). 이 값이 그대로
registrant_mapping(아래 ``LocalRegistrantDirectory``)·Cognito 세션 키로 흘러간다.

``ChainedVerifier``/``ChainedRegistrantDirectory``는 "로컬 우선, 실패 시 기존 경로로 폴백"이라는
같은 합성 패턴을 두 포트에 일반화한 작은 어댑터다 — ``login_router.get_verifier``/``get_directory``가
이걸로 기존 데모 스텁·인메모리 명단과 로컬 자체가입 인증을 한 체인으로 묶는다(기존 데모 로그인
회귀 없이).
"""

from __future__ import annotations

import uuid
from typing import Sequence

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth.credentials import check_password
from app.auth.dx_korea_verify import (
    DxKoreaVerifier,
    RejectionReason,
    VerifyOk,
    VerifyRejected,
    VerifyResult,
)
from app.auth.registrant_mapping import RegistrantDirectory, RegistrantRef
from app.db import release_connection
from app.models import BuyerProfile, ExhibitorProfile, Member, OrganizationEventRole

# 계정이 없거나 로컬 비밀번호가 없을 때 대신 대조하는 해시 — 그런 요청도 bcrypt 1회를 똑같이 치러, 응답 시간으로
# "이 이메일이 가입돼 있는가"를 떠볼 수 없게 한다(2026-10-03 교차리뷰). 진짜 해시와 같은 cost 12, 평문은 임의 문자열을
# 만들고 버렸다(어떤 입력과도 맞지 않는다고 보면 된다 — 맞더라도 결과를 쓰지 않는다).
_DUMMY_PASSWORD_HASH = "$2b$12$gb3XRAmOEtW0CVU4cRaopuyZdeerWp9JCzozNPmwow1C5kvzeqoOC"


class LocalCredentialVerifier:
    """자체 회원가입 계정(email+bcrypt password_hash) 검증자.

    ``password_hash``가 NULL인 멤버(공통 비밀번호 없이 명단 업로드로 생긴 담당자 등, DX Korea 검증
    대상)는 로컬 로그인 대상이 아니므로 그냥 거부한다 — 두 인증 경로가 서로의 계정을 침범하지 않는다.
    명단 업로드에 공통 비밀번호를 함께 올린 계정(app.roster)은 자체가입과 똑같이 여기서 검증된다.

    ⚠ ``verify``는 받은 세션의 커넥션을 **bcrypt 전에 풀에 돌려준다**(``release_connection``). bcrypt는 1회
    0.2~0.3초 CPU이고 로그인이 몰리면 자리(``credentials.password_hash_slot``)를 기다리기까지 한다 — 그동안
    커넥션을 쥐고 있으면 풀이 고갈된다(2026-10-02 부하 테스트에서 QueuePool 시간 초과로 500). 그래서 필요한
    값(회원 id·해시)만 평범한 값으로 읽어 두고 놓는다. 전제: 이 세션에 커밋 안 한 쓰기가 없다 — 로그인 경로에서는
    ``verify``가 그 요청의 첫 DB 작업이다. 닫힌 세션은 다음 쿼리에서 새 커넥션을 받으므로 호출부(``login_start``)는
    같은 세션을 그대로 이어 쓴다.
    """

    def __init__(self, db: Session) -> None:
        self._db = db

    def verify(self, username: str, password: str) -> VerifyResult:
        email = username.strip().lower()
        row = self._db.execute(
            select(Member.id, Member.password_hash).where(Member.email == email)
        ).one_or_none()
        # 읽을 건 다 읽었다 — 해시 대조(자리 대기 포함) 동안 커넥션을 쥐지 않는다(클래스 독스트링).
        release_connection(self._db)
        if row is None or row.password_hash is None:
            # 회원 없음/비밀번호 미설정 — 어느 쪽인지 구분하지 않는다(열거 공격 완화, dx_korea_verify와 동일 관례).
            # 응답 시간도 같게: 같은 자리를 거쳐 더미 해시와 한 번 대조하고 결과는 버린다(_DUMMY_PASSWORD_HASH 주석).
            check_password(password, _DUMMY_PASSWORD_HASH)
            return VerifyRejected(RejectionReason.INVALID_CREDENTIALS)
        if not check_password(password, row.password_hash):
            return VerifyRejected(RejectionReason.INVALID_CREDENTIALS)
        return VerifyOk(member_id=str(row.id))


class ChainedVerifier:
    """검증자 체인 — 앞에서부터 시도해 처음 성공(``VerifyOk``)하는 결과를 쓴다.

    전부 거부하면 마지막 검증자의 거부를 그대로 노출한다(사유를 합치지 않음 — 각 검증자의 기존
    거부 사유 체계를 그대로 유지). 체인이 비어있는 호출은 호출부 버그이므로 방어적으로 assert한다.
    """

    def __init__(self, verifiers: Sequence[DxKoreaVerifier]) -> None:
        self._verifiers = list(verifiers)

    def verify(self, username: str, password: str) -> VerifyResult:
        result: VerifyResult | None = None
        for verifier in self._verifiers:
            result = verifier.verify(username, password)
            if isinstance(result, VerifyOk):
                return result
        assert result is not None, "ChainedVerifier는 최소 1개의 검증자가 필요하다"
        return result


class LocalRegistrantDirectory:
    """자체가입 회원ID(``members.id``)로 역할을 읽는 디렉터리 — ``registrants`` 테이블을 거치지
    않는다. 자체가입은 명단 스냅샷 적재층(ADR-0009)을 건너뛰고 ``organization_event_roles``를
    직접 만들기 때문이다(``signup_service`` 참고).

    ``RegistrantRef.registrant_id`` 자리엔 실제 ``registrants.id``가 없어
    ``organization_event_roles.id``를 대신 쓴다 — 이 값은 다른 FK로 재사용되지 않고 로그인 응답의
    불투명 식별자로만 쓰이므로 문제없다(주석으로 명시).

    ⚠ 한계: 한 조직이 여러 행사에 걸쳐 역할을 가지면(자체가입 후 다른 행사에도 참가) 가장 최근
    생성된 역할 하나만 로그인 컨텍스트로 노출한다 — 로그인 자체가 아직 event_id를 받지 않는
    단일-행사 가정 위에 있어서다(멀티 이벤트 로그인 스코프는 이 슬라이스 범위 밖, 별도 후속 과제).
    """

    def __init__(self, db: Session) -> None:
        self._db = db

    def find_by_member_id(self, member_id: str) -> RegistrantRef | None:
        try:
            uuid.UUID(member_id)
        except (ValueError, AttributeError, TypeError):
            # 데모 DX Korea 회원ID(mbr-*)는 UUID가 아니다 — 즉시 폴백(체인의 다음 디렉터리로).
            return None

        member = self._db.get(Member, member_id)
        if member is None:
            return None

        role = self._db.execute(
            select(OrganizationEventRole)
            .where(OrganizationEventRole.organization_id == member.organization_id)
            .order_by(OrganizationEventRole.created_at.desc())
        ).scalars().first()
        if role is None:
            return None

        has_profile = False
        if role.is_buyer:
            has_profile = (
                self._db.execute(
                    select(BuyerProfile.id).where(BuyerProfile.org_event_role_id == role.id)
                ).scalar_one_or_none()
                is not None
            )
        elif role.is_exhibitor:
            has_profile = (
                self._db.execute(
                    select(ExhibitorProfile.id).where(ExhibitorProfile.org_event_role_id == role.id)
                ).scalar_one_or_none()
                is not None
            )

        return RegistrantRef(
            registrant_id=str(role.id),
            member_id=member_id,
            is_exhibitor=role.is_exhibitor,
            is_buyer=role.is_buyer,
            application_status=role.application_status,
            has_profile=has_profile,
        )


class ChainedRegistrantDirectory:
    """디렉터리 체인 — 앞에서부터 시도해 처음 찾은(``None`` 아닌) 결과를 쓴다."""

    def __init__(self, directories: Sequence[RegistrantDirectory]) -> None:
        self._directories = list(directories)

    def find_by_member_id(self, member_id: str) -> RegistrantRef | None:
        for directory in self._directories:
            ref = directory.find_by_member_id(member_id)
            if ref is not None:
                return ref
        return None
