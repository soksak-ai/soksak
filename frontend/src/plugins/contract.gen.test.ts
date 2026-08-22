// Plugin contract publication + pin — the core builds contract.json from a single source. The Doctor gate consumes it.
// Normal run: verify the committed contract.json matches the live core values (RED on drift).
// Regeneration: running vitest with GEN=1 rewrites contract.json from the current core values (no hand-editing).
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { themeVarContract } from "./themeContract";

const FILE = join(process.cwd(), "src", "plugins", "contract.json");

function liveContract() {
  const theme = themeVarContract();
  return {
    themeVars: theme.vars,
    themeVocab: theme.vocab,
  };
}

describe("plugin contract.json — published by the core and pinned", () => {
  it("the committed contract.json matches the live core values (regenerate with GEN=1)", () => {
    const live = liveContract();
    if (process.env.GEN || !existsSync(FILE)) {
      writeFileSync(FILE, JSON.stringify(live, null, 2) + "\n");
    }
    const onDisk = JSON.parse(readFileSync(FILE, "utf8"));
    expect(onDisk).toEqual(live); // RED here: contract.json was not updated after a core permission or theme change — regenerate with GEN=1.
  });
});
