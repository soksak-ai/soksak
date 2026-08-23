import { describe, expect, it, vi } from "vitest";
import { createEnvironmentEventHandler, reconcileEnvironmentRevision, setEnvironmentEventHandler } from "./environmentEvents";

describe("settings change events", () => {
  it("coalesces changes during reload and applies the latest revision", async () => {
    let releaseFirst: (() => void) | undefined;
    const reload = vi.fn().mockImplementationOnce(() => new Promise<void>((resolve) => { releaseFirst = resolve; })).mockResolvedValue(undefined);
    const handler = createEnvironmentEventHandler(reload, 3);
    const first = handler({ previousRevision: 3, revision: 4 });
    void handler({ previousRevision: 4, revision: 5 });
    void handler({ previousRevision: 5, revision: 6 });
    expect(reload).toHaveBeenCalledTimes(1);
    releaseFirst?.(); await first;
    expect(reload).toHaveBeenCalledTimes(2);
    expect(handler.revision()).toBe(6);
  });
  it("ignores duplicate and older revisions", async () => {
    const reload = vi.fn(async () => {}); const handler = createEnvironmentEventHandler(reload, 7);
    await handler({ previousRevision: 6, revision: 7 }); await handler({ previousRevision: 4, revision: 5 });
    expect(reload).not.toHaveBeenCalled();
  });
  it("shares one revision coordinator between install and environment events", async () => {
    let release!: () => void;
    const reload = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const handler = createEnvironmentEventHandler(reload, 3);
    const restore = setEnvironmentEventHandler(handler);
    const event = handler({ previousRevision: 3, revision: 4 });
    const install = reconcileEnvironmentRevision(4);
    expect(reload).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([event, install]);
    expect(handler.revision()).toBe(4);
    restore();
  });
});
