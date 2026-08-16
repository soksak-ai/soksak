import { describe, it, expect, vi } from "vitest";
import { makeCoreStore } from "./coreStore";

// core kv storage helper — localStorage (synchronous boot cache) + app.data (authority, cross-window broadcast).
// invoke, localStorage and onDataChange are injected for a pure test. key = one kv key in the core ns.

function harness(initialLs?: Record<string, string>) {
  const ls = new Map<string, string>(Object.entries(initialLs ?? {}));
  const localStorage = {
    getItem: (k: string) => ls.get(k) ?? null,
    setItem: (k: string, v: string) => void ls.set(k, v),
  };
  const remote = new Map<string, unknown>();
  const invoke = vi.fn(async (cmd: string, args: any) => {
    if (cmd === "data_kv_set") {
      remote.set(args.key, args.value);
      return;
    }
    if (cmd === "data_kv_get") return remote.get(args.key) ?? null;
    throw new Error(`unexpected ${cmd}`);
  });
  const listeners: Array<(key: string) => void> = [];
  const onDataChange = (cb: (key: string) => void) => {
    listeners.push(cb);
    return () => {};
  };
  const fireRemoteChange = (key: string) => listeners.forEach((l) => l(key));
  return { ls, remote, invoke, onDataChange, fireRemoteChange, localStorage };
}

// Missing and empty are different — if the two produce the same value, the consumer deletes an asset.
//
// RED evidence (measured 2026-08-01): a window respawn hydrates the snapshot and, on `workspaces.length === 0`,
// deletes that window's slot from the ledger. But when the authority was empty, hydrate **wrote the fallback
// in as the authority**, so a window with no snapshot and a window the user emptied gave the same answer.
// That window never opens again.
describe("read: missing and empty are separate answers", () => {
  it("a value in the authority is found", async () => {
    const h = harness();
    h.remote.set("window/w-1", { workspaces: [1] });
    const store = makeCoreStore<{ workspaces: number[] }>({
      key: "window/w-1",
      lsKey: "ls.w1",
      fallback: { workspaces: [] },
      invoke: h.invoke,
      onDataChange: h.onDataChange,
      localStorage: h.localStorage,
    });
    expect(await store.read()).toEqual({ found: true, value: { workspaces: [1] } });
  });

  it("nothing in the authority is not found — the fallback is not returned as if it were the value", async () => {
    const h = harness();
    const store = makeCoreStore<{ workspaces: number[] }>({
      key: "window/w-2",
      lsKey: "ls.w2",
      fallback: { workspaces: [] },
      invoke: h.invoke,
      onDataChange: h.onDataChange,
      localStorage: h.localStorage,
    });
    expect((await store.read()).found).toBe(false);
  });

  it("an empty authority is not filled with an empty value — that would fix missing as fact at that moment", async () => {
    const h = harness();
    const store = makeCoreStore<{ workspaces: number[] }>({
      key: "window/w-3",
      lsKey: "ls.w3",
      fallback: { workspaces: [] },
      invoke: h.invoke,
      onDataChange: h.onDataChange,
      localStorage: h.localStorage,
    });
    await store.hydrate();
    expect(h.remote.has("window/w-3")).toBe(false);
    expect(h.invoke.mock.calls.filter((c) => c[0] === "data_kv_set")).toHaveLength(0);
  });

  // A cache with no value behind it on this authority is not this installation's.
  //
  // The web view's localStorage is shared by origin, and one binary run against
  // two homes has two stores and one cache. Measured 2026-08-16: a second home
  // booted empty, took the first home's window ledger out of that cache and
  // wrote it into its own store, naming three windows it had never opened.
  //
  // This carried a cache written by an older build into app.data once. AGENTS
  // 4-3 has no migrations, and this one was the way in.
  it("content in the cache is not adopted by an authority that holds nothing", async () => {
    const h = harness({ "ls.w4": JSON.stringify({ workspaces: [7] }) });
    const store = makeCoreStore<{ workspaces: number[] }>({
      key: "window/w-4",
      lsKey: "ls.w4",
      fallback: { workspaces: [] },
      invoke: h.invoke,
      onDataChange: h.onDataChange,
      localStorage: h.localStorage,
    });
    expect(await store.hydrate()).toEqual({ workspaces: [] });
    expect(h.remote.has("window/w-4")).toBe(false);
    expect(h.invoke.mock.calls.filter((c) => c[0] === "data_kv_set")).toHaveLength(0);
  });

  it("a failed read throws — an unreadable authority is not folded into missing", async () => {
    const h = harness();
    h.invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "data_kv_get") throw new Error("no owner");
      return undefined;
    });
    const store = makeCoreStore<{ workspaces: number[] }>({
      key: "window/w-5",
      lsKey: "ls.w5",
      fallback: { workspaces: [] },
      invoke: h.invoke,
      onDataChange: h.onDataChange,
      localStorage: h.localStorage,
    });
    await expect(store.read()).rejects.toThrow("no owner");
  });
});

