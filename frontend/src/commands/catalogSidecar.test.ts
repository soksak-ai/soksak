import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("../framework", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../framework")>()),
  invoke: (...args: unknown[]) => invoke(...args),
}));

import { registerSidecarCatalog } from "./catalogSidecar";
import { execute, unregister } from "./registry";

describe("sidecar.request", () => {
  beforeEach(() => invoke.mockReset());
  afterEach(() => { for (const name of ["sidecar.request", "sidecar.install.local.plan", "sidecar.install.local"]) unregister(name); });

  it("relays one opaque control request without interpreting its command", async () => {
    registerSidecarCatalog();
    invoke.mockResolvedValueOnce({ ok: true, result: { data: { session: 7 } } });
    const request = { id: "inspect", command: "pty.pane", args: { request: { paneId: "pan-abc234" } } };
    const result = await execute("sidecar.request", { name: "pty", request }, {});
    expect(invoke).toHaveBeenCalledWith("sidecar_send", { name: "pty", payload: JSON.stringify(request) });
    expect(result).toMatchObject({ ok: true, data: { sidecar: "pty", response: { ok: true } } });
  });

  it("rejects an array instead of inventing a request shape", async () => {
    registerSidecarCatalog();
    const result = await execute("sidecar.request", { name: "pty", request: [] }, {});
    expect(result).toMatchObject({ ok: false, code: "INVALID_PARAMS" });
    expect(invoke).not.toHaveBeenCalled();
  });
});
