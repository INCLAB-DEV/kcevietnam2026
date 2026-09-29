"""슈퍼어드민 콘솔(#OP) — 행사 CRUD·참가기업 관리(직접수정/대리작성)·미팅 운영·통역사 배정.

`app.auth.organizer_guard`(#47/ADR-0012)의 master 가드를 그대로 재사용하고(쓰기는 master 전용),
읽기 전용 엔드포인트는 이 패키지의 `guard.require_event_operator`로 master+sub를 함께 허용하되
sub는 자기 관할(관리 바이어)로 필터한다. `organizer_guard.py`는 이 패키지가 수정하지 않는다 —
공개된 포트(SessionAuthenticator/EventOperatorDirectory)와 의존성만 재사용한다.
"""
