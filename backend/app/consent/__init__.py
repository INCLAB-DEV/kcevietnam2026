"""약관 동의 슬라이스 (F-AU-001 / ADR-0009).

순수 규칙(`rules`)·DB 수집(`service`)·HTTP(`router`)를 분리한다. 게이트·검증 같은
관찰 가능한 동작은 `rules`에 격리해 DB 없이 단위 테스트한다(PRD Testing Decisions).
"""
