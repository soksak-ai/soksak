// IME decision ledger — records what a composition-commit Enter was decided on.
//
// Why it is needed: IME composition signals differ per webview engine. Some engines omit
// `isComposing`; some give no legacy `keyCode 229` on a commit Enter. Swapping the framework
// breaks this first, and **the break is silent** — uncommitted text just commits, no error.
// The user hits it as "the name is saved wrong", and the cause has to be narrowed by reading source.
//
// So each decision is recorded as an event. Observation must be mechanical, and a decision that
// exists only while a human types a command is not observation.
//
// Flood guard: repeated identical decision combinations are only counted; publish only when the
// combination **changes**. An IME defect shows up as "which signal disappeared", so the transition
// is the signal.

import { moduleState } from "../lib/moduleState";
import { framework } from "../framework";

export interface ImeDecision {
  /** Composition state on the event (false when the engine omits it). */
  isComposing: boolean;
  /** Whether the legacy keyCode 229 fallback applied. */
  legacy: boolean;
  /** Final decision — is this a composition-commit Enter. */
  composing: boolean;
}

// Distinct things stand apart — put them in one bag and it is a bag, not state.
/** Previous key and repeat count — one unit (whether the same key repeats). */
const lastKey = moduleState("lib/imeLedger#lastKey", () => ({
  lastKey: "",
  repeats: 0,
}));
function publish(kind: string, payload: Record<string, unknown>): void {
  // Ledger publish is diagnostic — a failure must not block input handling.
  void framework
    .invoke("activity_publish", { kind, source: "core", payload })
    .catch(() => {});
}

export function noteImeDecision(d: ImeDecision): void {
  const key = `${d.isComposing}|${d.legacy}|${d.composing}`;
  if (key === lastKey.lastKey) {
    lastKey.repeats += 1;
    return;
  }
  const previous = lastKey.lastKey;
  const previousRepeats = lastKey.repeats;
  lastKey.lastKey = key;
  lastKey.repeats = 1;
  publish("ime.decision", {
    ...d,
    framework: framework.name,
    // Engine omits the composition signal and only legacy catches it — that alone is the diagnosis.
    signal: d.isComposing ? "isComposing" : d.legacy ? "legacy-229" : "none",
    previous: previous || null,
    previousRepeats: previous ? previousRepeats : 0,
  });
}

/** Test only — clears the transition state. */
export function __resetImeLedgerForTest(): void {
  lastKey.lastKey = "";
  lastKey.repeats = 0;
}
