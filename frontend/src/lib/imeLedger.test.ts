// IME decision ledger — publishes transitions only, and records which signal produced the decision.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn(async () => ({}));
vi.mock("../framework", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../framework")>()),
  framework: { name: "tauri", invoke: (...a: unknown[]) => invoke(...(a as [])) },
}));

import { __resetImeLedgerForTest, noteImeDecision } from "./imeLedger";
import { isComposingEnter } from "./imeKeys";

beforeEach(() => {
  invoke.mockClear();
  __resetImeLedgerForTest();
});
afterEach(() => vi.restoreAllMocks());

/** Published ime.decision payloads. */
function published(): Record<string, unknown>[] {
  return invoke.mock.calls
    .filter((c) => (c as unknown[])[0] === "activity_publish")
    .map((c) => ((c as unknown[])[1] as { payload: Record<string, unknown> }).payload);
}

describe("IME verdict ledger", () => {
  it("records which signal the verdict came from — a missing isComposing is itself the diagnosis", () => {
    noteImeDecision({ isComposing: true, legacy: false, composing: true });
    expect(published()[0]).toMatchObject({ signal: "isComposing", composing: true });

    noteImeDecision({ isComposing: false, legacy: true, composing: true });
    // Engine omits isComposing and only the legacy path matches = the first signal visible after a framework swap.
    expect(published()[1]).toMatchObject({ signal: "legacy-229", composing: true });
  });

  it("publishes only on a change, not on every repeat of the same verdict", () => {
    for (let i = 0; i < 5; i++) {
      noteImeDecision({ isComposing: true, legacy: false, composing: true });
    }
    expect(published()).toHaveLength(1);

    noteImeDecision({ isComposing: false, legacy: false, composing: false });
    const all = published();
    expect(all).toHaveLength(2);
    // The transition is the signal — include the previous state's repeat count so "it vanished suddenly" is readable.
    expect(all[1]).toMatchObject({ signal: "none", previousRepeats: 5 });
  });

  it("includes the active framework name — which framework the event came from", () => {
    noteImeDecision({ isComposing: true, legacy: false, composing: true });
    expect(published()[0]).toMatchObject({ framework: "tauri" });
  });

  it("makes no verdict and publishes nothing when the key is not Enter", () => {
    const e = { key: "a", nativeEvent: { isComposing: true }, keyCode: 65 } as never;
    expect(isComposingEnter(e)).toBe(false);
    expect(published()).toHaveLength(0);
  });

  it("a composition-commit Enter is not a commit — the verdict and the ledger entry go together", () => {
    const e = { key: "Enter", nativeEvent: { isComposing: true }, keyCode: 13 } as never;
    expect(isComposingEnter(e)).toBe(true);
    expect(published()[0]).toMatchObject({ composing: true, signal: "isComposing" });
  });

  it("blocks the commit on an engine that reports only the legacy 229", () => {
    const e = { key: "Enter", nativeEvent: { isComposing: false }, keyCode: 229 } as never;
    expect(isComposingEnter(e)).toBe(true);
    expect(published()[0]).toMatchObject({ signal: "legacy-229" });
  });
});
