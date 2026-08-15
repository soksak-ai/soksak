import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// [rule enforcement] Browser webview labels derive only from the single source of truth in
// webviewLabels.ts (browserLabel). Scattered inline `brw-${...}` definitions drop the window
// namespace, so labels collide across multiple windows (second-window browser not created, zombies).
// This test blocks that regression at build time — same track as the MW1 and capability guards.

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}

describe("webview label — one single truth", () => {
  it("no inline `brw-${...}` browser label is assembled outside webviewLabels", () => {
    const offenders: string[] = [];
    for (const f of walk("src")) {
      if (f.endsWith("webviewLabels.ts")) continue; // the single truth itself
      if (f.endsWith("webviewLabels.test.ts")) continue; // mentions this pattern as a string
      const src = readFileSync(f, "utf8");
      if (/`brw-\$\{/.test(src)) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });

  // **A retired prefix never comes back.** A label is an id too, and an id prefix is three characters
  // (state/ids.ts). `b-`, `w-`, and `pv-` are the previous generation; one leftover is enough for the
  // next person who reads that string to copy it as this repository's grammar. That is why fixtures
  // are counted too.
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
