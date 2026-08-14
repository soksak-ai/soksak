import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("bootstrap diagnostics", () => {
  it("publishes module evaluation failures before React starts", () => {
    const html = readFileSync(fileURLToPath(new URL("../index.html", import.meta.url)), "utf8");
    expect(html).toContain('data-boot-status="loading"');
    expect(html).toContain('window.addEventListener("error"');
    expect(html).toContain('window.addEventListener("unhandledrejection"');
    expect(html).toContain("data-boot-error");
  });
});
