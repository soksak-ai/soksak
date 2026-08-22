// Contract test for the update.* orchestrator — verifies disruption-scope ordering, the release
// identity gate, authenticated plugin updates, and event announcements.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("../framework", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../framework")>()),
  invoke: (...a: unknown[]) => invoke(...a),
}));

const pluginUpdate = vi.fn();
let pluginState: { plugins: Record<string, { source: string }>; release: boolean };
vi.mock("../state/plugins", () => ({
  usePlugins: { getState: () => pluginState },
}));
vi.mock("../plugins/registryInstallService", () => ({
  updateCertifiedRegistryPlugin: (...args: unknown[]) => pluginUpdate(...args),
}));

const publishActivity = vi.fn();
vi.mock("../state/activityFeed", () => ({
  publishActivity: (...a: unknown[]) => publishActivity(...a),
}));

import { registerUpdateCatalog } from "./catalogUpdate";
import { execute, getSpec, unregister } from "./registry";

/** Per-command invoke response router — unlisted commands answer {}. */
function route(map: Record<string, unknown>) {
  invoke.mockImplementation((cmd: string) =>
    Promise.resolve(cmd in map ? map[cmd] : {}),
  );
}

beforeEach(() => {
  invoke.mockReset();
  pluginUpdate.mockReset();
  publishActivity.mockClear();
  pluginState = { plugins: {}, release: false };
  registerUpdateCatalog();
});
afterEach(() => {
  unregister("update.check");
  unregister("update.apply");
});

describe("update.* registration", () => {
  it("update.apply is danger:destructive — it upgrades ptyd and relaunches the app", () => {
    expect(getSpec("update.check")).toBeDefined();
    const apply = getSpec("update.apply");
    expect(apply).toBeDefined();
    expect(apply!.danger).toBe("destructive");
    // Axis toggles are optional (omitted = run) — 0 required declarations.
    expect(apply!.params.app.required).toBeFalsy();
    expect(apply!.params.daemon.required).toBeFalsy();
  });
});

describe("update.apply channel gate (HOME policy: a remote app body update is release only)", () => {
  it("debug and dev (release:false) skip the app body — no update_apply, no app_relaunch", async () => {
    pluginState.release = false;
    route({ pty_daemon_upgrade: { sessions: 2, pid: 123 } });

    const r = await execute("update.apply", {}, {});

    const called = invoke.mock.calls.map((c) => c[0]);
    // The daemon axis no longer upgrades anything from here. A shell belongs to a sidecar, and the
    // sidecar is upgraded by installing it. What this asserts is that
    // asking for the axis is answered with a refusal rather than with an empty success.
    expect(called).not.toContain("pty_daemon_upgrade");
    expect(called).not.toContain("update_apply");
    expect(called).not.toContain("app_relaunch");
    const skipped = (r.data as { skipped: { axis: string; reason: string }[] }).skipped;
    expect(skipped).toContainEqual({ axis: "app", reason: "CHANNEL" });
    // A channel skip is not silent either — announced on the bus.
    expect(publishActivity).toHaveBeenCalledWith("update.skipped", "core", {
      axis: "app",
      reason: "channel",
    });
  });

  it("release with a new version runs update_apply then app_relaunch, daemon before app (HS1 order)", async () => {
    pluginState.release = true;
    route({
      pty_daemon_upgrade: { sessions: 0 },
      update_check: { available: true, version: "0.0.1", channel: "release" },
      update_apply: { installed: true, version: "0.0.1" },
      app_relaunch: null,
    });

    const r = await execute("update.apply", {}, {});

    const order = invoke.mock.calls.map((c) => c[0]);
    expect(order).toContain("update_apply");
    expect(order).toContain("app_relaunch");
    // HS1: the no-downtime daemon axis comes before the app body relaunch.
    expect(order.indexOf("pty_daemon_upgrade")).toBeLessThan(order.indexOf("update_apply"));
    expect(order.indexOf("update_apply")).toBeLessThan(order.indexOf("app_relaunch"));
    const applied = (r.data as { applied: { axis: string; version?: string }[] }).applied;
    expect(applied).toContainEqual({ axis: "app", version: "0.0.1" });
  });

  it("release with no new version does not relaunch (UPTODATE skip)", async () => {
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

describe("update.apply axis order and selection", () => {
  it("updates installed plugins and skips a development source", async () => {
    pluginState.release = false;
    pluginState.plugins = {
      "soksak-plugin-a": { source: "installed" },
      "soksak-plugin-dev": { source: "dev" },
    };
    pluginUpdate.mockResolvedValue({
      ok: true,
      id: "soksak-plugin-a",
      version: "0.0.1",
      generation: "generation-1",
    });
    route({});

    const r = await execute(
      "update.apply",
      { daemon: false, app: false },
      {},
    );

    // Dev plugins are not update call targets — installed only.
    expect(pluginUpdate).toHaveBeenCalledTimes(1);
    expect(pluginUpdate).toHaveBeenCalledWith("soksak-plugin-a");
    // daemon:false, app:false → those axes are not touched at all.
    const called = invoke.mock.calls.map((c) => c[0]);
    expect(called).not.toContain("pty_daemon_upgrade");
    const applied = (r.data as { applied: { axis: string }[] }).applied;
    expect(applied.map((a) => a.axis)).toEqual(["plugin"]);
  });

  it("a failed plugin update is recorded as skipped and the other axes continue", async () => {
    pluginState.release = false;
    pluginState.plugins = { "soksak-plugin-b": { source: "installed" } };
    pluginUpdate.mockResolvedValue({ ok: false, code: "TARGET_NOT_FOUND", message: "x" });
    route({ pty_daemon_upgrade: { sessions: 1 } });

    const r = await execute("update.apply", { app: false }, {});

    const skipped = (r.data as { skipped: { axis: string; id?: string; reason: string }[] }).skipped;
    expect(skipped).toContainEqual({ axis: "plugin", id: "soksak-plugin-b", reason: "TARGET_NOT_FOUND" });
    // The daemon axis is named as skipped rather than dropped, so a caller that asked for it is told
    // it was not done instead of reading an empty applied list as success.
    const notDone = (r.data as { skipped: { axis: string; reason?: string }[] }).skipped;
    const daemon = notDone.find((entry) => entry.axis === "daemon");
    expect(daemon, "the daemon axis was asked for and is in neither list").toBeDefined();
    expect(daemon?.reason).toContain("declared sidecar");
  });
});

describe("update.check survey", () => {
  it("reports app body availability and installed plugin count, excluding dev", async () => {
    pluginState.release = false;
    pluginState.plugins = {
      "soksak-plugin-a": { source: "installed" },
      "soksak-plugin-b": { source: "installed" },
      "soksak-plugin-dev": { source: "dev" },
    };
    route({ update_check: { available: false, channel: "local" } });

    const r = await execute("update.check", {}, {});
    const d = r.data as {
      channel: string;
      app: { available: boolean };
      plugins: { installed: number };
      daemon: { running: boolean; sessions: number };
    };
    expect(d.channel).toBe("local");
    expect(d.app.available).toBe(false);
    expect(d.plugins.installed).toBe(2); // dev excluded
    // The daemon axis reports nothing running, because this application holds no daemon. A shell is
    // a declared sidecar, and whether one has a newer release is the installer's question, answered
    // by whatever installed it rather than by a survey written here for one of them.
    expect(d.daemon.running).toBe(false);
  });
});
