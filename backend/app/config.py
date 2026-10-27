"""앱 설정 — 환경변수에서 주입. 시크릿(OpenAI/Cognito/S3)은 backend에만 둔다(CONTEXT.md).

어댑터 backend 토글(transcriber/structurer/storage)로 로컬·테스트는 fake, 실배포는 실제
서비스를 선택한다. 키가 없으면 실 어댑터 생성 시점에 명확히 실패한다(조용한 폴백 금지).
env_prefix는 없다 — 변수는 DATABASE_URL / TRANSCRIBER_BACKEND 처럼 그대로 읽는다.
"""

import json
from typing import Annotated, Literal

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # PostgreSQL 접속 URL. Alembic/앱이 공유한다. psycopg v3 드라이버. 운영(standalone)은 RDS가 아니라
    # 앱과 같은 EC2에서 도는 Postgres다 — 앱·DB가 같은 CPU·메모리를 나눠 쓴다(무거운 작업이 DB까지 느리게 한다).
    #   예: postgresql+psycopg://nabi:nabi@localhost:5432/nabi
    database_url: str = "postgresql+psycopg://nabi:nabi@localhost:5432/nabi"

    # 커넥션 풀(app.db.engine). SQLAlchemy 기본값(5+10, 대기 30초)은 단일 uvicorn 프로세스가 행사 당일
    # 몰리는 요청을 받기엔 작고, 고갈되면 요청이 30초씩 줄줄이 묶인 뒤에야 실패한다. 풀을 넓히되 못 얻으면
    # 10초 안에 실패시켜 적체가 번지지 않게 한다. pre_ping은 DB 쪽에서 끊긴 유휴 커넥션을 쓰기 전에 거른다.
    # ⚠ 늘릴 때는 DB의 max_connections(다른 클라이언트·마이그레이션 몫 포함)를 같이 본다.
    # 상한 50(10+40)은 동기 요청을 동시에 처리하는 AnyIO 스레드(40) + 전사 풀(3)·일괄 메일·스케줄러 스레드보다
    # 크게 잡은 값이다 — 풀이 스레드보다 작으면 CPU가 포화돼 짧은 쿼리도 늘어질 때 스레드끼리 커넥션을 기다리다
    # 10초에 실패한다(2026-10-03 부하 테스트: 30일 때 200명 동시 로그인 15건 실패·/api/me 45건 실패, 50일 때
    # 198/200 성공). Postgres max_connections는 100이다(레포 밖 읽기 전용 조회 최대 3 포함해도 여유).
    db_pool_size: int = 10
    db_max_overflow: int = 40
    db_pool_timeout: float = 10
    db_pool_pre_ping: bool = True

    # 비밀번호 해시(bcrypt cost 12, 1회 약 0.2~0.3초 CPU) 동시 실행 상한 — 프로세스 전체 합산
    # (app.auth.credentials.password_hash_slot). 로그인 검증·자체가입·비밀번호 변경·명단 공통 비밀번호·운영자의
    # 담당자 비밀번호 설정이 같은 자리를 나눠 쓴다. 상한이 없을 때(2026-10-02 부하 테스트, 2 vCPU·uvicorn 1개,
    # 첫 로그인 100명 동시) 해시 수십 개가 CPU 2개를 나눠 쓰느라 한 건이 수 초씩 걸렸고, 그동안 요청이 DB 커넥션
    # 까지 쥐고 있어 풀이 고갈됐다(500 9건, p95 20초). 로그인·가입·비밀번호 변경은 자리를 기다리기 전에 DB 커넥션을
    # 놓는다(app.db.release_connection — 운영자 경로 둘은 예외, app.admin.router._hash_or_422 주석).
    # - 자리 2: vCPU 2개 — 해시를 그보다 많이 동시에 돌려도 CPU를 나눠 쓸 뿐 처리량은 같고 건마다 늦어지기만 한다.
    # - 대기 상한 12명: 기다리는 요청도 AnyIO 스레드 토큰(프로세스 전체 40개)을 쥔다. 이미 12명이 기다리면 줄을
    #   세우지 않고 즉시 503으로 돌려보낸다 — 해시에 묶이는 스레드를 최대 2 + 12 = 14개로 막아, 로그인이 몰려도
    #   나머지 26개 이상은 해시와 무관한 다른 동기 API(/api/me·목록 조회 등)가 쓴다(2026-10-03 교차리뷰 HIGH).
    #   24 → 12(2026-10-06): AI 채팅·녹음 업로드 자리와 합친 스레드 예산을 40 아래로 맞췄다(아래
    #   ai_chat_max_waiters 주석). 줄에 서지 못해 503 login_busy를 받은 로그인은 화면이 무작위 간격으로 최대 4번
    #   다시 보낸다(frontend/lib/auth/login-retry).
    # - 대기 10초: 해시 1회 약 0.25초 × 자리 2 → 초당 약 8건이라 대기열 12명은 1.5초 남짓에 빠진다. 10초 넘게
    #   기다렸다면 CPU가 다른 일로 막힌 것이라 더 붙잡지 않는다.
    # 거절은 로그인이면 503 ``login_busy``(화면 "로그인 요청이 많아요"), 그 밖의 경로는 503 ``server_busy``다.
    password_hash_max_concurrency: int = Field(default=2, ge=1)
    password_hash_acquire_timeout_seconds: float = Field(default=10, gt=0)
    password_hash_max_waiters: int = Field(default=12, ge=0)

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

    # OpenAI 호출 상한(app.services.openai_clients). 지정하지 않으면 SDK 기본값(읽기 600초 + 재시도 2회)이
    # 그대로 적용돼, OpenAI가 느려지면 요청 하나가 수십 분 스레드를 쥔다. 용도마다 출력 길이가 달라 따로 둔다
    # (스트리밍이 아니라 응답이 다 만들어질 때까지 아무것도 안 오므로, 타임아웃이 곧 생성 시간 상한이다):
    #   - chat: 러브콜 초안 — 짧은 편지 한 통.
    #   - structuring: 텍스트 메모 구조화 — 메모 길이에 비례해 화자별 turns까지 다시 쓴다.
    #   - transcription: **전사 작업 안의 구조화** — 30분 전사 원문 전체를 transcript_turns로 다시 출력해
    #     수천~1만 토큰이 나온다(채팅 상한이면 긴 회의에서 잘린다). 이름은 예전(녹음 통째 전사도 이 값을 썼다)
    #     그대로다 — 운영 env 호환을 위해 바꾸지 않았다.
    #   - transcription_chunk: 녹음 **조각 하나**(기본 5분)의 오디오 전사 호출. 녹음은 통째로 보내지 않는다 —
    #     gpt-4o-transcribe는 1400초가 넘으면 거부하고, 20분짜리도 앞 8분만 전사한 채 조용히 잘랐다
    #     (2026-10-02 실측). 그래서 작업이 ffmpeg로 조각낸 뒤 조각마다 이 상한으로 부른다(app.services.
    #     recording_transcription). 5분 조각은 보통 수십 초 안에 끝난다.
    # 연결 수립은 용도와 무관하게 5초 상한이다(openai_clients). 재시도는 **호출 종류별**로, 최악 대기 시간을
    # 기준으로 정한다(응답 대기는 위 타임아웃 — 전사 작업 안의 구조화는 transcription 타임아웃을 쓴다):
    #   - chat 1회(최악 ≈ 2 × 60초).
    #   - structuring 0회 — 텍스트 구조화(최악 180초: 화면 요청이 BFF의 응답 헤더 대기 약 300초보다 먼저 끝나게)와
    #     전사 작업 안의 구조화(최악 300초) 둘 다.
    #   - transcription(오디오 조각 전사 호출) 1회 — 일시적인 429·5xx 하나로 작업 전체가 실패하지 않게
    #     (조각 하나 최악 2 × 120초).
    # ⚠ 전사 작업의 최악 실행 시간(아래 transcription_job_max_age_seconds 산정의 근거)이 이 값들로 정해진다.
    openai_chat_timeout_seconds: float = 60
    openai_structuring_timeout_seconds: float = 180
    openai_transcription_timeout_seconds: float = 300
    openai_transcription_chunk_timeout_seconds: float = 120
    openai_chat_max_retries: int = Field(default=1, ge=0)
    openai_structuring_max_retries: int = Field(default=0, ge=0)
    openai_transcription_max_retries: int = Field(default=1, ge=0)

    # AI 동시 호출 상한(app.services.ai_concurrency) — 미팅이 한꺼번에 끝나 녹음·정리 요청이 몰리는 순간용.
    # 전사는 전용 스레드풀에서 최대 N건만 돌고 나머지는 큐에서 기다린다. 동기 채팅 호출은 자리를 제한 시간
    # 안에 못 얻으면 바로 '바쁨'으로 돌려준다(구조화 503 ai_busy, 러브콜은 직접 작성 폴백).
    # 자리 대기 시간은 짧게 둔다 — 기다리는 동안 요청은 AnyIO 스레드 토큰(프로세스 전체 40개)을 쥐고 있어서,
    # 길게 기다리게 하면 AI와 무관한 다른 동기 API까지 스레드 대기로 밀린다.
    transcription_max_concurrency: int = Field(default=3, ge=1)
    ai_chat_max_concurrency: int = Field(default=6, ge=1)
    ai_chat_acquire_timeout_seconds: float = 5
    # 채팅 자리 대기 상한(2026-10-06 교차리뷰 HIGH) — 자리 6개가 다 찼을 때 줄을 설 수 있는 요청 수. 이미 8명이
    # 기다리는 중이면 줄을 세우지 않고 즉시 '바쁨'으로 돌려준다(구조화 503 ai_busy, 러브콜은 직접 작성 폴백). 빈 자리가
    # 있으면 대기 수와 무관하게 바로 잡는다. 예전엔 대기 수에 상한이 없어, 요청이 몰리면 기다리는 요청만으로 스레드
    # 40개가 5초씩 묶여 AI와 무관한 API까지 멈출 수 있었다. 녹음 업로드 자리에도 같은 장치를 둔다(아래
    # transcription_upload_max_waiters).
    #
    # 스레드 예산 — 자리(일하는 중 + 기다리는 중)에 묶일 수 있는 AnyIO 스레드(프로세스 전체 40개)의 최댓값:
    #   비밀번호 해시 2 + 12 = 14 / AI 채팅 6 + 8 = 14 / 녹음 업로드 4 + 5 = 9 → 합 37
    #   - 세 가지가 동시에 가득 차도 37개다 — 나머지 3개 이상은 이 세 자리와 무관한 요청이 쓴다.
    #   - 둘씩 겹치면 로그인 + 채팅 28, 로그인 + 업로드 23, 채팅 + 업로드 23 → 12·17·17개가 남는다.
    #   - 한 종류만 몰리면 14·14·9 → 26·26·31개가 남는다.
    #   ⚠ 이 여섯 값(자리 수 셋·대기 상한 셋) 중 하나라도 올릴 때는 합이 40 아래로 남는지 같이 본다. 기본값의 합이
    #   40 미만인지는 테스트가 잠근다(tests/test_ai_concurrency.py의 스레드 예산 테스트).
    ai_chat_max_waiters: int = Field(default=8, ge=0)
    # 녹음 업로드 상한. 30분 회의를 휴대폰·노트북으로 녹음하면 m4a는 수십 MB, 갤럭시 WAV 녹음은 150MB를 넘기도
    # 한다 — 서버가 ffmpeg로 줄이고 조각내 전사하므로(app.services.recording_transcription) 예전처럼 OpenAI 파일
    # 상한(25MB)에 묶이지 않는다. 넘는 파일은 S3 보관·작업 접수 전에 413(audio_too_large)으로 거른다.
    # ⚠ 세 겹을 같이 맞춘다: 이 값 / BFF(frontend/app/api/reviews/[...path]/route.ts, 이 값 + 1MB 여유) /
    # Caddy request_body 상한(210MB). 화면 사전 검사(frontend/lib/review/recording-limit.ts)도 같은 값이다.
    transcription_max_upload_bytes: int = 200 * 1024 * 1024
    # 녹음 업로드 동시 처리 상한 — 핸들러가 받은 파일을 S3로 흘려보내는 구간(파일당 수 초)에만 건다. boto3 멀티파트
    # 전송이 업로드마다 버퍼(≈ 동시 파트 수 × 8MB)를 잡으므로, 미팅이 한꺼번에 끝나 업로드가 몰려도 메모리가
    # 이 배수로만 늘게 한다. 자리를 제한 시간 안에 못 얻으면 503 ai_busy(화면은 "AI 요청이 많아요").
    # 대기 15초: 앞 업로드의 S3 전송은 보통 수 초면 끝나므로, 사용자가 수백 MB를 다 올린 뒤에 잠깐 겹쳤다는 이유로
    # 503을 받지 않게 넉넉히 기다린다(교차리뷰 M1). 기다리는 동안 요청은 AnyIO 스레드 토큰(전체 40개)을 쥐지만,
    # 이 대기에 묶이는 건 S3 전송이 몰린 순간의 업로드 요청뿐이다.
    # 대기 상한 5명(2026-10-06 교차리뷰 HIGH): 이미 5명이 기다리는 중이면 줄을 세우지 않고 즉시 503 ai_busy —
    # 업로드 자리에 묶이는 스레드를 최대 4 + 5 = 9개로 막는다(스레드 예산은 위 ai_chat_max_waiters 주석).
    # 9 = 전사 대기열 깊이(아래 transcription_max_queue_depth)에 맞춘 값이다. 업로드는 대기열 칸을 먼저 잡고
    # 이 자리에 오므로 동시에 여기 있을 수 있는 요청은 대기열 깊이만큼뿐이다 — 자리 + 대기 상한이 그보다 작으면
    # 칸까지 받은 업로드가 여기서 즉시 거절돼 수백 MB를 다시 올려야 한다. 대기열 깊이를 올릴 때는 이 값도 같이
    # 본다(둘의 관계는 tests/test_ai_concurrency.py의 기본값 테스트가 잠근다).
    transcription_max_concurrent_uploads: int = Field(default=4, ge=1)
    transcription_upload_acquire_timeout_seconds: float = 15
    transcription_upload_max_waiters: int = Field(default=5, ge=0)
    # 전사 대기열 깊이 상한 — 이 프로세스에 접수돼 아직 끝나지 않은(대기 + 실행) 전사 작업 수. 넘으면 업로드를
    # S3에 올리기 전에 503 ai_busy로 돌려보낸다. 예전엔 무제한으로 받아 두고 대기열 만료(당시 15분) 뒤에야 실패시켜,
    # 사용자가 결과를 못 받고 다시 올리면서 대기열이 더 길어졌다. 9 = 전사 풀(3) × 3바퀴 — 맨 뒤 작업은 앞의
    # 2바퀴(6건)를 기다린다. 대기열 만료(아래 600초) 안에 차례가 오려면 작업 1건이 평균 약 300초(=600/2) 안에
    # 끝나야 한다 — 30분 녹음 1건 추정 약 3~3.5분(변환 + 5분 조각 6개 순차 전사 + 구조화)이라 12(평균 200초 필요)
    # 대신 9로 둔다(2026-10-02). 실측 평균이 더 짧으면 환경변수 TRANSCRIPTION_MAX_QUEUE_DEPTH로 올린다.
    # (풀 크기나 대기열 만료를 바꾸면 이 값도 같이 본다.)
    transcription_max_queue_depth: int = Field(default=9, ge=1)
    # 녹음 길이 상한(초). 넘으면 전사 작업이 ffprobe 직후(길이 정보가 없는 녹음은 변환 결과로) 고정 문구로
    # 실패한다 — 업로드 단계에선 길이를 확실히 알 수 없다(브라우저 webm 녹음은 길이 메타데이터가 없고,
    # 휴대폰 m4a는 끝에 있는 moov를 읽어야 한다). 미팅은 30분이라 45분이면 넉넉하다. 60분으로 두지 않는 이유:
    # 작업 안 구조화가 전사 원문 전체를 transcript_turns로 다시 출력하므로(전사 길이에 비례), 아주 긴 녹음은 그
    # 응답이 300초 상한(openai_transcription_timeout_seconds) 안에 끝나지 않을 수 있다(2026-10-02 결정, 45분).
    # 화면 안내 문구(frontend/lib/review/recording-limit.ts MAX_RECORDING_MINUTES)도 같은 값이다.
    transcription_max_audio_seconds: float = Field(default=2700, gt=0)
    # 전사 조각 길이(초) — 녹음을 모노 16kHz WAV(16bit PCM)로 바꾸며 이 길이로 자른다(5분 ≈ 9.6MB).
    # gpt-4o-transcribe가 한 번에 끝까지 전사하는 길이가 실측 약 8분이라 그보다 넉넉히 짧게 둔다.
    transcription_chunk_seconds: int = Field(default=300, ge=10)
    # ffmpeg 변환·분할 1회의 상한(초). 45분 녹음도 보통 수십 초면 끝난다(t4g, 16kHz 모노 WAV) — 이 시간을
    # 넘기면 깨진 파일이나 비정상 입력으로 보고 작업을 실패시킨다.
    transcription_ffmpeg_timeout_seconds: float = 300
    # 전사 작업 1건의 실행 마감(초, 작업 시작부터). 조각을 하나 보내기 **전마다** 확인해 넘었으면 남은 조각을 보내지
    # 않고 실패로 끝낸다(이미 보낸 호출은 각자의 타임아웃까지 기다린다). 전사가 끝까지 끝났으면 마감과 무관하게
    # 구조화한다 — 다 만든 전사문을 버리지 않는다(구조화는 자체 상한 300초, 교차리뷰 H4). 30분 녹음(6조각)은 보통
    # 수 분, 상한인 45분 녹음(9조각)도 이 안에 끝난다.
    transcription_job_deadline_seconds: float = 600
    # 전사 작업이 대기열에서 이 시간(초)보다 오래 기다린 뒤에야 차례가 오면 OpenAI를 부르지 않고 실패로 끝낸다.
    # 화면 폴링 상한이 1800초(lib/review/transcription-tracker.ts)라 그 뒤에 끝나는 결과는 아무도 못 받는다.
    # 작업의 최악 실행 시간 = 실행 마감 600초 + 마감 직전에 시작한 마지막 조각 240초(120초 × 2회) + 구조화
    # 300초(× 1회) = 1140초.
    #   - 마감은 조각을 보내기 전에만 확인하고, 전사가 끝나면 구조화는 항상 한다(위 실행 마감 주석).
    #   - 마감 확인 전 단계(S3 내려받기 + ffprobe ≤ 60초 + ffmpeg ≤ 300초)는 마감 600초 안에 들어간다.
    # → 대기 600초 + 실행 1140초 = 1740초 ≤ 화면 폴링 1800초. 이보다 오래 기다린 작업은 끝나기 전에 화면이 먼저
    # 포기할 수 있어 비용·슬롯만 쓴다.
    # (위 OpenAI 타임아웃·재시도, 실행 마감, 화면 폴링 상한을 바꾸면 이 값도 다시 계산한다.)
    transcription_job_max_age_seconds: float = 600
    # 앱 시작 시, 이 프로세스가 뜨기 전에 만들어져 아직 pending인 전사 작업을 실패로 정리한다 — 그 작업을 돌리던
    # 프로세스(전사 풀)는 재시작으로 사라졌으므로 영영 끝나지 않는다. ⚠ 백엔드 프로세스가 하나라는 전제다
    # (standalone 배포: uvicorn 1개). 여러 프로세스·겹치는 롤링 배포에서는 살아 있는 다른 프로세스의 작업까지
    # 실패로 만든다 — 그런 배포에선 끈다.
    transcription_fail_orphans_on_startup: bool = True

    # 어댑터 선택. 'fake' = 외부 호출 없이 결정적 동작(로컬/테스트/데모).
    transcriber_backend: Literal["openai", "fake"] = "fake"
    structurer_backend: Literal["openai", "fake"] = "fake"
    storage_backend: Literal["s3", "fake"] = "fake"
    # 부하 테스트용 AI 지연 스텁(초) — 전사기·구조화기가 **fake일 때만** 호출마다 이만큼 잔다(전사는 조각마다,
    # 구조화는 호출마다). 운영 OpenAI 한도를 쓰지 않고 '느린 AI'의 대기열·스레드 점유를 재현한다. openai
    # 어댑터는 이 값을 받지 않는다(app.services.factory) — 운영(openai)에는 아무 영향이 없다.
    fake_ai_latency_seconds: float = Field(default=0, ge=0)

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
    # SMTP 소켓 타임아웃(초). 없으면 SES/네트워크가 응답을 멈췄을 때 발송 스레드가 무기한 묶인다. 정상 SES 발송은
    # 0.2~0.3초 정도라 8초면 충분히 넉넉하고, SES가 멈췄을 때 요청 스레드(단건 알림·러브콜 발송)를 붙잡는 시간을
    # 8초로 묶는다.
    smtp_timeout_seconds: float = 8
    # 이메일 초당 상한 — **프로세스 전체** 합산(일괄 확정 백그라운드·리마인더 스케줄러·요청 안 단건 발송이
    # 같은 상한을 나눠 쓴다, app.notifications.email.email_rate_limiter). SES 계정 한도(14통/초, 수신자 수
    # 기준)보다 낮게 둬 스로틀 오류를 피한다.
    email_max_per_second: float = Field(default=10, gt=0)
    # 메일 제목·본문에 쓰는 서비스/행사 표기. 행사별로 바뀔 수 있어 env로 뺀다(기본값은 사용자
    # 노출 제품명 Sales AI — 2026-09-30 NABI→Sales AI 리브랜딩으로 갱신).
    email_brand_name: str = "Sales AI"

    # 알림 리마인더 폴링 스케줄러(ADR-0010, ~1분 주기 asyncio 태스크). 기본 off — 명시적으로
    # 켜야 FastAPI lifespan이 백그라운드 tick을 돈다(테스트/로컬에서 의도치 않게 돌지 않도록).
    # ⚠ 회의록 텍스트 보존기간 정리(아래)도 이 스케줄러 안에서 하루 한 번 돈다 — 꺼져 있으면 정리도 안 돈다.
    scheduler_enabled: bool = False

    # 회의록 텍스트 보존기간(일) — 행사 종료일(events.exhibition_end, 그 행사 타임존 기준)에서 이 일수가 지나면
    # 그 행사 미팅의 회의록 자유 텍스트(전사·AI 정리·적합도 사유)를 지운다(app.services.meeting_text_retention).
    # 녹음 원본의 S3 수명주기 규칙(행사 종료 30일 뒤)과 같은 원칙이다(2026-10-02 발주사 결정). 만족도·후속의향·
    # Fit 등급 같은 정형 결과는 지우지 않는다. 정리를 잠시 멈추려면 큰 값(예: 36500)을 넣는다.
    meeting_text_retention_days_after_event: int = Field(default=30, ge=0)

    # 로컬 데모: 미팅 자동 시드. CORS는 Next(다른 포트) 브라우저 호출 허용(운영은 명시 오리진).
    demo_seed: bool = False
    cors_allow_origin_regex: str = r"http://(localhost|127\.0\.0\.1):\d+"

    # 참가자 미팅 신청 모달에서 **고를 수 있는** 장소 유형(발주사 운영 정책 — 현재는 부스 미팅만).
    # "행사에 그 장소가 있는가"(events.enabled_venue_types, 운영자가 어드민에서 켜고 끈다)와는 다른
    # 축이다: 여기서 빠진 유형은 목록에서 사라지지 않고 '불가능'으로 내려가 선택만 막힌다(참가자가
    # 정책을 알 수 있게). 다시 열 때 고칠 곳은 이 값 하나다 —
    #   MEETING_BOOKABLE_VENUE_TYPES=booth,zone_table   (JSON 배열 표기도 받는다)
    # 참가자 신청의 쓰기 가드는 계속 events.enabled_venue_types가 소유한다. 운영자 배정(강제·⚡재보충·
    # 일괄배정 확정)이 장소를 **자동으로** 고를 때도 이 정책을 따른다(2026-10-01 — 기본이면 참가사 부스,
    # app.matching.assignment_service._auto_venue_resolver). 운영자가 venue_id를 명시하면 그 장소를 쓴다.
    meeting_bookable_venue_types: Annotated[list[str], NoDecode] = ["booth"]

    @field_validator("meeting_bookable_venue_types", mode="before")
    @classmethod
    def _split_venue_types(cls, value):
        """콤마 구분(``booth,zone_table``)과 JSON 배열을 모두 받는다.

        표시 정책 하나 때문에 앱이 기동에 실패하면 안 된다 — 기본 list[str] 파싱은 JSON만 받아서
        ``booth,zone_table`` 같은 자연스러운 오타가 startup crash가 된다. 값 자체의 유효성(캐노니컬
        어휘인지)은 여기서 판단하지 않는다: 모르는 유형은 행사 설정과의 교집합에서 그냥 빠진다.
        """
        if not isinstance(value, str):
            return value
        text = value.strip()
        if text.startswith("["):
            return json.loads(text)
        return [part.strip() for part in text.split(",") if part.strip()]


settings = Settings()
