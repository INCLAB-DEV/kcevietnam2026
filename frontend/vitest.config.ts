import { defineConfig } from "vitest/config"
import react from "@vitejs/plugin-react"
import path from "path"

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./vitest.setup.ts"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
      // Next는 빌드 시 `server-only`를 alias한다(클라 import 시 에러). 테스트엔 그 런타임이 없으므로
      // noop 스텁으로 매핑해 server-only 모듈(serverApiClient)을 그냥 import할 수 있게 한다.
      "server-only": path.resolve(__dirname, "lib/test/server-only-stub.ts"),
    },
  },
})
