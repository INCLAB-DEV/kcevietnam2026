"""앱 설정 — 환경변수에서 주입. 시크릿(OpenAI/Cognito/S3)은 backend에만 둔다(CONTEXT.md).

어댑터 backend 토글(transcriber/structurer/storage)로 로컬·테스트는 fake, 실배포는 실제
서비스를 선택한다. 키가 없으면 실 어댑터 생성 시점에 명확히 실패한다(조용한 폴백 금지).
env_prefix는 없다 — 변수는 DATABASE_URL / TRANSCRIBER_BACKEND 처럼 그대로 읽는다.
"""

from typing import Literal

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # AWS RDS(PostgreSQL) 접속 URL. Alembic/앱이 공유한다. psycopg v3 드라이버.
    #   예: postgresql+psycopg://nabi:nabi@localhost:5432/nabi
    database_url: str = "postgresql+psycopg://nabi:nabi@localhost:5432/nabi"

    # 명단·녹음 원본 보관 S3(ADR-0008 D15). 미설정이면 FakeStorage로 원본 박제 생략(로컬/CI).
    #   자격증명은 boto3 기본 체인(IAM 역할/환경변수)에서 해결한다.
    s3_bucket: str | None = None
    aws_region: str | None = None

    # Cognito 세션 JWT 검증(ADR-0007/0008). FastAPI가 Cognito를 소유 — Next.js는 토큰만 싣고
    # 검증은 여기 한 곳에 모은다. issuer/client_id는 유저풀·앱클라이언트 식별, jwks_json은
    # 공개키 집합(.well-known/jwks.json 본문)을 주입한다. 미설정이면 보호 라우트는 인증
    # 미구성으로 401(조용한 통과 금지). 실배포: jwks를 네트워크에서 가져와 캐시하는 어댑터로
    # 교체(키 회전 대응) — 유저풀 ID·회전 정책은 HITL 인프라 결정이라 코드에 박지 않는다.
    cognito_issuer: str | None = None
    cognito_client_id: str | None = None
    cognito_jwks_json: str | None = None

    # 실 Cognito 세션 발급(AwsCognitoUserPool, ADR-0007/0008 1단계 — 로컬 구현). 유저풀 ID·앱클라이언트
    # secret·파생 비밀번호 시크릿은 인프라 결정(HITL)이라 코드에 박지 않고 env로 받는다. 실 앱클라이언트는
    # secret 없음(null)으로 확인됐으므로 app_client_secret은 기본 None(SECRET_HASH 생략) — 미래 클라이언트
    # 교체 대비로만 남겨둔다.
    cognito_user_pool_id: str | None = None
    cognito_app_client_secret: str | None = None
    # admin_set_user_password/admin_initiate_auth에 쓸 파생 비밀번호(HMAC) 시크릿 — member_id에서
    # 무상태로 재현 가능한 고정 비밀번호를 만든다(별도 저장 불필요). 미설정이면 실 유저풀 어댑터 생성
    # 시점에 명확히 실패한다(조용한 폴백 금지).
    cognito_session_password_secret: str | None = None
    # JWKS 동적 fetch(.well-known/jwks.json) 캐시 TTL(초). 만료 전엔 캐시 재사용, 만료 후 재fetch —
    # 키 회전 직후의 kid-miss는 이 TTL과 별개로 verify_session_token이 force_refresh로 1회 더 흡수한다.
    cognito_jwks_ttl_seconds: int = 900

    # AI / 전사·구조화 (MY-002). AI 스택은 OpenAI로 통일(발주자 결정, 2026-09) — 전사·구조화 모두
    # 같은 openai_api_key 를 쓴다.
    openai_api_key: str | None = None
    whisper_model: str = "whisper-1"  # OpenAI 전사 모델. gpt-4o-transcribe 등으로 교체 가능.
    structurer_model: str = "gpt-5.4-mini"  # OpenAI 구조화 모델(회의록+Fit 제안).

    # 어댑터 선택. 'fake' = 외부 호출 없이 결정적 동작(로컬/테스트/데모).
    transcriber_backend: Literal["openai", "fake"] = "fake"
    structurer_backend: Literal["openai", "fake"] = "fake"
    storage_backend: Literal["s3", "fake"] = "fake"

    # 운영자 권한 가드(#47/ADR-0012)의 인증·인가 backend. 기본 'cognito' = fail-closed(실 Cognito JWKS
    # 검증 + event_organizers 조회). 'demo'는 dev/test/6·17 데모 전용 인메모리 스텁을 명시적으로 켠다 —
    # 서명검증 없는 스텁이 prod에 새지 않도록 기본을 secure로 두고, 미설정 시 조용히 폴백하지 않는다.
    auth_backend: Literal["cognito", "demo"] = "cognito"

    # 알림(ADR-0010) 이메일 채널. 로그인 없이도 알림을 받게 하는 저비용 기본 채널 — 'fake'는
    # 외부 호출 없이 발송분을 기록만 한다(테스트/로컬 기본값). 'smtp'는 자격증명 없으면 생성
    # 시점에 명확히 실패한다(transcriber_backend와 동일한 fail-closed 패턴, 조용한 폴백 금지).
    email_backend: Literal["smtp", "fake"] = "fake"
    smtp_host: str | None = None
    smtp_port: int = 587
    smtp_user: str | None = None
    smtp_password: str | None = None
    smtp_from: str | None = None
    # 수신자가 답장할 주소. 발신 도메인에 MX가 없어 봉투 발신자로 답장을 받을 수 없을 때 씀
    # (SES 전환 대비, 2026-09). 미설정이면 Reply-To 헤더 자체를 넣지 않는다.
    smtp_reply_to: str | None = None
    # 수신자에게 보이는 발신자 표시이름("행사명" <no-reply@...> 형태). 미설정이면 주소만 노출.
    email_sender_name: str | None = None
    # 메일 제목·본문에 쓰는 서비스/행사 표기. 행사별로 바뀔 수 있어 env로 뺀다(기본값은 내부
    # 프로젝트명 NABI — 기존 동작 보존).
    email_brand_name: str = "NABI"

    # 알림 리마인더 폴링 스케줄러(ADR-0010, ~1분 주기 asyncio 태스크). 기본 off — 명시적으로
    # 켜야 FastAPI lifespan이 백그라운드 tick을 돈다(테스트/로컬에서 의도치 않게 돌지 않도록).
    scheduler_enabled: bool = False

    # 로컬 데모: 미팅 자동 시드. CORS는 Next(다른 포트) 브라우저 호출 허용(운영은 명시 오리진).
    demo_seed: bool = False
    cors_allow_origin_regex: str = r"http://(localhost|127\.0\.0\.1):\d+"


settings = Settings()
