"""auth — AU-001 통합 로그인의 백엔드 인증 슬라이스(ADR-0007/0008/0009).

이 패키지는 PRD F-AU-001이 식별한 deep module들을 **경계 안에 격리**한다. 외부
의존(DX Korea 인증 API·Cognito 유저풀)은 전부 Protocol 포트 뒤에 두고, 실호출은
규격 확정 후로 미룬다(HITL). 지금은 스텁 구현 + 계약 테스트만 둔다.

구현된 모듈:
- ``deeplink_token`` — 딥링크 토큰 발급·검증(만료·무효·일회성) 규칙(#20).
- ``dx_korea_verify`` — 아이디/비번 → 회원ID 검증 어댑터(규격 미확정 → 포트로 격리, #21).
- ``registrant_mapping`` — 회원ID → 적재 레코드 매핑(없으면 not-found, #21).
- ``session_issue`` — 최초=게이트 Cognito 계정 발급+세션, 재방문=기존 계정 세션(#21).
- ``jwt_verify`` — Cognito 발급 JWT의 JWKS/RS256 검증(FastAPI가 소유, #21).
- ``login`` — 검증→매핑→세션을 엮고 결정된 라우트를 실어 넘기는 얇은 오케스트레이터(#21/#22).
- ``role_branch`` — 역할(exhibitor/buyer) + 운영사 여부 → 최종 라우트 순수 분기(#22).
- ``router`` — 위 모듈을 FastAPI 엔드포인트로 노출.

약관 동의(consent) 수집은 별도 슬라이스에서 합류한다(F-AU-001).
"""
