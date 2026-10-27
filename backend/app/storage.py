"""업로드 원본 보관 포트 — S3에 명단 원본을 영구보관한다(ADR-0008 D15, 암호화·접근통제).

S3 버킷이 설정돼 있으면 S3에 올리고, 아니면(로컬/CI·테스트) NullStorage로 건너뛴다.
raw JSONB(registrants.raw)와 별개로, 파일 그 자체를 손실 없이 박제하는 채널이다.
"""

from __future__ import annotations

import uuid
from typing import Protocol

from app.aws_clients import shared_boto3_client
from app.config import settings


class RosterStorage(Protocol):
    def put_original(self, event_id: str, filename: str, data: bytes, content_type: str | None) -> str | None:
        """원본을 보관하고 위치 키(S3 key 등)를 반환. 미설정이면 None."""
        ...


class NullStorage:
    """S3 미설정 환경(로컬/CI)용 무동작 보관소 — 적재는 진행하되 원본 박제는 생략."""

    def put_original(self, event_id: str, filename: str, data: bytes, content_type: str | None) -> str | None:
        return None


class S3Storage:
    """boto3 기반 S3 보관소. 키: roster/{event_id}/{uuid}-{filename}.

    ``get_storage``가 요청마다 만들지만 boto3 클라이언트는 리전별 프로세스 공유본이다(app.aws_clients) — 기본
    세션으로 요청마다 만들면 스레드풀에서 동시에 도는 업로드들 사이에 클라이언트 생성이 경합한다. boto3는 여전히
    처음 쓸 때 지연 임포트된다(S3 미사용 환경에서 초기화 비용을 피한다).
    """

    def __init__(self, bucket: str, region: str | None):
        self._bucket = bucket
        self._client = shared_boto3_client("s3", region)

    def put_original(self, event_id: str, filename: str, data: bytes, content_type: str | None) -> str | None:
        safe_name = (filename or "roster").replace("/", "_")
        key = f"roster/{event_id}/{uuid.uuid4().hex}-{safe_name}"
        extra = {"ContentType": content_type} if content_type else {}
        self._client.put_object(Bucket=self._bucket, Key=key, Body=data, **extra)
        return key


def get_storage() -> RosterStorage:
    """설정에 따라 보관소를 고른다. FastAPI 의존성으로 주입한다."""
    if settings.s3_bucket:
        return S3Storage(settings.s3_bucket, settings.aws_region)
    return NullStorage()
