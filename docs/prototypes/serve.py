#!/usr/bin/env python3
"""
NABI 프로토타입 개발 서버 (캐시 OFF)

`python -m http.server` 는 캐시 제어 헤더를 안 보내서, 브라우저가 옛
nabi-ui.css / HTML 을 계속 캐시한다 → CSS 를 고쳐도 화면에 반영 안 됨
(폰 프리뷰에서 드로어/모달이 프레임 밖으로 새는 증상이 대표적).

이 서버는 모든 응답에 no-store 를 붙여 항상 최신 파일을 받게 한다.

사용:
    cd docs/prototypes
    python3 serve.py            # http://localhost:8765
    python3 serve.py 9000       # 포트 지정
"""
import sys
import http.server
import socketserver

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def log_message(self, fmt, *args):  # 조용히
        pass


with socketserver.TCPServer(("", PORT), NoCacheHandler) as httpd:
    httpd.allow_reuse_address = True
    print(f"NABI prototypes → http://localhost:{PORT}  (캐시 OFF — 항상 최신)")
    print("종료: Ctrl+C")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n중지됨")
