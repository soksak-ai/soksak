// @vitest-environment node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("test process ownership", () => {
  it("uses worker threads so an interrupted runner cannot orphan forked node processes", () => {
    const config = readFileSync(resolve(import.meta.dirname, "../vitest.config.ts"), "utf8");
    expect(config).toContain('pool: "threads"');
    expect(config).not.toContain('pool: "forks"');
  });
});
