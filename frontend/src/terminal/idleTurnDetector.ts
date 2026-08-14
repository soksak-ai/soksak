// Output-idle heuristic turn.ended provider (core, OFF by default). Subscribes to the PTY output of a
// pane running a command and, after an output burst, treats N ms with no output as "turn ended" (an
// interactive agent waits for input after output). Not polling (debounce on output events). False
// positives are possible (slow streamers, TUI redraw) → opt-in (turned on by the turn.idleDetection
// command). The idle source of mailbox self-subscribe turns this on (the core has no mailbox reference —
// coupling 0, through the command).

import { moduleState } from "../lib/moduleState";
import {
  subscribeAnyCommandStarted,
  subscribeAnyCommandFinished,
  subscribeOutput,
} from "./ptyBridge";

export interface IdleTurnPayload {
  projectId: string | null;
  root: string | null;
  paneId: string | null;
  source: "idle";
}

// Distinct things stand apart — put them in one bag and it is a bag, not state.
/** Injected wiring — the emit and lookup sites (avoids a circular import). Distinct from tuning and lifetime. */
const wiring = moduleState("terminal/idleTurnDetector#wiring", () => ({
  emitFn: null as ((p: IdleTurnPayload) => void) | null,
  projectInfoOf: (() => null) as (
    paneId: string,
  ) => { id: string; root: string | null } | null,
}));

/** Detection threshold — set by a person. */
const tuning = moduleState("terminal/idleTurnDetector#tuning", () => ({
  idleMs: 2000,
}));

/** The running detector — dispose handle. */
const running = moduleState("terminal/idleTurnDetector#running", () => ({
  active: null as { dispose: () => void } | null,
}));

// One-time wiring (startPluginHooks) — injects emit/projectInfo (avoids a circular import). No effect before start.
export function configureIdleTurnDetector(deps: {
  emit: (p: IdleTurnPayload) => void;
  projectInfoOf: (paneId: string) => { id: string; root: string | null } | null;
}): void {
  wiring.emitFn = deps.emit;
  wiring.projectInfoOf = deps.projectInfoOf;
}

export function isIdleTurnDetectionOn(): boolean {
  return running.active !== null;
}

export function idleTurnMs(): number {
  return tuning.idleMs;
}

// Toggle — enabled=true starts detection (already on: updates ms only), false stops and cleans up. Idempotent.
export function setIdleTurnDetection(enabled: boolean, ms?: number): void {
  if (typeof ms === "number" && ms > 0) tuning.idleMs = Math.max(250, ms);
  if (enabled) {
    if (!running.active) running.active = startDetector();
  } else if (running.active) {
    running.active.dispose();
    running.active = null;
  }
}

function startDetector(): { dispose: () => void } {
  // Per-pane output subscription + debounce timer. Attached on command start, detached on finish.
  const perTab = new Map<
    string,
    { unOut: () => void; timer: ReturnType<typeof setTimeout> | null }
  >();

  const arm = (paneId: string) => {
    const e = perTab.get(paneId);
    if (!e) return;
    if (e.timer) clearTimeout(e.timer);
    e.timer = setTimeout(() => {
      const info = wiring.projectInfoOf(paneId);
      wiring.emitFn?.({
        projectId: info?.id ?? null,
        root: info?.root ?? null,
        paneId,
        source: "idle",
      });
    }, tuning.idleMs);
  };

  const detach = (paneId: string) => {
    const e = perTab.get(paneId);
    if (!e) return;
    e.unOut();
    if (e.timer) clearTimeout(e.timer);
    perTab.delete(paneId);
  };

  // Command start → start the output monitor for that pane (timer only after the first output — prevents an immediate false positive with no output).
  const unStart = subscribeAnyCommandStarted((paneId) => {
    if (perTab.has(paneId)) return;
    const unOut = subscribeOutput(paneId, () => arm(paneId));
    perTab.set(paneId, { unOut, timer: null });
  });
  // Command finish → detach the monitor (program exit, not per turn — command.finished is emitted separately from the shell source).
  const unFinish = subscribeAnyCommandFinished((paneId) => detach(paneId));

  return {
    dispose: () => {
      unStart();
      unFinish();
      for (const paneId of [...perTab.keys()]) detach(paneId);
    },
  };
}

// Test only — clears everything.
export function resetIdleTurnDetectorForTest(): void {
  if (running.active) {
    running.active.dispose();
    running.active = null;
  }
  wiring.emitFn = null;
  wiring.projectInfoOf = () => null;
  tuning.idleMs = 2000;
}
