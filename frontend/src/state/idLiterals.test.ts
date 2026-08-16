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
// An identifier appears in test source in two positions, so there are two scans.
//
// **Object fields** — a `tabId` holding `t1`. The field name states the kind of its value. Matching
// on string shape alone would also catch `"v1"` (a version) and `"g2"` (a grid name), which makes
// noise, not a rule, so the counter check runs only where a field name is present.
//
// **Bare string literals** — a native surface label is `<kind>-<window>-<viewId>`
// (lib/surfaceLabels.ts) and it is passed as an argument, stored in no id field, so the field scan
// reads none of them. Measured 2026-08-16 in the running application:
// `browser-win-8ed56cd7d9305935-tab-2trqyu`.
//
// **How a literal is separated from a URL, a CSS class and a command name.** Two filters, in this
// order. First the shape: an identifier is lowercase words joined by hyphens and nothing else, so
// `https://example.org` (`:`, `/`), `window/win-1/view/tab-gggggg` (`/`) and
// `view.presentation.trace.close` (`.`) are dropped before any check reads them. Then the
// vocabulary: what survives is judged only when its first segment is a surface kind this product
// retired, or when it ends in an issued view id. `plugin-view-container` and `browser-chromium`
// pass both filters as text and are judged by neither, which is why a class name and an engine name
// raise nothing.
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

/** The prefixes ids.ts issues. A view id at the end of a surface label is one of these. */
const ISSUED_PREFIXES = "wsp|spc|pan|tab|spl|shl";

/** Surface kinds the core minted and stopped issuing. The kind is the plugin's word since
 *  2026-08-16 (lib/surfaceLabels.ts): the core wrote `brw-`, the browser plugin writes `browser-`.
 *  A retired kind in a fixture is a label no issuer produces, so the reader of that label — the
 *  window filter, the reclaim, the inventory lookup — is exercised on a value it never meets. */
const RETIRED_SURFACE_KINDS = ["brw"];

/** A retired kind with a label body after it. The bare fragment `brw-` is what a gate writes down
 *  in order to refuse it — webviewLabels.test.ts and the doc comment in idScope.test.ts both hold
 *  one — and no plugin hands a bare prefix to a surface. A label assembled from that fragment is
 *  read where it is written whole, by the check below it. */
const RETIRED_KIND = new RegExp(`^(?:${RETIRED_SURFACE_KINDS.join("|")})-[a-z0-9]`);

/** Lowercase words joined by hyphens, optionally left open for a template head
 *  (`` `brw-main-${viewId}` `` is one fixture written in two pieces). */
const IDENTIFIER_SHAPED = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*[.-]?$/;

/** An issued view id at the end of a longer value — the mark of a surface label.
 *
 *  Either delimiter, so the retired `-` grammar is still caught rather than passing unrecognised.
 *  A value that ends in a view id and is not a well-formed label is the defect this reports. */
const LABEL_TAIL = new RegExp(`[.-](?:${ISSUED_PREFIXES})-[a-z2-7]{6}$`);

/** `<kind>.<window>.<viewId>` — NAMING N3. Three fields, split by a delimiter no field admits.
 *
 *  The middle field is a host window name: `win-` plus an opaque body, or the reserved
 *  orchestrator name `main`. Without it two windows produce one label, and the second window's
 *  surface has no address of its own.
 *
 *  Joined by `.` since 2026-08-16. Joined by `-` the value could not be parsed at all — every
 *  field holds a `-` — so a reader searched for the window name at whatever position it occurred,
 *  and a kind ending in a window name yielded a view id from the wrong field.
 *
 *  The body is the one `validWindowName` admits (frameworks/wails/window_rules.go), which is wider
 *  than what `newWindowID` issues (six base32 characters since 2026-08-16, N1). A label is judged
 *  here against what the host accepts as a window name; the issuer's own shape is gated in
 *  frameworks/wails/window_id_test.go. */
const SURFACE_LABEL = new RegExp(
  `^[a-z][a-z0-9-]*\\.(?:win-[a-z0-9_-]+|main)\\.(?:${ISSUED_PREFIXES})-[a-z2-7]{6}$`,
);

/** The run of identifier characters after a quote. It stops at the first character an identifier
 *  never holds, so `<div data-native-surface-id="brw-a">` yields the value and not the markup. */
const QUOTED = /["'`]([A-Za-z0-9_.:/-]*)/g;

function testFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) testFiles(path, out);
    else if (/\.test\.tsx?$/.test(name)) out.push(path);
  }
  return out;
}

const ROOT = join(__dirname, "..");

