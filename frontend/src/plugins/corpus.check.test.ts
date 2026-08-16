import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseManifest } from "./spec";

// Every sample manifest is read by this build's parser, and the ones that are not are named.
//
// A sample that does not parse cannot be installed, so the list is the work left rather than a
// surprise found later. Two are known: `contributes.fileViewers` was how a plugin declared it draws
// a file (CORE-CENSUS 1), and converting those two is a source change, not a manifest edit.
const HOME = join(process.env.HOME ?? "", ".soksak-dev/plugins");

/** Named, with why. An entry stays only while its manifest still fails. */
const KNOWN_UNPARSED: Record<string, string> = {
  "soksak-plugin-editor-codemirror": "declares contributes.fileViewers — becomes a centre view with an open command",
  "soksak-plugin-media-viewer": "declares contributes.fileViewers — becomes a centre view with an open command",
};

describe("the sample corpus parses", () => {
  it("every manifest is accepted except the ones named here", () => {
    const bad: string[] = [];
    let read = 0;
    for (const d of readdirSync(HOME)) {
      const f = join(HOME, d, "plugin.json");
      if (!existsSync(f)) continue;
      read += 1;
      const { manifest } = parseManifest(JSON.parse(readFileSync(f, "utf8")), d);
      if (!manifest && !(d in KNOWN_UNPARSED)) bad.push(d);
    }
    expect(read).toBeGreaterThan(40);
    expect(bad).toEqual([]);
  });

  it("a name on the known list still fails — an entry that excuses nothing is an exemption nobody granted", () => {
    for (const d of Object.keys(KNOWN_UNPARSED)) {
      const f = join(HOME, d, "plugin.json");
      if (!existsSync(f)) continue;
      const { manifest } = parseManifest(JSON.parse(readFileSync(f, "utf8")), d);
      expect(manifest, `${d} parses now — take it off the list`).toBeNull();
    }
  });
});
