"""참가자용 미팅 도메인 (F-MT-001) — 신청·수락·거절·취소 + 가용 슬롯 조회.

운영자 콘솔(``app.admin``)과 달리 **참가 당사자(참가사·바이어)** 가 쓰는 경로다. 권한의 닻은
``Principal.organization_id`` 하나 — 내 org가 낀 미팅만 보이고 바꿀 수 있다.

- ``router``  — HTTP 경계. 도메인 예외를 ``{"detail": {"code", "message"}}`` 로 환산한다.
- ``service`` — 트랜잭션·검증 순서·알림 커밋 경계를 소유(DB 접근은 여기로 모은다).
- ``schemas`` — 요청/응답 계약(snake_case, extra="forbid").

동시성(슬롯·장소 점유)은 이 패키지가 직접 구현하지 않고 ``app.matching.slot_booking``에 봉인돼
있다 — 가용성 계산과 쓰기 가드가 같은 술어를 쓰게 하기 위함.
"""
