// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RegistrySection } from "./PluginManagerModal";
import { useRegistry } from "../state/registry";
import { usePluginInstallProgress } from "../plugins/registryInstallProgress";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const entry = {
  registryId: "official", id: "soksak-plugin-terminal-kitty", version: "0.0.11",
  size: 1, sha256: "a".repeat(64),
} as never;

describe("plugin manager installation progress", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    useRegistry.setState({ entries: [entry], status: "live" });
    usePluginInstallProgress.setState({ installs: {
      "soksak-plugin-terminal-kitty": {
        pluginId: "soksak-plugin-terminal-kitty", phase: "staging",
        completed: 1, total: 3, componentId: "soksak-sidecar-pty",
      },
    } });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("disables the same plugin and renders real component progress", () => {
    act(() => root.render(<RegistrySection busy={false} run={() => {}} installed={{}} />));
    const row = host.querySelector('[data-node="plugin/soksak-plugin-terminal-kitty/registry-row"]');
    const progress = host.querySelector<HTMLElement>('[role="progressbar"]');
    expect(row?.getAttribute("aria-busy")).toBe("true");
    expect(host.querySelector<HTMLButtonElement>("button.dbtn")?.disabled).toBe(true);
    expect(progress?.getAttribute("aria-valuenow")).toBe("1");
    expect(progress?.getAttribute("aria-valuemax")).toBe("3");
    expect(host.textContent).toContain("soksak-sidecar-pty");
  });
});
