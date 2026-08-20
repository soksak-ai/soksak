// §1 Permissions — single source of truth for the plugin permission vocabulary and the consent
// screen disclosures. A permission is an allow-list entry in the capability broker between the
// opaque sandbox and the native host. The host runs only explicit operations that pass both
// manifest consent and runtime principal verification.
// PERMISSION_INFO is the honest disclosure text for the consent screen — caution = highlight it.
// Its label/detail are getters: each read resolves in the language selected at that moment, so a
// language change on the open consent screen re-renders with the new text.

import { tmsg } from "../../i18n";

export type PluginPermission =
// [RULE] UI region permission split — every UI region a plugin touches is clearly distinct and is
// declared as its own permission (titlebar, statusbar, content, fullscreen are different regions).
// The consent screen must state exactly which region is affected — different region, different permission.
| "ui" // register content/sidebar views (the host owns placement — safe) + icon sets
| "ui:statusbar" // add an item to the status bar (chrome region)
| "ui:titlebar" // add a toggle icon to the titlebar right control group (chrome region)
// Overlay family — both draw over the body, but the scope differs, so they are split into variants.
| "ui:overlay:pane" // overlay covering one content pane (hides only that pane body — GUI over a pane)
| "ui:overlay:screen" // layer covering the whole app (over chrome and every pane — most invasive, e.g. mascot effects)
| "programs" // register a + menu program (selecting it may auto-run a terminal command)
| "commands" // run registry commands (the ones without danger) + register own commands
| "commands:destructive" // run danger:"destructive" commands (close, remove)
| "commands:inject" // run danger:"inject" commands (term.send/exec, browser.eval …)
| "process" // spawn an external subprocess + bidirectional raw stdio (general — LSP/MCP/ACP/arbitrary CLI integration)
| "webview" // drive a core-embedded child webview (WKWebView) — browser-class content view (native page load, eval, inject)
| "sidecar" // load a shared native engine module (dylib) into the app process + opaque channel (sidecars[] declaration required — docs/SIDECARS.md)
| "service" // resident plugin service — a command-owning process the core spawns and routes to (service declaration required — docs/PLUGIN-SERVICE.md)
| "storage" // dedicated storage (~/.soksak/plugins-data/<id>/)
| "data" // general embedded DB (app.data — namespace isolation, CJK search, watch across every window)
| "secrets" // encrypted vault (app.secrets — sealed API key/token storage, no plaintext readback, injection only)
| "notify" // OS notification (push) + in-app banner, sound, deep link (a notification ranks with a push)
| "schedule" // general scheduler (app.scheduler — at/every/cron/reconcile triggers fire commands automatically and persist them)
| "fs:read" // read a file at an arbitrary path
| "fs:write" // write a file at an arbitrary path
| "clipboard:read" // read system clipboard text + subscribe to changes (monitoring is part of reading)
| "clipboard:write" // write text to the system clipboard (other apps then paste it)
| "terminal" // observe the terminal command lifecycle (command.started/finished — command line, cwd)
| "terminal:read" // read terminal screen buffer content + subscribe to changes (stronger than command metadata — the full screen text)
| "terminal:write" // send input to the terminal PTY (key injection — stronger than observation, a separate permission)
| "network"; // direct network from the sandbox is blocked; only brokered network operations are allowed

export const PERMISSIONS: readonly PluginPermission[] = [
"ui",
"ui:statusbar",
"ui:titlebar",
"ui:overlay:pane",
"ui:overlay:screen",
"programs",
"commands",
"commands:destructive",
"commands:inject",
"process",
"webview",
"sidecar",
"service",
"storage",
"data",
"secrets",
"notify",
"schedule",
"fs:read",
"fs:write",
"clipboard:read",
"clipboard:write",
"terminal",
"terminal:read",
"terminal:write",
"network",
];

