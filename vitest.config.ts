// 프론트엔드 단위 테스트 설정 — vite.config 와 분리(앱 빌드에 영향 없음).
// globals 미사용: 테스트 파일이 vitest 에서 명시적으로 import 한다(tsconfig 무변경).
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    // scripts 짝 테스트(게이트 자가검사)도 같은 러너로 돈다 — 검사 메커니즘을 늘리지 않는다.
    include: ["src/**/*.test.ts", "src/**/*.test.tsx", "scripts/**/*.test.mjs"],
  },
});
