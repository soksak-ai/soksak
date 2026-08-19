import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("orchestrator bundle boundary", () => {
  it("loads OrchestratorApp only inside the main-window branch", () => {
    const source = readFileSync(resolve(import.meta.dirname, "../main.tsx"), "utf8");
    expect(source).not.toContain('import { OrchestratorApp } from "./orchestrator/OrchestratorApp"');
    expect(source).toContain('await import("./orchestrator/OrchestratorApp")');
  });
});
