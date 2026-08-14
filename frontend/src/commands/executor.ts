// Command executor: runs the cmd-request emitted by the core socket server through the registry
// and replies with invoke(cmd_result), matched by request id. Call startExecutor() once at app start.

import { invoke as frameworkInvoke } from "../framework";
import { moduleState } from "../lib/moduleState";
import { invoke } from "../framework";
import { currentWindowLabel } from "../lib/webviewLabels";
import { listenThisWindow } from "../lib/windowEvents";
import { useSettings } from "../state/settings";
import { registerCatalog } from "./catalog";
import { registerDebugCatalog } from "./catalogDebug";
import { registerOrchestratorCatalog } from "./catalogOrchestrator";
import { registerRemoteCatalog } from "./catalogRemote";
import { registerRemoteConfirmDevCatalog } from "./catalogRemoteConfirmDev";
import { getSpec, execute, setPermissionGate } from "./registry";
import { markRuntimeReady } from "./commandObservation";
import { completeCommandReply } from "./commandReplyTransaction";
import type { CommandAfterReplyTask } from "./registry";

interface CmdRequest {
  id: number;
  method: string;
  params?: Record<string, unknown> | null;
  pane?: string | null;
  window?: string | null;
  // Correlation parent (conversation turn id) — agent env SOKSAK_PARENT → sok → socket request
  // meta. Passes through ctx and becomes the activity entry payload.parentId (turn set grouping).
  parent?: string | null;
  // Execution origin (§5) — core-internal emissions only (scheduler "schedule"). System
  // origins are not read aloud and are dimmed.
  origin?: string | null;
  // How many run this request together — when two frameworks hold the same label, both get it.
  hosts?: number | null;
}

// The "already filled" record must live **with** the registry. If only one is replaced the two
// diverge: registry only stays empty forever (core commands lost); record only dies on duplicate
// registration.
const boot = moduleState("commands/executor#boot", () => ({ started: false }));

// Boot readiness gate — delays external requests (scheduler, socket) that arrive before plugin
// activation (initPluginHost) finishes, until the completion event. Structural repair (no retries,
// no polling) of the race where a right-after-boot emission hit a plugin command not yet registered
// (or a registered handler whose dependency plugin was not yet active) and produced a fake
// UNKNOWN_COMMAND. "Wait for unregistered commands only" is not enough — it misses the case where a
// registered command's handler calls another plugin command (workflow reconcile → kanban). Waiting
// for everything is the correct semantics.
// Outside the hot-swap boundary — when these values are replaced, the "already done" record and
// the lazy-init and unsubscribe slots go with them, and the filling side does not fill again.
const ms = moduleState("commands/executor#state", () => ({
  hostReady: false,
  resolveFrameworkReady: undefined as (() => void) | undefined,
}));
const hostReadyGate = new Promise<void>((resolve) => {
  ms.resolveFrameworkReady = resolve;
});

/** Plugin host activation complete signal — main.tsx calls it once right after initPluginHost(). */
export function markCommandHostReady(): void {
  ms.hostReady = true;
  // Declare wiring complete — after this, missing observation wiring is a defect, not a "not yet",
  // and the response reports it as such.
  markRuntimeReady();
  ms.resolveFrameworkReady?.();
}

/**
 * Waits **from outside** for plugin boot to finish.
 *
 * Even when the workspace boot phase answers ready, plugin bodies are still running — the two are
 * different facts, and asking for different facts under one name misses the stamp that lands
 * afterwards, producing "never measured" (measured 2026-08-08). No re-polling: resolve immediately
 * if the fact already passed, otherwise block on that event.
 *
 * Refuses past the timeout. Answering "ready" for something never waited on makes the caller
 * decide on a fact that does not exist.
 */
export function awaitCommandHostReady(timeoutMs: number): Promise<{ ready: true }> {
  if (ms.hostReady) return Promise.resolve({ ready: true as const });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(tmsg("msg.plugin.boot.wait.timeout", { ms: timeoutMs }))),
      timeoutMs,
    );
    void hostReadyGate.then(() => {
      clearTimeout(timer);
      resolve({ ready: true as const });
    });
  });
}

