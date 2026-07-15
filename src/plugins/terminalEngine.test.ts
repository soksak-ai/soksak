// resolveTerminalProgram — 코어의 터미널 어포던스가 겨냥하는 계약(soksak-spec-plugin-terminal)을 설정 엔진의
// program id 로 해소한다. 특정 플러그인/ program id 하드코딩 없이 발견·선택으로만 결정한다.
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

  it("활성 터미널 구현체가 없으면 null", () => {
    expect(resolveTerminalProgram()).toBeNull();
  });

  it("구현체 하나면 그 엔진의 자기 뷰 program id 를 해소한다", () => {
    disposers.push(registerProgram(XTERM, "terminal-xterm"));
    usePlugins.setState({ plugins: { [XTERM]: enginePlugin(XTERM) } });
    expect(resolveTerminalProgram()).toBe("terminal-xterm");
  });

  it("구현체가 둘이면 사용자 선택을 존중한다", () => {
    disposers.push(registerProgram(XTERM, "terminal-xterm"));
    disposers.push(registerProgram(GHOSTTY, "terminal-ghostty"));
    usePlugins.setState({
      plugins: { [XTERM]: enginePlugin(XTERM), [GHOSTTY]: enginePlugin(GHOSTTY) },
    });
    useContractSelection.setState({ selected: { [TERMINAL_CONTRACT.id]: GHOSTTY } });
    expect(resolveTerminalProgram()).toBe("terminal-ghostty");
  });

  it("선택이 없으면 첫 구현체(발견 순서)로 폴백한다", () => {
    disposers.push(registerProgram(XTERM, "terminal-xterm"));
    disposers.push(registerProgram(GHOSTTY, "terminal-ghostty"));
    usePlugins.setState({
      plugins: { [XTERM]: enginePlugin(XTERM), [GHOSTTY]: enginePlugin(GHOSTTY) },
    });
    expect(resolveTerminalProgram()).toBe("terminal-xterm");
  });

  it("stale 선택(비활성/미발견)은 첫 구현체로 폴백한다", () => {
    disposers.push(registerProgram(XTERM, "terminal-xterm"));
    usePlugins.setState({ plugins: { [XTERM]: enginePlugin(XTERM) } });
    useContractSelection.setState({ selected: { [TERMINAL_CONTRACT.id]: GHOSTTY } });
    expect(resolveTerminalProgram()).toBe("terminal-xterm");
  });

  it("비활성(disabled) 구현체는 후보가 아니다", () => {
    disposers.push(registerProgram(XTERM, "terminal-xterm"));
    usePlugins.setState({ plugins: { [XTERM]: enginePlugin(XTERM, "disabled") } });
    expect(resolveTerminalProgram()).toBeNull();
  });

  it("구현체가 등록한 게 크로스-플러그인(viewPlugin) program 뿐이면 자기 뷰 program 없음 → null", () => {
    disposers.push(
      registerProgram(XTERM, "agent-on-terminal", { viewPlugin: "soksak-plugin-other" }),
    );
    usePlugins.setState({ plugins: { [XTERM]: enginePlugin(XTERM) } });
    expect(resolveTerminalProgram()).toBeNull();
  });
});
