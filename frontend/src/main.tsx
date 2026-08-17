import { initSectionSetsPersistence } from "./state/sectionSets";
import ReactDOM from "react-dom/client";
import {
  installFramework,
  resolveWindowLabel,
  presentWindow,
  resetNativeSurfaces,
  invoke as bootInvoke,
  emitLocal,
  listen,
} from "./framework";
import { bootFactPayload } from "./lib/bootFact";
import { setWindowBackgroundSink } from "./theme/engine";
// Boot error observation (covers the P12 blind spot) — when a render/module error blanks the screen, neither
// snapshot nor DOM shows the cause. Global errors are published to the activity hub (boot.error) so the boot
// crash message and stack are readable from socket activity.recent alone. Installed at the very top, before React mounts.
if (typeof window !== "undefined") {
  const reportBootError = (msg: string, stack: string) =>
    void bootInvoke("activity_publish", {
      kind: "boot.error",
      source: "boot",
      // Boot crash path (before stores are ready) — language-neutral without i18n (punctuation + raw error). Self-description §3.
      payload: { msg, stack, message: `⚠ ${msg}` },
    }).catch(() => {});
  window.addEventListener("error", (e) =>
    reportBootError(String(e.message), String((e.error && e.error.stack) || "")),
  );
  window.addEventListener("unhandledrejection", (e) =>
    reportBootError("reject: " + String(e.reason), String((e.reason && e.reason.stack) || "")),
  );
}
import App from "./App";
import { markCommandHostReady, startExecutor } from "./commands/executor";
import { catalogJson, execute, onRegistryChange } from "./commands/registry";
import { installControlDoor } from "./framework/wails/controlDoor";
import {
  declareRendererCommands,
  installRendererDoor,
  type RendererDeclaration,
} from "./framework/wails/rendererDoor";
import { loadCliName } from "./lib/cliIdentity";
import { startWebviewGc } from "./lib/webviewGc";
import { initPluginHost } from "./plugins/host";
import { initNotify } from "./lib/notify";
import { currentWindowLabel } from "./lib/webviewLabels";
import { onBootCacheDiscarded } from "./state/coreStore";
import { claimRoots } from "./state/workspaceRegistry";
import { recordRecentWorkspace } from "./state/recentWorkspaces";
import { useSessions } from "./state/sessions";
import { daemonOnWorkspaceOpen } from "./commands/catalogDaemon";
import { initSkillRefresh } from "./state/skillRefresh";
import {
  initWorkspacePersistence,
  respawnSavedWindows,
  initControlPlaneFrame,
  coreStoreDeps,
} from "./state/windowBoot";
import { initWindowTitle } from "./state/windowTitle";
import { installSwapObserver, installInputObserver } from "./lib/motionDebug";
import { installErrorLedger } from "./lib/errorLedger";
import { beginBootPluginEventBuffer, flushBootPluginEvents } from "./plugins/hooks";
import { useBootPhase } from "./state/bootPhase";
import { initViewLabelsPersistence } from "./state/viewLabels";
import { initSettingsPersistence } from "./state/settings";
import { initThemePersistence } from "./state/theme";
import { initPluginSettingsPersistence } from "./state/pluginSettings";
import { initPluginsPersistence } from "./state/plugins";
import { initRegistryPersistence } from "./state/registry";
import { startActivityFeed } from "./state/activityFeed";
import { OrchestratorApp } from "./orchestrator/OrchestratorApp";
import "./assets/fonts.css";
import { applySavedWindowZoom } from "./lib/zoomIntent";
import { tmsg } from "./i18n";

// Terminal spawn options (cwd/shell/autorun command) come from the terminal plugin, not the core —
// the plugin view spawns directly on mount with PluginViewContext (root/command) and its own setting (shell).

// AI command interface: catalog registration + socket request executor (once per app lifetime).
startExecutor();

