// Observation of command execution — the trace sink, the totals, the wiring-complete declaration,
// the persistence state, and the verdict those four produce.
//
// Why it is split from the registry: the registry is "what can be called" and this is "whether
// that execution is visible". The two axes do not grow together — registration happens once at
// boot, observation on every execution.
//
// The verdict needs **one number** from the registry, so it arrives as an argument. That keeps
// this file free of any reference to the registry, and the registry free of the inside of
// observation.

import { dataChangeHealth } from "../state/dataChangeHealth";
import { activityHealth } from "../state/activityHealth";
import { moduleState } from "../lib/moduleState";
import type { CommandTrace } from "./registry";

// Health of the tracing — **when tracing dies, that fact is not traced either.** So it is counted
// separately.
//
// Measured 2026-07-31: commands answered normally while nothing accumulated in the activity
// ledger. From outside there was no way to ask whether the sink was attached or when the last
// trace was emitted, so the ledger was queried twice and the timestamps compared — that is manual
// work, not a diagnosis. The state survives a hot swap.

/** The trace sink — whether it is attached. It is wiring, with a lifetime different from the two
 *  axes below. */
const traceSink = moduleState("commands/registry#traceSink", () => ({
  fn: null as ((t: CommandTrace) => void) | null,
}));

/** Trace totals — how many were emitted. The count continues across a sink swap. */
const traceCount = moduleState("commands/registry#traceCount", () => ({
  emitted: 0,
  lastEmitAt: 0,
}));

/**
 * The wiring-complete declaration — **the point at which a verdict is allowed**.
 *
 * Before boot states "everything is attached", a missing installation is not a defect (attaching
 * is still in progress, or it is a harness with this part turned off). A verdict without this
 * signal makes a booting app and a broken app look the same.
 */
const runtime = moduleState("commands/registry#runtime", () => ({
  ready: false,
}));

const persistBox = moduleState("commands/registry#persistStats", () => ({
  v: null as Record<string, number> | null,
}));

/** Boot declares the wiring finished — missing wiring after this is a defect. */
export function markRuntimeReady(): void {
  runtime.ready = true;
}

/**
 * Stores the persistence state — the frontend cannot read the core-side counters directly.
 *
 * A publish getting stamped and that entry remaining in the ledger are different facts. A failed
 * write goes into the recovery queue, and with nowhere counting it, the outside sees only "publish
 * succeeded" in the meantime (measured 2026-07-31: 63 entries could not be told apart as lost or
 * pending).
 */
export function noteActivityPersist(stats: Record<string, number>): void {
  persistBox.v = stats;
}

export function setCommandTraceSink(fn: ((t: CommandTrace) => void) | null): void {
  traceSink.fn = fn;
}

/** One trace — increments the totals and sends it to the sink when one is attached. */
export function emitTrace(t: CommandTrace, at: number): void {
  traceCount.emitted += 1;
  traceCount.lastEmitAt = at;
  traceSink.fn?.(t);
}

// A dead axis is stated by **every response** — a fact that takes a separate question never gets
// asked.
//
// Measured 2026-07-31: activity publishing was cut off while the app answered commands fine.
// Finding that out took querying the ledger twice and comparing the latest timestamps. Whatever
// the querying side asked for, a limping core must be stated in that answer.
/** The audit answered by the ledger owner — with two processes writing the store, the verdict is
 *  half a verdict without it. */
const ledgerBox = moduleState("commands/commandObservation#ledgerBox.v", () => ({
  v: null as Record<string, unknown> | null,
}));

export function noteLedgerAudit(audit: Record<string, unknown> | null): void {
  ledgerBox.v = audit;
}

export function degradedAxes(registeredCount: number): string[] | undefined {
  const bad: string[] = [];
  const a = activityHealth();
  if (!runtime.ready) return undefined;
  if (a.attempts === 0) {
    // 0 attempts is not "healthy", it is **unconfirmed**. Silencing it makes a window with the
    // publish wiring missing entirely look like a working window — the two faces of 0 are
    // separated here too.
    bad.push(tmsg("msg.health.activity.neverAttempted"));
  } else if (a.ledgerSwitches > 0) {
    // One window's publishing split across two ledgers — neither one holds all of that window.
    bad.push(
      tmsg("msg.health.activity.ledgerSwitched", {
        n: a.ledgerSwitches,
        ledger: a.ledger || tmsg("msg.health.activity.ledgerUnnamed"),
      }),
    );
  } else if (a.stampRegressions > 0) {
    // A stamp going backwards = the answering ledger changed or the resume point was lost.
    // Loading in that state overwrites existing rows (ON CONFLICT DO UPDATE), so the past is
    // destroyed silently.
    bad.push(
      tmsg("msg.health.activity.stampRegressed", {
        n: a.stampRegressions,
        seq: a.lastStamp,
      }),
    );
  } else if (!a.healthy) {
    bad.push(
      tmsg("msg.health.activity.publishFailing", {
        n: a.consecutiveFailures,
        failed: a.failed,
        attempts: a.attempts,
        tail: a.lastError ? ` — ${a.lastError}` : "",
      }),
    );
  }
  if (registeredCount === 0) bad.push(tmsg("msg.health.commands.registryEmpty"));
  // Facts from the ledger owner — with this process intact but the other side blocked, the ledger
  // does not grow.
  if (ledgerBox.v) {
    const reg = Number(ledgerBox.v.time_regressions ?? 0);
    if (reg > 0) {
      bad.push(
        tmsg("msg.health.activity.timeRegression", {
          n: reg,
          seq: String(ledgerBox.v.first_regression_seq),
        }),
      );
    }
    const lp = (ledgerBox.v.persist ?? {}) as Record<string, number>;
    if ((lp.failures ?? 0) > 0 || (lp.pending ?? 0) > 0) {
      bad.push(
        tmsg("msg.health.activity.ownerWriteBlocked", {
          failures: lp.failures ?? 0,
          pending: lp.pending ?? 0,
          tail: lp.lastError ? ` — ${String(lp.lastError).slice(0, 80)}` : "",
        }),
      );
    }
  }
  // A missing sink is not "quiet", it is a defect — every execution in this window disappears from
  // the ledger.
  if (!traceSink.fn) bad.push(tmsg("msg.health.commands.traceSinkMissing"));
  // When persistence falls behind, an entry is stamped but not in the ledger — that gap shows up
  // only on a query, and whoever queries has no reason to expect it. The response states it first.
  if (persistBox.v && ((persistBox.v.pending ?? 0) > 0 || (persistBox.v.failures ?? 0) > 0)) {
    bad.push(
      tmsg("msg.health.activity.persistBehind", {
        pending: persistBox.v.pending ?? 0,
        failures: persistBox.v.failures ?? 0,
        drops: persistBox.v.drops ?? 0,
      }),
    );
  }
  return bad.length > 0 ? bad : undefined;
}

export function commandHealth(registeredCount: number): Record<string, unknown> {
  return {
    persist: persistBox.v ?? { unknown: 1 },
    ready: runtime.ready,
    commands: {
      registered: registeredCount,
      traceSinkInstalled: traceSink.fn !== null,
      emitted: traceCount.emitted,
      lastEmitAt: traceCount.lastEmitAt,
    },
    activity: activityHealth(),
    dataChange: dataChangeHealth(),
    degradedAxes: degradedAxes(registeredCount) ?? [],
  };
}
