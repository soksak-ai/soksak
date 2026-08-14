// term.* target resolution — core terminal host first, PTY substrate (plugin terminal) as the
// fallback. One resolution path (resolveTermTab): the same tab id resolves through the core
// host-div or through the substrate (getPtyIo/getObservedCwd). A plugin terminal
// (tab.open program=terminal → kind=plugin) must be reachable by term.read/send/exec/cwd
// (no TARGET_NOT_FOUND).
import { beforeEach, describe, expect, it, vi } from "vitest";

// The catalog import can touch settings (localStorage), so stub it first.
const mem = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
  clear: () => mem.clear(),
});

import { resolveTermTab } from "./termResolve";
import {
  registerPtyIo,
  pushObservedCwd,
  resetPtyObservationStoreForTest,
} from "../terminal/ptyObservationStore";

beforeEach(() => {
  resetPtyObservationStoreForTest();
});

describe("resolveTermTab — a plugin terminal with no core host resolves through the substrate", () => {
  it("a tab whose IO is registered only in the substrate is valid, and read, send, and cwd all resolve", () => {
    const reads: (number | undefined)[] = [];
    const sends: string[] = [];
    registerPtyIo("tab-v37", {
      readBuffer: (lines) => {
        reads.push(lines);
        return "PLUGIN_BUFFER";
      },
      sendInput: (data) => void sends.push(data),
    });
    pushObservedCwd("tab-v37", "<local-evidence>/plug");

    // Explicit tab="tab-v37" — absent from the core host, present in the substrate.
    const r = resolveTermTab({ tab: "tab-v37" }, {});
    expect(r).not.toBeNull();
    expect(r!.tabId).toBe("tab-v37");

    // read goes through the substrate IO.
    expect(r!.readBuffer(50)).toBe("PLUGIN_BUFFER");
    expect(reads).toEqual([50]);

    // send goes through the substrate IO (true).
    expect(r!.sendInput("echo hi\r")).toBe(true);
    expect(sends).toEqual(["echo hi\r"]);

    // cwd comes from the substrate observation.
    expect(r!.getCwd()).toBe("<local-evidence>/plug");
  });

  it("a tab present nowhere resolves to null — the source of TARGET_NOT_FOUND", () => {
    expect(resolveTermTab({ tab: "ghost" }, {})).toBeNull();
  });

  it("substrate observation without registered IO is valid but read and send are not ready (undefined, false)", () => {
    pushObservedCwd("tab-v99", "<local-evidence>/x"); // pushObservedCwd is a no-op with no observation, so register first.
    // With no observation at all it is not valid — instead of creating the observation with
    // registerPtyIo and disposing it right away, this registers with registerPtyIo and then
    // clears the IO only, to separate it from a pure ghost with neither IO nor cwd.
    const dispose = registerPtyIo("tab-v99", {
      readBuffer: () => "X",
      sendInput: () => {},
    });
    dispose(); // Dispose IO → the observation (hasPtyObservation) remains.
    const r = resolveTermTab({ tab: "tab-v99" }, {});
    expect(r).not.toBeNull();
    expect(r!.readBuffer()).toBeUndefined();
    expect(r!.sendInput("x")).toBe(false);
  });
});
