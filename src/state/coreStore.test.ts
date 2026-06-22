import { describe, it, expect, vi } from "vitest";
import { makeCoreStore } from "./coreStore";

// core kv 저장 헬퍼 — localStorage(동기 부트 캐시) + app.data(권위·크로스윈도우 broadcast).
// invoke·localStorage·onDataChange 를 주입받아 순수 테스트. 키 = core ns 의 한 kv 키.

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

describe("makeCoreStore", () => {
  it("loadSync: localStorage 캐시를 동기 반환(부트 — render 전)", () => {
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

  it("loadSync: 캐시 없으면 fallback", () => {
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

  it("save: localStorage 캐시 + app.data 권위 양쪽 기록(core ns)", async () => {
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

  it("hydrate: app.data 권위값을 읽어 localStorage 캐시 갱신 + 반환", async () => {
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
    expect(JSON.parse(h.ls.get("soksak.settings")!)).toEqual({ a: 9 }); // 캐시 갱신
  });

  it("hydrate: app.data 비어있으면 localStorage 캐시를 app.data 로 1회 마이그레이션", async () => {
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
    expect(v).toEqual({ a: 7 });
    expect(h.remote.get("settings")).toEqual({ a: 7 }); // 마이그레이션됨
  });

  it("subscribe: 다른 창의 data-change(같은 key) 시 콜백에 최신 권위값 전달", async () => {
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

  it("subscribe: 다른 key 의 data-change 는 무시", async () => {
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
