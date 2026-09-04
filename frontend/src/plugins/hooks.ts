// Plugin events — the single channel that notifies plugins of host state changes.
// Implementation rule: subscribe to the sessions and theme stores and synthesize the diff.
// No emit is injected into existing store code (surgical — the only explicit emit is

// A listener failure cannot kill the host (§0-4) — try/catch per callback.

import { moduleState } from "../lib/moduleState";
import { tmsg } from "../i18n";
import { safeListen } from "../lib/safeListen";
import { listenThisWindow } from "../lib/windowEvents";
import { currentWindow } from "../framework";
import { currentWindowLabel } from "../lib/webviewLabels";
import { allGroups, useSessions } from "../state/sessions";
import { useTheme } from "../state/theme";
import { useSettings } from "../state/settings";
import { setAnyOutputSink } from "../terminal/ptyObservationStore";
import {
  subscribeAnyCommandFinished,
  subscribeAnyCommandStarted,
} from "../terminal/ptyBridge";
import { busOn } from "./bus";
import type { PluginPermission } from "./spec";

type SessionsState = ReturnType<(typeof useSessions)["getState"]>;

export interface Disposable {
  dispose(): void | Promise<void>;
}

export interface PluginEventMap {
  "workspace.changed": { projectId: string; root: string | null };
  // A new workspace was created (right after the root is fixed) — root initialization policy
  // (git init etc.) is owned by plugins subscribing to this event, not by the core.
  "workspace.created": { projectId: string; root: string | null };
  // Rail binding changed (sidebar projection §4.3) — on binding view switch (including an active
  // tab switch inside a group), release, and pin change. viewId=null means no binding (empty workspace).
  "projection.changed": { projectId: string; viewId: string | null };
  "view.activated": {
    projectId: string;
    viewId: string;
    kind: string;
    path?: string;
  };
  /** Paths dropped on this window. The core places no meaning on a drop: a terminal plugin types
   *  them, an editor plugin opens them, and both may be listening. paneId is the workspace's
   *  cwd-tracking pane when there is one — where "here" is, for a subscriber that wants it. */
  "paths.dropped": {
    projectId: string | null;
    paneId: string | null;
    grants: Array<{ id: string; kind: "file" | "image" }>;
  };
  "theme.changed": { name: string; mode: "light" | "dark" };
  // Progress delta (MESSAGE-PROTOCOL §2) — sidecar events and AI thinking, published by the consuming plugin.
  "command.progress": { command?: string; delta?: unknown; source?: string };
  // Host display language changed — the refresh signal for a plugin's own i18n (text inside its views).
  "locale.changed": { language: string };
  // Whether the app (main window) is active — relays the core WindowEvent::Focused. Switching to
  // another app makes it false; focus moving to a child webview inside the same window (embedded
  // browser) leaves it unchanged, since this is window level. The exact signal for stopping secondary
  // animations (pets etc.) while the window is not viewed (DOM blur also fires for children and is inaccurate).
  "app.focus": { focused: boolean };
  // Window edge-drag live resize start (true) / end (false) — relays the core NSWindow live-resize
  // notification (browser.rs install_live_resize_monitor). The single channel for terminal/browser
  // plugins to lower the frequency of heavy work during a drag (terminal fit, PTY, native webview
  // repositioning) and snap exactly once at the end of it — isomorphic with app.focus (window-focus
  // relay). No permission required (non-sensitive lifecycle). Only signals emit_to'd to this window
  // arrive (per-window — listenThisWindow).
  "window.live-resize": { active: boolean };
  // A window of this application has gone. Whatever was kept under its label — a session in a
  // separate process, a subscription, a record — is this plugin's to let go of: a unit outlives the
  // window that opened it, and no other reading reports that the window is not coming back.
  //
  // The window it names is not this one. A plugin in the closing window dies with it, so acting on
  // this is the surviving instances' work.
  "window.gone": { windowLabel: string };
  // A native terminal surface signalled a painted frame (V13: pushed on change,
  // at most ten per second per pane). sequence is the pane's frame sequence —
  // the surface owner's evidence that its pixels moved.
  "terminal-surface.state": { pane: string; sequence: number; generation: number };
  "process.inventory.changed": {
    revision: number;
    kind: "started" | "updated" | "ended";
    process: {
      id: string; owner: string; window?: string; pane?: string; cwd?: string;
      pid: number; parentPid: number; command: string; state: "running" | "ended";
      startedAtUnixMs: number; endedAtUnixMs?: number;
    };
  };
  // Panel divider drag gesture start (true) / end (false) — a layout-internal gesture channel
  // isomorphic with window.live-resize (window edge). The signal a native surface adapter uses to
  // separate move from resize and to start/end its own placement transition. Emitted by the GroupArea
  // divider handler (real drag, native bridge and E2E synthesis all take the same path). No permission required.
  "layout.resize-gesture": { active: boolean; kinds?: ("move" | "resize")[] };
  // Emitted by the core after a content slot is parked/unparked by a content tab switch etc. (core
  // useLayoutEffect = after the React commit) — the signal for a plugin owning a native webview to
  // re-snap its bounds once against its own anchor. Covers position-only changes (size unchanged)
  // that ResizeObserver cannot catch.
  "layout.reflow": { activeSpaceId: string | null };
  // The exact transaction boundary where a shared presentation epoch's visual journey lands or is
  // cancelled. A native surface adapter forbids ordinary reflow bounds writes until this event and
  // fixes the target frame after the landing.
  "layout.travel-finished": { transactionId: string; status: "landed" | "cancelled" };
  // Window zoom factor changed (§Zoom) — a native surface outside the webview (CEF engine etc.) uses it to compose the effective factor (window × view).
  "window.zoom": { factor: number };
  // Effective visibility of a view body slot (space active && tab active) changed — the core is the
  // single owner (R12 native layer extension). A plugin with a native surface (engine surface, child
  // webview) matches show/hide and re-snap to this fact (replaces the viewport-guessing
  // IntersectionObserver). parked=true is invisible, false is back.
  "view.parked": { viewId: string; parked: boolean };
  // webview health (circuit breaker) transition — the core (webview_health.rs) detects renderer
  // process death, recovers it, and emit_to's that window. state: recovering=automatic recovery
  // scheduled (with attempt), open=budget exhausted (automatic recovery stopped — recover manually
  // with webview.recover), closed=back to normal. label is the window label (that window's main
  // webview) or b-<win>-<view> (browser child). The signal for a plugin owning a native surface to
  // re-snap and re-hydrate on its child's death or return.
  "webview.health": {
    label: string;
    window: string;
    state: "recovering" | "open" | "closed";
    attempt: number | null;
  };
  // Terminal command start (OSC 633;E from the shell preexec — command line and cwd included, no polling).
  // [RULE] Per-command domain handling is owned by plugins subscribing to this event,
  // not by the core — the same rule as workspace.created. The core provides only the generic socket
  // and holds no code specific to one plugin — no tight coupling.
  "command.started": {
    projectId: string | null;
    paneId: string;
    commandLine: string;
    cwd: string | null;
    // [R2] Foreground pgid of the command that just started (best-effort — shell/null on an exec race).
    // The command/pid/sessionId triple.
    pid?: number | null;
  };
  // Terminal command end (OSC 133/633 shell integration detection — no polling). The auto-refresh
  // trigger for the git view etc. projectId is the workspace of the pane (null when not found).
  // commandLine is set only for a real command with an observed start (shell init byproducts are
  // null — the prompt end fired per pane at boot).
  "command.finished": {
    projectId: string | null;
    paneId: string;
    exitCode?: number;
    commandLine?: string | null;
  };
  // Open topic "turn ended" — 3 providers: shell (OSC133 command end), idle (output idle heuristic,
  // OFF by default), acp (published on the bus by the ACP plugin → mirrored into hooks by the core).
  // The mailbox self-subscribe consumes it and generates a message mechanically at turn end. The core
  // has no notion of a specific plugin (zero coupling) — only the topic contract.
  // Activity hub entry (P12 execution visibility) — the window-side relay of the same stream as the
  // orchestrator feed. Entries from every window flow through (payload.window = the originating
  // window) — filter to this window with ownWindow.
  activity: {
    seq: number;
    ts: number;
    kind: string;
    source: string;
    payload: Record<string, unknown>;
    ownWindow: boolean;
  };
  "turn.ended": {
    projectId: string | null;
    // Workspace root (folder path) — a window-independent stable identifier. The scope key for
    // consistency across windows on one workspace (projectId can differ per window, so it is unfit as
    // a scope). Subscribers (the mailbox) scope by root.
    root: string | null;
    paneId: string | null;
    source: "shell" | "idle" | "acp";
    // Context of the finished command (shell provider only — for body enrichment). Absent (undefined) for idle/acp.
    command?: string | null;
    cwd?: string | null;
    // Exit code (R2 — shell provider OSC133 D;<code>). undefined when absent (no code delivered / non-shell).
    exitCode?: number;
  };
}