describe("makeCoreStore", () => {
  it("loadSync: the localStorage cache is returned synchronously (boot — before render)", () => {
    const h = harness({ "soksak.settings": JSON.stringify({ a: 1 }) });
    const store = makeCoreStore<{ a: number }>({
      key: "settings",
      lsKey: "soksak.settings",
      fallback: { a: 0 },
      invoke: h.invoke,
      onDataChange: h.onDataChange,
      localStorage: h.localStorage,
    });
    expect(store.loadSync()).toEqual({ a: 1 });
  });

  it("loadSync: no cache gives the fallback", () => {
    const h = harness();
    const store = makeCoreStore({
      key: "settings",
      lsKey: "soksak.settings",
      fallback: { a: 0 },
      invoke: h.invoke,
      onDataChange: h.onDataChange,
      localStorage: h.localStorage,
    });
    expect(store.loadSync()).toEqual({ a: 0 });
  });

  it("save: both the localStorage cache and the app.data authority are written (core ns)", async () => {
    const h = harness();
    const store = makeCoreStore({
      key: "settings",
      lsKey: "soksak.settings",
      fallback: { a: 0 },
      invoke: h.invoke,
      onDataChange: h.onDataChange,
      localStorage: h.localStorage,
    });
    await store.save({ a: 5 });
    expect(JSON.parse(h.ls.get("soksak.settings")!)).toEqual({ a: 5 });
    expect(h.invoke).toHaveBeenCalledWith("data_kv_set", {
      ns: "core",
      key: "settings",
      value: { a: 5 },
    });
    expect(h.remote.get("settings")).toEqual({ a: 5 });
  });

  it("hydrate: the app.data authority value is read, the localStorage cache updated, and the value returned", async () => {
    const h = harness({ "soksak.settings": JSON.stringify({ a: 1 }) });
    h.remote.set("settings", { a: 9 });
    const store = makeCoreStore({
      key: "settings",
      lsKey: "soksak.settings",
      fallback: { a: 0 },
      invoke: h.invoke,
      onDataChange: h.onDataChange,
      localStorage: h.localStorage,
    });
    const v = await store.hydrate();
    expect(v).toEqual({ a: 9 });
    expect(JSON.parse(h.ls.get("soksak.settings")!)).toEqual({ a: 9 }); // cache updated
  });

  it("hydrate: an empty app.data answers the fallback, and writes nothing", async () => {
    const h = harness({ "soksak.settings": JSON.stringify({ a: 7 }) });
    const store = makeCoreStore({
      key: "settings",
      lsKey: "soksak.settings",
      fallback: { a: 0 },
      invoke: h.invoke,
      onDataChange: h.onDataChange,
      localStorage: h.localStorage,
    });
    const v = await store.hydrate();
    expect(v).toEqual({ a: 0 });
    // Nothing is written either way: an empty fallback written to the authority
    // fixes "not there yet" as "empty", and a consumer reading that treats it as
    // emptied by the user — window respawn deleted a ledger slot on that answer.
    expect(h.remote.has("settings")).toBe(false);
  });

  // [read-your-writes] stage = sets the value this window just wrote as the in-memory authority at once (the caller
  // debounces the disk flush). Even when disk (SQLite) still holds the old value, hydrate in the same window must see the just-written value.
  it("stage: an unflushed staged value wins over stale SQLite (read-your-writes — the disk flush is separate)", async () => {
    const h = harness();
    h.remote.set("settings", { a: 1 }); // authority SQLite = the old value (debounced, not updated yet)
    const store = makeCoreStore<{ a: number }>({
      key: "settings",
      lsKey: "soksak.settings",
      fallback: { a: 0 },
      invoke: h.invoke,
      onDataChange: h.onDataChange,
      localStorage: h.localStorage,
    });
    store.stage({ a: 2 }); // this window just wrote it (not flushed to disk)
    expect(await store.hydrate()).toEqual({ a: 2 }); // the value just written, not the stale {a:1}
    expect(JSON.parse(h.ls.get("soksak.settings")!)).toEqual({ a: 2 }); // the synchronous cache is immediate too
  });

  it("subscribe: during an unflushed local write, a stale echo does not overwrite the value just written (read-your-writes)", async () => {
    const h = harness();
    h.remote.set("settings", { a: 1 }); // the old value (SQLite)
    const store = makeCoreStore<{ a: number }>({
      key: "settings",
      lsKey: "soksak.settings",
      fallback: { a: 0 },
      invoke: h.invoke,
      onDataChange: h.onDataChange,
      localStorage: h.localStorage,
    });
    const seen: Array<{ a: number }> = [];
    store.subscribe((v) => seen.push(v));
    store.stage({ a: 2 }); // local write (not flushed to disk) — the authority is {a:2}
    h.fireRemoteChange("settings"); // SQLite is still {a:1} (stale) — an overwrite from this echo is the violation
    await Promise.resolve();
    await Promise.resolve();
    expect(seen).toEqual([]); // no revert from a stale echo
  });

  it("subscribe: a data-change from another window (same key) passes the newest authority value to the callback", async () => {
    const h = harness();
    h.remote.set("settings", { a: 1 });
    const store = makeCoreStore({
      key: "settings",
      lsKey: "soksak.settings",
      fallback: { a: 0 },
      invoke: h.invoke,
      onDataChange: h.onDataChange,
      localStorage: h.localStorage,
    });
    const seen: Array<{ a: number }> = [];
    store.subscribe((v) => seen.push(v));
    h.remote.set("settings", { a: 2 });
    h.fireRemoteChange("settings");
    await Promise.resolve();
    await Promise.resolve();
    expect(seen[seen.length - 1]).toEqual({ a: 2 });
  });

  it("subscribe: a self-echo (the value this window just wrote) skips the re-apply", async () => {
    const h = harness();
    const store = makeCoreStore<{ a: number }>({
      key: "settings",
      lsKey: "soksak.settings",
      fallback: { a: 0 },
      invoke: h.invoke,
      onDataChange: h.onDataChange,
      localStorage: h.localStorage,
    });
    const seen: Array<{ a: number }> = [];
    store.subscribe((v) => seen.push(v));
    // This window saves → broadcast self-echo. A same-value echo does not call cb (already applied, 0 re-renders).
    await store.save({ a: 5 });
    h.fireRemoteChange("settings");
    await Promise.resolve();
    await Promise.resolve();
    expect(seen).toEqual([]); // self-echo skip
    // Then another window saves a different value → that echo applies normally.
    h.remote.set("settings", { a: 9 });
    h.fireRemoteChange("settings");
    await Promise.resolve();
    await Promise.resolve();
    expect(seen[seen.length - 1]).toEqual({ a: 9 });
  });

  it("subscribe: a data-change for another key is ignored", async () => {
    const h = harness();
    const store = makeCoreStore({
      key: "settings",
      lsKey: "soksak.settings",
      fallback: { a: 0 },
      invoke: h.invoke,
      onDataChange: h.onDataChange,
      localStorage: h.localStorage,
    });
    const seen: unknown[] = [];
    store.subscribe((v) => seen.push(v));
    h.fireRemoteChange("theme");
    await Promise.resolve();
    expect(seen).toEqual([]);
  });
});
