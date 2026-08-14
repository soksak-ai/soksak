// PTY substrate observation bridge — the core terminal view (host-div) is removed (the terminal is a
// plugin view too), and what remains here is a thin delegation layer that exposes the cwd, command,
// and output subscriptions of ptyObservationStore (the generic PTY substrate) under names. The
// plugin terminal (app.pty.spawn → registerPtyIo/feedPtyOutput) is the store's producer, and the
// app.terminal.*, command.*, idle, and status consumers read that store through these functions.
//
// [history] ptyBridge used to hold the core terminal view's host-div and xterm instances in a
// private map and drive them directly. When that view moved to a plugin, the host-div machinery was
// removed entirely.

import {
  observedRunningCommands,
  getObservedCwd as storeGetCwd,
  subscribeObservedCwd,
  subscribeObservedCommandFinished,
  subscribeObservedOutput,
  subscribeAnyCommandStarted as storeSubAnyStart,
  subscribeAnyCommandFinished as storeSubAnyFinish,
} from "./ptyObservationStore";

/** Subscribes to command completion on every pane (enriches the turn.ended body — finished command
 *  line and cwd included). Returns the unsubscribe function.
 *  [delegation] Forwards to the same-named subscription on the substrate store (plugin terminal
 *  producer). */
export function subscribeAnyCommandFinished(
  cb: (paneId: string, commandLine?: string | null, cwd?: string | null, exitCode?: number) => void,
): () => void {
  return storeSubAnyFinish(cb);
}

/** Subscribes to command start on every pane (relays command.started). Returns the unsubscribe
 *  function. [delegation] substrate store. */
export function subscribeAnyCommandStarted(
  cb: (paneId: string, commandLine: string, cwd: string | null) => void,
): () => void {
  return storeSubAnyStart(cb);
}

/** Snapshot of every command currently running. [delegation] substrate store. */
export function runningCommands(): {
  paneId: string;
  commandLine: string;
  cwd: string | null;
}[] {
  return observedRunningCommands();
}

/** Current working directory of the pane terminal (shell integration OSC 7/633;P). undefined when
 *  unconfirmed. [delegation] substrate store (plugin terminal cwd resolution). */
export function getCwdOfHost(paneId: string): string | undefined {
  return storeGetCwd(paneId);
}

/** Subscribes to cwd changes on a pane (no polling). Fires once at registration when a current value
 *  exists. Returns the unsubscribe function.
 *  [delegation] substrate store — safe to subscribe before the handle is ready (pre-registered empty
 *  observation). */
export function subscribeCwd(
  paneId: string,
  cb: (cwd: string) => void,
): () => void {
  return subscribeObservedCwd(paneId, cb);
}

/** Subscribes to command completion (OSC 133/633 D) on a pane (no polling). Returns the unsubscribe
 *  function. [delegation] substrate store. */
export function subscribeCommandFinished(
  paneId: string,
  cb: () => void,
): () => void {
  return subscribeObservedCommandFinished(paneId, cb);
}

/** Subscribes to output changes (screen updates) on a pane terminal (no polling). Returns the
 *  unsubscribe function. [delegation] substrate store.
 *  Generic signal a plugin uses for live stream display and input-landed verification (buffer
 *  re-read trigger). */
export function subscribeOutput(paneId: string, cb: () => void): () => void {
  return subscribeObservedOutput(paneId, cb);
}
