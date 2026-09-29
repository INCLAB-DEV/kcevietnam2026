// vitest용 `server-only` noop 스텁(vitest.config.ts alias). 프로덕션 빌드에선 Next가 진짜
// `server-only`로 alias하므로 이 파일은 테스트 런타임에서만 쓰인다.
export {}
