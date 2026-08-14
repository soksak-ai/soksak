// @vitest-environment jsdom
// **Where to query whether plugin boot finished.**
//
// Even when the workspace boot phase (`app.boot.wait`) reports ready, plugin bodies are still running —
// measured 2026-08-08: after waiting on that phase the ledger was read and the bundle stamp was not there yet.
// The two are different facts, and querying different facts under one name blocks the decision with "never measured".
//
// That boundary is already in the code — `markCommandHostReady`. The caller must be able to wait on it from
// outside. No second query: an already-past fact returns at once, otherwise the call waits on that event.
import { describe, expect, it, vi } from "vitest";

vi.mock("../framework", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../framework")>()),
  invoke: vi.fn(async () => undefined),
}));

import { markCommandHostReady, awaitCommandHostReady } from "./executor";
import { registerBootCatalog } from "./catalogBoot";
import { execute, getSpec } from "./registry";

registerBootCatalog();

describe("plugin boot completion is awaited from outside", () => {
  // Past the limit it reports that fact, not "ready" — a failure to wait cannot be expressed as success.
  //
  // This check comes **first**. Ready is a fact that cannot be reverted once set (a door that reverts it is a
  // door through which the product loses ready), and a fresh module load keeps that record outside the module boundary.
  it("past the limit it rejects with the deadline", async () => {
    await expect(awaitCommandHostReady(10)).rejects.toThrow(/10ms/);
  });

  it("the command exists and declares what it answers", () => {
    const spec = getSpec("plugin.boot.wait");
    expect(spec).toBeDefined();
    expect(spec?.returns).toContain("ready");
  });

  // Waiting forever on an already-past fact kills the caller by timeout alone.
  it("an already-past completion answers at once", async () => {
    markCommandHostReady();
    await expect(awaitCommandHostReady(50)).resolves.toEqual({ ready: true });
    const out = await execute("plugin.boot.wait", { timeoutMs: 50 }, {});
    expect(out.ok).toBe(true);
  });

});
