// **Where an id is written, write an id.**
//
// The issuer emits only `<three-letter prefix>-<6 base32 chars>` (ids.ts). When a fixture writes
// `t1`, `v3`, or `g1`, the check runs on a shape the product never produces. Two things are lost:
// the code that reads the prefix never executes (a defect there surfaces only on the real device),
// and a human or agent reading this file takes `t1` for this product's id.
//
// Rule (user, 2026-08-15): an id takes a **three-letter prefix** that separates its kind. One or
// two letters do not separate — a single `s` points at space, split, and session at once.
//
// The check is limited to **fields that hold an id**. Matching on string shape alone would also
// catch `"v1"` (a version) and `"g2"` (a grid name), which makes noise, not a rule. The field name
// states the kind of its value, so counting happens only where that name is available.
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Fields holding a layout entity id — a value here must have the shape the issuer emits. */
const ID_FIELDS = [
  "id",
  "activeId",
  "activeTabId",
  "activeSpaceId",
  "activePaneId",
  "projectId",
  "spaceId",
  "paneId",
  "tabId",
  "viewId",
  "logicalPaneId",
  "boundTabId",
  "boundPaneId",
];

/** Counter names — `t1`, `v99`, `g5`. They state no kind and reappear across windows. */
const COUNTER = /^[a-z]{1,2}\d+$/;

/** Issuer shape — three-letter prefix + 6 base32 chars. Derived labels add the window name on top. */
const ISSUED = /^[a-z]{3}-[a-z2-7]{6}$/;

function testFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) testFiles(path, out);
    else if (/\.test\.tsx?$/.test(name)) out.push(path);
  }
  return out;
}

const ROOT = join(__dirname, "..");

/** One `<field>: "<value>"` site. A counter-shaped value is a violation. */
function counterIdSites(): string[] {
  const fields = ID_FIELDS.join("|");
  const re = new RegExp(`\\b(${fields})\\s*:\\s*"([^"]*)"`, "g");
  const found: string[] = [];
  for (const path of testFiles(ROOT)) {
    const rel = path.slice(ROOT.length + 1);
    const source = readFileSync(path, "utf8");
    for (const m of source.matchAll(re)) {
      if (COUNTER.test(m[2])) found.push(`${rel}: ${m[1]}: "${m[2]}"`);
    }
  }
  return found;
}

describe("fixture ids have the shape the product actually issues", () => {
  it("the counted target exists — there are files and sites to check", () => {
    const fields = ID_FIELDS.join("|");
    const re = new RegExp(`\\b(${fields})\\s*:\\s*"([^"]*)"`, "g");
    const sites = testFiles(ROOT).reduce(
      (n, path) => n + [...readFileSync(path, "utf8").matchAll(re)].length,
      0,
    );
    expect({ files: testFiles(ROOT).length > 50, sites: sites > 50 }).toEqual({
      files: true,
      sites: true,
    });
  });

  it("no id field holds a counter name", () => {
    expect(counterIdSites()).toEqual([]);
  });

  it("the two shapes this gate separates actually differ — the rule checks itself", () => {
    expect(COUNTER.test("t1")).toBe(true);
    expect(COUNTER.test("wsp-aaaaaa")).toBe(false);
    expect(ISSUED.test("wsp-aaaaaa")).toBe(true);
    expect(ISSUED.test("t1")).toBe(false);
    // A two-letter prefix is not the issued shape — exactly what this rule blocks.
    expect(ISSUED.test("sh-aaaaaa")).toBe(false);
  });
});
