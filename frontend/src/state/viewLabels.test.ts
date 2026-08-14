import { describe, it, expect, beforeEach } from "vitest";
import { useViewLabels, resolveViewLabel } from "./viewLabels";

// viewLabels — user-set tab label per viewKey, persisted by the core. Generic override channel
// shared by the left and right sidebar views, not a plugin special case. Unset falls back to the
// manifest title.

beforeEach(() => {
  useViewLabels.setState({ labels: {} });
});

describe("viewLabels store", () => {
  it("set: assigns a label to a viewKey", () => {
    useViewLabels.getState().setLabel("soksak-plugin-folderpop.folders", "FolderPop");
    expect(useViewLabels.getState().labels["soksak-plugin-folderpop.folders"]).toBe("FolderPop");
  });

  it("set with an empty or blank string removes the override and falls back to the manifest", () => {
    const s = useViewLabels.getState();
    s.setLabel("x.y", "Custom");
    s.setLabel("x.y", "   ");
    expect(useViewLabels.getState().labels["x.y"]).toBeUndefined();
  });

  it("clear: removes the override explicitly", () => {
    const s = useViewLabels.getState();
    s.setLabel("x.y", "Custom");
    s.clearLabel("x.y");
    expect(useViewLabels.getState().labels["x.y"]).toBeUndefined();
  });
});

describe("resolveViewLabel", () => {
  it("returns the override when one is set, and the fallback (manifest title) otherwise", () => {
    useViewLabels.getState().setLabel("x.y", "My label");
    expect(resolveViewLabel("x.y", "Default")).toBe("My label");
    expect(resolveViewLabel("z.w", "Default")).toBe("Default");
  });
});
