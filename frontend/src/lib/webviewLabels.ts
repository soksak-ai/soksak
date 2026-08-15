import { moduleState } from "../lib/moduleState";
import { currentWindow } from "../framework";

// The single source for multi-window identifiers. Any name that must be unique
// across the whole application — a browser child webview label, for one — is
// derived here. View ids are already globally unique (state/ids.ts); a label
// adds the window name so the value also states which window it belongs to.
// Reclaiming a surface and filtering out labels with no parent window read that
// one value.
//
// [RULE] Rebuilding `brw-${viewId}` inline drops the window namespace, and two
// windows then produce the same label (second window: no browser, or a zombie).
// Browser labels come from browserLabel() only — webviewLabels.test.ts fails the
// build on an inline rebuild.

// This window's label, cached. Each window is a separate JS context and caches
// its own. This cache is outside the hot-swap boundary: replacing it would drop
// the "already done" record along with the lazy initialisation, and whoever was
// filling it does not fill it again.
const ms = moduleState("lib/webviewLabels#state", () => ({
  cached: null as string | null,
}));
export function currentWindowLabel(): string {
  if (ms.cached) return ms.cached;
  try {
    const label = currentWindow().label;
    // An empty value is "not resolved yet", not an answer. Caching it leaves the
    // window without a name for the rest of the session, and that one name is
    // what separates the orchestrator from a workspace window. Measured
    // 2026-08-15: the main window logged window-name:main and still drew the
    // workspace shell, because module top-level code asked once before boot's
    // async resolution, and that "" became the answer to every later question.
    if (!label) return "";
    ms.cached = label;
  } catch {
    // Outside the framework (jsdom) there is no answer. This is also "not yet",
    // not a window named "".
    return "";
  }
  return ms.cached;
}

/** The browser child webview label for a given window.
 *
 * This window's own label comes from `browserLabel` below; another window's —
 * tests, cross-window checks — comes from here. Without it a caller writes
 * `brw-${...}` by hand, and that copy stays wrong until someone changes the
 * grammar.
 */
export function browserLabelIn(windowLabel: string, viewId: string): string {
  return `${browserLabelPrefixIn(windowLabel)}${viewId}`;
}

/** The browser child webview label prefix for a given window. */
export function browserLabelPrefixIn(windowLabel: string): string {
  return `${BROWSER_PREFIX}${windowLabel}-`;
}

// The globally unique label of a browser child webview: brw-<windowLabel>-<viewId>.
export function browserLabel(viewId: string): string {
  return browserLabelIn(currentWindowLabel(), viewId);
}

/** The browser child webview label prefix.
 *
 *  A label is an identifier, so its prefix is three letters like every other
 *  (`b-` reads as browser or as body). Only this module references the grammar,
 *  so the value is defined only here. */
export const BROWSER_PREFIX = "brw-";

// This window's browser label prefix. Reclaiming compares only its own window's
// browsers: webview_list returns every window's, so the prefix selects this
// window's and no other window's surface is closed.
export function browserLabelPrefix(): string {
  return browserLabelPrefixIn(currentWindowLabel());
}

// Selects browser child labels whose parent window is gone. This module owns the
// label grammar (brw-<window>-<view>), so this check is defined here too.
export function orphanBrowserLabels(labels: string[], windows: string[]): string[] {
  return labels.filter(
    (l) =>
      l.startsWith(BROWSER_PREFIX) &&
      !windows.some((w) => l.startsWith(`${BROWSER_PREFIX}${w}-`)),
  );
}

// The inverse of browserLabel: the viewId for *this* window's browser label, and
// null otherwise. Another window's browser (brw-<other>-…) and non-browser
// webviews have no name this window can read.
export function browserViewIdFromLabel(label: string): string | null {
  const prefix = browserLabelPrefix();
  return label.startsWith(prefix) ? label.slice(prefix.length) : null;
}
