import { describe, it, expect, beforeEach, vi } from "vitest";
import { busEmit, busOn, busResetForTest } from "./bus";

describe("plugin bus — custom topic pub/sub between plugins", () => {
  beforeEach(() => busResetForTest());

  it("emit delivers the payload to the subscriber", () => {
    const got: unknown[] = [];
    busOn("acp.update.1", (p) => got.push(p));
    busEmit("acp.update.1", { sessionUpdate: "agent_message_chunk" });
    expect(got).toEqual([{ sessionUpdate: "agent_message_chunk" }]);
  });

  it("topic isolation — another topic receives nothing", () => {
    const got: unknown[] = [];
    busOn("a", (p) => got.push(p));
    busEmit("b", 1);
    expect(got).toEqual([]);
  });

  it("nothing is received after unsubscribe", () => {
    const got: unknown[] = [];
    const off = busOn("t", (p) => got.push(p));
    off();
    busEmit("t", 1);
    expect(got).toEqual([]);
  });

  it("every subscriber receives, and one listener throwing does not stop the others (isolation)", () => {
    const reported = vi.spyOn(console, "error").mockImplementation(() => {});
    const got: number[] = [];
    busOn("t", () => {
      throw new Error("boom");
    });
    busOn("t", () => got.push(2));
    busEmit("t", 0);
    expect(got).toEqual([2]);
    expect(reported).toHaveBeenCalledWith("[bus] t listener error:", expect.objectContaining({ message: "boom" }));
    reported.mockRestore();
  });
});
