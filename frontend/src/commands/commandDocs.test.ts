import { beforeAll, describe, expect, it } from "vitest";

import { startExecutor } from "./executor";
import { execute, getSpec } from "./registry";

describe("command.docs — one discoverable command", () => {
  beforeAll(() => startExecutor());

  it("declares the command name filter", () => {
    expect(getSpec("command.docs")?.params.name).toMatchObject({ type: "string", required: false });
  });

  it("returns the full public spec for exactly one name", async () => {
    const result = await execute("command.docs", { name: "window.snapshot" }, {});
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      command: {
        name: "window.snapshot",
        description: expect.any(String),
        params: expect.any(Object),
        returns: expect.any(String),
        errors: expect.any(Array),
        examples: expect.any(Array),
      },
    });
  });

  it("refuses an absent name as UNKNOWN_COMMAND", async () => {
    const result = await execute("command.docs", { name: "no.such.command" }, {});
    expect(result).toMatchObject({ ok: false, code: "UNKNOWN_COMMAND" });
  });
});
