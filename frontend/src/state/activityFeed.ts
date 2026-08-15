// Activity feed producer (A1) — publishes this window's execution facts to the core hub (activity.rs).
// Family 1: plugin events (command.started/finished, turn.ended, view.activated) — terminal and AI turns.
// Family 2: command registry execute instrumentation (CommandTrace) — every command the orchestrator issues.
// The hub assigns seq/ts, broadcasts to all windows, and persists, so this file only publishes.

import { ledgerOf, notePublish, stampOf } from "./activityHealth";
import { invoke } from "../framework";
import { currentWindowLabel } from "../lib/webviewLabels";
import { onPluginEvent } from "../plugins/hooks";
import { setCommandTraceSink } from "../commands/commandObservation";
import { tmsg } from "../i18n";

/** Hub publish (window label attached automatically) — shared by core producers (this file's
 *  instrumentation plus the orchestrator conversation set). */
export function publishActivity(
  kind: string,
  source: string,
  payload: Record<string, unknown>,
): void {
  void invoke("activity_publish", {
    kind,
    source,
    payload: { ...payload, window: currentWindowLabel() },
  })
    .then((reply) => {
      // Only a stamp means it landed — a resolved call alone does not prove a ledger record.
      const seq = stampOf(reply);
      if (seq === null) {
        notePublish(false, Date.now(), tmsg("msg.health.activity.noStamp"));
        return;
      }
      notePublish(true, Date.now(), undefined, seq, ledgerOf(reply));
    })
    .catch((e: unknown) => {
      // A hub that cannot serve (test harness and such) does not block live behavior — but it is
      // **counted**. Not blocking and not recording the fact are different: a swallowed failure
      // stays silent even when publishing is cut off entirely, and from outside it took two ledger
      // queries and a timestamp comparison to detect (measured 2026-07-31).
      notePublish(false, Date.now(), e instanceof Error ? e.message : String(e));
    });
}
const publish = publishActivity;

/** Once at boot — connects the event subscriptions and the registry instrumentation sink to the hub. */
export function startActivityFeed(): void {
  // The producer owns its display sentence (message) and spoken text (speak), as commands do — the
  // consumer has no knowledge of kind. Terminal command activity is owned by the terminal plugin
  // (app.activity.publish with its own i18n) — core does not bridge command.started/finished. What
  // remains here is the core domain (turn detection, view management, generic progress relay,
  // registry instrumentation), and those sentences are in core i18n (activity.*).
  onPluginEvent("turn.ended", (p) => {
    publish("turn.ended", p.source, {
      paneId: p.paneId,
      command: p.command,
      message: tmsg("activity.turn.ended") + (p.command ? ` — ${p.command}` : ""),
    });
  });
  onPluginEvent("view.activated", (p) =>
    publish("view.activated", "ui", {
      projectId: p.projectId,
      viewId: p.viewId,
      message: tmsg("activity.view.activated", { viewId: p.viewId }),
    }),
  );
  // Progress delta (between request and response) — when a consuming plugin publishes sidecar events
  // or AI thinking as command.progress, it is added to the activity stream (MESSAGE-PROTOCOL.md §2).
  // Same idea as textdelta.
  onPluginEvent("command.progress", (p) => {
    const command = (p as { command?: string }).command;
    const delta = (p as { delta?: unknown }).delta;
    publish("command.progress", (p as { source?: string }).source ?? "plugin", {
      command,
      delta,
      message: `⋯ ${command ? `${command}: ` : ""}${delta ?? ""}`,
    });
  });
  // Registry instrumentation (P12 proper) — params arrives as a key list only (registry summarizes).
  // Opting out is declared by spec.trace === false (registry skips the sink call entirely).
  setCommandTraceSink((t) => {
    publish("command.executed", t.source, {
      command: t.command,
      title: t.title,
      danger: t.danger,
      paramKeys: t.paramKeys,
      ok: t.ok,
      code: t.code,
      message: t.message,
      durationMs: t.durationMs,
      startedAt: t.startedAt,
      finishedAt: t.finishedAt,
      media: t.media,
      speak: t.speak,
      parentId: t.parentId,
      origin: t.origin,
    });
  });
}
