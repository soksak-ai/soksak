// update.* 오케스트레이터 계약 테스트 — HS1 축 순서·release 채널 게이트·loud 고지·dev 스킵.
// invoke(코어)·usePlugins(store)·publishActivity(허브)는 mock. 각 설치 프리미티브는 경계가
// 소유하므로 여기선 "올바른 축을 올바른 순서·게이트로 부르는가"만 증명한다.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...a: unknown[]) => invoke(...a),
}));

const pluginUpdate = vi.fn();
let pluginState: { plugins: Record<string, { source: string }>; release: boolean; update: typeof pluginUpdate };
vi.mock("../state/plugins", () => ({
  usePlugins: { getState: () => pluginState },
}));

const publishActivity = vi.fn();
vi.mock("../state/activityFeed", () => ({
  publishActivity: (...a: unknown[]) => publishActivity(...a),
}));

import { registerUpdateCatalog } from "./catalogUpdate";
import { execute, getSpec, unregister } from "./registry";

/** 커맨드별 invoke 응답 라우터 — 미지정 커맨드는 {} 로 응답. */
function route(map: Record<string, unknown>) {
  invoke.mockImplementation((cmd: string) =>
    Promise.resolve(cmd in map ? map[cmd] : {}),
  );
}

beforeEach(() => {
  invoke.mockReset();
  pluginUpdate.mockReset();
  publishActivity.mockClear();
  pluginState = { plugins: {}, release: false, update: pluginUpdate };
  registerUpdateCatalog();
});
afterEach(() => {
  unregister("update.check");
  unregister("update.apply");
});

describe("update.* 등록", () => {
  it("update.apply 는 danger:destructive (ptyd 판올림·앱 relaunch 포함)", () => {
    expect(getSpec("update.check")).toBeDefined();
    const apply = getSpec("update.apply");
    expect(apply).toBeDefined();
    expect(apply!.danger).toBe("destructive");
    // 축 토글은 선택적(생략=실행) — 필수 선언 0.
    expect(apply!.params.app.required).toBeFalsy();
    expect(apply!.params.daemon.required).toBeFalsy();
  });
});

describe("update.apply 채널 게이트 (HOME 정책: 앱 본체 원격은 release 만)", () => {
  it("debug/dev(release:false) 는 앱 본체를 건너뛴다 — update_apply·app_relaunch 미호출", async () => {
    pluginState.release = false;
    route({ pty_daemon_upgrade: { sessions: 2, pid: 123 } });

    const r = await execute("update.apply", {}, {});

    const called = invoke.mock.calls.map((c) => c[0]);
    expect(called).toContain("pty_daemon_upgrade");
    expect(called).not.toContain("update_apply");
    expect(called).not.toContain("app_relaunch");
    const skipped = (r.data as { skipped: { axis: string; reason: string }[] }).skipped;
    expect(skipped).toContainEqual({ axis: "app", reason: "CHANNEL" });
    // 채널 스킵도 무음이 아니다 — 버스로 고지.
    expect(publishActivity).toHaveBeenCalledWith("update.skipped", "core", {
      axis: "app",
      reason: "channel",
    });
  });

  it("release + 새 판 있음 → update_apply 후 app_relaunch, 데몬이 앱보다 먼저(HS1 순서)", async () => {
    pluginState.release = true;
    route({
      pty_daemon_upgrade: { sessions: 0 },
      update_check: { available: true, version: "0.3.0", channel: "release" },
      update_apply: { installed: true, version: "0.3.0" },
      app_relaunch: null,
    });

    const r = await execute("update.apply", {}, {});

    const order = invoke.mock.calls.map((c) => c[0]);
    expect(order).toContain("update_apply");
    expect(order).toContain("app_relaunch");
    // HS1: 무중단 데몬 축이 앱 본체 relaunch 보다 먼저.
    expect(order.indexOf("pty_daemon_upgrade")).toBeLessThan(order.indexOf("update_apply"));
    expect(order.indexOf("update_apply")).toBeLessThan(order.indexOf("app_relaunch"));
    const applied = (r.data as { applied: { axis: string; version?: string }[] }).applied;
    expect(applied).toContainEqual({ axis: "app", version: "0.3.0" });
  });

  it("release 라도 새 판 없으면 relaunch 안 함(UPTODATE 스킵)", async () => {
    pluginState.release = true;
    route({
      pty_daemon_upgrade: { sessions: 0 },
      update_check: { available: false, channel: "release" },
    });

    const r = await execute("update.apply", {}, {});

    const called = invoke.mock.calls.map((c) => c[0]);
    expect(called).not.toContain("update_apply");
    expect(called).not.toContain("app_relaunch");
    const skipped = (r.data as { skipped: { axis: string; reason: string }[] }).skipped;
    expect(skipped).toContainEqual({ axis: "app", reason: "UPTODATE" });
  });
});

