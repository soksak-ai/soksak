// PTY observation store — collects cwd, command start/finish, and output observations under a
// paneId (string) key.
//
// [Principle] Observation is at the terminal-protocol level = filled by the generic substrate
// (whoever drives app.pty). The cwd/command/output subscriptions the core terminal view's ptyBridge
// held privately moved here, so app.terminal.* + command.*/turn.ended + idle/status keep working
// even when the core view is gone (only plugin terminals left). The key is the same paneId (string)
// that app.terminal.*, the file tree, and the sok CLI use.
//
// [Single-producer invariant — no double emission] Exactly one PTY producer fills a given paneId:
//   - Core terminal view: ptyBridge.getHost sends that pane's PTY output to feedPtyOutput.
//   - Plugin terminal: app.pty.spawn sends that pane's PTY output to feedPtyOutput.
// Two producers never write the same paneId at once, so OSC is parsed once (zero duplicate emits).

import { moduleState } from "../lib/moduleState";
import {
  createPtyObservationParser,
  type PtyObservationParser,
} from "./ptyObservation";

// IO handler a PTY driver registers (GAP2) — screen buffer read + PTY input write. Core host and
// plugin terminal register under the same paneId key. app.terminal.readBuffer/sendText prefer this
// path (no dependency on the core ptyBridge host div — it still covers plugin terminals after the
// core terminal view is removed).
export interface PtyIo {
  readBuffer: (lines?: number) => string;
  sendInput: (data: string) => void;
}

interface TabObservation {
  parser: PtyObservationParser;
  cwd: string | undefined;
  running: { commandLine: string; cwd: string | null } | null;
  cwdSubs: Set<(cwd: string) => void>;
  cmdFinishedSubs: Set<() => void>;
  outputSubs: Set<() => void>;
  // IO handler of the PTY driver running this pane, once registered. undefined when absent.
  io?: PtyIo;
}

const observations = moduleState(
  "terminal/ptyObservationStore#observations",
  () => new Map<string, TabObservation>(),
);

// Global (any pane) command start/finish subscribers — relay for plugin events
// (command.started/finished, turn.ended). The finished command line and cwd travel with it
// (enriches the turn.ended body).
// Outside the hot-swap boundary — when this table is replaced, the filling side treats it as
// already filled and does not fill again.
const anyCmdStartSubs = moduleState("terminal/ptyObservationStore#anyCmdStartSubs", () => new Set<
  (paneId: string, commandLine: string, cwd: string | null) => void
>());
// Outside the hot-swap boundary — a replaced map would stay empty: the filling side has already
// recorded the fill and does not fill again.
const anyCmdFinishedSubs = moduleState("terminal/ptyObservationStore#anyCmdFinishedSubs", () => new Set<
  (paneId: string, commandLine?: string | null, cwd?: string | null, exitCode?: number) => void
>());
/**
 * Starts observation for paneId (once at PTY spawn). Idempotent — an existing entry is kept.
 * After that, feeding output through feedPtyOutput(paneId, …) parses OSC and pushes to subscribers.
 */
export function registerPtyObservation(paneId: string): void {
  if (observations.has(paneId)) return;
  const obs: TabObservation = {
    parser: undefined as unknown as PtyObservationParser,
    cwd: undefined,
    running: null,
    cwdSubs: new Set(),
    cmdFinishedSubs: new Set(),
    outputSubs: new Set(),
  };
  obs.parser = createPtyObservationParser({
    onCwd: (c) => {
      obs.cwd = c;
      for (const cb of [...obs.cwdSubs]) cb(c);
    },
    onCommandStart: (commandLine) => {
      obs.running = { commandLine, cwd: obs.cwd ?? null };
      for (const cb of [...anyCmdStartSubs])
        cb(paneId, commandLine, obs.cwd ?? null);
    },
    onCommandFinished: (exitCode) => {
      // Capture the finished command just before clearing → the turn.ended body holds "which
      // command finished + exit code (R2)". The emitter (shell-integration.zsh) emits D (finish
      // mark) only when paired with C (execute) — the parser trusts the wire (§5 is inscribed in
      // the emitter: a finish without a start is never emitted).
      const fin = obs.running;
      obs.running = null;
      for (const cb of [...obs.cmdFinishedSubs]) cb();
      for (const cb of [...anyCmdFinishedSubs])
        cb(paneId, fin?.commandLine ?? null, fin?.cwd ?? null, exitCode);
    },
  });
  observations.set(paneId, obs);
}

