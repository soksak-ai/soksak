// @vitest-environment jsdom
// Shutdown must name its target — it must not shut down another framework in the same home as well.
//
// The description of `app.shutdown.commit` stated that it does not shut down another framework along with
// it. But the orchestrator window of both frameworks is `main`, and a call that cannot select a label goes
// to **every** holder of that label — that rule itself is right (refusing on collision once meant neither
// app could be called from outside the moment both were running). So only the written contract was false.
//
// Measured 2026-08-08: a shutdown called to restart one side also closed the window of another framework
// the user had open. A command with irreversible side effects must take "who is shut down" as an argument.
import { describe, expect, it, vi } from "vitest";

const quitNative = vi.hoisted(() => ({
  invoke: vi.fn<(command: string) => Promise<unknown>>(async () => undefined),
}));
vi.mock("../framework", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../framework")>()),
  invoke: quitNative.invoke,
  frameworkName: "tauri",
}));

import { registerCatalog } from "./catalog";
import { execute } from "./registry";
import type { CommandContext } from "./registry";

registerCatalog();

const shutdownReceipt = {
  phase: "reaped",
  reaped: true,
  processChildrenReaped: 0,
  localPtysReaped: 0,
  daemonPtysTransferred: 0,
  daemonsReaped: 0,
  servicesReaped: 0,
  nativeWindowsDrained: 0,
  nativeSurfacesDrained: 0,
  nativePaneHostsDrained: 0,
  nativeInputMonitorsDrained: 0,
  nativeRemaining: 0,
};

const ctx = () => {
  const tasks: (() => unknown)[] = [];
  return {
    ctx: { afterReply: (t: () => unknown) => tasks.push(t) } as unknown as CommandContext,
    run: async () => {
      for (const t of tasks) await t();
    },
  };
};

describe("app.shutdown.commit — only the named framework shuts down", () => {
  it("leaves this process running when another framework is named", async () => {
    quitNative.invoke.mockClear();
    const { ctx: c, run } = ctx();
    const out = await execute("app.shutdown.commit", { framework: "electron" }, c);
    await run();
    expect(out.ok).toBe(true);
    expect(out.data?.quit, "this process shut down on a call that named another framework").toBe(false);
    expect(quitNative.invoke).not.toHaveBeenCalled();
  });

  it("shuts down when it names itself", async () => {
    quitNative.invoke.mockClear();
    const { ctx: c, run } = ctx();
    quitNative.invoke.mockResolvedValueOnce(shutdownReceipt);
    const out = await execute("app.shutdown.commit", { framework: "tauri" }, c);
    await run();
    expect(out.data?.quit).toBe(true);
    expect(quitNative.invoke).toHaveBeenCalledWith("app_shutdown_prepare");
  });

  // With no target the receiving side shuts down — this does not break older calls.
  it("shuts down on the receiving side when no framework is named", async () => {
    quitNative.invoke.mockClear();
    const { ctx: c, run } = ctx();
    quitNative.invoke.mockResolvedValueOnce(shutdownReceipt);
    const out = await execute("app.shutdown.commit", {}, c);
    await run();
    expect(out.data?.quit).toBe(true);
    expect(quitNative.invoke).toHaveBeenCalledWith("app_shutdown_prepare");
  });

  it("names which framework answered — several answers need one to be identified", async () => {
    const { ctx: c } = ctx();
    const out = await execute("app.shutdown.commit", { framework: "electron" }, c);
    expect(out.data?.framework).toBe("tauri");
  });
});
