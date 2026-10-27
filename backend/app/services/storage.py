"""파일 저장 — 원본 녹음은 S3 영구보관(암호화·접근통제, ADR-0008).

업로드는 presigned URL 흐름(브라우저→S3)이 표준이나, 슬라이스에서는 backend 가 바이트를
받아 저장하는 경로도 지원한다(서버 전사 직결). 테스트/로컬은 FakeStorage.

녹음은 최대 200MB(config.transcription_max_upload_bytes)라 **바이트로 들고 다니지 않는다**:
업로드는 Starlette가 디스크에 받아 둔 파일을 ``put_fileobj``로 흘려보내고, 전사 작업은
``download_to_file``로 임시 파일에 내려받는다. 예전처럼 ``bytes``로 읽으면 업로드마다 파일 크기의
1~2배가 메모리에 올라왔다(동시 업로드 수만큼 곱해진다).
"""

from __future__ import annotations

import shutil
import tempfile
import threading
from pathlib import Path
from typing import BinaryIO, Protocol

from app.aws_clients import shared_boto3_client

# S3 전송(boto3 upload_fileobj/download_file) 설정. 멀티파트 조각을 메모리에 읽어 올리므로 업로드 1건이 잡는
# 메모리 ≈ 메모리에 쌓아 두는 조각 수 × 조각 크기다. 기본(동시 10 · 쌓아 두기 10 × 8MB ≈ 80MB)은 업로드가
# 몰리면 메모리 4GB 서버에 부담이라 4조각(≈ 32MB)으로 묶는다 — 동시 업로드 상한(config.
# transcription_max_concurrent_uploads, 기본 4)과 곱해도 128MB 안이다. 같은 리전 S3라 4조각이면 충분히 빠르다.
_PART_BYTES = 8 * 1024 * 1024
_MAX_PARTS_IN_FLIGHT = 4

# FakeStorage가 객체를 메모리에 두는 크기 한도 — 넘으면 임시 파일로 넘긴다(부하 테스트가 fake 저장소로 수백 MB를
# 올려도 메모리에 쌓이지 않게. Starlette 업로드 스풀과 같은 1MB).
_FAKE_SPOOL_BYTES = 1024 * 1024
_COPY_CHUNK_BYTES = 1024 * 1024


def _transfer_config():
    from boto3.s3.transfer import TransferConfig

    config = TransferConfig(
        multipart_threshold=_PART_BYTES,
        multipart_chunksize=_PART_BYTES,
        max_concurrency=_MAX_PARTS_IN_FLIGHT,
    )
    # boto3의 TransferConfig 생성자는 이 값을 받지 않지만 s3transfer가 그대로 읽는다(기본 10) — 메모리에 쌓아 둘
    # 조각 수를 동시 전송 수와 같게 묶는다.
    config.max_in_memory_upload_chunks = _MAX_PARTS_IN_FLIGHT
    return config


class Storage(Protocol):
    def put(self, key: str, data: bytes, *, content_type: str = "application/octet-stream") -> str:
        """바이트를 key 에 저장하고 저장 식별자(S3 key)를 돌려준다."""
        ...

    def put_fileobj(
        self, key: str, fileobj: BinaryIO, *, content_type: str = "application/octet-stream"
    ) -> str:
        """파일 객체를 ``read(n)``으로 조금씩 읽어 key 에 저장한다(통째로 메모리에 올리지 않는다).

        ``fileobj.read``가 던진 예외(예: 업로드 상한 초과)는 그대로 올라가고, 그때는 아무것도 저장되지 않는다.
        """
        ...

    def get(self, key: str) -> bytes:
        ...

    def download_to_file(self, key: str, path: Path) -> None:
        """key 의 객체를 ``path``에 파일로 내려받는다(메모리에 통째로 올리지 않는다)."""
        ...


