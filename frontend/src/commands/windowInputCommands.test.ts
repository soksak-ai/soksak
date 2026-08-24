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
});
