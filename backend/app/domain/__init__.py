"""도메인 deep modules — DB·HTTP·AI 어댑터에 의존하지 않는 순수 로직.

F-MY-002에서 식별된 격리 테스트 대상 3종:
- review_capture           : 2-step 리뷰 진행 / noshow 분기 / 재진입 수정 / Fit 검수
- love_call_signal         : Love Call 단방향·Mutual 격상 / 공개·비공개 노출 경계
- review_provenance_binding: 매칭 출처 보존 + 리뷰 저장 시 Fit 결합 (precision·대조군)
"""
