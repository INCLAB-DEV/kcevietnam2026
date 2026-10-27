"""공유 OpenAI 클라이언트(동시성 하드닝 1차) — 명시 timeout·재시도 1회·용도별 재사용을 잠근다.

예전엔 요청마다 ``OpenAI()``를 새로 만들었고 timeout/max_retries를 아무도 지정하지 않아 SDK 기본값(읽기
600초·재시도 2회)이 그대로였다. 용도마다 실효 타임아웃이 다르다 — 러브콜 초안 60초, 텍스트 메모 구조화
180초, 전사 작업 안의 구조화 300초(전사 원문 전체를 transcript_turns로 다시 출력한다), 녹음 조각(5분) 전사
120초(2026-10-02 조각 전사 — 녹음을 통째로 보내지 않는다).
네트워크는 타지 않는다 — ``OpenAI()`` 생성은 소켓을 열지 않으므로 더미 키로 속성만 검사한다.
라우트별 배선(어느 경로가 어느 타임아웃으로 호출하는가)은 ``test_ai_concurrency.py``의 ``TestTimeoutPerPath``가 잠근다.
"""

from __future__ import annotations

import threading

import openai
import pytest

from app.config import Settings
from app.services.factory import build_structurer, build_transcriber
from app.services.love_call_mail import build_love_call_mail_drafter
from app.services.openai_clients import reset_shared_clients, shared_openai_client
from app.services.structuring import FakeStructurer, for_full_transcript


@pytest.fixture(autouse=True)
def _fresh_cache():
    reset_shared_clients()
    yield
    reset_shared_clients()


def _openai_settings(**overrides) -> Settings:
    base = dict(
        transcriber_backend="openai",
        structurer_backend="openai",
        openai_api_key="sk-test-shared-clients",
    )
    base.update(overrides)
    # 로컬 .env(개발자별 타임아웃 설정 등)가 기본값 검증에 섞이지 않게 파일은 읽지 않는다.
    return Settings(_env_file=None, **base)


def _limits(adapter) -> tuple[float, float, int]:
    """어댑터가 쓰는 공유 클라이언트의 (응답 대기 상한, 연결 상한, 재시도 횟수)."""
    client = adapter._client  # type: ignore[attr-defined]
    return (client.timeout.read, client.timeout.connect, client.max_retries)


def _job_structurer(s: Settings):
    # 라우트(reviews.transcribe_and_structure)와 같은 조합 — 응답 대기는 전사 상한, 재시도는 구조화 공통.
    return for_full_transcript(
        build_structurer(s),
        timeout=s.openai_transcription_timeout_seconds,
        max_retries=s.openai_structuring_max_retries,
    )


def test_each_use_gets_its_own_configured_timeout_and_retries():
    s = _openai_settings(
        openai_chat_timeout_seconds=61,
        openai_structuring_timeout_seconds=181,
        openai_transcription_timeout_seconds=301,
        openai_transcription_chunk_timeout_seconds=121,
        openai_chat_max_retries=2,
        openai_structuring_max_retries=3,
        openai_transcription_max_retries=4,
    )
    text_structurer = build_structurer(s)
    job_structurer = _job_structurer(s)
    drafter = build_love_call_mail_drafter(s)
    transcriber = build_transcriber(s)

    # 응답 대기는 용도별, 재시도는 호출 종류별(구조화 둘은 같은 값), 연결 수립은 언제나 5초다.
    assert _limits(text_structurer) == (181, 5.0, 3)
    assert _limits(job_structurer) == (301, 5.0, 3)
    assert _limits(drafter) == (61, 5.0, 2)
    # 오디오 전사는 조각 하나 기준 상한(121)이다 — 작업 안 구조화(301)와 따로다.
    assert _limits(transcriber) == (121, 5.0, 4)
    # 채팅 세 용도는 클라이언트를 나눠 쓰지 않는다 — 긴 구조화가 짧은 상한의 클라이언트를 얻는 일이 없다.
    chat_clients = {id(text_structurer._client), id(job_structurer._client), id(drafter._client)}  # type: ignore[attr-defined]
    assert len(chat_clients) == 3
    # 전사 작업용 구조화기는 모델을 그대로 이어받는다(타임아웃·재시도만 다르다).
    assert job_structurer._model == text_structurer._model  # type: ignore[attr-defined]


def test_clients_are_reused_within_each_use():
    s = _openai_settings()
    # 요청마다 어댑터를 새로 만들어도 클라이언트(=httpx 커넥션 풀)는 실효 설정당 하나.
    assert build_structurer(s)._client is build_structurer(s)._client  # type: ignore[attr-defined]
    assert build_love_call_mail_drafter(s)._client is build_love_call_mail_drafter(s)._client  # type: ignore[attr-defined]
    assert build_transcriber(s)._client is build_transcriber(s)._client  # type: ignore[attr-defined]
    assert _job_structurer(s)._client is _job_structurer(s)._client  # type: ignore[attr-defined]


def test_defaults_bound_the_worst_case_wait():
    """기본값 — 러브콜 초안 60초·재시도 1(최악 약 120초), 텍스트 구조화 180초·재시도 0(BFF 응답 헤더 대기
    약 300초 안), 전사 작업 안의 구조화 300초·재시도 0, 오디오 조각 전사 120초·재시도 1(일시적 429·5xx 흡수).
    연결 수립은 전부 5초. 전사 작업의 최악 실행 = 실행 마감 600 + 마지막 조각 120 × 2 + 구조화 300 × 1 = 1140초
    (대기열 만료 600초의 근거 — 600 + 1140 ≤ 화면 폴링 1800, test_ai_concurrency.TestQueuedJobExpiry)."""
    s = _openai_settings()
    assert _limits(build_love_call_mail_drafter(s)) == (60, 5.0, 1)
    assert _limits(build_structurer(s)) == (180, 5.0, 0)
    assert _limits(_job_structurer(s)) == (300, 5.0, 0)
    assert _limits(build_transcriber(s)) == (120, 5.0, 1)


def test_fake_structurer_passes_through_unchanged():
    """타임아웃 개념이 없는 구현(fake·테스트 대역)은 전사 작업에도 그대로 흐른다(override 보존)."""
    fake = FakeStructurer()
    assert for_full_transcript(fake, timeout=300, max_retries=0) is fake


def test_concurrent_first_use_builds_exactly_one_client(monkeypatch):
    """요청이 몰린 첫 순간에도 클라이언트는 하나만 만들어진다(지연 생성의 동시 초기화 안전)."""
    built: list[object] = []
    real_openai = openai.OpenAI

    def counting_openai(**kwargs):
        client = real_openai(**kwargs)
        built.append(client)
        return client

    monkeypatch.setattr(openai, "OpenAI", counting_openai)

    barrier = threading.Barrier(8)
    got: list[object] = []
    lock = threading.Lock()

    def worker():
        barrier.wait()
        client = shared_openai_client("chat", api_key="sk-test-race", timeout=60, max_retries=1)
        with lock:
            got.append(client)

    threads = [threading.Thread(target=worker) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=5)

    assert len(built) == 1
    assert len(got) == 8 and all(c is built[0] for c in got)
