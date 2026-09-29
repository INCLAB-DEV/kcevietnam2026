"""파일 저장 — 원본 녹음은 S3 영구보관(암호화·접근통제, ADR-0008).

업로드는 presigned URL 흐름(브라우저→S3)이 표준이나, 슬라이스에서는 backend 가 바이트를
받아 저장하는 경로도 지원한다(작은 녹음·서버 전사 직결). 테스트/로컬은 FakeStorage(인메모리).
"""

from __future__ import annotations

from typing import Protocol


class Storage(Protocol):
    def put(self, key: str, data: bytes, *, content_type: str = "application/octet-stream") -> str:
        """바이트를 key 에 저장하고 저장 식별자(S3 key)를 돌려준다."""
        ...

    def get(self, key: str) -> bytes:
        ...


class FakeStorage:
    """인메모리 저장 — 테스트/로컬."""

    def __init__(self) -> None:
        self._objects: dict[str, bytes] = {}

    def put(self, key: str, data: bytes, *, content_type: str = "application/octet-stream") -> str:
        self._objects[key] = data
        return key

    def get(self, key: str) -> bytes:
        return self._objects[key]


class S3Storage:
    """S3 저장. boto3 는 optional-extra(infra). 서버사이드 암호화(AES256) 적용."""

    def __init__(self, bucket: str, region: str = "ap-northeast-2") -> None:
        if not bucket:
            raise RuntimeError("S3 버킷 미설정")
        try:
            import boto3
        except ModuleNotFoundError as exc:  # pragma: no cover - infra extra
            raise RuntimeError("boto3 미설치 — `uv pip install '.[infra]'`") from exc
        self._s3 = boto3.client("s3", region_name=region)
        self._bucket = bucket

    def put(self, key: str, data: bytes, *, content_type: str = "application/octet-stream") -> str:  # pragma: no cover - 외부호출
        self._s3.put_object(
            Bucket=self._bucket,
            Key=key,
            Body=data,
            ContentType=content_type,
            ServerSideEncryption="AES256",
        )
        return key

    def get(self, key: str) -> bytes:  # pragma: no cover - 외부호출
        obj = self._s3.get_object(Bucket=self._bucket, Key=key)
        return obj["Body"].read()
