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
  id: PLUGIN,
  name: "A",
  version: "0.0.1",
  appVersionRequirement: "0.0.1",
  description: "plugin for tests",
  permissions: ["commands"],
  entry: "main.js",
};

const view = (surfaces: ("side" | "tab")[]) => ({
  id: "tree",
  title: { en: "T", ko: "T" },
  icon: "|",
  surfaces,
  transparent: false,
  nativeSurface: false,
});

describe("the plugin settings sidebar link", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    useViewRegistry.setState({ views: {}, badges: {}, version: 0 });
    useSectionSets.setState({ sets: [], byPlugin: {}, left: null });
    const { manifest, validation } = parseManifest(MANIFEST, PLUGIN);
    if (!manifest) throw new Error(`the test manifest does not parse: ${validation.errors.join(", ")}`);
    usePlugins.setState({
      plugins: { [PLUGIN]: { manifest, dir: "/p", source: "local", status: "enabled" } },
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

  // One select per place: each holds its own set, so the panel offers each separately. Two of
  // them, because the window's left edge holds one set for the whole installation — that one is a
  // general setting, not a plugin's.
  const select = (place: "rail" | "right" = "rail") =>
    host.querySelector<HTMLSelectElement>(`[data-sidebar-set="${place}"]`);

  it("offers a composed sidebar and links it to this plugin when chosen", () => {
    restores: "none" as const,
    useViewRegistry.getState().register(PLUGIN, view(["side"]), { restores: "none" as const, mount: () => {} });
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

    expect(useSectionSets.getState().byPlugin[PLUGIN]).toEqual({ rail: set.id });
  });

  it("does not offer a sidebar whose section lives on a tab", () => {
    // A tab view is opened as a tab; putting it in a set would drop it silently, and the person
     // would read that as the plugin failing rather than as the set being wrong.
    restores: "none" as const,
    useViewRegistry.getState().register(PLUGIN, view(["tab"]), { restores: "none" as const, mount: () => {} });
    const set = useSectionSets.getState().create("work");
    useSectionSets.getState().arrange(set.id, [`${PLUGIN}.tree`]);
    render();

    expect([...(select("rail")?.options ?? [])].map((o) => o.value)).toEqual([""]);
    expect([...(select("right")?.options ?? [])].map((o) => o.value)).toEqual([""]);
  });

  it("offers a section that lives beside the work in both places it can stand", () => {
    restores: "none" as const,
    useViewRegistry.getState().register(PLUGIN, view(["side"]), { restores: "none" as const, mount: () => {} });
    const set = useSectionSets.getState().create("work");
    useSectionSets.getState().arrange(set.id, [`${PLUGIN}.tree`]);
    render();

    expect([...(select("rail")?.options ?? [])].map((o) => o.value)).toEqual(["", set.id]);
    expect([...(select("right")?.options ?? [])].map((o) => o.value)).toEqual(["", set.id]);
  });

  it("says nothing has been composed rather than offering an empty list", () => {
    render();
    expect(select()).toBeNull();
    expect(host.textContent).toContain("sections.create");
  });
});