export const PLUGIN_EVENTS: readonly (keyof PluginEventMap)[] = [
  "workspace.changed",
  "workspace.created",
  "projection.changed",
  "view.activated",
  "paths.dropped",
  "theme.changed",
  "locale.changed",
  "app.focus",
  "window.live-resize",
  "window.gone",
  "terminal-surface.state",
  "process.inventory.changed",
  "layout.resize-gesture",
  "layout.reflow",
  "layout.travel-finished",
  "window.zoom",
  "view.parked",
  "webview.health",
  "command.started",
  "command.finished",
  "command.progress",
  "turn.ended",
  "activity",
];

// Events that need a permission gate → the required permission. An event not listed needs no permission (generic notification).
// command.* exposes the commands the user runs (command line, cwd) → requires the "terminal" permission.
// The consent screen shows that permission (core/terminal access is disclosed to the user).
export const EVENT_PERMISSIONS: Partial<
  Record<keyof PluginEventMap, PluginPermission>
> = {
  "command.started": "terminal",
  "command.finished": "terminal",
  // Turn end exposes terminal screen activity (including idle detection) → gated on screen read permission.
  "turn.ended": "terminal:read",
  // The activity hub streams command lines, turns and other terminal activity → the same class of gate.
  activity: "terminal",
  // Surface render progress requires the surface permission.
  "terminal-surface.state": "surface",
  "process.inventory.changed": "terminal",
};

