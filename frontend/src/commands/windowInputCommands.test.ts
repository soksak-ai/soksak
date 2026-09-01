import { beforeAll, describe, expect, it } from "vitest";

import { startExecutor } from "./executor";
import { execute, getSpec } from "./registry";

describe("window.input — discoverable native input diagnostics", () => {
  beforeAll(() => startExecutor());

  it.each([
    ["window.input.state", []],
    ["window.input.mark", ["text"]],
    ["window.input.pointer.wait", ["sequence", "timeoutMs"]],
    ["window.input.pointer.inject", ["x", "y"]],
    ["window.input.pointer.drag", ["fromX", "fromY", "toX", "toY", "steps", "durationMs"]],
    ["window.input.pointer.click", [
      "x", "y", "recordDir", "recordFrames", "recordIntervalMs", "recordLeadMs", "recordMaxBytes", "traceAddresses",
    ]],
    ["window.input.key.press", ["key", "ctrl", "meta", "shift", "alt"]],
    ["window.native-close.status", []],
    ["window.native-close.click", []],
    ["window.native-close.wait", ["sequence", "timeoutMs"]],
  ])("publishes the exact help contract for %s", async (name, params) => {
    expect(Object.keys(getSpec(name)?.params ?? {})).toEqual(params);
    const result = await execute("command.docs", { name }, {});
    expect(result).toMatchObject({
      ok: true,
      data: {
        command: {
          name,
          description: expect.any(String),
          returns: expect.any(String),
          examples: expect.any(Array),
        },
      },
    });
  });

  it("native pointer click exposes a frame-bound recording and DOM trace receipt", () => {
    expect(getSpec("window.input.pointer.click")?.returns).toContain("recording");
    expect(getSpec("window.input.pointer.click")?.returns).toContain("trace");
  });

  it("separates native pointer delivery from a UI drag", async () => {
    const result = await execute("command.docs", { name: "window.input.pointer.drag" }, {});
    expect(result).toMatchObject({ ok: true });
    expect((result as { data: { command: { description: string } } }).data.command.description)
      .toMatch(/DOM gesture|DOM 드래그/);
  });
});
