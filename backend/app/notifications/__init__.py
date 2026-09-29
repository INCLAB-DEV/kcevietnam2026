"""알림 시스템 (F-NT-001, ADR-0010) — Organization 공유 인박스 + 채널 확장 포트.

로그인하지 않으면 앱 알림을 못 받는 베트남 전시 피벗 대응: 이메일이 저비용 기본 발송 채널이고,
추후 메신저 등 추가 채널은 ``channels.py``의 레지스트리에 클래스 1개를 등록하는 것으로 끝난다.

- ``service.py``: 알림 생성(6종) + org 공유 인박스 조회/읽음 처리. payload jsonb 스냅샷.
- ``channels.py``: 채널 포트(Protocol) — InAppChannel(DB 기록=발신) · EmailChannel(이메일 포트 경유).
- ``email.py``: 이메일 발송 포트 — FakeEmailSender(기본값) · SmtpEmailSender(smtplib, fail-closed).
- ``scheduler.py``: 10분 리마인더 폴링 잡(멱등) + FastAPI lifespan 게이트(SCHEDULER_ENABLED).
- ``router.py``: ``GET/POST /api/notifications`` — org 인박스 조회·읽음 처리.
- ``schemas.py``: 타입별 payload 스냅샷 스키마(Pydantic) + API 응답 모델.
"""
