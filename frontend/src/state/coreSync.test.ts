import { describe, it, expect, vi } from "vitest";
import { createCoreSync } from "./coreSync";

// createCoreSync — thin glue connecting a zustand store's serialized state to coreStore (app.data
// authority + ls sync cache + broadcast). Before boot, save writes ls only; after init(deps) it
// writes app.data too. hydrate/subscribe go through apply.

function harness(initialLs?: Record<string, string>) {
  const ls = new Map<string, string>(Object.entries(initialLs ?? {}));
  // createCoreSync uses window.localStorage directly, so inject it on the global.
  (globalThis as { localStorage?: Storage }).localStorage = {
    getItem: (k: string) => ls.get(k) ?? null,
    setItem: (k: string, v: string) => void ls.set(k, v),
    removeItem: (k: string) => void ls.delete(k),
    clear: () => ls.clear(),
    key: () => null,
    length: 0,
  } as Storage;
  const remote = new Map<string, unknown>();
  const invoke = vi.fn(async (cmd: string, args: any) => {
    if (cmd === "data_kv_set") return void remote.set(args.key, args.value);
    if (cmd === "data_kv_get") return remote.get(args.key) ?? null;
    throw new Error(cmd);
  });
  const listeners: Array<(k: string) => void> = [];
  const onDataChange = (cb: (k: string) => void) => {
    listeners.push(cb);
    return () => {};
  };
  return {
    ls,
    remote,
    deps: { invoke, onDataChange, localStorage: globalThis.localStorage },
    fire: (k: string) => listeners.forEach((l) => l(k)),
  };
}

// Stable flush for async invoke (several microtasks).
const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

describe("createCoreSync", () => {
  it("loadSync: the ls cache, or the fallback when it is absent", () => {
    const h = harness({ "soksak.x": JSON.stringify({ a: 2 }) });
    const cs = createCoreSync<{ a: number }>({ key: "x", lsKey: "soksak.x", fallback: { a: 0 }, apply: () => {} });
    expect(cs.loadSync()).toEqual({ a: 2 });
    harness();
    const cs2 = createCoreSync({ key: "x", lsKey: "soksak.x", fallback: { a: 9 }, apply: () => {} });
    expect(cs2.loadSync()).toEqual({ a: 9 });
    void h;
  });

  it("save before boot: writes ls only, app.data untouched", () => {
    const h = harness();
    const cs = createCoreSync({ key: "x", lsKey: "soksak.x", fallback: { a: 0 }, apply: () => {} });
    cs.save({ a: 5 });
    expect(JSON.parse(h.ls.get("soksak.x")!)).toEqual({ a: 5 });
    expect(h.remote.size).toBe(0); // app.data untouched
  });

  it("save after init: both ls and app.data", async () => {
    const h = harness();
    const cs = createCoreSync({ key: "x", lsKey: "soksak.x", fallback: { a: 0 }, apply: () => {} });
    cs.init(h.deps);
    await flush();
    cs.save({ a: 7 });
    cs.flush(); // flushes the authoritative (app.data) debounce now (test only — 300ms in production)
    await flush();
    expect(h.remote.get("x")).toEqual({ a: 7 });
    expect(JSON.parse(h.ls.get("soksak.x")!)).toEqual({ a: 7 });
  });

  // [performance RULE] Rapid input (⌘± autorepeat, slider drag) must apply to the live UI
  // (memory/ls cache) immediately every time, while the authoritative persist (app.data: SQLite
  // write + broadcast to every window) folds into one settled value. Without debounce, every key
  // causes a SQLite+IPC+broadcast storm → CPU 100% (user report). RED: 30 rapid inputs → 30
  // authoritative writes (storm).
  it("rapid save: the authoritative persist is debounced (storm blocked) and the ls cache is immediate", async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      const sets = () => h.deps.invoke.mock.calls.filter((c) => c[0] === "data_kv_set").length;
      const cs = createCoreSync<{ n: number }>({ key: "x", lsKey: "soksak.x", fallback: { n: 0 }, apply: () => {} });
      cs.init(h.deps);
      await vi.runAllTimersAsync(); // hydrate (empty authority → one cache migration)
      const before = sets();
      // 30 rapid inputs.
      for (let i = 0; i < 30; i++) cs.save({ n: i });
      // The ls cache writes immediately every time (boot crash-safe) — the last value.
      expect(JSON.parse(h.ls.get("soksak.x")!)).toEqual({ n: 29 });
      // Before the debounce expires — 0 authoritative writes (storm blocked).
      expect(sets() - before).toBe(0);
      // After expiry — exactly 1 authoritative write (last value only).
      await vi.advanceTimersByTimeAsync(400);
      expect(sets() - before).toBe(1);
      expect(h.remote.get("x")).toEqual({ n: 29 });
    } finally {
      vi.useRealTimers();
    }
  });

  // [read-your-writes RED] save writes the ls cache immediately and defers the authoritative
  // (app.data) write by a 300ms debounce. Reading the authoritative channel again inside that
  // window (same key data-change → readRemote) hits a SQLite that still holds the old value, so
  // the just-written value is overwritten as stale (read-your-writes violation — user report:
  // stale right after dev.load, survives after waiting 1.5s = the debounce flush window). Disk
  // flush stays debounced, but the in-memory authority must be visible immediately.
  it("read-your-writes: a stale echo inside the debounce window does not revert the value just written", async () => {
    const h = harness();
    h.remote.set("x", { n: 0 });
    const applied: Array<{ n: number }> = [];
    const cs = createCoreSync<{ n: number }>({ key: "x", lsKey: "soksak.x", fallback: { n: 0 }, apply: (v) => applied.push(v) });
    cs.init(h.deps);
    await flush(); // hydrate {n:0} → apply
    cs.save({ n: 5 }); // pending (debounce) — SQLite still holds {n:0}
    const mark = applied.length;
    h.fire("x"); // stale echo (SQLite {n:0}) — applying it would revert the {n:5} just written
    await flush();
    const after = applied.slice(mark);
    expect(after.every((v) => v.n === 5)).toBe(true); // no revert to {n:0}
  });

  it("init: applies the app.data authoritative value through apply", async () => {
    const h = harness({ "soksak.x": JSON.stringify({ a: 1 }) });
    h.remote.set("x", { a: 42 });
    const applied: Array<{ a: number }> = [];
    const cs = createCoreSync<{ a: number }>({ key: "x", lsKey: "soksak.x", fallback: { a: 0 }, apply: (v) => applied.push(v) });
    cs.init(h.deps);
    await flush();
    expect(applied[applied.length - 1]).toEqual({ a: 42 });
  });

  it("subscribe: another window's change on the same key — apply", async () => {
    const h = harness();
    h.remote.set("x", { a: 1 });
    const applied: Array<{ a: number }> = [];
    const cs = createCoreSync<{ a: number }>({ key: "x", lsKey: "soksak.x", fallback: { a: 0 }, apply: (v) => applied.push(v) });
    cs.init(h.deps);
    await flush();
    h.remote.set("x", { a: 2 });
    h.fire("x");
    await flush();
    expect(applied[applied.length - 1]).toEqual({ a: 2 });
  });
});
