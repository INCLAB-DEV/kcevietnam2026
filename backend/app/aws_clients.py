"""프로세스 공유 boto3 클라이언트 — (서비스, 리전)마다 처음 쓸 때 한 번만, 락 아래에서, 전용 Session으로 만든다.

boto3 클라이언트는 만들어진 뒤엔 스레드 간에 공유해도 안전하지만, **만드는 과정**(특히 기본 세션을 쓰는
``boto3.client(...)``)은 thread-safe가 아니다. 예전엔 녹음 원본 보관(app.services.storage)·명단 원본 보관
(app.storage)이 요청마다, Cognito 유저풀(app.auth.cognito_pool)이 첫 로그인들마다 기본 세션으로 클라이언트를
만들었다 — 업로드·전사·로그인이 모두 스레드풀에서 돌기 때문에, 행사 시작 직후처럼 첫 요청이 몰리면 생성이
경합할 수 있었다.

전용 ``boto3.Session()``을 쓰는 이유: 이 모듈 밖에서 기본 세션으로 클라이언트를 만드는 코드가 있어도 생성
시점이 겹쳐 서로의 세션 상태를 건드리지 않는다. 자격증명·리전 해석은 ``boto3.client``와 같은 기본 체인
(IAM 역할/환경변수/공유 설정)이다.

boto3 는 optional-extra(infra)다 — 미설치면 ``ModuleNotFoundError``가 그대로 올라간다(호출부가 필요하면
설치 안내로 바꾼다 — 조용한 폴백 금지).

타임아웃·재시도는 명시한다(``_client_config``): botocore 기본(연결·응답 각 60초, legacy 모드 재시도)이면
S3·Cognito가 느려질 때 업로드·로그인 요청 스레드가 오래 묶일 수 있다. 연결 5초, 응답 대기 60초, 재시도는
standard 모드(스로틀·일시 오류만 재시도)로 ``max_attempts=3`` — botocore에서 이 값은 **첫 시도를 뺀 재시도
횟수**라 한 요청은 최대 4번까지 시도된다(``total_max_attempts=4``로 해석된다).

클라이언트 하나의 HTTP 연결 풀은 ``max_pool_connections=32``로 넓힌다(botocore 기본 10). 공유 클라이언트라 녹음
업로드(동시 4건 × 멀티파트 4조각 = 16)와 전사 작업의 원본 내려받기(동시 3건 × 4조각 = 12)가 한 풀을 나눠 쓴다 —
기본 10이면 전송이 겹칠 때 연결을 기다리거나 풀이 꽉 찼다는 경고와 함께 연결을 버리고 다시 맺는다(교차리뷰 M2).
"""

from __future__ import annotations

import threading
from typing import Any

_lock = threading.Lock()
_clients: dict[tuple[str, str | None], Any] = {}


def _client_config() -> Any:
    from botocore.config import Config

    return Config(
        connect_timeout=5,
        read_timeout=60,
        retries={"max_attempts": 3, "mode": "standard"},
        max_pool_connections=32,
    )


def shared_boto3_client(service_name: str, region: str | None) -> Any:
    """``service_name``(예: "s3", "cognito-idp")·``region``용 공유 클라이언트. 동시 첫 호출에도 하나만 만든다."""
    key = (service_name, region)
    client = _clients.get(key)
    if client is not None:
        return client
    with _lock:
        client = _clients.get(key)
        if client is None:
            import boto3

            client = boto3.Session().client(
                service_name, region_name=region, config=_client_config()
            )
            _clients[key] = client
    return client


def reset_shared_boto3_clients() -> None:
    """캐시를 비운다 — 테스트가 생성 횟수·재사용을 처음 상태에서 검증할 때 쓴다."""
    with _lock:
        _clients.clear()
