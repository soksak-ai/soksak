// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { setRegistryRuntimeDeps, useRegistry, OFFICIAL_REGISTRY_DESCRIPTOR } from "./registry";

// A refresh already running is awaited, not skipped.
//
// A second caller arriving during a fetch was answered `{status: "fetching", skipped: true}` at
// once, and `plugin.catalog` turned that into a catalogue of nothing with no error in it. Measured
// on the running build 2026-08-16: the gate read `official -> fetching (), 0 units` and there was no
// way, from the answer, to tell a busy registry from an empty one.
//
// One fetch per registry stays the rule. What changes is who waits: everyone waits for the same one.
describe("a refresh that is already running", () => {
  const restores: (() => void)[] = [];

  afterEach(() => {
    for (const undo of restores.splice(0)) undo();
    vi.useRealTimers();
  });

  it("answers the second caller with the first fetch's result, not with 'fetching'", async () => {
    let release: () => void = () => {};
    const started: number[] = [];
    restores.push(
      setRegistryRuntimeDeps({
        load: async () => {
          started.push(1);
          await new Promise<void>((r) => {
            release = r;
          });
          throw new Error("load refused");
        },
      }),
    );
    useRegistry.setState({
      descriptors: [OFFICIAL_REGISTRY_DESCRIPTOR],
      registries: {
        [OFFICIAL_REGISTRY_DESCRIPTOR.id]: {
          descriptor: OFFICIAL_REGISTRY_DESCRIPTOR,
          status: "idle",
          fetchedOnce: false,
          entries: [],
        },
      },
    });

    const first = useRegistry.getState().refresh(true);
    await Promise.resolve();
    const second = useRegistry.getState().refresh(true);

    release();
    const [a, b] = await Promise.all([first, second]);

    // One fetch, and both callers hold its outcome — a terminal status, never "fetching".
    expect(started).toHaveLength(1);
    expect(a[0]?.status).not.toBe("fetching");
    expect(b[0]?.status).not.toBe("fetching");
    expect(b[0]?.status).toBe(a[0]?.status);
  });
});
