// Without counting notification **arrivals**, a broken cross-process path goes unnoticed.
//
// Measured (2026-08-01): after moving store ownership to cored, there was no place to measure
// "does the other side receive it when one side writes". The receiving side updates silently, and
// receiving nothing is just as silent — the two states look identical. This counter separates them
// (live measurement: Tauri write → Electron window received 162→180).
import { describe, it, expect, beforeEach, vi } from "vitest";

const BAG_KEY = "__soksakModuleState";

describe("counting store change notifications on arrival", () => {
  beforeEach(() => {
    // The counter is stored outside the module boundary (globalThis) — clearing only the bag leaves
    // already-captured references behind, so reset the modules too (reference_module-state-boundary).
    delete (globalThis as Record<string, unknown>)[BAG_KEY];
    vi.resetModules();
  });

  it("nothing arrived is 0 with no last fact", async () => {
    const m = await import("./dataChangeHealth");
    const h = m.dataChangeHealth();
    // 0 means **unconfirmed**, not healthy — a process with missing wiring must not look the same as
    // a process nobody has written to yet, so the caller judges; this returns facts only.
    expect(h.received).toBe(0);
    expect(h.lastAt).toBeNull();
    expect(h.lastNs).toBeNull();
  });

  it("arrivals are counted and the last fact is kept", async () => {
    const { noteDataChange, dataChangeHealth } = await import("./dataChangeHealth");
    noteDataChange("core", "kv_set");
    noteDataChange("soksak-plugin-kanban", "put");
    const h = dataChangeHealth();
    expect(h.received).toBe(2);
    expect(h.lastNs).toBe("soksak-plugin-kanban");
    expect(h.lastOp).toBe("put");
    expect(typeof h.lastAt).toBe("number");
  });

  it("an ns this window does not use is counted too — the count is evidence the path works", async () => {
    // Counting after filtering makes "nothing arrived" look the same as "something arrived, not mine".
    const { noteDataChange, dataChangeHealth } = await import("./dataChangeHealth");
    noteDataChange("other-plugin", "put");
    expect(dataChangeHealth().received).toBe(1);
  });
});
