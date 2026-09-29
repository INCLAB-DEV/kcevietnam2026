"""roster-import deep module (F-OP-002 / 이슈 #50).

주관사 전체 신청자 스냅샷(CSV/엑셀)을 회원ID 키로 멱등 upsert + eager 생성
(org/member/role) + raw 보존 + role 출처유추한다. 입력=파일, 출력=신규/갱신/무변경 집계.
ADR-0007(명단 스냅샷·회원ID 키) / ADR-0009(registrants 적재·eager·raw·게이트).
"""