// The door from outside to this window's commands. There is one registry and this is the transport in front of it —
// a build without the door cannot be verified from outside, and "there was no command to call" is not a reason.
installControlDoor({ scope: globalThis as never, execute, catalog: catalogJson });
// Reclaims browser child webviews left after the parent window closed (invariant check — event-driven, no polling).
startWebviewGc();
// Terminal foreground command (shell integration OSC event) → that view's running status (M5, no polling).
// Activity feed (A1) — publishes this window's event and registry execution instrumentation to the core hub (P12).
startActivityFeed();

// Boot (P3): prepare the first workspace root (~/.soksak/workspaces/workspace1), then render —
// a workspace without a root cannot exist (P1), so the app starts after the root is ready.
// Order guarantee: the plugin host (re-activating consented plugins) comes first — events
// (workspace.created etc.) must fire after listeners are registered, or they are lost
// (the cause of the incident where the first workspace's git init was lost in a new environment).
// Render proceeds even on failure (0 workspaces = the exception state of boot failure alone, reason to the console).
// Boot step stamps — the observation surface for blank-screen diagnosis. ① document.title (IPC-independent — while
// the webview is alive it is readable from outside as the CGWindowList window name) ② activity hub boot.step (over
// IPC — persisting to records proves IPC is alive). The difference between the two channels is the verdict: title advancing alone means IPC is dead.
const initialTitle = typeof document !== "undefined" ? document.title : "";
function bootStamp(step: string): void {
  try {
    document.title = `boot:${step}`;
  } catch {
    /* non-DOM test */
  }
  void bootInvoke("activity_publish", {
    kind: "boot.step",
    source: "boot",
    payload: bootFactPayload(step),
  }).catch(() => {});
}

// Declares the commands this window answers to the backend registry — that is how `sok ui.tree` works with no window.
// Called after the command host is ready: reading before that declares a catalog missing every plugin command,
// and a missing name looks like "no such command" from outside.
// The catalogue this window answers, as the backend has to receive it.
const declaredNames = () => catalogJson().map((entry) => entry.name);

/**
 * Keeps the backend's delegation table equal to this window's registry.
 *
 * The declaration used to be sent only at the end of boot, so a plugin enabled afterwards
 * registered a command the window answered and the socket refused — measured 2026-08-16, with
 * plugin.conformance counting the command as registered while sok called it unknown. §3.5 has one
 * registry; two that disagree is the drift it forbids.
 *
 * Subscribed rather than called at each lifecycle site, so the fourth site nobody has written yet
 * cannot forget.
 */
function followRegistryWithDeclaration(): void {
  onRegistryChange(() => {
    void declareRendererCommands({
      emit: (event, payload) => emitLocal(event, payload),
      names: declaredNames,
    }).catch((e) => console.error("re-declaring the command catalogue failed:", e));
  });
}

async function declareCommandsToBackend(): Promise<void> {
  await installRendererDoor({
    names: declaredNames,
    emit: (event, payload) => emitLocal(event, payload),
    listen: async (event, handler) => {
      await listen<RendererDeclaration>(event, (received) => handler(received.payload));
    },
    onPageHide: (run) => window.addEventListener("pagehide", run),
    // The receipt goes to the ledger — a refusal (another window already answers that name, this process
    // answers it directly) left in the console alone cannot be read from outside.
    report: (declaration) => {
      void bootInvoke("activity_publish", {
        kind: "renderer.commands",
        source: "renderer",
        payload: {
          ...declaration,
          message: `· ${tmsg("msg.renderer.commands", {
            window: declaration.window,
            held: declaration.held.length,
            refused: declaration.refused.length,
          })}`,
        },
      }).catch(() => {});
    },
  });
}

