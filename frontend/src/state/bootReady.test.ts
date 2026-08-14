import { afterEach, describe, expect, it } from "vitest";
import { useBootPhase } from "./bootPhase";
import { awaitBootReady } from "./bootReady";

afterEach(() => useBootPhase.getState().setPhase("ready"));

describe("boot ready event barrier", () => {
  it("resolves at once when the phase is already ready", async () => {
    useBootPhase.getState().setPhase("ready");
    await expect(awaitBootReady(50)).resolves.toEqual({ phase: "ready" });
  });

  it("waits for the activating→ready state event", async () => {
    useBootPhase.getState().setPhase("activating");
    const waiting = awaitBootReady(100);
    queueMicrotask(() => useBootPhase.getState().setPhase("ready"));
    await expect(waiting).resolves.toEqual({ phase: "ready" });
  });

  it("fails after a bounded time when no ready event arrives", async () => {
    useBootPhase.getState().setPhase("restoring");
    await expect(awaitBootReady(5)).rejects.toThrow("boot ready");
  });
});
