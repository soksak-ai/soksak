import { CONTENT_VIEW_EVENT } from "../lib/contentViewEvents";
import type { ContentViewEventKey } from "./api";
// Production dependency wiring for the plugin API — the PluginApiDeps implementation from api.ts.
// (Tests inject fake deps — this file only connects the real registry/store/bridge.)

import { invoke } from "../framework";
import { safeListen } from "../lib/safeListen";
import {
  execute,
  getSpec,
  register,
  unregister,
} from "../commands/registry";
import { useSessions } from "../state/sessions";
import {
  getCwdOfHost,
  subscribeCwd,
  subscribeCommandFinished,
} from "../terminal/ptyBridge";
import { onPluginEvent } from "./hooks";
import type { DataChangeEvent, PluginApiDeps } from "./api";
import type { ContractProviderRef } from "./spec";

// Safe global listen subscription — consolidated into the single lib/safeListen util (hand-rolled version removed).
function subscribe<T>(event: string, onPayload: (payload: T) => void): () => void {
  return safeListen<T>(event, (e) => onPayload(e.payload));
}

/** Short key (what a plugin calls it) → wire name (canonical table). A new key is blocked here at compile time. */
const WIRE: Record<ContentViewEventKey, string> = {
  nav: CONTENT_VIEW_EVENT.nav,
  title: CONTENT_VIEW_EVENT.title,
  status: CONTENT_VIEW_EVENT.status,
  "open-external": CONTENT_VIEW_EVENT.openExternal,
  loading: CONTENT_VIEW_EVENT.loading,
} as const;

export function defaultPluginDeps(
  appVersion: string,
  implementsOf?: (pluginId: string) => ContractProviderRef[],
): PluginApiDeps {
  return {
    appVersion,
    invoke: (cmd, args) => invoke(cmd, args),
    execute,
    registerCommand: register,
    unregisterCommand: unregister,
    getCommandDanger: (name) => getSpec(name)?.danger,
    implementsOf,
    on: onPluginEvent,
    currentWorkspace: () => {
      const s = useSessions.getState();
      const workspace = s.workspaces.find((t) => t.id === s.activeId);
      return workspace ? { id: workspace.id, root: workspace.root ?? null } : null;
    },
    // fs-change subscription (core watcher, no polling) → callback with the changed parent directory string. Return = unsubscribe.
    onFsChange: (cb) => subscribe<string>("fs-change", cb),
    // data-change (core DbState change) subscribed in every window — the cross-window channel for
    // app.data.watch. Global listen (a broadcast at the framework boundary), so a change in any window arrives at all windows (consistent within the same workspace).
    onDataChange: (cb) => subscribe<DataChangeEvent>("data-change", cb),
    // clipboard-change (core native watcher — Win/X11/Wayland events, macOS changeCount polling)
    // subscribed in every window → callback with the changed text.
    onClipboardChange: (cb) => subscribe<string>("clipboard-change", cb),
    // Terminal pane cwd snapshot/subscription plus command-finished subscription — bridged from core ptyBridge (exposed as app.terminal).
    getCwd: (paneId) => getCwdOfHost(paneId),
    subscribeCwd: (paneId, cb) => subscribeCwd(paneId, cb),
    subscribeCommandFinished: (paneId, cb) => subscribeCommandFinished(paneId, cb),
    // Content view event subscription filtered by label — exposed as app.webview.on.
    //
    // **Names are not assembled.** The old version built `` `browser-${event}` ``, which tied the
    // short key and the wire name together through string arithmetic — change one side and the
    // publish lands nowhere, and that absence is not an error but an event that never arrives.
    // Names are picked from the canonical table (core is canonical).
    subscribeWebview: (label, event, cb) =>
      subscribe<{ label: string } & Record<string, unknown>>(WIRE[event], (p) => {
        if (p.label === label) cb(p);
      }),
  };
}
