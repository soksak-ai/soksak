// Health of activity publishing — stops it from dying silently.
//
// The publish site swallowed failures (`.catch(() => {})`). The intent was to not block live
// operation, and that call is right, but **not blocking and not recording the fact are
// different**. Swallowed failures were not even counted, so publishing could stop while the app
// still answered commands normally, with no way to tell from outside.
//
// Measured (2026-07-31): hub publishing stopped at 16:54:27. It took a person querying the ledger
// twice and comparing the latest timestamps to find out — that is manual work, not diagnostics.
// One machine query must answer it.
//
// The state survives a hot swap (moduleState) — if the observation state disappears at the exact
// moment observation stops, nothing is left.

import { moduleState } from "../lib/moduleState";

/** Consecutive failures at this count mean unhealthy. A single failure can be transient. */
export const UNHEALTHY_AFTER = 2;

interface Counters {
  attempts: number;
  ok: number;
  failed: number;
  consecutiveFailures: number;
  lastOkAt: number;
  lastFailAt: number;
  lastError: string;
  /** Last admission stamp received (seq). Comparing it with the hub ledger seq separates who stamped it. */
  lastStamp: number;
  /**
   * How many times the stamp went backwards — ledger seq increases monotonically (the id is
   * `a{seq:016}`, so lexical order is time order). Going backwards means the answering ledger
   * changed or the resume point was lost, and admission then **overwrites** existing rows
   * (PERSIST_SQL uses ON CONFLICT DO UPDATE). Silent destruction of the past, so it must surface
   * under a name.
   */
  stampRegressions: number;
  /**
   * Name of the ledger that answered last. **When two ledgers each increase monotonically, seq
   * alone makes both look normal** — which ledger a write went to is settled only by the ledger
   * stating its name.
   */
  ledger: string;
  /** How many times the answering ledger changed. One window's publishing split across two ledgers leaves neither complete. */
  ledgerSwitches: number;
  /** Count of unnamed stamps — replies that cannot be compared. Counting absence as sameness hides the split. */
  unnamedLedger: number;
}

const counters = moduleState<Counters>("state/activityHealth#counters", () => ({
  attempts: 0,
  ok: 0,
  failed: 0,
  consecutiveFailures: 0,
  lastOkAt: 0,
  lastFailAt: 0,
  lastError: "",
  lastStamp: 0,
  stampRegressions: 0,
  ledger: "",
  ledgerSwitches: 0,
  unnamedLedger: 0,
}));

/**
 * Read the admission stamp from a reply — **resolve is not evidence of admission.**
 *
 * On admission the hub stamps the item (seq) and returns it (cored ledger::admit — stamp, persist,
 * then put that item in the reply). So a seq in the reply means the row is in the ledger; no seq
 * means the publish call went out but nothing was recorded in the ledger.
 *
 * Measured (2026-07-31): the ledger was stopped while publishes resolved and were counted as
 * successes. Counting call success alone makes those two states identical — this is the site that
 * counts the boundary.
 */
export function stampOf(reply: unknown): number | null {
  if (!reply || typeof reply !== "object") return null;
  const seq = (reply as { seq?: unknown }).seq;
  return typeof seq === "number" && Number.isFinite(seq) ? seq : null;
}

/** Name of the ledger that stamped it — an unnamed reply cannot be compared (empty string). */
export function ledgerOf(reply: unknown): string {
  if (!reply || typeof reply !== "object") return "";
  const l = (reply as { ledger?: unknown }).ledger;
  return typeof l === "string" ? l : "";
}

/** Record the result of one publish. Success clears consecutive failures but not past failures. */
export function notePublish(
  ok: boolean,
  at: number,
  error?: string,
  stamp?: number,
  ledger?: string,
): void {
  counters.attempts += 1;
  if (ok) {
    if (stamp !== undefined) {
      if (counters.lastStamp > 0 && stamp < counters.lastStamp) {
        counters.stampRegressions += 1;
      }
      counters.lastStamp = stamp;
    }
    if (ledger === undefined || ledger === "") {
      counters.unnamedLedger += 1;
    } else {
      if (counters.ledger !== "" && counters.ledger !== ledger) {
        counters.ledgerSwitches += 1;
      }
      counters.ledger = ledger;
    }
    counters.ok += 1;
    counters.consecutiveFailures = 0;
    counters.lastOkAt = at;
    return;
  }
  counters.failed += 1;
  counters.consecutiveFailures += 1;
  counters.lastFailAt = at;
  counters.lastError = error ?? "";
}

export interface ActivityHealth extends Counters {
  /** At least one success and consecutive failures below the threshold. 0 attempts is unconfirmed, not healthy. */
  healthy: boolean;
}

export function activityHealth(): ActivityHealth {
  return {
    ...counters,
    healthy:
      counters.ok > 0 &&
      counters.consecutiveFailures < UNHEALTHY_AFTER &&
      counters.stampRegressions === 0 &&
      counters.ledgerSwitches === 0,
  };
}
