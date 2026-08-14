// Native child webview GC — invariant: the set of existing `brw-<windowLabel>-<viewId>` webviews
// *of this window* ⊆ the set of webview-owning views in this window's store. Creation/destruction
// happens in the browser plugin (content view) lifecycle, but an async creation overlapping a fast
// close/move can leave an ownerless webview (a window nothing can close) — the invariant is
// verified and reclaimed on every layout change (event-driven, no polling). The label is
// window-namespaced (webviewLabels is the single truth), so webview_list (app-wide) is filtered by
// this window's prefix and only *this window's* are reclaimed (never terminate another window's).
// The native query (webview_list) runs only when the "set" of owning views changed — an unrelated
// store write such as a drag ends at one string comparison (docs/PERFORMANCE.md principle 5).
//
// The core does not identify a view that owns a child webview (native surface) by name — the
// plugin "declares" it in the manifest with contributes.views[].nativeSurface=true (spec
// data-driven), and here the ownsSurface predicate derived from that declaration is the only test.
// A plugin id hardcoded in the core = tight coupling (violates the plugin/core separation rule).

import { moduleState } from "../lib/moduleState";
import { invoke } from "../framework";
import { rafThrottle } from "./rafThrottle";
import { allGroups, useSessions, type Project } from "../state/sessions";
import { usePlugins } from "../state/plugins";
import { browserLabel, browserLabelPrefix } from "./webviewLabels";
import { ownsNativeSurfaceFromManifests } from "./nativeSurfaceOwnership";

// "Does view viewId of plugin pluginId own a native child surface" — the predicate form of the
// manifest declaration.
export type OwnsSurface = (pluginId: string, viewId: string) => boolean;

// Pure — the label set of every view in tabs that owns (declares) a webview. Injecting
// ownsSurface/labelOf makes unit tests independent of plugin state and of the window namespace
// (currentWindowLabel).
export function collectWebviewLabels(
  tabs: readonly Project[],
  ownsSurface: OwnsSurface,
  labelOf: (viewId: string) => string = browserLabel,
): Set<string> {
  const live = new Set<string>();
  for (const t of tabs) {
    for (const c of t.spaces) {
      for (const g of allGroups(c.layout)) {
        for (const v of g.tabs) {
          // A view declaring nativeSurface — it owns a child webview/surface under the
          // browserLabel(view.id) scheme.
          if (v.kind === "plugin" && ownsSurface(v.pluginId, v.view))
            live.add(labelOf(v.id));
        }
      }
    }
  }
  return live;
}

function liveBrowserLabels(): Set<string> {
  return collectWebviewLabels(useSessions.getState().projects, ownsNativeSurfaceFromManifests);
}

// The "already attached" record must survive the hot-swap boundary — if only this flag is lost,
// the installation is gone while the installing side treats it as already done and never attaches
// again (never installed).
/** Whether the sweep loop already started — if only this is lost, the starting side treats it as
 *  already started and never starts it again. */
const started = moduleState("lib/webviewGc#started", () => ({ on: false }));

// Recovery reboot guard (webview_health recovery-in-flight one-shot flag) — right after the
// recovery reload of a crashed main webview the frontend boots with an empty store, so a sweep
// before session restore is applied misreads live=∅ and can reclaim live child b-* webviews. The
// core flag is consumed once to start in held, and windowBoot releases it with
// releaseWebviewGcHold after applying the restore. A normal boot gets consume=false and is
// released at once. (The control-plane main window does not run windowBoot, but it has no child
// webview either, so a sweep is pointless — staying held is harmless.)
export type GcGateState = "pending" | "held" | "released";

// Pure core of the gate transition — the next state when the consume response arrives. If
// windowBoot's release arrived first (released), a late consume response cannot revert it
// (one-way release).
export function gateAfterConsume(cur: GcGateState, inFlight: boolean): GcGateState {
  if (cur === "released") return "released";
  return inFlight ? "held" : "released";
}

// Outside the hot-swap boundary — if the gate state and the sweep slot are replaced with new ones,
// the "already released" verdict is lost and the releasing side treats it as already released and
// never releases again.
/** Recovery reboot guard — one-way release (released never goes back). */
const gate = moduleState("lib/webviewGc#gate", () => ({
  gcGate: "pending" as GcGateState,
}));

/** The sweep slot — wired separately from the gate (different lifetime). */
const sweepHandle = moduleState("lib/webviewGc#sweep", () => ({
  sweepRef: null as (() => void) | null,
}));

export function releaseWebviewGcHold(): void {
  const was = gate.gcGate;
  gate.gcGate = "released";
  if (was !== "released") sweepHandle.sweepRef?.();
}

export function startWebviewGc(): void {
  if (started.on) return;
  started.on = true;

  let lastKey: string | null = null;
  const sweep = rafThrottle(() => {
    // Recovery reboot guard — no sweep before the restore is applied (release); see the
    // gate.gcGate header above.
    if (gate.gcGate !== "released") return;
    // While manifests are not loaded (right after boot, before the plugin scan) no verdict is
    // possible — a live=∅ misread can wrongly reclaim a webview that survived HMR. Held until the
    // declarations are loaded (the usePlugins subscription re-fires on load).
    if (Object.keys(usePlugins.getState().plugins).length === 0) return;
    const live = liveBrowserLabels();
    const key = [...live].sort().join(",");
    if (key === lastKey) return;
    lastKey = key;
    const prefix = browserLabelPrefix();
    void invoke<string[]>("webview_list")
      .then((labels) => {
        for (const label of labels) {
          // webview_list returns app-wide (every window) browser webviews — only this window's
          // (prefix) are compared and reclaimed. Another window's browser is that window's GC
          // work, so it is never touched (no cross-window termination).
          if (!label.startsWith(prefix)) continue;
          if (!live.has(label)) {
            invoke("webview_close", { label }).catch(() => {});
          }
        }
      })
      .catch(() => {});
  });

  sweepHandle.sweepRef = sweep;
  useSessions.subscribe(() => sweep());
  usePlugins.subscribe(() => sweep()); // Re-decide on manifest load or change (boot hold release included)
  // Consume the recovery-reboot flag from the core once — otherwise released at once and normal
  // sweeping resumes.
  void invoke<boolean>("webview_recovery_consume")
    .then((inFlight) => {
      const next = gateAfterConsume(gate.gcGate, inFlight);
      if (gate.gcGate === next) return;
      gate.gcGate = next;
      if (next === "released") sweep();
    })
    .catch(() => {
      // Core query failure (test runtime and the like) — the hold is not made permanent.
      if (gate.gcGate !== "released") {
        gate.gcGate = "released";
        sweep();
      }
    });
}