// Boot complete — restores the title so no stamp remains (initWindowTitle takes over after this).
//
// The document is also told, because the boot script reads that attribute to decide what an
// unhandled error means: while it reads "loading", any error is a boot failure and raises the
// failure screen. Nothing ever set it past "loading", so a throw an hour into a session was
// reported as a start that never happened — measured 2026-08-17, `<html>` carried
// data-boot-status="failed" while the application was running, and the failure screen's own
// selector then styled the document element and inset the whole window by its 40px padding.
function bootDone(): void {
  try {
    document.title = initialTitle;
    document.documentElement.dataset.bootStatus = "ready";
  } catch {
    /* non-DOM test */
  }
}

async function boot(): Promise<void> {
  // Moves the time the document started executing into the ledger — before it is the webview coming up, after it
  // is the bundle running. As one lump, which side to fix is unknown.
  const documentStart = (globalThis as { __soksakDocumentStart?: number }).__soksakDocumentStart;
  if (typeof documentStart === "number") {
    void bootInvoke("activity_publish", {
      kind: "boot.step",
      source: "boot",
      payload: bootFactPayload("document-start", { atUnixMs: documentStart }),
    }).catch(() => {});
  }
  bootStamp("module-loaded"); // the point the whole module graph finished running — before it is webview load time
  installErrorLedger(); // error ledger — first thing in boot (no later exception can stay silent)
  // A boot cache this build could not read is a defect, not a first run, and the two are fixed in
  // different places. Reported as they happen rather than drained once: the reads that matter most
  // are during restore, which is later than any single drain point would be.
  onBootCacheDiscarded((lsKey, why) => bootStamp(`cache-discarded:${lsKey}:${why}`));
  // The chosen framework installs its own parts — implementations, devices, styles. Not enumerated here.
  // Must be first in boot: with no content view implementation installed, a plugin opening a view is refused with the name.
  // Read the window name first. This value is cached and becomes the first address segment, so reading it late
  // freezes an empty label first and every later address becomes `win//...` — the creating side and the resolving
  // side then point at different windows, and that mismatch appears only as NOT_EXPOSED (measured 2026-08-15).
  const resolvedLabel = await resolveWindowLabel();
  // Records what this window resolved itself to be. This one value selects the orchestrator/workspace branch, so
  // without the record there is no way from outside to ask "why did this window render that shell" —
  // measured 2026-08-15: the main window rendered the workspace shell, and a person reported the cause from the screen.
  bootStamp(`window-name:${resolvedLabel}`);
  // The window background follows the theme bg. The root DOM is transparent, so the window supplies the color of
  // unpainted areas; a window stuck at a build-time constant diverges from the theme at every edge — measured
  // 2026-08-15: the theme was light while the window was near black, and the translucent background showed the desktop behind it.
  setWindowBackgroundSink((color) => {
    void bootInvoke("window_set_background", { color });
  });
  await installFramework();
  bootStamp("enter");
  // Caches this app's CLI name (sok/sok-dev/sok-debug) before the window kind branch — app-global identity, so
  // both the orchestrator (main) and workspaces (w-*) need it (single source for hint prefixes and agent spawn).
  // On failure it falls back to sok (absorbed internally). A prerequisite, not a gate, so it does not block render.
  await loadCliName();
  bootStamp("cli-name");
  // Syncs core persisted state (settings, theme, plugin settings, plugin consent/enabled) with app.data
  // authority + multi-window broadcast (coreSync). The synchronous initial state is already loaded from the ls
  // cache — here it starts app.data hydrate + subscription to other windows' changes. Before the plugin host (which consumes enabledIds).
  try {
    initSettingsPersistence(coreStoreDeps);
    initThemePersistence(coreStoreDeps);
    initPluginSettingsPersistence(coreStoreDeps);
    initSectionSetsPersistence(coreStoreDeps);
    initPluginsPersistence(coreStoreDeps);
    initRegistryPersistence(coreStoreDeps);
    initViewLabelsPersistence(coreStoreDeps);
  } catch (e) {
    console.error("core persistence sync init failed:", e);
  }
  // Control plane (A3) — main is the orchestrator's reserved name (NAMING 4b): the platform bootstrap window is
  // the control plane, and every workspace is a w-<uuid> window. Branches after core persistence (theme, settings)
  // and renders the shell only. The shell consumes command and event surfaces alone (same standing as an external client — P13).
  // Command catalog and activity instrumentation are module-level. Respawn (every workspace slot) is handled here too.
  bootStamp("persist-init");
  // The branch stands only on a resolved label. If resolveWindowLabel could not read the name it already stopped
  // above, so at this point label is the name this host actually answered.
  const windowLabel = currentWindowLabel();
  if (windowLabel === "main") {
    // The plugin host is not run — the registry is already final, so the readiness gate is released immediately
    // (left locked, an unregistered command sent to this window waits until timeout).
    markCommandHostReady();
    try {
      await declareCommandsToBackend();
      followRegistryWithDeclaration();
    } catch (e) {
      console.error("command catalog declaration failed:", e);
    }
    bootStamp("main-ready");
    // Fixes the hidden native window's final position and size first. Restoring after the first visible frame
    // makes the whole window jump once even when the traffic lights and the DOM agree.
    await initControlPlaneFrame();
    bootStamp("control-frame");
    void respawnSavedWindows();
    ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
      <OrchestratorApp />,
    );
    bootStamp("render");
    await applySavedWindowZoom();
    bootStamp("zoom");
    await presentWindow();
    bootStamp("presented");
    bootDone();
    return;
  }
  // The screen comes first — queueing the first paint behind plugin activation (measured 2.46s of a 2.5s boot —
  // 46 sequential) leaves the person looking at an empty window for that time. The layout skeleton renders without
  // plugins (unregistered view = placeholder contract, PluginViewHost), and slots fill as activations arrive.
  // The ordering contract is unchanged: restore (firing workspace.created) still comes after the plugin host —
  // no recurrence of the incident where firing before listener registration lost events (git init never ran).
  beginBootPluginEventBuffer(); // boot-window fires go to a queue — flush at the end of boot (after every subscriber is in place)
  useBootPhase.getState().setPhase("restoring");
  // The previous session's child webviews are backend-owned and survive a renderer reboot (reload) — left alone,
  // the old browser shows over the empty pre-restore screen (real incident: Example Domain over an empty window,
  // user measurement 2026-07-27). Early in boot, hide every child of this window — the restore render re-shows
  // only the active views (commitViewVisibility — a new context means an empty map, which guarantees re-publish).
  await resetNativeSurfaces();
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <App />,
  );
  await applySavedWindowZoom();
  await presentWindow();
  bootStamp("render");
  installSwapObserver(); // swap (parking↔appearance) observation — once over the whole document after render
  // Surface audit and DOM holes are not installed here — both matter only when content is outside the document,
  // and that framework installs them itself (in its adapter's install).
  installInputObserver(); // input fire observation (gesture→activation causal chain)
  // Programmatic open (window.new{root}) — the window creator passes boot instructions as a URL query
  // (the only channel across per-window JS context isolation). An instruction outranks restore: the user intent is
  // "that workspace in this window". On claim failure (create↔boot race) it degrades to empty state (the notice points at the orchestrator).
  const bootParams = new URLSearchParams(window.location.search);
  const initRoot = bootParams.get("root");
  if (initRoot) {
    // A boot instruction is consumed once — left in the URL, window.reload (renderer reboot = restore path) takes
    // this branch again and discards the saved session (measured: 0 tabs after reload — restore-load harness).
    // Clearing is immediate (on entering the branch): a reload during open does not re-apply the instruction.
    {
      const clean = new URL(window.location.href);
      clean.searchParams.delete("root");
      clean.searchParams.delete("alias");
      window.history.replaceState(null, "", clean.toString());
    }
    try {
      const denied = await claimRoots([initRoot]);
      if (!denied.has(initRoot)) {
        const initAlias = bootParams.get("alias") ?? "";
        useSessions.getState().bootstrapFirstWorkspace(initRoot, { alias: initAlias });
        void recordRecentWorkspace(initRoot, initAlias); // recent list (explicit open)
      } else {
        console.warn(`[P6] the instructed workspace is open in another window — degraded to empty state: ${initRoot}`);
      }
    } catch (e) {
      console.error("instructed workspace boot failed:", e);
    }
  }
  // Restores the persisted workspace (layout, tabs, splits) first (A5). With a restore present, default boot is skipped.
  // The restore's roots are paths validated in the previous session — if absent, that workspace view opens empty and
  // the user cleans it up (no fs validation here blocks the whole restore). The autosave subscription starts here too.
  // (With a tab already created from initRoot, restoreWorkspaces is an idempotent no-op — only the autosave subscription starts.)
  try {
    await initWorkspacePersistence();
  } catch (e) {
    console.error("workspace persistence init failed:", e);
  }
  // The point where restore becomes a fact on screen — the plugin host comes after this (restore is 300ms).
  // Before, the host (2.3s measured total plugin activation) blocked restore (4ms) and left 3s of empty screen.
  // The event-loss contract that ordering used to cover is now covered by the boot event buffer (hooks.flushBootPluginEvents).
  bootStamp("restore-visible");
  useBootPhase.getState().setPhase("activating");
  // First-paint approximation — the frame after the render commit. Lower bound of when a person feels "the screen came up".
  // (rAF is paused for an occluded window, so this stamp may not arrive — measure timing on a foreground window.)
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      bootStamp("painted");
    });
  });
  bootStamp("plugin-body:begin");
  try {
    await initPluginHost();
  } catch (e) {
    console.error("plugin host init failed:", e);
  }
  bootStamp("plugin-body:end");
  // Releases the boot readiness gate — unregistered (plugin) command requests that arrived earlier and waited now run.
  // Released even when exiting through a failure (a permanently locked gate kills remote requests by timeout only).
  markCommandHostReady();
  try {
    await declareCommandsToBackend();
    followRegistryWithDeclaration();
  } catch (e) {
    console.error("command catalog declaration failed:", e);
  }
  // Notification click (OS) and external/cold-start deep link routing — once, after the command registry and plugins are ready.
  try {
    await initNotify();
  } catch (e) {
    console.error("notification/deep-link init failed:", e);
  }
  // Native window title = active workspace (Dock window list and Mission Control distinction — measured: every window
  // showed the same app name). A display-only subscription, unrelated to autosave.
  void initWindowTitle();
  // Workspace daemon open hook — after reclaiming recorded leftover pids, auto-starts only the daemons the user allowed
  // (finding a Procfile alone runs nothing — security contract). A failure does not block boot.
  {
    const root = useSessions.getState().workspaces.find((t) => t.id === useSessions.getState().activeId)?.root;
    if (root) void daemonOnWorkspaceOpen(root);
  }
  // Skill write-through — regenerates SKILL.md when the active plugin set changes (P8).
  initSkillRefresh();
  // Sidebar projection tracking (A8, R1) — observes the binding through the session active chain subscription and
  // fires projection.changed. Once per window.
  // Respawn and first-run bootstrap are the control plane's (main) — a workspace window is responsible only for its
  // own restore (snapshot or initRoot), and with neither it starts in the empty state (exception).
  // StrictMode off: in dev, double-run effects would run plugin mount / PTY spawn twice and briefly create
  // duplicate sessions (dev behavior kept simple).
  // Boot event buffer replay — once, after every core subscriber and plugin hook is in place (FIFO). Delivery timing
  // here matches the old "host → restore" order — nothing lost, nothing fired early.
  flushBootPluginEvents();
  // Engine host return — the symmetric half of the load-start hide (which blocks reboot ghosts). With plugin
  // activation and event replay done, this is the first point where surface state is aligned.
  useBootPhase.getState().setPhase("ready");
  bootStamp("boot:done");
  bootDone();
}

void boot();
