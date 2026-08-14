// resolveTerminalProgram — resolves the contract the core terminal affordance targets
// (soksak-spec-plugin-terminal) to the configured engine's program id. Decided by discovery and
// selection only, with no hardcoded plugin or program id.
import { afterEach, describe, expect, it, vi } from "vitest";

const mem = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
  clear: () => mem.clear(),
});

import { resolveTerminalProgram, TERMINAL_CONTRACT } from "./terminalEngine";
import { useProgramRegistry } from "./programRegistry";
import { usePlugins, type PluginRuntime } from "../state/plugins";
import { useContractSelection } from "../state/contractSelection";
import type { ContributedProgram, PluginManifest } from "./spec";

const XTERM = "soksak-plugin-terminal-xterm";
const GHOSTTY = "soksak-plugin-terminal-ghostty";

function enginePlugin(
  id: string,
  status: "enabled" | "disabled" = "enabled",
): PluginRuntime {
  return {
    manifest: { id, implements: [{ id: TERMINAL_CONTRACT.id, version: "0.0.1" }] } as unknown as PluginManifest,
    dir: "",
    source: "dev",
    status,
  };
}

function registerProgram(
  pluginId: string,
  programId: string,
  extra?: Partial<ContributedProgram>,
): () => void {
  return useProgramRegistry.getState().register(pluginId, {
    id: programId,
    kind: "view",
    view: "content",
    title: { en: programId, ko: programId },
    ...extra,
  } as ContributedProgram);
}

let disposers: (() => void)[] = [];
afterEach(() => {
  disposers.forEach((d) => d());
  disposers = [];
  usePlugins.setState({ plugins: {} });
  useContractSelection.setState({ selected: {} });
});

describe("resolveTerminalProgram", () => {
  it("pins the first-party terminal requirement to the exact 0.0.1 contract", () => {
    expect(TERMINAL_CONTRACT).toEqual({
      id: "soksak-spec-plugin-terminal",
      range: "0.0.1",
    });
  });

  it("null when no terminal implementation is active", () => {
    expect(resolveTerminalProgram()).toBeNull();
  });

  it("resolves that engine's own view program id when there is one implementation", () => {
    disposers.push(registerProgram(XTERM, "terminal-xterm"));
    usePlugins.setState({ plugins: { [XTERM]: enginePlugin(XTERM) } });
    expect(resolveTerminalProgram()).toBe("terminal-xterm");
  });

  it("honours the user's choice when there are two implementations", () => {
    disposers.push(registerProgram(XTERM, "terminal-xterm"));
    disposers.push(registerProgram(GHOSTTY, "terminal-ghostty"));
    usePlugins.setState({
      plugins: { [XTERM]: enginePlugin(XTERM), [GHOSTTY]: enginePlugin(GHOSTTY) },
    });
    useContractSelection.setState({ selected: { [TERMINAL_CONTRACT.id]: GHOSTTY } });
    expect(resolveTerminalProgram()).toBe("terminal-ghostty");
  });

  it("falls back to the first implementation (discovery order) when nothing is chosen", () => {
    disposers.push(registerProgram(XTERM, "terminal-xterm"));
    disposers.push(registerProgram(GHOSTTY, "terminal-ghostty"));
    usePlugins.setState({
      plugins: { [XTERM]: enginePlugin(XTERM), [GHOSTTY]: enginePlugin(GHOSTTY) },
    });
    expect(resolveTerminalProgram()).toBe("terminal-xterm");
  });

  it("falls back to the first implementation on a stale choice (disabled or not found)", () => {
    disposers.push(registerProgram(XTERM, "terminal-xterm"));
    usePlugins.setState({ plugins: { [XTERM]: enginePlugin(XTERM) } });
    useContractSelection.setState({ selected: { [TERMINAL_CONTRACT.id]: GHOSTTY } });
    expect(resolveTerminalProgram()).toBe("terminal-xterm");
  });

  it("a disabled implementation is not a candidate", () => {
    disposers.push(registerProgram(XTERM, "terminal-xterm"));
    usePlugins.setState({ plugins: { [XTERM]: enginePlugin(XTERM, "disabled") } });
    expect(resolveTerminalProgram()).toBeNull();
  });

  it("null when the implementation registered only cross-plugin (viewPlugin) programs and no own-view program", () => {
    disposers.push(
      registerProgram(XTERM, "agent-on-terminal", { viewPlugin: "soksak-plugin-other" }),
    );
    usePlugins.setState({ plugins: { [XTERM]: enginePlugin(XTERM) } });
    expect(resolveTerminalProgram()).toBeNull();
  });
});
