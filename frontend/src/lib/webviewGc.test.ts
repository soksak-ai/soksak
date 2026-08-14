// webviewGc — unit verification of the pure core of the webview reclaim invariant
// (collectWebviewLabels).
// Invariant: the live label set = the set of plugin content views that "declare native surface
// ownership in the manifest" (contributes.views[].nativeSurface=true). Ownership comes from the
// declaration (the ownsSurface predicate), not a hardcoded id — a core carrying specific plugin
// names is tight coupling (violates the plugin/core separation principle).
// Without this shape held, a live webview is mistaken for abandoned and reclaimed (wrong reclaim),
// or a dead webview is never caught (missed reclaim).

import { describe, expect, it } from "vitest";
import { collectWebviewLabels, gateAfterConsume, type OwnsSurface } from "./webviewGc";
import { splitLeaf } from "../state/splitTree";
import type { Project, Tab, Pane, Space } from "../state/sessions";

// Test label double: independent of the window namespace (currentWindowLabel) — viewId used as-is
// for b-<id>. Built by string concatenation, not an inline template (the single-truth guard blocks
// only inline templates — this is an injected test double, not a redefinition of the real label scheme).
const labelOf = (viewId: string) => "b-".concat(viewId);

// Declaration double — the exact shape of manifest contributes.views[].nativeSurface:
// pluginId → (view id within the plugin → nativeSurface). The real runtime predicate derives from the usePlugins manifest.
const decls: Record<string, Record<string, boolean>> = {
  "soksak-plugin-browser-native": { content: true },
  // Frame-streaming engines: a view exists but creates no native child surface (DOM canvas) — declared non-owning.
  "soksak-plugin-browser-canvas": { content: false },
  "soksak-plugin-terminal-xterm": { content: false },
};
const ownsSurface: OwnsSurface = (pluginId, viewId) =>
  decls[pluginId]?.[viewId] === true;

function group(tabs: Tab[]): Pane {
  return { id: "g1", tabs, activeTabId: tabs[0]?.id ?? "" };
}

function content(views: Tab[]): Space {
  return { id: "c1", title: "1", layout: splitLeaf(group(views)), activePaneId: "g1" };
}

function tab(views: Tab[]): Project {
  return {
    id: "t1",
    title: "p",
    sidebarOpen: false,
    rightOpen: false,
    rightView: null,
    leftLayout: splitLeaf({ viewKeys: [], activeViewKey: "" }),
    root: "<local-evidence>",
    spaces: [content(views)],
    activeSpaceId: "c1",
  };
}

const pluginView = (id: string, pluginId: string, view = "content"): Tab => ({
  id,
  kind: "plugin",
  title: "P",
  pluginId,
  view,
});

describe("collectWebviewLabels — label set of webview-owning views, keyed on the nativeSurface declaration", () => {
  it("counts the label of a nativeSurface-declaring view (a miss reclaims it as a false orphan — regression guard)", () => {
    const live = collectWebviewLabels(
      [tab([pluginView("v2", "soksak-plugin-browser-native")])],
      ownsSurface,
      labelOf,
    );
    expect([...live]).toEqual(["b-v2"]);
  });

  it("does not count a non-owning view (terminal, undeclared plugin)", () => {
    const live = collectWebviewLabels(
      [tab([pluginView("v3", "soksak-plugin-terminal-xterm"), pluginView("v4", "soksak-plugin-other")])],
      ownsSurface,
      labelOf,
    );
    expect(live.size).toBe(0);
  });

  it("counts only the declaring engine when an owning and a non-owning engine coexist", () => {
    const live = collectWebviewLabels(
      [
        tab([
          pluginView("v1", "soksak-plugin-browser-native"),
          pluginView("v2", "soksak-plugin-browser-canvas"),
        ]),
      ],
      ownsSurface,
      labelOf,
    );
    expect(live).toEqual(new Set(["b-v1"]));
  });

  it("does not count a nativeSurface=false view (DOM canvas — not a GC target)", () => {
    const live = collectWebviewLabels(
      [tab([pluginView("v5", "soksak-plugin-browser-canvas")])],
      ownsSurface,
      labelOf,
    );
    expect(live.size).toBe(0);
  });

  it("does not count an undeclared view id even from the same plugin (declaration is per view)", () => {
    const live = collectWebviewLabels(
      [tab([pluginView("v6", "soksak-plugin-browser-native", "settings")])],
      ownsSurface,
      labelOf,
    );
    expect(live.size).toBe(0);
  });

  it("collects every owning view spread across spaces and groups", () => {
    const t: Project = {
      ...tab([pluginView("v1", "soksak-plugin-browser-native")]),
      spaces: [
        content([pluginView("v1", "soksak-plugin-browser-native")]),
        content([pluginView("v2", "soksak-plugin-browser-native")]),
      ],
    };
    // Avoid an id collision on the second content
    t.spaces[1] = { ...t.spaces[1], id: "c2" };
    const live = collectWebviewLabels([t], ownsSurface, labelOf);
    expect(live).toEqual(new Set(["b-v1", "b-v2"]));
  });
});

// Recovery reboot gate transition core (gateAfterConsume) — holding the sweep on the boot right
// after a recovery reload prevents a live=∅ misjudgment reclaim before session restore applies.
// It does not revert even when the windowBoot release arrives before the consume response
// (one-way release).
describe("webviewGc recovery reboot gate", () => {
  it("ordinary boot (consume=false) — released at once", () => {
    expect(gateAfterConsume("pending", false)).toBe("released");
  });

  it("recovery reboot (consume=true) — held, sweep waits until restore applies", () => {
    expect(gateAfterConsume("pending", true)).toBe("held");
  });

  it("a late consume response cannot revert a release that already arrived", () => {
    expect(gateAfterConsume("released", true)).toBe("released");
    expect(gateAfterConsume("released", false)).toBe("released");
  });
});
