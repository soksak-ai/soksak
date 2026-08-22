// Frontend unit test config — kept separate from vite.config (no effect on the app build).
// globals unused: test files import explicitly from vitest (tsconfig unchanged).
import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  resolve: {
    // Tests never pick the product framework implicitly. Point the same seam the product graph uses
    // at the neutral adapter — this stops shared modules from loading against Wails by accident.
    alias: {
      "#framework-adapter": resolve(import.meta.dirname, "src/framework/selected.neutral.ts"),
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/testEnvironment.ts"],
    // Process workers survive as PID-1 children when an interactive runner is interrupted.
    // Thread workers share the runner lifecycle, so cancellation cannot orphan Node processes.
    pool: "threads",
    maxWorkers: 4,
    minWorkers: 1,
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
