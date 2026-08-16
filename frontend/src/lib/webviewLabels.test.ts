import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// A retired prefix is in neither source nor fixture.
//
// One and two character prefixes do not separate the kinds in this product (NAMING N1), and a
// fixture holding one exercises a shape no issuer produces.
//
// The single-source rule was here too, as a search for an inline `` `brw-${…}` ``. Both the kind
// and the owning file changed on 2026-08-16 — the grammar is lib/surfaceLabels.ts and the kind is
// the plugin's word — so that search matched nothing and the rule stood with nothing behind it. It
// moved to lib/surfaceLabelGrammar.test.ts, which refuses an assembly by its shape rather than by
// one kind's name.

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}

describe("webview label — one single truth", () => {
  it("a one or two character label prefix is in neither source nor fixture", () => {
    const retired = /["'`](b|w|pv|cv)-[a-z0-9]/;
    const offenders: string[] = [];
    for (const f of walk("src")) {
      if (f.endsWith("webviewLabels.test.ts")) continue; // mentions this pattern as a string
      const src = readFileSync(f, "utf8");
      for (const [index, line] of src.split("\n").entries()) {
        if (retired.test(line)) offenders.push(`${f}:${index + 1}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
