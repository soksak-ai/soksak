import { moduleState } from "../lib/moduleState";
import { currentWindow } from "../framework";

// The name of the window this document is.
//
// One value, cached per window. Every identifier that must be unique across the whole application
// has it in the middle — a surface label is `<kind>-<window>-<viewId>`, and lib/surfaceLabels.ts is
// where that shape is defined.
//
// This module held the browser's label grammar until 2026-08-16: `brw-`, the prefix, the inverse,
// and the orphan filter. The core minted a browser's identifier and handed it back through
// `app.webview.label(viewId)`, so the plugin that owns a browser could not have been replaced
// without editing the core, and a second kind of surface had nowhere to get a label from. The kind
// is the plugin's word now; the shape stayed here, one directory over.

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