class FakeStorage:
    """테스트/로컬 저장 — 작은 객체는 메모리, 큰 객체는 임시 파일(SpooledTemporaryFile)에 둔다.

    ``deps.get_storage``가 요청마다 새로 만들고, 전사 작업이 같은 인스턴스를 넘겨받아 읽는다 — 작업이 끝나 참조가
    사라지면 임시 파일도 같이 지워진다.
    """

    def __init__(self) -> None:
        self._objects: dict[str, tempfile.SpooledTemporaryFile] = {}
        self._lock = threading.Lock()

    def put(self, key: str, data: bytes, *, content_type: str = "application/octet-stream") -> str:
        spool = tempfile.SpooledTemporaryFile(max_size=_FAKE_SPOOL_BYTES)
        spool.write(data)
        self._store(key, spool)
        return key

    def put_fileobj(
        self, key: str, fileobj: BinaryIO, *, content_type: str = "application/octet-stream"
    ) -> str:
        spool = tempfile.SpooledTemporaryFile(max_size=_FAKE_SPOOL_BYTES)
        try:
            shutil.copyfileobj(fileobj, spool, _COPY_CHUNK_BYTES)
        except BaseException:
            spool.close()  # 읽다가 실패(상한 초과 등)하면 반쯤 쓴 객체를 남기지 않는다 — S3 멀티파트 중단과 같다.
            raise
        self._store(key, spool)
        return key

    def get(self, key: str) -> bytes:
        with self._lock:
            spool = self._objects[key]
            spool.seek(0)
            return spool.read()

    def download_to_file(self, key: str, path: Path) -> None:
        with self._lock:
            spool = self._objects[key]
            spool.seek(0)
            with open(path, "wb") as out:
                shutil.copyfileobj(spool, out, _COPY_CHUNK_BYTES)

    def _store(self, key: str, spool: tempfile.SpooledTemporaryFile) -> None:
        with self._lock:
            previous = self._objects.get(key)
            self._objects[key] = spool
        if previous is not None:
            previous.close()


class S3Storage:
    """S3 저장. boto3 는 optional-extra(infra). 서버사이드 암호화(AES256) 적용.

    인스턴스는 가볍다(버킷 이름 + 공유 클라이언트 참조) — 요청마다 만들어도(deps.get_storage) boto3 클라이언트는
    새로 만들지 않는다. 리전별 공유 클라이언트(app.aws_clients)라 명단 원본 보관(app.storage)과도 같은
    클라이언트를 쓴다.
    """

    def __init__(self, bucket: str, region: str = "ap-northeast-2") -> None:
        if not bucket:
            raise RuntimeError("S3 버킷 미설정")
        try:
            self._s3 = shared_boto3_client("s3", region)
        except ModuleNotFoundError as exc:  # pragma: no cover - infra extra
            raise RuntimeError("boto3 미설치 — `uv pip install '.[infra]'`") from exc
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

    def put_fileobj(
        self, key: str, fileobj: BinaryIO, *, content_type: str = "application/octet-stream"
    ) -> str:  # pragma: no cover - 외부호출
        # 8MB 이상이면 멀티파트로 조각내 올린다. 중간에 실패하면(읽기 예외 포함) s3transfer가 멀티파트 업로드를
        # 중단(abort)하고 예외를 그대로 올린다 — 반쯤 올라간 객체는 남지 않는다.
        self._s3.upload_fileobj(
            fileobj,
            self._bucket,
            key,
            ExtraArgs={"ContentType": content_type, "ServerSideEncryption": "AES256"},
            Config=_transfer_config(),
        )
        return key

    def get(self, key: str) -> bytes:  # pragma: no cover - 외부호출
        obj = self._s3.get_object(Bucket=self._bucket, Key=key)
        return obj["Body"].read()

    def download_to_file(self, key: str, path: Path) -> None:  # pragma: no cover - 외부호출
        self._s3.download_file(self._bucket, key, str(path), Config=_transfer_config())
