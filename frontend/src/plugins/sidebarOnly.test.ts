import { describe, expect, it } from "vitest";
import { parseManifest } from "./spec";

// A plugin may live in a sidebar and nowhere else.
//
// A file list is used by a terminal, an editor and a browser alike, so it cannot be owned by one of
// them: the plugin that draws it is its own, with one region declared and no view in the centre.
// Nothing else has to change for that — a plugin declares the regions it is placed in, and `center`
// is not among them here.
//
// Written down because the design was first described with a terminal "providing" a file tree, which
// puts a shared thing inside one owner and is the coupling the whole arrangement exists to avoid.
describe("a plugin that lives in a sidebar and nowhere else", () => {
  it("parses with one left view, no centre view, and no reference to who uses it", () => {
    const { manifest, validation } = parseManifest(
      {
        id: "soksak-plugin-file-tree",
        name: "File tree",
        version: "0.0.1",
        spec: "0.0.1",
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
    // Which pane it follows arrives at mount as view context (paneId), so it names no plugin.
    expect(JSON.stringify(manifest)).not.toContain("terminal");
  });
});
