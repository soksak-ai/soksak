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

  // [read-your-writes] stage = 이 창이 방금 기록한 값을 in-memory 권위로 즉시 세운다(디스크 flush 는 호출측
  // 이 디바운스). 디스크(SQLite)가 아직 옛 값이어도 같은 창 hydrate 는 방금 쓴 값을 봐야 한다.
  it("stage: 미flush 스테이징 값이 stale SQLite 보다 우선(read-your-writes — 디스크 flush 분리)", async () => {
    const h = harness();
    h.remote.set("settings", { a: 1 }); // 권위 SQLite = 옛 값(디바운스로 아직 갱신 전)
    const store = makeCoreStore<{ a: number }>({
      key: "settings",
      lsKey: "soksak.settings",
      fallback: { a: 0 },
      invoke: h.invoke,
      onDataChange: h.onDataChange,
      localStorage: h.localStorage,
    });
    store.stage({ a: 2 }); // 이 창이 방금 기록(디스크 미flush)
    expect(await store.hydrate()).toEqual({ a: 2 }); // stale {a:1} 아닌 방금 쓴 값
    expect(JSON.parse(h.ls.get("soksak.settings")!)).toEqual({ a: 2 }); // 동기 캐시도 즉시
  });

  it("subscribe: 미flush 로컬 쓰기 중 stale echo 는 방금 쓴 값을 덮지 않는다(read-your-writes)", async () => {
    const h = harness();
    h.remote.set("settings", { a: 1 }); // 옛 값(SQLite)
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
    store.stage({ a: 2 }); // 로컬 쓰기(디스크 미flush) — 권위는 {a:2}
    h.fireRemoteChange("settings"); // SQLite 는 아직 {a:1}(stale) — 이 echo 가 덮으면 위반
    await Promise.resolve();
    await Promise.resolve();
    expect(seen).toEqual([]); // stale echo 로 인한 revert 없음
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

  it("subscribe: self-echo(자기 창이 방금 쓴 값) 는 재apply skip", async () => {
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
    // 이 창이 저장 → broadcast self-echo. 같은 값 echo 는 cb 미호출(이미 반영됨, 재렌더 0).
    await store.save({ a: 5 });
    h.fireRemoteChange("settings");
    await Promise.resolve();
    await Promise.resolve();
    expect(seen).toEqual([]); // self-echo skip
    // 이후 다른 창이 다른 값 저장 → 그 echo 는 정상 apply.
    h.remote.set("settings", { a: 9 });
    h.fireRemoteChange("settings");
    await Promise.resolve();
    await Promise.resolve();
    expect(seen[seen.length - 1]).toEqual({ a: 9 });
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