/** Files that write a retired shape down in order to refuse it.
 *
 *  A gate holds the counter-example it rejects, and a gate that fired on its own subject would
 *  make every rule here unstatable. Both of these assert against the retired form by name. */
const GATES = new Set([
  "state/idLiterals.test.ts",
  "lib/surfaceLabelGrammar.test.ts",
]);

interface LiteralSite {
  rel: string;
  line: number;
  value: string;
}

let literalCache: LiteralSite[] | null = null;

/** Every quoted run in every test file, with the line it is on. */
function literalSites(): LiteralSite[] {
  if (literalCache) return literalCache;
  const out: LiteralSite[] = [];
  for (const path of testFiles(ROOT)) {
    const rel = path.slice(ROOT.length + 1);
    if (GATES.has(rel)) continue;
    readFileSync(path, "utf8")
      .split("\n")
      .forEach((text, index) => {
        for (const m of text.matchAll(QUOTED)) {
          if (m[1]) out.push({ rel, line: index + 1, value: m[1] });
        }
      });
  }
  literalCache = out;
  return out;
}

function identifierLiterals(): LiteralSite[] {
  return literalSites().filter((site) => IDENTIFIER_SHAPED.test(site.value));
}

function report(sites: LiteralSite[]): string[] {
  return [...new Set(sites.map((s) => `${s.rel}:${s.line}: "${s.value}"`))];
}

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

/** Literals opening with a kind the product no longer issues. */
function retiredKindSites(): string[] {
  return report(identifierLiterals().filter((site) => RETIRED_KIND.test(site.value)));
}

/** Literals ending in an issued view id whose remainder is not `<kind>-<window>`. */
function malformedLabelSites(): string[] {
  return report(
    identifierLiterals().filter(
      (site) => LABEL_TAIL.test(site.value) && !SURFACE_LABEL.test(site.value),
    ),
  );
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

describe("fixture surface labels are the shape the product actually issues", () => {
  it("the counted target exists — there are literals and hyphen-joined identifiers to check", () => {
    // Measured 2026-08-16: 16581 quoted runs, 2584 of them hyphen-joined identifiers. A bare word
    // is identifier-shaped too, so the second count reads the values a label is built from and a
    // scan that collapsed to single words could not pass it.
    const joined = identifierLiterals().filter((site) => site.value.includes("-"));
    expect({
      literals: literalSites().length > 5_000,
      identifiers: joined.length > 500,
    }).toEqual({ literals: true, identifiers: true });
  });

  it("no fixture opens with a retired surface kind", () => {
    expect(retiredKindSites()).toEqual([]);
  });

  it("a surface label fixture has a window name between its kind and its view id", () => {
    expect(malformedLabelSites()).toEqual([]);
  });

  it("the gate reads a label and passes over a URL, a class name, a path and a command", () => {
    // The grammar of NAMING N3: three fields split by a delimiter no field admits. The window body
    // is what validWindowName accepts, which is wider than what newWindowID issues.
    expect(SURFACE_LABEL.test("browser.win-8ed56cd7d9305935.tab-2trqyu")).toBe(true);
    expect(SURFACE_LABEL.test("browser.win-q4m2xr.tab-2trqyu")).toBe(true);
    expect(SURFACE_LABEL.test("browser.main.tab-2trqyu")).toBe(true);
    // A retired kind, a missing window, a view id that is not the issued shape.
    expect(RETIRED_KIND.test("brw-a")).toBe(true);
    expect(RETIRED_KIND.test("brw-main-tab-k6jivs")).toBe(true);
    expect(SURFACE_LABEL.test("browser.tab-2trqyu")).toBe(false);
    expect(SURFACE_LABEL.test("browser.win-a.tab-2")).toBe(false);
    // The retired join. Every field held the delimiter, so the value could not be split — it is
    // refused here rather than passing as something this gate does not recognise.
    expect(SURFACE_LABEL.test("browser-win-q4m2xr-tab-2trqyu")).toBe(false);
    for (const notAnIdentifier of [
      "https://example.org",
      "plugin-view-container",
      "window/win-1/view/tab-gggggg/content/browser-win-1-tab-gggggg",
      "view.presentation.trace.close",
      "window_focus_set",
      "browser-chromium",
    ]) {
      // These two conjunctions are the whole judgement a scanned literal receives.
      expect({
        value: notAnIdentifier,
        retired: IDENTIFIER_SHAPED.test(notAnIdentifier) && RETIRED_KIND.test(notAnIdentifier),
        label: IDENTIFIER_SHAPED.test(notAnIdentifier) && LABEL_TAIL.test(notAnIdentifier),
      }).toEqual({ value: notAnIdentifier, retired: false, label: false });
    }
  });
});