export function startExecutor(): void {
  if (boot.started) return;
  // Command reception took a measured 10 s to open, and nothing measured that interval
  // (2026-08-08). Now the machine answers where the time goes between catalog registration and
  // listener installation.
  const executorAt = performance.now();
  const executorStep = (name: string) => {
    // The webview console is unreadable over the socket — put it on the activity ledger so the
    // machine answers (same axis as boot.step).
    void frameworkInvoke("activity_publish", {
      kind: "boot.step",
      source: "boot",
      payload: {
        step: `executor:${name}`,
        message: `· executor ${name} +${(performance.now() - executorAt).toFixed(0)}ms`,
      },
    }).catch(() => {});
  };
  boot.started = true;
  registerCatalog();
  // Remote confirm desktop human gate (remote.confirm) — the live command the remote-iroh sidecar
  // delegates destructive decisions to. Authority (PendingConfirms, tokens) stays in the sidecar;
  // only the human decision happens in the core modal.
  registerRemoteCatalog();
  // Dev-only mock commands (zero registrations in the production bundle) — headless verification of
  // the confirm modal without a live phone.
  registerRemoteConfirmDevCatalog();
  // Dev-only debug.* — held-reply (debug.sleep) for scheduler process_lease e2e verification.
  // Zero in production.
  registerDebugCatalog();
  // The natural-language console (orchestrator.*) is control plane (main) only — it is a capability
  // that does not exist in workspace windows (UNKNOWN_COMMAND is the correct answer). The socket
  // targets it explicitly with --window main.
  if (currentWindowLabel() === "main") registerOrchestratorCatalog();
  // Permission gate: reads the per-danger-class policy from the settings store and resolves
  // allow/deny.
  setPermissionGate((danger) => {
    const s = useSettings.getState();
    const policy =
      danger === "destructive" ? s.remoteDestructive : s.remoteInject;
    if (policy === "deny") {
      console.warn(`[permission] remote ${danger} command blocked (policy: deny)`);
      return false;
    }
    return true;
  });
  // Accept only cmd-requests emit_to'd at this window (a global listen would also receive
  // emit_to(other window), running the command twice across two windows → per-window independence
  // collapses). See the lib/windowEvents header.
  executorStep("catalog-registered");
  // One request runs once — anything arriving between listener installation and the drain of
  // pending deliveries can come by both paths. The delivery side has no record of what already ran,
  // so this is the only place to decide (a side effect that happens twice cannot be undone).
  const served = new Set<number>();
  const subscription = listenThisWindow<CmdRequest>("cmd-request", async (e) => {
    const { id, method, params, pane, window, parent, origin, hosts } = e.payload;
    if (served.has(id)) return;
    served.add(id);
    // Host not ready = plugin activation in progress. The gate stops **unregistered commands only**
    // — holding already-registered core commands (state.tree etc.) too pushes the socket reply
    // behind plugin activation (measured 2.5s) even though restore finished at 231ms (this gate was
    // the last bottleneck against the 300ms restore target). Unregistered commands wait for
    // completion — if still unregistered after that, the UNKNOWN_COMMAND is real.
    if (!ms.hostReady && getSpec(method) === undefined) await hostReadyGate;
    // Via socket = remote (AI/CLI) call → subject to the permission gate. window is this window's
    // own label (routing check and command context).
    const afterReply: CommandAfterReplyTask[] = [];
    const result = await execute(method, params ?? {}, {
      pane: pane ?? undefined,
      remote: true,
      window: window ? { label: window } : undefined,
      parent: parent ?? undefined,
      origin: origin ?? undefined,
      hosts: hosts ?? undefined,
      afterReply: (task) => afterReply.push(task),
    });
    await completeCommandReply(
      () => invoke("cmd_result", { id, result }),
      afterReply,
      (err) => console.error("cmd_result reply failed:", err),
    );
  });
  // Drain deliveries that arrived before the listener stood up. `emit_to` succeeds as long as the
  // window exists, so that event vanishes silently and the sender waits out the reply timeout
  // (10s) — measured 2026-08-08: 9.4 s of an 11.7 s boot was one command's timeout.
  //
  // Signal **only after listening has actually begun**. Signaling right after registration starts
  // sends the drained envelope to a listener that is not there yet, and it vanishes the same way
  // (measured: 1 drained, and that command still hit TIMEOUT at 10.002 s).
  void subscription.ready.then(async () => {
    executorStep("listener-installed");
    const resent = await frameworkInvoke<number>("cmd_listener_ready", {
      window: currentWindowLabel(),
    }).catch((err) => `failed:${String(err)}`);
    executorStep(`pending-drained:${resent}`);
  });
}
