// Plugin contract publication + pin — the core builds contract.json from a single source. The Doctor gate consumes it.
// Normal run: verify the committed contract.json matches the live core values (RED on drift).
// Regeneration: running vitest with GEN=1 rewrites contract.json from the current core values (no hand-editing).
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PERMISSIONS, SPEC_VERSION } from "./spec";
import { themeVarContract } from "./themeContract";

const FILE = join(process.cwd(), "src", "plugins", "contract.json");

// Naming rule (the machine-enforceable part only): soksak-plugin- prefix + lowercase kebab segments. The
// category/name structure is not machine-enforced because standalone tools (kanban, erd, …) are exceptions —
// Doctor checks the format and id === directory only.
const ID_PATTERN = "^soksak-plugin-[a-z0-9]+(-[a-z0-9]+)*$";

function liveContract() {
  const theme = themeVarContract();
  return {
    specVersion: SPEC_VERSION,
    idPattern: ID_PATTERN,
    permissions: [...PERMISSIONS].sort(),
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