// All-pane output activity sink (B3) — hooks injects it and records lastActivity (the injector owns
// the throttle). Unlike the per-pane subscription (subscribeObservedOutput), it sees all output in
// one place without enumerating panes.
// Outside the hot-swap boundary — when these values are replaced, the "already done" record and
// the lazy-init and unsubscribe slots go with them, and the filling side does not fill again.
const ms = moduleState("terminal/ptyObservationStore#state", () => ({
  anyOutputSink: null as ((paneId: string) => void) | null,
}));
export function setAnyOutputSink(cb: ((paneId: string) => void) | null): void {
  ms.anyOutputSink = cb;
}

/** Feeds a PTY output chunk to that paneId's observation parser and notifies output subscribers.
 *  No-op when unregistered. */
export function feedPtyOutput(paneId: string, chunk: string | Uint8Array): void {
  const obs = observations.get(paneId);
  if (!obs) return;
  obs.parser.write(chunk);
  if (obs.outputSubs.size) for (const cb of [...obs.outputSubs]) cb();
  ms.anyOutputSink?.(paneId);
}

// ── Push of already-parsed observations (core terminal view producer path) ──────
// The core terminal view already parses OSC through xterm shellIntegration → that result is pushed
// straight into the store without re-parsing raw bytes. Only one producer fills a given paneId
// (single-producer invariant), so this never overlaps the plugin path's feedPtyOutput — zero double
// emission.

/** Core producer: cwd change push (notifies only on an actual change). */
export function pushObservedCwd(paneId: string, cwd: string): void {
  const obs = observations.get(paneId);
  if (!obs || !cwd || cwd === obs.cwd) return;
  obs.cwd = cwd;
  for (const cb of [...obs.cwdSubs]) cb(cwd);
}

/** Core producer: command start push (holds the command line — notifies global subscribers and
 *  updates running). */
export function pushObservedCommandStart(paneId: string, commandLine: string): void {
  const obs = observations.get(paneId);
  if (!obs) return;
  obs.running = { commandLine, cwd: obs.cwd ?? null };
  for (const cb of [...anyCmdStartSubs]) cb(paneId, commandLine, obs.cwd ?? null);
}

/** Core producer: command finish push (pane + global subscribers, holds the finished command
 *  line, cwd, and exitCode (R2), clears running). */
export function pushObservedCommandFinished(paneId: string, exitCode?: number): void {
  const obs = observations.get(paneId);
  if (!obs) return;
  const fin = obs.running;
  obs.running = null;
  for (const cb of [...obs.cmdFinishedSubs]) cb();
  for (const cb of [...anyCmdFinishedSubs])
    cb(paneId, fin?.commandLine ?? null, fin?.cwd ?? null, exitCode);
}

/** Core producer: output change push (screen update notification — for live streams and input
 *  verification). */
export function pushObservedOutput(paneId: string): void {
  const obs = observations.get(paneId);
  if (!obs || !obs.outputSubs.size) return;
  for (const cb of [...obs.outputSubs]) cb();
}

/** Ends observation for a pane (PTY close / permanent pane close). Drops the cwd snapshot and all
 *  subscriptions. */
export function disposePtyObservation(paneId: string): void {
  const obs = observations.get(paneId);
  if (!obs) return;
  obs.cwdSubs.clear();
  obs.cmdFinishedSubs.clear();
  obs.outputSubs.clear();
  observations.delete(paneId);
}

/** Current cwd snapshot for a pane (undefined before shell integration). */
export function getObservedCwd(paneId: string): string | undefined {
  return observations.get(paneId)?.cwd;
}

