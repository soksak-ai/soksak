// 프론트엔드 단위 테스트 설정 — vite.config 와 분리(앱 빌드에 영향 없음).
// globals 미사용: 테스트 파일이 vitest 에서 명시적으로 import 한다(tsconfig 무변경).
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