// Permission descriptions for the consent screen (§0-2 honest disclosure). caution = highlight it.
export const PERMISSION_INFO: Record<
PluginPermission,
{ label: string; detail: string; caution?: true }
> = {
ui: {
  get label() {
    return tmsg("perm.ui.label");
  },
  get detail() {
    return tmsg("perm.ui.detail");
  },
},
"ui:statusbar": {
  get label() {
    return tmsg("perm.ui.statusbar.label");
  },
  get detail() {
    return tmsg("perm.ui.statusbar.detail");
  },
},
"ui:titlebar": {
  get label() {
    return tmsg("perm.ui.titlebar.label");
  },
  get detail() {
    return tmsg("perm.ui.titlebar.detail");
  },
},
"ui:overlay:pane": {
  get label() {
    return tmsg("perm.ui.overlay.pane.label");
  },
  get detail() {
    return tmsg("perm.ui.overlay.pane.detail");
  },
  caution: true,
},
"ui:overlay:screen": {
  get label() {
    return tmsg("perm.ui.overlay.screen.label");
  },
  get detail() {
    return tmsg("perm.ui.overlay.screen.detail");
  },
  caution: true,
},
programs: {
  get label() {
    return tmsg("perm.programs.label");
  },
  get detail() {
    return tmsg("perm.programs.detail");
  },
  caution: true,
},
commands: {
  get label() {
    return tmsg("perm.commands.label");
  },
  get detail() {
    return tmsg("perm.commands.detail");
  },
},
"commands:destructive": {
  get label() {
    return tmsg("perm.commands.destructive.label");
  },
  get detail() {
    return tmsg("perm.commands.destructive.detail");
  },
  caution: true,
},
"commands:inject": {
  get label() {
    return tmsg("perm.commands.inject.label");
  },
  get detail() {
    return tmsg("perm.commands.inject.detail");
  },
  caution: true,
},
process: {
  get label() {
    return tmsg("perm.process.label");
  },
  get detail() {
    return tmsg("perm.process.detail");
  },
  caution: true,
},
webview: {
  get label() {
    return tmsg("perm.webview.label");
  },
  get detail() {
    return tmsg("perm.webview.detail");
  },
  caution: true,
},
sidecar: {
  get label() {
    return tmsg("perm.sidecar.label");
  },
  get detail() {
    return tmsg("perm.sidecar.detail");
  },
  caution: true,
},
service: {
  get label() {
    return tmsg("perm.service.label");
  },
  get detail() {
    return tmsg("perm.service.detail");
  },
  caution: true,
},
storage: {
  get label() {
    return tmsg("perm.storage.label");
  },
  get detail() {
    return tmsg("perm.storage.detail");
  },
},
data: {
  get label() {
    return tmsg("perm.data.label");
  },
  get detail() {
    return tmsg("perm.data.detail");
  },
},
secrets: {
  get label() {
    return tmsg("perm.secrets.label");
  },
  get detail() {
    return tmsg("perm.secrets.detail");
  },
  caution: true,
},
notify: {
  get label() {
    return tmsg("perm.notify.label");
  },
  get detail() {
    return tmsg("perm.notify.detail");
  },
  caution: true,
},
schedule: {
  get label() {
    return tmsg("perm.schedule.label");
  },
  get detail() {
    return tmsg("perm.schedule.detail");
  },
  caution: true,
},
"fs:read": {
  get label() {
    return tmsg("perm.fs.read.label");
  },
  get detail() {
    return tmsg("perm.fs.read.detail");
  },
  caution: true,
},
"fs:write": {
  get label() {
    return tmsg("perm.fs.write.label");
  },
  get detail() {
    return tmsg("perm.fs.write.detail");
  },
  caution: true,
},
"clipboard:read": {
  get label() {
    return tmsg("perm.clipboard.read.label");
  },
  get detail() {
    return tmsg("perm.clipboard.read.detail");
  },
  caution: true,
},
"clipboard:write": {
  get label() {
    return tmsg("perm.clipboard.write.label");
  },
  get detail() {
    return tmsg("perm.clipboard.write.detail");
  },
  caution: true,
},
terminal: {
  get label() {
    return tmsg("perm.terminal.label");
  },
  get detail() {
    return tmsg("perm.terminal.detail");
  },
  caution: true,
},
"terminal:read": {
  get label() {
    return tmsg("perm.terminal.read.label");
  },
  get detail() {
    return tmsg("perm.terminal.read.detail");
  },
  caution: true,
},
"terminal:write": {
  get label() {
    return tmsg("perm.terminal.write.label");
  },
  get detail() {
    return tmsg("perm.terminal.write.detail");
  },
  caution: true,
},
network: {
  get label() {
    return tmsg("perm.network.label");
  },
  get detail() {
    return tmsg("perm.network.detail");
  },
  caution: true,
},
};
