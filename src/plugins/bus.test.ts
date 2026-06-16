import { describe, it, expect, beforeEach } from "vitest";
import { busEmit, busOn, busResetForTest } from "./bus";

describe("plugin bus — 플러그인 간 커스텀 토픽 pub/sub", () => {
  beforeEach(() => busResetForTest());

  it("emit → 구독자에게 payload 전달", () => {
    const got: unknown[] = [];
    busOn("acp.update.1", (p) => got.push(p));
    busEmit("acp.update.1", { sessionUpdate: "agent_message_chunk" });
    expect(got).toEqual([{ sessionUpdate: "agent_message_chunk" }]);
  });

  it("토픽 격리 — 다른 토픽은 미수신", () => {
    const got: unknown[] = [];
    busOn("a", (p) => got.push(p));
    busEmit("b", 1);
    expect(got).toEqual([]);
  });

  it("해지(unsubscribe) 후 미수신", () => {
    const got: unknown[] = [];
    const off = busOn("t", (p) => got.push(p));
    off();
    busEmit("t", 1);
    expect(got).toEqual([]);
  });

  it("다중 구독자 모두 수신 + 한 리스너 오류가 다른 리스너를 막지 않음(격리)", () => {
    const got: number[] = [];
    busOn("t", () => {
      throw new Error("boom");
    });
    busOn("t", () => got.push(2));
    busEmit("t", 0);
    expect(got).toEqual([2]);
  });
});
