import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { CHROME_SLOTS, COLOR_SLOTS, EFFECT_SLOTS } from "./tokens";

const FRONTEND = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

// The one file allowed to hold literal colours, because it is the definition of
// what a colour token means. Everything else asks for a slot.
const PALETTE = join("src", "theme", "tokens.ts");

const LITERAL_COLOUR = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\(/;

function stylesheets(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry === "bindings") continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      stylesheets(path, found);
    } else if (entry.endsWith(".css")) {
      found.push(path);
    }
  }
  return found;
}

describe("theme tokens", () => {
  it("declares every slot the engine will fill", () => {
    // A theme arrives as data. These names are the contract between that data
    // and every rule that paints, so they are asserted rather than assumed.
    expect(COLOR_SLOTS).toEqual([
      "bg", "card", "side", "inset",
      "fg", "fg2", "fg3", "bd",
      "acc", "accbg", "ok", "shadow",
    ]);
    expect(EFFECT_SLOTS).toEqual(["glow", "scan", "amb"]);
    expect(CHROME_SLOTS).toEqual([
      "titlebar", "tabBar", "tabShape", "paneStyle",
      "panePad", "gutter", "statusBg", "font",
    ]);
  });

  it("keeps literal colours out of every stylesheet", () => {
    const sheets = stylesheets(FRONTEND);
    expect(sheets.length).toBeGreaterThan(0);

    const offenders = sheets
      .filter((path) => LITERAL_COLOUR.test(readFileSync(path, "utf8")))
      .map((path) => relative(FRONTEND, path))
      .sort();

    // A rule that paints a literal cannot be re-themed. Every literal here is
    // one component that a future theme would have to rewrite rather than fill.
    expect(offenders).toEqual([]);
  });

  it("keeps literal colours out of components", () => {
    const sources: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.tsx?$/.test(entry) && !entry.endsWith(".test.ts") && !entry.endsWith(".test.tsx")) {
          sources.push(path);
        }
      }
    };
    walk(join(FRONTEND, "src"));

    const offenders = sources
      .filter((path) => relative(FRONTEND, path) !== PALETTE)
      .filter((path) => LITERAL_COLOUR.test(readFileSync(path, "utf8")))
      .map((path) => relative(FRONTEND, path))
      .sort();

    expect(offenders).toEqual([]);
  });
});
