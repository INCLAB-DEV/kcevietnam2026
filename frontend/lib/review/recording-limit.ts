// 녹음 업로드 상한 — 백엔드 TRANSCRIPTION_MAX_UPLOAD_BYTES 기본값(200MB)과 같다. 서버가 녹음을 줄이고 5분 조각으로
// 나눠 전사하므로 예전 OpenAI 파일 상한(25MB)에 묶이지 않는다 — 30분 WAV 녹음(150MB 안팎)까지 받는다.
// 넘는 파일은 올려 봐야 서버가 413으로 거절하므로, 업로드(수백 MB 전송) 전에 화면에서 먼저 막는다.
// ⚠ BFF(app/api/reviews/[...path]/route.ts)·Caddy 본문 상한과 함께 맞춘다(backend/app/config.py 주석).

export const MAX_RECORDING_MB = 200
export const MAX_RECORDING_BYTES = MAX_RECORDING_MB * 1024 * 1024
// 녹음 길이 상한(분) — 백엔드 TRANSCRIPTION_MAX_AUDIO_SECONDS 기본값(2700초)과 같다. 길이는 업로드 전에 화면이
// 확실히 알 수 없어(브라우저 녹음 webm은 길이 정보가 없다) 검사는 서버가 하고, 화면은 안내 문구에만 쓴다.
export const MAX_RECORDING_MINUTES = 45

export function isRecordingTooLarge(file: Pick<File, "size">): boolean {
  return file.size > MAX_RECORDING_BYTES
}
