import { describe, expect, it } from "vitest";
import { parseManifest } from "./spec";

// A plugin may live in a sidebar and nowhere else.
//
// One of the shapes the placement declaration allows, not the required one: a terminal declaring a
// file tree beside its own centre view is equally valid, and so are two plugins each declaring one.
// Who declares a section is the author's choice; the mechanism is the same either way.
//
// Written down because a plugin with no centre view used to be impossible — a content view had to
// declare its sidebar, and A1 required every plugin drawing content to have one.
describe("a plugin that lives in a sidebar and nowhere else", () => {
  it("parses with one left view, no centre view, and no reference to who uses it", () => {
    const { manifest, validation } = parseManifest(
      {
        id: "soksak-plugin-file-tree",
        name: "File tree",
        version: "0.0.1",
        spec: "soksak-spec-plugin@0.0.1",
        description: { en: "A file tree", ko: "A file tree" },
        entry: "main.js",
        permissions: ["ui", "commands"],
        contributes: {
          views: [
            {
              id: "tree",
              title: { en: "Files", ko: "Files" },
              icon: "folder",
              placements: ["left"],
            },
          ],
          commands: [{ name: "reveal", title: { en: "Reveal", ko: "Reveal" } }],
        },
      },
      "soksak-plugin-file-tree",
    );
    expect(validation.errors).toEqual([]);
    expect(manifest?.contributes.views[0].placements).toEqual(["left"]);
    // Which pane it follows arrives at mount as view context (paneId), so a section names no plugin.
    expect(JSON.stringify(manifest)).not.toContain("terminal");
  });
});