describe("update.apply 축 순서·선택 (HS1: 플러그인 → 사이드카 → ptyd → 앱)", () => {
  it("플러그인은 installed 만(dev 스킵), 사이드카 뒤에, 지정 순서로 반영", async () => {
    pluginState.release = false;
    pluginState.plugins = {
      "soksak-plugin-a": { source: "installed" },
      "soksak-plugin-dev": { source: "dev" },
    };
    pluginUpdate.mockResolvedValue({ ok: true, id: "soksak-plugin-a", version: "1.2.0" });
    route({});

    const r = await execute(
      "update.apply",
      { sidecars: [{ name: "terminal-alacritty", url: "u", sha256: "s" }], daemon: false, app: false },
      {},
    );

    // dev 플러그인은 update 호출 대상 아님 — installed 만.
    expect(pluginUpdate).toHaveBeenCalledTimes(1);
    expect(pluginUpdate).toHaveBeenCalledWith("soksak-plugin-a");
    expect(invoke).toHaveBeenCalledWith("sidecar_ensure", {
      name: "terminal-alacritty",
      url: "u",
      sha256: "s",
    });
    // daemon:false·app:false → 그 축은 아예 손대지 않는다.
    const called = invoke.mock.calls.map((c) => c[0]);
    expect(called).not.toContain("pty_daemon_upgrade");
    const applied = (r.data as { applied: { axis: string }[] }).applied;
    expect(applied.map((a) => a.axis)).toEqual(["plugin", "sidecar"]);
  });

  it("플러그인 update 실패는 skipped 로 기록(축 진행은 계속)", async () => {
    pluginState.release = false;
    pluginState.plugins = { "soksak-plugin-b": { source: "installed" } };
    pluginUpdate.mockResolvedValue({ ok: false, code: "TARGET_NOT_FOUND", message: "x" });
    route({ pty_daemon_upgrade: { sessions: 1 } });

    const r = await execute("update.apply", { app: false }, {});

    const skipped = (r.data as { skipped: { axis: string; id?: string; reason: string }[] }).skipped;
    expect(skipped).toContainEqual({ axis: "plugin", id: "soksak-plugin-b", reason: "TARGET_NOT_FOUND" });
    // 플러그인이 막혀도 데몬 축은 진행.
    const applied = (r.data as { applied: { axis: string }[] }).applied;
    expect(applied.map((a) => a.axis)).toContain("daemon");
  });
});

describe("update.check 조사", () => {
  it("앱 본체 available + 설치 플러그인 수 + 데몬 상태를 보고(dev 제외)", async () => {
    pluginState.release = false;
    pluginState.plugins = {
      "soksak-plugin-a": { source: "installed" },
      "soksak-plugin-b": { source: "installed" },
      "soksak-plugin-dev": { source: "dev" },
    };
    route({
      update_check: { available: false, channel: "local" },
      pty_daemon_status: { running: true, sessions: 3 },
    });

    const r = await execute("update.check", {}, {});
    const d = r.data as {
      channel: string;
      app: { available: boolean };
      plugins: { installed: number };
      daemon: { running: boolean; sessions: number };
    };
    expect(d.channel).toBe("local");
    expect(d.app.available).toBe(false);
    expect(d.plugins.installed).toBe(2); // dev 제외
    expect(d.daemon.running).toBe(true);
    expect(d.daemon.sessions).toBe(3);
  });
});
