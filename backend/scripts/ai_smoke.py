#!/usr/bin/env python3
"""OpenAI AI 파이프라인 실연동 스모크 — 배포 전 오케스트레이터가 직접 실행.

전사(Whisper 계열)와 구조화(OpenAIStructurer)를 실 API 키로 태워 계약이 살아있는지 확인한다.
테스트 스위트가 아니다 — CI/pytest에서 자동 실행하지 않는다(실 네트워크·실 과금 호출).

사용법:
    OPENAI_API_KEY=sk-... .venv/bin/python scripts/ai_smoke.py
    .venv/bin/python scripts/ai_smoke.py --key-file ~/.secrets/openai.key
    .venv/bin/python scripts/ai_smoke.py --audio sample.wav --transcribe-model gpt-4o-transcribe

키는 화면(stdout/stderr)에 절대 출력하지 않는다.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

# 스크립트를 `python scripts/ai_smoke.py`로 직접 실행할 때도 app 패키지를 찾도록 backend/ 루트를
# sys.path에 추가한다(pytest는 pyproject의 pythonpath=["."]로 처리하지만 이건 pytest 밖 실행).
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

_KEY_RE = re.compile(r"sk-[A-Za-z0-9_-]{10,}")

# K-콘텐츠 수출 상담 느낌의 샘플 미팅 전사(한국어, 합성 — 실 데이터 아님).
_SAMPLE_TRANSCRIPT = """
안녕하세요, NABI 비즈매칭으로 연결된 참가사입니다. 오늘 저희 웹툰 IP 라이선스 건으로 뵙게 됐습니다.
네, 반갑습니다. 저희는 동남아 OTT 플랫폼 콘텐츠 소싱을 담당하고 있습니다.
먼저 저희 작품 3편의 현지화 진행 상황을 공유드리겠습니다. 베트남어 자막은 이미 완료됐습니다.
좋네요. 저희 쪽에서는 성인 인증 등급과 방영 심의 기준이 맞는지가 가장 중요합니다.
등급 관련해서는 저희가 심의 대응 가이드를 별도로 준비해서 다음 주까지 전달드리겠습니다.
계약 조건 중에서는 최소 보장 로열티(MG) 규모가 궁금합니다. 기존에 진행하신 사례가 있을까요.
네, 유사 규모 플랫폼과는 에피소드당 정액 방식으로 진행한 이력이 있습니다. 자료로 정리해서 드리겠습니다.
일정상으로는 이번 분기 내 계약을 마무리하고 싶습니다. 가능할까요.
저희도 같은 목표입니다. 내부 법무 검토만 거치면 2주 내로 초안 회신드릴 수 있습니다.
오늘 논의 감사합니다. 다음 미팅에서는 로열티 정산 주기와 정산 리포트 양식을 확정하시죠.
""".strip()


def _resolve_api_key(args: argparse.Namespace) -> str | None:
    import os

    if args.key_file:
        try:
            text = Path(args.key_file).expanduser().read_text()
        except OSError as exc:
            print(f"[FAIL] --key-file 읽기 실패: {exc}", file=sys.stderr)
            return None
        match = _KEY_RE.search(text)
        if not match:
            print("[FAIL] --key-file 에서 sk-... 형식 키를 찾지 못했습니다", file=sys.stderr)
            return None
        return match.group(0)
    return os.environ.get("OPENAI_API_KEY")


def _run_transcription(api_key: str, audio_path: str, model: str) -> bool:
    from app.services.transcription import OpenAIWhisperTranscriber

    path = Path(audio_path)
    if not path.exists():
        print(f"[FAIL] --audio 파일 없음: {audio_path}", file=sys.stderr)
        return False
    try:
        transcriber = OpenAIWhisperTranscriber(api_key, model=model)
        text = transcriber.transcribe(path.read_bytes(), filename=path.name)
    except Exception as exc:  # noqa: BLE001 - 스모크는 원인을 그대로 보여줘야 함
        print(f"[FAIL] 전사 단계 실패({model}): {exc}", file=sys.stderr)
        return False
    print(f"[OK] 전사({model}): {text[:200]!r}{'…' if len(text) > 200 else ''}")
    return True


def _run_structuring(api_key: str, model: str) -> bool:
    from app.services.structuring import OpenAIStructurer

    try:
        structurer = OpenAIStructurer(api_key, model=model)
        result = structurer.structure(_SAMPLE_TRANSCRIPT, counterpart_org="샘플 OTT사")
    except Exception as exc:  # noqa: BLE001
        print(f"[FAIL] 구조화 단계 실패({model}): {exc}", file=sys.stderr)
        return False

    summary = {
        "discussion_count": len(result.report.discussion),
        "agreements_count": len(result.report.agreements),
        "actions_count": len(result.report.actions),
        "fit_suggestion": result.fit_suggestion.value if result.fit_suggestion else None,
        "fit_reason_seed": result.fit_reason_seed,
        "fit_reason_tags": result.fit_reason_tags,
        "transcript_turns_count": len(result.transcript_turns),
        "discussion_sample": result.report.discussion[:2],
    }
    print(f"[OK] 구조화({model}):")
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return True


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--key-file", help="OPENAI_API_KEY 를 담은 파일 경로(sk-... 정규식 추출)")
    parser.add_argument("--audio", help="전사 실측에 쓸 오디오 파일. 없으면 전사 단계 SKIP")
    parser.add_argument(
        "--transcribe-model", default="gpt-4o-transcribe", help="전사 모델(기본 gpt-4o-transcribe)"
    )
    parser.add_argument(
        "--structurer-model", default="gpt-5.4-mini", help="구조화 모델(기본 gpt-5.4-mini)"
    )
    args = parser.parse_args()

    api_key = _resolve_api_key(args)
    if not api_key:
        print(
            "[FAIL] OpenAI API 키 없음 — OPENAI_API_KEY 환경변수 또는 --key-file 을 지정하세요",
            file=sys.stderr,
        )
        return 1

    ok = True

    if args.audio:
        ok = _run_transcription(api_key, args.audio, args.transcribe_model) and ok
    else:
        print("[SKIP] --audio 미지정 — 전사 단계 생략")

    ok = _run_structuring(api_key, args.structurer_model) and ok

    if not ok:
        print("[FAIL] 스모크 실패 — 위 로그 참조", file=sys.stderr)
        return 1
    print("[OK] 스모크 전체 통과")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