type AnyListener = (payload: never) => void;
const listeners = moduleState(
  "plugins/hooks#listeners",
  () => new Map<keyof PluginEventMap, Set<AnyListener>>(),
);

export function onPluginEvent<K extends keyof PluginEventMap>(
  event: K,
  fn: (payload: PluginEventMap[K]) => void,
): Disposable {
  if (!PLUGIN_EVENTS.includes(event)) {
    throw new Error(tmsg("plugin.event.unknown", { event: String(event) }));
  }
  let set = listeners.get(event);
  if (!set) {
    set = new Set();
    listeners.set(event, set);
  }
  set.add(fn as AnyListener);
  return {
    dispose: () => {
      set.delete(fn as AnyListener);
    },
  };
}

// ── Boot event buffer — the contract that keeps restore from waiting on the plugin host (restore is 300ms).
// The old order (host → restore) prevented "fired before listeners registered" losses (the missed
// git init incident) by ordering alone, and that cost 2.5s of boot (a measured 2.3s plugin activation
// total blocked a 4ms restore). Now the buffer holds that contract instead of the order: firings
// during boot are queued only, and once the host and core subscribers are all in place
// flushBootPluginEvents replays them FIFO — delivery timing matches the old order, only the state
// (restore) comes earlier.
// The buffer is a mode boot turns on explicitly — the default is immediate delivery (entry points
// outside the boot buffer contract, such as tests and the orchestrator, stay as they are). Only the
// workspace boot contracts a begin→flush pair.
// Outside the hot-swap boundary — if these values become new, the "already done" memory and the lazy
// initialization disappear together, and the side that filled them does not fill them again.
const ms = moduleState("plugins/hooks#state", () => ({
  bootBuffering: false,
}));
const bootQueue: Array<[keyof PluginEventMap, unknown]> = [];

