"""프로세스 공유 OpenAI 클라이언트 — 용도(kind)별로 하나를 지연 생성해 재사용한다.

예전엔 요청마다 어댑터를 새로 만들면서(``deps.get_structurer`` → ``factory.build_structurer`` →
``OpenAIStructurer.__init__``) ``OpenAI()``도 매번 새로 만들었다. 클라이언트마다 httpx 커넥션 풀이 따로라
keep-alive 재사용이 안 됐고, 무엇보다 **timeout/max_retries를 아무도 지정하지 않아** SDK 기본값(읽기
600초, 재시도 2회)이 그대로 적용됐다 — OpenAI가 느려지면 요청 스레드 하나가 수십 분 묶일 수 있었다.

타임아웃이 용도마다 다르다(config 주석): 러브콜 초안 60초, 텍스트 메모 구조화 180초, 녹음 전사와 전사 작업
안의 구조화 300초. 캐시 키에 **실제 타임아웃·재시도**가 들어가므로, 같은 "chat" 용도라도 설정이 다르면 다른
인스턴스다 — 긴 구조화가 짧은 상한의 클라이언트를 잘못 얻어 쓰는 일이 없다. 같은 용도·같은 설정이면 같은
인스턴스를 돌려준다 — OpenAI 클라이언트는 thread-safe라 동시 요청이 하나를 공유해도 된다(운영에선 설정이
고정이라 사실상 실효 설정당 1개).

타임아웃은 숫자 하나가 아니라 ``httpx.Timeout(t, connect=5.0)``(SDK가 ``openai.Timeout``으로 재노출)으로
넘긴다 — 숫자 하나면 연결 수립까지 t초(최대 300초)를 기다리게 되는데, 연결이 안 되는 상황은 몇 초면 판가름
난다(SDK 기본도 connect 5초다).
"""

from __future__ import annotations

import threading
from typing import Any, Literal

ClientKind = Literal["chat", "transcription"]

# 연결 수립 상한(초) — 용도와 무관하다. 응답 생성 대기(read)만 용도별 타임아웃을 따른다.
CONNECT_TIMEOUT_SECONDS = 5.0

_lock = threading.Lock()
_clients: dict[tuple[str, str, float, int], Any] = {}


def shared_openai_client(
    kind: ClientKind, *, api_key: str, timeout: float, max_retries: int
) -> Any:
    """용도별 공유 ``openai.OpenAI`` 인스턴스. 처음 부를 때 한 번만 만든다(동시 첫 호출에도 1개).

    openai 패키지는 optional-extra(infra)다 — 미설치면 ``ModuleNotFoundError``가 그대로 올라가고,
    호출부(어댑터 생성자)가 도메인 에러로 바꿔 명확히 실패시킨다(조용한 폴백 금지).
    """
    key = (kind, api_key, float(timeout), int(max_retries))
    client = _clients.get(key)
    if client is not None:
        return client
    with _lock:
        client = _clients.get(key)
        if client is None:
            from openai import OpenAI, Timeout

            client = OpenAI(
                api_key=api_key,
                timeout=Timeout(timeout, connect=CONNECT_TIMEOUT_SECONDS),
                max_retries=max_retries,
            )
            _clients[key] = client
    return client


def reset_shared_clients() -> None:
    """캐시를 비운다 — 테스트가 생성 인자·재사용을 처음 상태에서 검증할 때 쓴다."""
    with _lock:
        _clients.clear()
