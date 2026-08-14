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
      if (/`b-\$\{/.test(src)) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });
});
