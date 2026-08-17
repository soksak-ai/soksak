// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PluginSettings } from "./PluginSettings";
import { usePlugins } from "../state/plugins";
import { useSectionSets } from "../state/sectionSets";
import { useViewRegistry } from "../plugins/viewRegistry";
import { parseManifest } from "../plugins/spec";

// A sidebar is given to a plugin where a person sets that plugin.
//
// Sections go into a set, and the set is given to a plugin (A2a). The second half was reachable only
// through `sections.link` until 2026-08-16 — a rule stated as "connect it in the plugin settings"
// that the plugin settings did not carry. A rule a person cannot reach is a rule they do not have.
const PLUGIN = "soksak-plugin-a";

const MANIFEST = {
  spec: "soksak-spec-plugin@0.0.1",
  id: PLUGIN,
  name: "A",
  version: "0.0.1",
  description: "plugin for tests",
  permissions: ["commands"],
  entry: "main.js",
};

const view = (placements: ("left" | "right" | "center")[]) => ({
  id: "tree",
  title: { en: "T", ko: "T" },
  icon: "|",
  placements,
  defaultPlacement: placements[0],
  transparent: false,
  nativeSurface: false,
  decoration: false,
});

describe("the plugin settings sidebar link", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    useViewRegistry.setState({ views: {}, badges: {}, version: 0 });
    useSectionSets.setState({ sets: [], byPlugin: {}, mode: "individual", fixed: {} });
    const { manifest, validation } = parseManifest(MANIFEST, PLUGIN);
    if (!manifest) throw new Error(`the test manifest does not parse: ${validation.errors.join(", ")}`);
    usePlugins.setState({
      plugins: { [PLUGIN]: { manifest, dir: "/p", source: "dev", status: "enabled" } },
    });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  const render = () =>
    act(() => {
      root.render(<PluginSettings pluginId={PLUGIN} />);
    });

  // One select per region: each region holds its own set, so the panel offers each separately.
  const select = (region: "left" | "right" = "left") =>
    host.querySelector<HTMLSelectElement>(`[data-sidebar-set="${region}"]`);

  it("offers a composed sidebar and links it to this plugin when chosen", () => {
    useViewRegistry.getState().register(PLUGIN, view(["left"]), { mount: () => {} });
    const set = useSectionSets.getState().create("work");
    useSectionSets.getState().arrange(set.id, [`${PLUGIN}.tree`]);
    render();

    // Oracle liveness — a panel already linked would prove nothing about the click below.
    expect(useSectionSets.getState().byPlugin[PLUGIN]).toBeUndefined();
    expect([...(select()?.options ?? [])].map((o) => o.value)).toEqual(["", set.id]);

    act(() => {
      const el = select()!;
      el.value = set.id;
      el.dispatchEvent(new Event("change", { bubbles: true }));
    });

    expect(useSectionSets.getState().byPlugin[PLUGIN]).toEqual({ left: set.id });
  });

  it("does not offer a sidebar whose section is placed in the other region", () => {
    useViewRegistry.getState().register(PLUGIN, view(["right"]), { mount: () => {} });
    const set = useSectionSets.getState().create("work");
    useSectionSets.getState().arrange(set.id, [`${PLUGIN}.tree`]);
    render();

    expect([...(select("left")?.options ?? [])].map((o) => o.value)).toEqual([""]);
    // Where its section is placed, it is offered — otherwise the panel offers nothing anywhere.
    expect([...(select("right")?.options ?? [])].map((o) => o.value)).toEqual(["", set.id]);
  });

  it("says nothing has been composed rather than offering an empty list", () => {
    render();
    expect(select()).toBeNull();
    expect(host.textContent).toContain("sections.create");
  });
});
