import { describe, expect, it, vi } from "vitest";

import { handleNativeCloseRequest, windowNativeCloseEvent } from "./nativeCloseRequests";

describe("native close request", () => {
  it("routes the addressed native pointer request through the public close command", async () => {
    const run = vi.fn(async () => ({ ok: true as const, code: "OK", message: "", data: {} }));
    await handleNativeCloseRequest({ window: "win-a", sequence: 7, atUnixMs: 10 }, run);
    expect(windowNativeCloseEvent).toBe("window.native-close-requested");
    expect(run).toHaveBeenCalledWith("window.close", {}, {});
  });

  it("rejects an unsequenced request without closing", async () => {
    const run = vi.fn();
    await expect(handleNativeCloseRequest({ window: "win-a", sequence: 0, atUnixMs: 10 }, run as never))
      .rejects.toThrow("invalid");
    expect(run).not.toHaveBeenCalled();
  });
});
