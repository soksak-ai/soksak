import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("workspace surface loading", () => {
  it("loads App only after the control-plane branch exits", () => {
    const source = readFileSync(resolve(import.meta.dirname, "../main.tsx"), "utf8");
    expect(source).not.toContain('import App from "./App"');
    expect(source).toContain('const { default: App } = await import("./App")');
    expect(source.indexOf('await import("./orchestrator/OrchestratorApp")')).toBeLessThan(
      source.indexOf('await import("./App")'),
    );
  });
});
