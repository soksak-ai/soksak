import { describe, expect, it, vi } from "vitest";
import { createSettingsEventHandler } from "./settingsEvents";

describe("settings change events", () => {
  it("coalesces changes during reload and applies the latest revision", async () => {
    let releaseFirst: (() => void) | undefined;
    const reload = vi.fn().mockImplementationOnce(() => new Promise<void>((resolve) => { releaseFirst = resolve; })).mockResolvedValue(undefined);
    const handler = createSettingsEventHandler(reload, 3);
    const first = handler({ previousRevision: 3, revision: 4 });
    void handler({ previousRevision: 4, revision: 5 });
    void handler({ previousRevision: 5, revision: 6 });
    expect(reload).toHaveBeenCalledTimes(1);
    releaseFirst?.(); await first;
    expect(reload).toHaveBeenCalledTimes(2);
    expect(handler.revision()).toBe(6);
  });
  it("ignores duplicate and older revisions", async () => {
    const reload = vi.fn(async () => {}); const handler = createSettingsEventHandler(reload, 7);
    await handler({ previousRevision: 6, revision: 7 }); await handler({ previousRevision: 4, revision: 5 });
    expect(reload).not.toHaveBeenCalled();
  });
});
