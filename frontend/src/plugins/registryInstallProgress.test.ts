import { beforeEach, describe, expect, it } from "vitest";
import {
  beginPluginInstall,
  pluginInstallActive,
  pluginInstallProgress,
  setPluginInstallProgress,
  waitForPluginInstallPhase,
  usePluginInstallProgress,
} from "./registryInstallProgress";

describe("plugin install progress", () => {
  beforeEach(() => usePluginInstallProgress.setState({ installs: {} }));

  it("admits one active install per plugin and exposes its real component count", () => {
    expect(beginPluginInstall("soksak-plugin-terminal-kitty")).toBe(true);
    expect(beginPluginInstall("soksak-plugin-terminal-kitty")).toBe(false);
    setPluginInstallProgress({
      pluginId: "soksak-plugin-terminal-kitty", phase: "staging",
      completed: 1, total: 3, componentId: "soksak-sidecar-pty",
    });
    expect(pluginInstallProgress("soksak-plugin-terminal-kitty")).toEqual([{
      pluginId: "soksak-plugin-terminal-kitty", phase: "staging",
      completed: 1, total: 3, componentId: "soksak-sidecar-pty",
    }]);
    expect(pluginInstallActive(pluginInstallProgress()[0])).toBe(true);
  });

  it("allows retry only after a terminal failure", () => {
    beginPluginInstall("demo");
    setPluginInstallProgress({ pluginId: "demo", phase: "failed", completed: 0, total: 2, error: "network" });
    expect(pluginInstallActive(pluginInstallProgress("demo")[0])).toBe(false);
    expect(beginPluginInstall("demo")).toBe(true);
  });

  it("waits on the phase transition event without polling", async () => {
    beginPluginInstall("demo");
    const waited = waitForPluginInstallPhase("demo", "committing", 1000);
    setPluginInstallProgress({ pluginId: "demo", phase: "committing", completed: 2, total: 2 });
    await expect(waited).resolves.toMatchObject({ phase: "committing", completed: 2 });
  });
});
