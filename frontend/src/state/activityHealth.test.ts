// Publishing must not die silently — one machine query must reveal it.
//
// Measured (2026-07-31): activity hub publishing stopped at 16:54:27 while the app kept answering
// commands normally. That nothing accumulated in the ledger surfaced only after a human queried
// twice and compared timestamps — that is manual work, not diagnosis. The publish site swallowed
// failures whole with `.catch(() => {})`, and swallowed failures were never counted.
//
// Not blocking live behavior differs from not recording the fact. Do not block, but **count**.
import { describe, it, expect, beforeEach, vi } from "vitest";

const BAG_KEY = "__soksakModuleState";

describe("activity publish health — no silent failure", () => {
  beforeEach(() => {
    delete (globalThis as Record<string, unknown>)[BAG_KEY];
    vi.resetModules();
  });

  it("a success records the last success time", async () => {
    const m = await import("./activityHealth");
    // Oracle liveness — if it reads as success from the start, this check proves nothing.
    expect(m.activityHealth().ok).toBe(0);
    expect(m.activityHealth().healthy).toBe(false);

    m.notePublish(true, 1000);

    const h = m.activityHealth();
    expect(h.ok).toBe(1);
    expect(h.lastOkAt).toBe(1000);
    expect(h.consecutiveFailures).toBe(0);
    expect(h.healthy).toBe(true);
  });

  it("a failure records the consecutive failure count and the reason", async () => {
    const m = await import("./activityHealth");
    m.notePublish(true, 1000);
    m.notePublish(false, 2000, "no socket");
    m.notePublish(false, 3000, "no socket");

    const h = m.activityHealth();
    expect(h.failed).toBe(2);
    expect(h.consecutiveFailures).toBe(2);
    expect(h.lastError).toBe("no socket");
    // Piled-up consecutive failures mean unhealthy — "one success at the end" is not evidence.
    expect(h.healthy).toBe(false);
  });

  it("a later success clears the consecutive failure count", async () => {
    const m = await import("./activityHealth");
    m.notePublish(false, 1000, "x");
    m.notePublish(false, 2000, "x");
    m.notePublish(true, 3000);

    const h = m.activityHealth();
    expect(h.consecutiveFailures).toBe(0);
    expect(h.healthy).toBe(true);
    // Past failures are not erased — recovery does not cover the fact.
    expect(h.failed).toBe(2);
  });

  it("a response with no stamp is not a success — resolve is not evidence of a write", async () => {
    const m = await import("./activityHealth");
    // On a store the hub stamps (seq) and returns it. No stamp means the publish left but nothing
    // landed in the ledger — measured (2026-07-31): publishes resolved and were counted as
    // successes while the ledger was stopped, and nothing inside the app exposed that.
    expect(m.stampOf({ seq: 7, ts: 1 })).toBe(7);
    expect(m.stampOf({ ok: true })).toBeNull();
    expect(m.stampOf(null)).toBeNull();
    expect(m.stampOf({ seq: "7" })).toBeNull();
  });

  it("records the fact when the answering ledger changes", async () => {
    const m = await import("./activityHealth");
    // Two ledgers each increasing monotonically both read as normal from seq alone — which ledger
    // a write went to is determined only when the ledger states its name (measured 2026-07-31: app
    // stamp 2068 against hub ledger 84810, and the app detected nothing wrong).
    m.notePublish(true, 1000, undefined, 10, "/home/a/data/soksak.db");
    expect(m.activityHealth().ledgerSwitches).toBe(0);
    expect(m.activityHealth().ledger).toBe("/home/a/data/soksak.db");

    m.notePublish(true, 2000, undefined, 11, "/home/b/data/soksak.db");

    const h = m.activityHealth();
    expect(h.ledgerSwitches).toBe(1);
    expect(h.ledger).toBe("/home/b/data/soksak.db");
    expect(h.healthy).toBe(false);
  });

  it("a stamp with no ledger name is unconfirmed", async () => {
    const m = await import("./activityHealth");
    m.notePublish(true, 1000, undefined, 10);
    // A hub that gives no name cannot be compared — counting an absent name as equal hides the split forever.
    expect(m.activityHealth().ledger).toBe("");
    expect(m.activityHealth().unnamedLedger).toBe(1);
  });

  it("health state survives a module swap", async () => {
    const first = await import("./activityHealth");
    first.notePublish(true, 1000);
    vi.resetModules();
    const second = await import("./activityHealth");
    expect(second).not.toBe(first);
    expect(second.activityHealth().ok).toBe(1);
  });
});
