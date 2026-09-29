"""CORS 배선 회귀 테스트(main.py의 CORSMiddleware) — FE의 credentials:"include" 크로스오리진
호출이 브라우저에서 막히지 않는지 고정한다.

allow_credentials가 빠지면 프리플라이트 응답에 access-control-allow-credentials 헤더가 안 붙어
브라우저가 실제 요청 자체를 보내지 않는다(E2E로 재현된 결함). allow_origin_regex(localhost/
127.0.0.1:포트무관)와 조합해도 매칭된 origin을 그대로 반사하는지(와일드카드로 새지 않는지)도 함께
확인한다.
"""

from __future__ import annotations

from fastapi.testclient import TestClient

from app.main import app


def test_cors_preflight_allows_credentials_for_local_origin():
    client = TestClient(app)
    resp = client.options(
        "/health",
        headers={
            "Origin": "http://localhost:3000",
            "Access-Control-Request-Method": "GET",
        },
    )
    assert resp.status_code == 200
    assert resp.headers.get("access-control-allow-credentials") == "true"
    # credentials 모드에서 "*"는 무효 — 매칭된 origin 그대로를 반사해야 브라우저가 받아들인다.
    assert resp.headers.get("access-control-allow-origin") == "http://localhost:3000"


def test_cors_preflight_rejects_disallowed_origin():
    # allow_origin_regex 밖의 origin은 여전히 거부(credentials 추가가 화이트리스트를 넓히지 않는다).
    client = TestClient(app)
    resp = client.options(
        "/health",
        headers={
            "Origin": "http://evil.example.com",
            "Access-Control-Request-Method": "GET",
        },
    )
    assert "access-control-allow-origin" not in resp.headers
