# NABI 백엔드 — ECS Fargate 배포용 이미지 (docker/build-push-action, context: backend)
# Python 3.12 고정 — pyproject.toml requires-python >=3.12 + AWS 런타임과 정합(python-preference=managed 주석 참고).
# 멀티스테이지: builder에서 uv로 의존성/프로젝트 설치 → runtime은 결과 venv만 복사해 슬림 유지.

FROM python:3.12-slim AS builder

# uv 바이너리만 공식 이미지에서 가져온다(파이썬은 base의 3.12 사용, python-preference=managed로 uv.lock과 정합).
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /bin/

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PROJECT_ENVIRONMENT=/app/.venv

WORKDIR /app

# 의존성 레이어를 먼저 캐시 — pyproject/lock만으로 sync(소스 변경이 이 레이어를 무효화하지 않음).
# 본 프로젝트는 [build-system]이 없는 non-package(virtual) 구성이라 uv가 nabi-backend 자체는 빌드하지
# 않고 의존성만 venv에 설치한다(uv pip list에 nabi-backend 미등장으로 로컬 확인) — --no-install-project 불필요.
RUN --mount=type=cache,target=/root/.cache/uv \
    --mount=type=bind,source=uv.lock,target=uv.lock \
    --mount=type=bind,source=pyproject.toml,target=pyproject.toml \
    uv sync --frozen --no-dev

# 앱 소스 복사(런타임에 app.main:app을 PYTHONPATH 없이 WORKDIR 기준으로 임포트).
# 테스트/샘플 데이터/문서는 .dockerignore로 제외해 빌드 컨텍스트·이미지 크기를 줄인다.
COPY pyproject.toml uv.lock ./
COPY app ./app
COPY alembic.ini ./alembic.ini
COPY migrations ./migrations


FROM python:3.12-slim AS runtime

# 녹음 전처리(app.services.audio_preprocessing)용 ffmpeg·ffprobe — 시스템 패키지라 런타임 단계에만 둔다(파이썬
# 의존성 아님). 녹음을 모노 16kHz WAV(PCM)로 바꾸고 5분 조각으로 나눠 전사한다(통째 전사는 긴 녹음을 조용히 잘랐다).
# --no-install-recommends로 권장 패키지를 빼도 Debian ffmpeg(13/trixie, 7.1)는 libavfilter → libplacebo → mesa
# 의존(libllvm19 약 120MB 등)을 끌고 와 이미지가 약 0.5GB → 1.1GB로 커진다(2026-10-02 로컬 arm64 측정).
# 줄이려면 정적 빌드 ffmpeg로 바꾸는 방법이 있다(후속 과제 — 지금은 배포판 패키지의 보안 업데이트를 택한다).
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

RUN groupadd --system app && useradd --system --gid app --no-create-home app

WORKDIR /app
COPY --from=builder --chown=app:app /app /app

ENV PATH="/app/.venv/bin:$PATH" \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

USER app
EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
