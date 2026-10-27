"""녹음 저장소 스트리밍(2026-10-02) — 원본(최대 200MB)을 바이트로 들고 다니지 않는다.

네트워크는 타지 않는다 — S3는 botocore Stubber로 s3transfer가 실제로 부르는 API 순서만 확인한다.

잠그는 것:
- S3: ``put_fileobj``는 8MB 이상이면 멀티파트(ContentType·SSE AES256 유지), 작으면 PutObject 한 번. 읽기 래퍼가
  상한 초과로 예외를 던지면 멀티파트를 중단(abort)하고 **같은 예외**를 올린다 — 라우트가 413으로 바꾼다.
  ``download_to_file``은 파일로 내려받는다.
- FakeStorage: 큰 객체는 메모리가 아니라 임시 파일에 둔다(부하 테스트가 fake 저장소로 수백 MB를 올려도 메모리에
  쌓이지 않게). 읽다가 실패하면 반쯤 쓴 객체를 남기지 않는다.
"""

from __future__ import annotations

import io

import boto3
import pytest
from botocore.response import StreamingBody
from botocore.stub import ANY, Stubber

from app.api.reviews import _CappedUpload, _UploadTooLarge
from app.services.storage import FakeStorage, S3Storage

MB = 1024 * 1024


def _stubbed_storage():
    client = boto3.Session(aws_access_key_id="test", aws_secret_access_key="test").client(
        "s3", region_name="ap-northeast-2"
    )
    storage = S3Storage.__new__(S3Storage)  # 공유 클라이언트 대신 스텁 클라이언트를 꽂는다
    storage._s3 = client
    storage._bucket = "nabi-test-bucket"
    return storage, client


class TestS3Streaming:
    def test_large_upload_goes_multipart_with_content_type_and_encryption(self):
        storage, client = _stubbed_storage()
        with Stubber(client) as stub:
            stub.add_response(
                "create_multipart_upload",
                {"UploadId": "upload-1"},
                {
                    "Bucket": "nabi-test-bucket",
                    "Key": "meetings/e/m/o/x-a.m4a",
                    "ContentType": "audio/mp4",
                    "ServerSideEncryption": "AES256",
                    "ChecksumAlgorithm": ANY,
                },
            )
            for _ in range(3):  # 20MB = 8MB 조각 3개
                stub.add_response("upload_part", {"ETag": '"etag"'}, None)
            stub.add_response("complete_multipart_upload", {}, None)

            key = storage.put_fileobj(
                "meetings/e/m/o/x-a.m4a",
                _CappedUpload(io.BytesIO(b"\x01" * (20 * MB)), 200 * MB),
                content_type="audio/mp4",
            )
            stub.assert_no_pending_responses()
        assert key == "meetings/e/m/o/x-a.m4a"

    def test_small_upload_is_a_single_put(self):
        storage, client = _stubbed_storage()
        with Stubber(client) as stub:
            stub.add_response("put_object", {"ETag": '"etag"'}, None)
            storage.put_fileobj("k", _CappedUpload(io.BytesIO(b"\x01" * 1000), 5000), content_type="audio/mp4")
            stub.assert_no_pending_responses()

    def test_cap_exceeded_mid_stream_aborts_multipart_and_keeps_the_exception(self):
        storage, client = _stubbed_storage()
        with Stubber(client) as stub:
            stub.add_response("create_multipart_upload", {"UploadId": "upload-2"}, None)
            for _ in range(2):  # 상한(20MB) 전까지의 조각
                stub.add_response("upload_part", {"ETag": '"etag"'}, None)
            stub.add_response("abort_multipart_upload", {}, None)

            with pytest.raises(_UploadTooLarge):
                storage.put_fileobj(
                    "k", _CappedUpload(io.BytesIO(b"\x01" * (30 * MB)), 20 * MB), content_type="audio/mp4"
                )
            stub.assert_no_pending_responses()  # 중단(abort)까지 불렀다 — 반쯤 올라간 객체가 남지 않는다

    def test_download_writes_to_a_file(self, tmp_path):
        storage, client = _stubbed_storage()
        data = b"recording-bytes" * 100
        with Stubber(client) as stub:
            stub.add_response("head_object", {"ContentLength": len(data), "ETag": '"etag"'}, None)
            stub.add_response(
                "get_object",
                {"Body": StreamingBody(io.BytesIO(data), len(data)), "ContentLength": len(data), "ETag": '"etag"'},
                None,
            )
            target = tmp_path / "source.bin"
            storage.download_to_file("k", target)
        assert target.read_bytes() == data


class TestFakeStorageSpool:
    def test_large_object_lives_on_disk_not_in_memory(self):
        storage = FakeStorage()
        storage.put_fileobj("big", io.BytesIO(b"\x02" * (3 * MB)))
        spool = storage._objects["big"]
        assert spool._rolled  # 1MB를 넘으면 임시 파일로 넘어갔다
        assert storage.get("big") == b"\x02" * (3 * MB)

    def test_failed_read_leaves_no_object(self):
        storage = FakeStorage()
        with pytest.raises(_UploadTooLarge):
            storage.put_fileobj("k", _CappedUpload(io.BytesIO(b"\x01" * 5000), 1000))
        assert storage._objects == {}

    def test_download_to_file_round_trip(self, tmp_path):
        storage = FakeStorage()
        storage.put("k", b"abc" * 1000)
        storage.download_to_file("k", tmp_path / "out.bin")
        assert (tmp_path / "out.bin").read_bytes() == b"abc" * 1000
