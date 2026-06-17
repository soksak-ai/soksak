// turn.ended 오픈 계약 — acp provider(bus)→hooks 채널 미러(메일함은 한 곳만 구독).
import { describe, expect, it } from "vitest";
import { onPluginEvent, startPluginHooks } from "./hooks";
import { busEmit } from "./bus";

describe("turn.ended 오픈 계약", () => {
  it("bus 의 turn.ended 가 hooks 채널로 미러된다(acp provider)", () => {
    startPluginHooks(); // bus→hooks 미러 배선(모듈 수명당 1회 가드)
    const got: unknown[] = [];
    const sub = onPluginEvent("turn.ended", (p) => got.push(p));
    busEmit("turn.ended", { projectId: "p1", root: "/r", paneId: null, source: "acp" });
    expect(got).toEqual([{ projectId: "p1", root: "/r", paneId: null, source: "acp" }]);
    sub.dispose();
  });

  it("turn.ended 는 알려진 이벤트(미지 이벤트 throw 아님)", () => {
    expect(() => onPluginEvent("turn.ended", () => {}).dispose()).not.toThrow();
  });
});
