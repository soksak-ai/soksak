// Single target resolution path for term.* — everything resolves through the PTY substrate
// (ptyObservationStore). Core does not own a terminal view (the terminal is a plugin view too), so
// term.read/send/exec/cwd apply only to plugin terminals driven by app.pty (zero core lock-in).
// Target key = the tab id of that terminal instance (registerIo(tabId)). The same key binds IO
// (read/write) and observation (cwd).
//
// [invariant] One producer per tab (substrate IO). An explicit tab that has an observation is the
// target; otherwise the context (the terminal tab of the active chain) is found by a substrate
// predicate.

import {
  getObservedCwd,
  getPtyIo,
  hasPtyObservation,
} from "../terminal/ptyObservationStore";
import type { CommandContext } from "./registry";

// Resolved terminal target — tab id + substrate IO.
export interface TermTarget {
  tabId: string;
  /** Screen and scrollback text (the last `lines` lines). undefined when not ready. */
  readBuffer: (lines?: number) => string | undefined;
  /** Injects raw input into the PTY. false when not ready. */
  sendInput: (data: string) => boolean;
  /** Current working directory (shell integration OSC). undefined when unconfirmed. */
  getCwd: () => string | undefined;
}

// Context-based (active chain) terminal tab resolver — used when no explicit tab is given. catalog
// implements and injects it from the sessions + substrate predicates (avoids a circular import).
// null means the context has no terminal.
export type ContextResolve = (
  params: Record<string, unknown>,
  ctx: CommandContext,
) => { tabId: string } | null;

// Target backed by substrate IO (app.pty-driven, such as a plugin terminal).
function substrateTarget(tabId: string): TermTarget {
  return {
    tabId,
    readBuffer: (lines) => getPtyIo(tabId)?.readBuffer(lines),
    sendInput: (data) => {
      const io = getPtyIo(tabId);
      if (!io) return false;
      io.sendInput(data);
      return true;
    },
    getCwd: () => getObservedCwd(tabId),
  };
}

/**
 * Resolves the target tab for term.* through a single path (all substrate).
 *   1) An explicit tab that has a substrate observation (hasPtyObservation) is the target.
 *   2) With no explicit tab, contextResolve finds it (the terminal tab of the active chain).
 * Neither one yields null (→ the caller answers TARGET_NOT_FOUND).
 *
 * With contextResolve omitted (unit tests and such), only the explicit tab path is attempted.
 */
export function resolveTermTab(
  params: Record<string, unknown>,
  ctx: CommandContext,
  contextResolve?: ContextResolve,
): TermTarget | null {
  const explicit = params.tab as string | undefined;
  if (explicit) {
    return hasPtyObservation(explicit) ? substrateTarget(explicit) : null;
  }
  const ctxTab = contextResolve?.(params, ctx);
  if (ctxTab && hasPtyObservation(ctxTab.tabId)) {
    return substrateTarget(ctxTab.tabId);
  }
  return null;
}
