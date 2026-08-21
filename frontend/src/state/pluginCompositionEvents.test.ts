import { describe, expect, it, vi } from "vitest";

import { createPluginCompositionEventHandler } from "./pluginCompositionEvents";

describe("plugin composition change events", () => {
  it("coalesces changes that arrive during reload and applies the latest generation", async () => {
    let releaseFirst: (() => void) | undefined;
    const reload = vi.fn()
      .mockImplementationOnce(() => new Promise<void>((resolve) => { releaseFirst = resolve; }))
      .mockResolvedValue(undefined);
    const handler = createPluginCompositionEventHandler(reload, 3);

    const first = handler({ previousGeneration: 3, generation: 4 });
    void handler({ previousGeneration: 4, generation: 5 });
    void handler({ previousGeneration: 5, generation: 6 });
    expect(reload).toHaveBeenCalledTimes(1);
    releaseFirst?.();
    await first;

    expect(reload).toHaveBeenCalledTimes(2);
    expect(handler.generation()).toBe(6);
  });

  it("ignores duplicate and older generations", async () => {
    const reload = vi.fn(async () => {});
    const handler = createPluginCompositionEventHandler(reload, 7);
    await handler({ previousGeneration: 6, generation: 7 });
    await handler({ previousGeneration: 4, generation: 5 });
    expect(reload).not.toHaveBeenCalled();
  });
});
