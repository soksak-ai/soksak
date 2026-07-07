import { describe, it, expect, vi } from "vitest";
import { createCoreSync } from "./coreSync";

// createCoreSync — zustand 스토어의 직렬화 상태를 coreStore(app.data 권위 + ls 동기캐시 + broadcast)에
// 잇는 얇은 글루. 부트 전 save 는 ls 만, init(deps) 후엔 app.data 도. hydrate/subscribe 는 apply 로.

function harness(initialLs?: Record<string, string>) {
  const ls = new Map<string, string>(Object.entries(initialLs ?? {}));
  // window.localStorage 를 createCoreSync 가 직접 쓰므로 전역에 주입.
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

// async invoke(여러 microtask) 안정 flush.
const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

describe("createCoreSync", () => {
  it("loadSync: ls 캐시(없으면 fallback)", () => {
    const h = harness({ "soksak.x": JSON.stringify({ a: 2 }) });
    const cs = createCoreSync<{ a: number }>({ key: "x", lsKey: "soksak.x", fallback: { a: 0 }, apply: () => {} });
    expect(cs.loadSync()).toEqual({ a: 2 });
    harness();
    const cs2 = createCoreSync({ key: "x", lsKey: "soksak.x", fallback: { a: 9 }, apply: () => {} });
    expect(cs2.loadSync()).toEqual({ a: 9 });
    void h;
  });

  it("부트 전 save: ls 만 기록(app.data 미접근)", () => {
    const h = harness();
    const cs = createCoreSync({ key: "x", lsKey: "soksak.x", fallback: { a: 0 }, apply: () => {} });
    cs.save({ a: 5 });
    expect(JSON.parse(h.ls.get("soksak.x")!)).toEqual({ a: 5 });
    expect(h.remote.size).toBe(0); // app.data 미접근
  });

  it("init 후 save: ls + app.data 양쪽", async () => {
    const h = harness();
    const cs = createCoreSync({ key: "x", lsKey: "soksak.x", fallback: { a: 0 }, apply: () => {} });
    cs.init(h.deps);
    await flush();
    cs.save({ a: 7 });
    cs.flush(); // 권위(app.data) 디바운스 즉시 비움(테스트 — 실제는 300ms 후)
    await flush();
    expect(h.remote.get("x")).toEqual({ a: 7 });
    expect(JSON.parse(h.ls.get("soksak.x")!)).toEqual({ a: 7 });
  });

  // [성능 RULE] 연타(⌘± autorepeat·슬라이더 드래그)는 라이브 UI(메모리/ls 캐시)는 매번 즉시 반영하되,
  // 권위 persist(app.data: SQLite 쓰기 + 전 창 broadcast)는 정착값 1회로 접어야 한다. 디바운스 없으면
  // 키마다 SQLite+IPC+broadcast 폭풍 → CPU 100%(사용자 보고). RED: 연타 30회 → 권위 쓰기 30회(폭풍).
  it("연타 save: 권위 persist 는 디바운스(연타 폭풍 차단), ls 캐시는 즉시", async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      const sets = () => h.deps.invoke.mock.calls.filter((c) => c[0] === "data_kv_set").length;
      const cs = createCoreSync<{ n: number }>({ key: "x", lsKey: "soksak.x", fallback: { n: 0 }, apply: () => {} });
      cs.init(h.deps);
      await vi.runAllTimersAsync(); // hydrate(빈 권위 → 캐시 1회 마이그레이션)
      const before = sets();
      // 연타 30회.
      for (let i = 0; i < 30; i++) cs.save({ n: i });
      // ls 캐시는 매번 즉시(부트 crash-safe) — 마지막 값.
      expect(JSON.parse(h.ls.get("soksak.x")!)).toEqual({ n: 29 });
      // 디바운스 만료 전 — 권위 쓰기 0(폭풍 차단).
      expect(sets() - before).toBe(0);
      // 만료 후 — 권위 쓰기 정확히 1회(마지막 값만).
      await vi.advanceTimersByTimeAsync(400);
      expect(sets() - before).toBe(1);
      expect(h.remote.get("x")).toEqual({ n: 29 });
    } finally {
      vi.useRealTimers();
    }
  });

  // [read-your-writes RED] save 는 ls 캐시만 즉시 쓰고 권위(app.data) 기록은 300ms 디바운스로 미룬다.
  // 그 창(디바운스 flush 전)에 권위 채널을 다시 읽으면(같은 key data-change → readRemote) SQLite 는 아직
  // 옛 값이라 방금 쓴 값을 stale 로 덮는다(read-your-writes 위반 — 사용자 보고: dev.load 직후 stale, 1.5s
  // 기다리면 생존 = 디바운스 flush 창). 디스크 flush 는 계속 디바운스하되 in-memory 권위는 즉시 보여야 한다.
  it("read-your-writes: 디바운스 창 안 stale echo 가 방금 쓴 값을 되돌리지 않는다", async () => {
    const h = harness();
    h.remote.set("x", { n: 0 });
    const applied: Array<{ n: number }> = [];
    const cs = createCoreSync<{ n: number }>({ key: "x", lsKey: "soksak.x", fallback: { n: 0 }, apply: (v) => applied.push(v) });
    cs.init(h.deps);
    await flush(); // hydrate {n:0} → apply
    cs.save({ n: 5 }); // pending(디바운스) — SQLite 는 아직 {n:0}
    const mark = applied.length;
    h.fire("x"); // stale echo(SQLite {n:0}) — 이게 apply 되면 방금 쓴 {n:5} 를 되돌림
    await flush();
    const after = applied.slice(mark);
    expect(after.every((v) => v.n === 5)).toBe(true); // {n:0} 으로 revert 없음
  });

  it("init: app.data 권위값을 apply 로 적용", async () => {
    const h = harness({ "soksak.x": JSON.stringify({ a: 1 }) });
    h.remote.set("x", { a: 42 });
    const applied: Array<{ a: number }> = [];
    const cs = createCoreSync<{ a: number }>({ key: "x", lsKey: "soksak.x", fallback: { a: 0 }, apply: (v) => applied.push(v) });
    cs.init(h.deps);
    await flush();
    expect(applied[applied.length - 1]).toEqual({ a: 42 });
  });

  it("subscribe: 다른 창 변경(같은 key) → apply", async () => {
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
