import { beforeEach, describe, expect, it, vi } from "vitest";

describe("presentation display frame ledger", () => {
  beforeEach(() => vi.resetModules());

  it("publishes exact trace-owned frames and keeps a bounded public ledger", async () => {
    const frames = await import("./presentationDisplayFrames");
    const seen: unknown[] = [];
    const off = frames.onPresentationDisplayFrame((frame) => seen.push(frame));
    frames.publishPresentationDisplayFrame({
      traceId: "flow/01-left",
      producer: "native-display-link",
      clock: "mach-continuous-unix-anchored",
      sourceGeneration: 7,
      frameSequence: 11,
      presentationRevision: 12,
      presentedAtUnixMs: 1234.5,
    });
    off();
    expect(seen).toEqual([expect.objectContaining({
      traceId: "flow/01-left",
      sourceGeneration: 7,
      frameSequence: 11,
      presentedAtUnixMs: 1234.5,
    })]);
    expect(frames.presentationDisplayFrameFacts("flow/01-left")).toEqual(seen);
  });
});
