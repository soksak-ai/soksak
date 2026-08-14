import { describe, expect, it, vi } from "vitest";
import { completeCommandReply } from "./commandReplyTransaction";

describe("command reply transaction", () => {
  it("runs the follow-up transaction only after the reply is delivered", async () => {
    let release!: () => void;
    const reply = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const afterReply = vi.fn();

    const transaction = completeCommandReply(reply, [afterReply], vi.fn());
    await Promise.resolve();
    expect(afterReply).not.toHaveBeenCalled();

    release();
    await expect(transaction).resolves.toBe(true);
    expect(afterReply).toHaveBeenCalledTimes(1);
  });

  it("skips the follow-up transaction when the reply fails, so the retry survives", async () => {
    const failure = new Error("transport closed");
    const afterReply = vi.fn();
    const onReplyFailure = vi.fn();

    await expect(completeCommandReply(
      () => Promise.reject(failure),
      [afterReply],
      onReplyFailure,
    )).resolves.toBe(false);
    expect(onReplyFailure).toHaveBeenCalledWith(failure);
    expect(afterReply).not.toHaveBeenCalled();
  });
});
