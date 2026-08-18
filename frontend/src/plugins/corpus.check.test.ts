import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseManifest } from "./spec";

// Every sample manifest is read by this build's parser, and every refusal states which kind it is.
//
// A sample that does not parse cannot be installed, so a refusal is the work left rather than a
// surprise found later. There are two kinds and they are told apart mechanically, not by a list
// somebody keeps up to date:
//
//   · it names the vocabulary this contract deleted — `placements` / `defaultPlacement`, from
//     before a view declared a surface (L11c: the old path is deleted, never mapped). Converting
//     one is a manifest edit made when that plugin is brought over, one at a time.
//   · anything else — named here, with why.
//
// The corpus is in the previous application's home and is read, never written: that application
// still runs on it.
const HOME = join(process.env.HOME ?? "", ".soksak-dev/plugins");

/** Named, with why. An entry stays only while its manifest still fails. */
const KNOWN_UNPARSED: Record<string, string> = {
  "soksak-plugin-editor-codemirror": "declares contributes.fileViewers — becomes a centre view with an open command",
  "soksak-plugin-media-viewer": "declares contributes.fileViewers — becomes a centre view with an open command",
};

/** The vocabulary a view used before it declared a surface. Read from the text, so a manifest
 *  carrying it is told from one that fails for its own reasons without anyone deciding. */
const NAMES_A_PLACE = /"(placements|defaultPlacement)"/;

type Sample = { dir: string; source: string; parses: boolean };

function corpus(): Sample[] {
  const out: Sample[] = [];
  for (const dir of readdirSync(HOME)) {
    const f = join(HOME, dir, "plugin.json");
    if (!existsSync(f)) continue;
    const source = readFileSync(f, "utf8");
    out.push({ dir, source, parses: parseManifest(JSON.parse(source), dir).manifest !== null });
  }
  return out;
}

describe("the sample corpus parses", () => {
  it("every refusal is one of the two kinds", () => {
    const samples = corpus();
    expect(samples.length).toBeGreaterThan(40);
    const unexplained = samples
      .filter((s) => !s.parses && !NAMES_A_PLACE.test(s.source) && !(s.dir in KNOWN_UNPARSED))
      .map((s) => s.dir);
    expect(unexplained).toEqual([]);
  });

  it("a manifest naming a place is refused, not quietly read", () => {
    // The oracle for the rule above: were the old keys accepted and dropped, this list would be
    // empty and the test above would pass while every one of these views stood somewhere its
    // author never chose.
    const carried = corpus().filter((s) => NAMES_A_PLACE.test(s.source));
    expect(carried.length).toBeGreaterThan(0);
    expect(carried.filter((s) => s.parses).map((s) => s.dir)).toEqual([]);
  });

  it("a name on the known list still fails — an entry that excuses nothing is an exemption nobody granted", () => {
    for (const s of corpus().filter((x) => x.dir in KNOWN_UNPARSED)) {
      expect(s.parses, `${s.dir} parses now — take it off the list`).toBe(false);
    }
  });
});
