// turn.ended open contract — acp provider (bus) mirrored to the hooks channel (the mailbox is subscribed in one place only).
import { describe, expect, it } from "vitest";
import { onPluginEvent, startPluginHooks } from "./hooks";
import { busEmit } from "./bus";

describe("turn.ended open contract", () => {
  it("turn.ended on the bus is mirrored to the hooks channel (acp provider)", () => {
    startPluginHooks(); // bus→hooks mirror wiring (guarded to run once per module lifetime)
    const got: unknown[] = [];
    const sub = onPluginEvent("turn.ended", (p) => got.push(p));
    busEmit("turn.ended", { projectId: "wsp-aaaaaa", root: "/r", paneId: null, source: "acp" });
    expect(got).toEqual([{ projectId: "wsp-aaaaaa", root: "/r", paneId: null, source: "acp" }]);
    sub.dispose();
  });

  it("turn.ended is a known event, not an unknown-event throw", () => {
    expect(() => onPluginEvent("turn.ended", () => {}).dispose()).not.toThrow();
  });
});
