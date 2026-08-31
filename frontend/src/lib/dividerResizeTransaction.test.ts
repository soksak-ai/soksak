import { describe, expect, it, vi } from "vitest";
import { createDividerResizeTransaction } from "./dividerResizeTransaction";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};

describe("divider resize transaction", () => {
  it("applies a layout only after its native geometry succeeds", async () => {
    const ready = deferred();
    const apply = vi.fn();
    const transaction = createDividerResizeTransaction<number>({
      stage: () => ready.promise,
      apply,
    });
    transaction.submit(1);
    expect(apply).not.toHaveBeenCalled();
    ready.resolve();
    await transaction.drain();
    expect(apply).toHaveBeenCalledWith(1);
  });

  it("retains the latest pointer value while a native application is running", async () => {
    const first = deferred();
    const staged: number[] = [];
    const applied: number[] = [];
    const transaction = createDividerResizeTransaction<number>({
      stage: async (value) => {
        staged.push(value);
        if (value === 1) await first.promise;
      },
      apply: (value) => applied.push(value),
    });
    transaction.submit(1);
    transaction.submit(2);
    transaction.submit(3);
    first.resolve();
    await transaction.drain();
    expect(staged).toEqual([1, 3]);
    expect(applied).toEqual([1, 3]);
  });

  it("waits for the post-paint signal before staging a target", async () => {
    const painted = deferred();
    const staged: number[] = [];
    const transaction = createDividerResizeTransaction<number>({
      beforeStage: () => painted.promise,
      stage: async (value) => { staged.push(value); },
      apply: () => undefined,
    });
    transaction.submit(1);
    await Promise.resolve();
    expect(staged).toEqual([]);
    painted.resolve();
    await transaction.drain();
    expect(staged).toEqual([1]);
  });
});
