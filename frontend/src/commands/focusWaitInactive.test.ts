// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from "vitest";

import { startExecutor } from "./executor";
import { execute } from "./registry";

describe("ui.focus.wait in an inactive window", () => {
  beforeAll(() => startExecutor());

  it("returns immediately instead of starting a timer WebKit may suspend", async () => {
    const original = document.hasFocus;
    Object.defineProperty(document, "hasFocus", { configurable: true, value: () => false });
    try {
      const result = await execute("ui.focus.wait", { tab: "tab-target", timeoutMs: 4000 }, {});
      expect(result).toMatchObject({ ok: false, code: "WINDOW_NOT_FOCUSED" });
    } finally {
      Object.defineProperty(document, "hasFocus", { configurable: true, value: original });
    }
  });
});
