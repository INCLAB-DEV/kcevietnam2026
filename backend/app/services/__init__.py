"""외부 어댑터 — 전사(Whisper)·구조화(OpenAI)·저장(S3)·내보내기(docx/pdf).

도메인(app.domain)은 이들을 모른다. API 레이어가 factory 로 주입한다.
설정 backend 토글로 로컬/테스트는 fake, 실배포는 실제 서비스를 고른다.
"""