export function beginBootPluginEventBuffer(): void {
  ms.bootBuffering = true;
}

export function flushBootPluginEvents(): void {
  if (!ms.bootBuffering) return;
  ms.bootBuffering = false;
  for (const [ev, pl] of bootQueue.splice(0)) {
    dispatchPluginEvent(ev, pl as PluginEventMap[typeof ev]);
  }
}

/** Test only — reset the buffer state (reproduces the once-per-window-boot contract in every test). */
export function __resetBootPluginEventsForTest(): void {
  ms.bootBuffering = false;
  bootQueue.length = 0;
}

function dispatchPluginEvent<K extends keyof PluginEventMap>(
  event: K,
  payload: PluginEventMap[K],
): void {
  const set = listeners.get(event);
  if (!set) return;
  for (const fn of [...set]) {
    try {
      (fn as (p: PluginEventMap[K]) => void)(payload);
    } catch (e) {
      // §0-4: a plugin listener failure is isolated — not propagated to other listeners or the host.
      console.error(`plugin event listener failed (${String(event)}):`, e);
    }
  }
}

export function emitPluginEvent<K extends keyof PluginEventMap>(
  event: K,
  payload: PluginEventMap[K],
): void {
  if (ms.bootBuffering) {
    bootQueue.push([event, payload]);
    return;
  }
  dispatchPluginEvent(event, payload);
}

// Called once on a successful FileViewer save (save success cannot be told from store signals alone).
export function emitPathsDropped(payload: PluginEventMap["paths.dropped"]): void {
  emitPluginEvent("paths.dropped", payload);
}

// Re-seed the sessions diff baseline to now right after boot restore is applied — restore is not creation (§5).
// startPluginHooks injects the real implementation (a call before that is a no-op — a window without
// hooks has no diff either). The injection point must cross the hot-swap boundary — if only this slot
// is empty, the side that filled it treats it as filled and does not fill it again. What remains then
// is "nobody answers", and that silence is not an error.
const reseedSessionsSlot = moduleState(
  "plugins/hooks#reseedSessions",
  () => ({ v: null as (() => void) | null }),
);
export function reseedSessionsSnapshot(): void {
  reseedSessionsSlot.v?.();
}

// ── State diff synthesis ──────────────────────────────────────────────────────

interface ActiveViewKey {
  projectId: string;
  viewId: string;
  kind: string;
  path?: string;
}

interface SessionsSnapshot {
  activeProjectId: string;
  rootByWorkspace: Map<string, string | null>;
  activeView: ActiveViewKey | null;
  // Every open file view (any workspace): viewId → {projectId, path}
}

function snapshotSessions(s: SessionsState): SessionsSnapshot {
  const rootByWorkspace = new Map<string, string | null>();
  let activeView: ActiveViewKey | null = null;
  for (const workspace of s.workspaces) {
    rootByWorkspace.set(workspace.id, workspace.root ?? null);
    if (workspace.id === s.activeId) {
      const content = workspace.spaces.find(
        (c) => c.id === workspace.activeSpaceId,
      );
      if (content) {
        const group = allGroups(content).find(
          (g) => g.id === content.activePaneId,
        );
        const view = group?.tabs.find((v) => v.id === group.activeTabId);
        if (view) {
          activeView = {
            projectId: workspace.id,
            viewId: view.id,
            kind: view.kind,
          };
        }
      }
    }
  }
  return { activeProjectId: s.activeId, rootByWorkspace, activeView };
}

