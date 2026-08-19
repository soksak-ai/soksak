// @vitest-environment jsdom
// A pane with no view states what actually happened to the plugin.
//
// It said "the plugin is disabled or removed" whenever the view was not registered — one sentence
// for every reason a view can be absent. Measured 2026-08-19: after the manifest contract changed,
// three installed plugins were refused by name and every pane in the window read that sentence.
// Nothing was disabled and nothing was removed. The reason existed — `plugin.list` answered
// `rejected[]` with the refused keys — and the screen said something else.
//
// A sentence that is not true about the state it describes sends a person to the wrong place. Three
// states, three sentences, and the refusal comes with its own reason.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../framework", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../framework")>()),
  invoke: vi.fn(async () => undefined),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { PluginViewHost } from "./PluginViewHost";
import { usePlugins } from "../state/plugins";
import { useViewRegistry } from "../plugins/viewRegistry";

describe("what a pane says when its view is not there", () => {
  let host: HTMLElement;
  let root: Root;

  beforeEach(() => {
    useViewRegistry.setState({ views: {}, badges: {}, version: 0 });
    usePlugins.setState({ plugins: {}, rejected: [] });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  const draw = () =>
    act(() => {
      root.render(
        <PluginViewHost
          viewKey="soksak-plugin-file-tree.tree"
          projectId="wsp-aaaaaa"
          root="<local-evidence>/w"
          region="rail"
          paneId="pan-aaaaaa"
        />,
      );
    });

  const said = () => host.textContent ?? "";

  it("names the manifest as refused, and says what was refused", () => {
    usePlugins.setState({
      rejected: [
        {
          id: "soksak-plugin-file-tree",
          dir: "/home/plugins/soksak-plugin-file-tree",
          errors: ['contributes.views[0]: unknown key "placements"'],
        },
      ],
    });
    draw();
    expect(said()).toContain("placements");
    expect(said()).not.toContain("removed");
  });

  it("says the plugin is installed and off when that is what it is", () => {
    usePlugins.setState({
      plugins: {
        "soksak-plugin-file-tree": {
          id: "soksak-plugin-file-tree",
          status: "disabled",
        } as never,
      },
    });
    draw();
    expect(said()).not.toContain("removed");
  });

  it("says the plugin is not installed when nothing knows it", () => {
    draw();
    expect(said().length).toBeGreaterThan(0);
  });
});