/** Whether this id drives a PTY substrate (a generic terminal signal — independent of pluginId).
 *  true when an observation is registered. The file tree's cwdTabOf uses it to follow core and
 *  plugin terminals without distinguishing them. */
export function hasPtyObservation(paneId: string): boolean {
  return observations.has(paneId);
}

/** A PTY driver (core host / plugin terminal) registers the IO handler for this paneId (GAP2).
 *  Pre-registers the observation too when absent (idempotent). Returns the unregister function.
 *  Preferred path for app.terminal.readBuffer/sendText. */
export function registerPtyIo(paneId: string, io: PtyIo): () => void {
  registerPtyObservation(paneId); // pre-register the observation (safe when IO or a subscription arrives before spawn)
  const obs = observations.get(paneId)!;
  obs.io = io;
  return () => {
    const cur = observations.get(paneId);
    if (cur && cur.io === io) cur.io = undefined;
  };
}

/** Registered IO handler for this paneId (undefined when absent). Queried by
 *  app.terminal.readBuffer/sendText. */
export function getPtyIo(paneId: string): PtyIo | undefined {
  return observations.get(paneId)?.io;
}

/** Snapshot of every currently running command (at most 1 per pane). */
export function observedRunningCommands(): {
  paneId: string;
  commandLine: string;
  cwd: string | null;
}[] {
  const out: { paneId: string; commandLine: string; cwd: string | null }[] = [];
  for (const [paneId, obs] of observations) {
    if (obs.running)
      out.push({ paneId, commandLine: obs.running.commandLine, cwd: obs.running.cwd });
  }
  return out;
}

/** Subscribe to pane cwd changes (no polling). Fires once at registration when a value exists.
 *  Returns the unsubscribe function. */
export function subscribeObservedCwd(
  paneId: string,
  cb: (cwd: string) => void,
): () => void {
  registerPtyObservation(paneId); // safe when the subscription arrives before spawn (empty observation pre-registered)
  const obs = observations.get(paneId)!;
  obs.cwdSubs.add(cb);
  if (obs.cwd) cb(obs.cwd);
  return () => {
    obs.cwdSubs.delete(cb);
  };
}

/** Subscribe to pane command finish (OSC 133/633 D) (no polling). Returns the unsubscribe function. */
export function subscribeObservedCommandFinished(
  paneId: string,
  cb: () => void,
): () => void {
  registerPtyObservation(paneId);
  const obs = observations.get(paneId)!;
  obs.cmdFinishedSubs.add(cb);
  return () => {
    obs.cmdFinishedSubs.delete(cb);
  };
}

/** Subscribe to pane output changes (screen update) (no polling). Returns the unsubscribe function.
 *  For live streams and input-landed verification. */
export function subscribeObservedOutput(
  paneId: string,
  cb: () => void,
): () => void {
  registerPtyObservation(paneId);
  const obs = observations.get(paneId)!;
  obs.outputSubs.add(cb);
  return () => {
    obs.outputSubs.delete(cb);
  };
}

/** Subscribe to command starts on every pane (relay for the plugin command.started event).
 *  Returns the unsubscribe function. */
export function subscribeAnyCommandStarted(
  cb: (paneId: string, commandLine: string, cwd: string | null) => void,
): () => void {
  anyCmdStartSubs.add(cb);
  return () => {
    anyCmdStartSubs.delete(cb);
  };
}

/** Subscribe to command finishes on every pane (relay for command.finished/turn.ended). Carries the
 *  finished command line and cwd. Returns the unsubscribe function. */
export function subscribeAnyCommandFinished(
  cb: (paneId: string, commandLine?: string | null, cwd?: string | null, exitCode?: number) => void,
): () => void {
  anyCmdFinishedSubs.add(cb);
  return () => {
    anyCmdFinishedSubs.delete(cb);
  };
}

// Test only — clears everything.
export function resetPtyObservationStoreForTest(): void {
  observations.clear();
  anyCmdStartSubs.clear();
  anyCmdFinishedSubs.clear();
}