function diffSessions(prev: SessionsSnapshot, next: SessionsSnapshot): void {
  for (const [projectId, root] of next.rootByWorkspace) {
    if (!prev.rootByWorkspace.has(projectId)) {
      emitPluginEvent("workspace.created", { projectId, root: root ?? null });
    }
  }
  if (prev.activeProjectId !== next.activeProjectId) {
    emitPluginEvent("workspace.changed", {
      projectId: next.activeProjectId,
      root: next.rootByWorkspace.get(next.activeProjectId) ?? null,
    });
  }
  const a = prev.activeView;
  const b = next.activeView;
  if (b && (!a || a.projectId !== b.projectId || a.viewId !== b.viewId)) {
    emitPluginEvent("view.activated", b);
    // B3 — activation is activity too (the basis for last-used time and hydration priority).
    useSessions.getState().setViewRuntime(b.projectId, b.viewId, { lastActivity: Date.now() });
  }
}

// Module state retains subscription initialization across hot replacement.
const startedFlag = moduleState("plugins/hooks#startedFlag.on", () => ({ on: false }));

// startPluginHooks installs each store subscription once per application module state.
export function startPluginHooks(): void {
  if (startedFlag.on) return;
  startedFlag.on = true;

  // Convert the framework window lifetime event to the public plugin event.
  void currentWindow()
    .onWindowGone((windowLabel) => emitPluginEvent("window.gone", { windowLabel }))
    .catch(() => {
      // A framework without window lifetime support emits no event. Shutdown still reaps units.
    });

  // Validate terminal-surface:state before publishing the typed plugin event.
  void currentWindow()
    .listen<{ pane?: unknown; sequence?: unknown; generation?: unknown }>("terminal-surface:state", (event) => {
      const payload = terminalSurfaceStatePayload(event.payload);
      if (payload) emitPluginEvent("terminal-surface.state", payload);
    })
    .catch(() => {
      // A framework without native surface events emits no terminal surface state.
    });

  // Do not run an O(n) snapshot+diff on every store write (principles 1 and 5,
  // docs/PERFORMANCE.md) — resizeSplit writes at 60Hz+ during a drag, but these events
  // (coarse semantics: active/open changes) never change from layout ratios.
  // The coalesce is a microtask, not rAF: the diff is unrelated to rendering (principle 4's
  // rAF is for input→render alignment), and WebKit suspends rAF in an occluded window, which
  // was measured to delay events indefinitely during remote (sok/MCP) operation.
  // One synchronous burst (a resize storm etc.) collapses into a single run.
  let prevSessions = snapshotSessions(useSessions.getState());
  let diffQueued = false;
  const scheduleSessionsDiff = () => {
    if (diffQueued) return;
    diffQueued = true;
    queueMicrotask(() => {
      diffQueued = false;
      const next = snapshotSessions(useSessions.getState());
      diffSessions(prevSessions, next);
      prevSessions = next;
    });
  };
  useSessions.subscribe(() => scheduleSessionsDiff());
  // Swallow the restore delta (§5 "replay is not observation") — windowBoot calls this right after
  // boot restore is applied. The source of workspace.created firing per window, because the diff took
  // restore-created workspaces for creation (measured: automatic git.init per window + repeated "OK" readouts).
  reseedSessionsSlot.v = () => {
    prevSessions = snapshotSessions(useSessions.getState());
  };

  let prevTheme = {
    name: useTheme.getState().current,
    mode: useTheme.getState().effectiveMode,
  };
  useTheme.subscribe((state) => {
    if (
      state.current !== prevTheme.name ||
      state.effectiveMode !== prevTheme.mode
    ) {
      prevTheme = { name: state.current, mode: state.effectiveMode };
      emitPluginEvent("theme.changed", prevTheme);
    }
  });

  let prevLanguage = useSettings.getState().language;
  useSettings.subscribe((state) => {
    if (state.language !== prevLanguage) {
      prevLanguage = state.language;
      emitPluginEvent("locale.changed", { language: state.language });
    }
  });

  // B3 — PTY output is activity too (evidence from process output). Persisting is throttled to 30s
  // per pane: output is high frequency, so writing the store every time causes a save/re-render storm
  // (the live vs durable separation principle).
  // CPU/GPU usage sampling is rejected — it polls continuously, and the output event is the
  // event-based evidence for the same information.
  {
    const OUTPUT_ACTIVITY_MS = 30_000;
    const lastWrite = new Map<string, number>();
    setAnyOutputSink((paneId) => {
      const now = Date.now();
      const prev = lastWrite.get(paneId) ?? 0;
      if (now - prev < OUTPUT_ACTIVITY_MS) return;
      lastWrite.set(paneId, now);
      useSessions.getState().setViewRuntime(null, paneId, { lastActivity: now });
    });
  }

  // Terminal command start → plugin event. A discrete event, and a generic socket: the core
  // publishes what the decoder saw and reads nothing into it.
  subscribeAnyCommandStarted((paneId, commandLine, cwd) => {
    // The foreground pid used to travel with this, read from the application's own PTY daemon. A
    // shell is a unit's now: the application does not hold one, and asking a unit for it would be
    // this code knowing what unit a pane's shell came from — which is the plugin's business.
    //
    // Absent rather than invented. A consumer reading a pid of 0 or -1 would act on a process that
    // is not there.
    void (async () => {
      const pid = null;
      emitPluginEvent("command.started", {
        projectId: workspaceOfTab(paneId),
        paneId,
        commandLine,
        cwd,
        pid,
      });
      // B3 — view runtime record: the observed cwd (restore spawn location) and the activity time (the event is the evidence).
      useSessions.getState().setViewRuntime(null, paneId, {
        ...(cwd ? { cwd } : {}),
        lastActivity: Date.now(),
      });
    })();
  });

  // Terminal command end → plugin event (git view auto-refresh etc.). A discrete event, so no
  // coalesce is needed — the frequency equals how often the user finishes a command.
  subscribeAnyCommandFinished((paneId, commandLine, cwd, exitCode) => {
    const info = projectInfoOfTab(paneId);
    emitPluginEvent("command.finished", {
      projectId: info?.id ?? null,
      paneId,
      exitCode,
      commandLine: commandLine ?? null,
    });
    // B3 — cwd at the command end (a cd before it is included) and the activity time.
    useSessions.getState().setViewRuntime(null, paneId, {
      ...(cwd ? { cwd } : {}),
      lastActivity: Date.now(),
    });
    // shell provider: command end = turn.ended (source shell). Includes the finished command line,
    // cwd and exitCode (R2) for body enrichment.
    emitPluginEvent("turn.ended", {
      projectId: info?.id ?? null,
      root: info?.root ?? null,
      paneId,
      source: "shell",
      command: commandLine ?? null,
      cwd: cwd ?? null,
      exitCode,
    });
  });

  // A plugin's "turn ended" event is mirrored into the hooks channel. Core does not define a turn.
  busOn("turn.ended", (payload) => {
    if (payload && typeof payload === "object") {
      emitPluginEvent("turn.ended", payload as PluginEventMap["turn.ended"]);
    }
  });

  // Activity hub broadcast (a stream common to every window, activity.rs app.emit) → plugin event.
  // The same source as the feed the orchestrator sees — the standard entrance for activity-consuming
  // plugins (log views, readout, etc.). ownWindow = whether the entry originated in this window
  // (compares entry.payload.window) — for window-scoped filtering.
  // A global listen is correct here (it receives the app.emit broadcast) — safeListen guards a
  // missing backend and a double unlisten.
  safeListen<{ seq: number; ts: number; kind: string; source: string; payload: Record<string, unknown> }>(
    "activity",
    (e) => {
      const entry = e.payload;
      emitPluginEvent("activity", {
        ...entry,
        ownWindow: String(entry.payload?.window ?? "") === currentWindowLabel(),
      });
    },
  );

  safeListen<unknown>("process-inventory-changed", (e) => {
    const payload = processInventoryEventPayload(e.payload);
    if (payload) emitPluginEvent("process.inventory.changed", payload);
  });

  // App (this window) active → plugin event. Only "window-focus" emit_to'd to this window is received
  // (a global listen would also receive other windows' focus and fire app.focus wrongly). See the
  // lib/windowEvents header.
  listenThisWindow<boolean>("window-focus", (e) => {
    emitPluginEvent("app.focus", { focused: e.payload });
  });

  // Window live resize (edge drag) start/end → plugin event. Only "window-live-resize" emit_to'd to
  // this window is received (per-window). The core browser.rs install_live_resize_monitor sends the
  // NSWindow Will/DidEndLiveResize notifications only to that window label → each window receives
  // only its own drag (no frontend filter needed). Wiring isomorphic with window-focus → app.focus.
  listenThisWindow<boolean>("window-live-resize", (e) => {
    emitPluginEvent("window.live-resize", { active: e.payload });
  });

  // webview health transition (core webview_health emit_to) → plugin event. Only signals emit_to'd to
  // this window are received (per-window — wiring isomorphic with window-focus). No permission
  // required (non-sensitive lifecycle).
  listenThisWindow<PluginEventMap["webview.health"]>("webview-health", (e) => {
    emitPluginEvent("webview.health", e.payload);
  });
}

export function processInventoryEventPayload(
  value: unknown,
): PluginEventMap["process.inventory.changed"] | null {
  if (!value || typeof value !== "object") return null;
  const event = value as Record<string, unknown>;
  if (!Number.isSafeInteger(event.revision) || Number(event.revision) < 1
    || (event.kind !== "started" && event.kind !== "updated" && event.kind !== "ended")
    || !event.process || typeof event.process !== "object") return null;
  const process = event.process as Record<string, unknown>;
  if (typeof process.id !== "string" || process.id === ""
    || typeof process.owner !== "string" || process.owner === ""
    || !Number.isSafeInteger(process.pid) || Number(process.pid) < 1
    || !Number.isSafeInteger(process.parentPid) || Number(process.parentPid) < 0
    || typeof process.command !== "string"
    || (process.state !== "running" && process.state !== "ended")
    || !Number.isSafeInteger(process.startedAtUnixMs)
    || (["window", "pane", "cwd"] as const).some((field) => process[field] !== undefined && typeof process[field] !== "string")
    || (process.endedAtUnixMs !== undefined && !Number.isSafeInteger(process.endedAtUnixMs))) return null;
  return value as PluginEventMap["process.inventory.changed"];
}

export function terminalSurfaceStatePayload(value: {
  pane?: unknown; sequence?: unknown; generation?: unknown;
} | null | undefined): PluginEventMap["terminal-surface.state"] | null {
  if (typeof value?.pane !== "string" || !Number.isSafeInteger(value.sequence)
    || Number(value.sequence) < 0 || !Number.isSafeInteger(value.generation)
    || Number(value.generation) < 1) return null;
  return { pane: value.pane, sequence: Number(value.sequence), generation: Number(value.generation) };
}

// The workspace {id, root} of a pane. null when not found. root is a window-independent stable
// identifier (the turn.ended scope key). id is a window-local UI handle (for workspace.activate).
//
// The observation substrate's paneId = the sessions view.id of a plugin terminal view (= the paneId
// passed to app.pty.spawn). The core does not own terminal views (a terminal is a plugin view too).
function projectInfoOfTab(paneId: string): { id: string; root: string | null } | null {
  for (const t of useSessions.getState().workspaces) {
    for (const c of t.spaces) {
      for (const g of allGroups(c)) {
        for (const v of g.tabs) {
          if (v.id === paneId) {
            return { id: t.id, root: t.root ?? null };
          }
        }
      }
    }
  }
  return null;
}

// The workspace id of a pane (for places that need the id only, e.g. command.started).
function workspaceOfTab(paneId: string): string | null {
  return projectInfoOfTab(paneId)?.id ?? null;
}
