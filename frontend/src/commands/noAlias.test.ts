// One name per behavior (standard S6 / symptom C5).
//
// (a) What this gate enforces
//     ① No alias declaration — a description that states "same as <other command>" fails.
//        Two names for one behavior make the caller guess which to use, and a fix lands on one side only.
//     ② No same verb with the same signature — when the last segment of the name (the verb) matches and the
//        declared (params, returns) signature matches too, it is one behavior from the outside. Only the names differ.
//     The signature is built from parameter name, type and required flag plus the returns string. Descriptions are
//     excluded: a different description is not evidence of a different meaning, only evidence that the same thing
//     was written twice.
//
//     ★ The plan's original rule (signature match alone is a violation) is corrected here — counted as written it
//     produces falsehoods. Three of the 6 measured pairs share only the signature while the behavior is opposite
//     or different:
//       plugin.enable ≡ plugin.disable            (id*) -> { id, status }
//       ui.projection.pin ≡ ui.projection.unpin   (project, ref*, side) -> { pins: {left, right} }
//       media.proxy.stream ≡ media.proxy.playlist (referer, url*, userAgent) -> { url }
//     A gate that judges antonyms as "one behavior" cannot reach GREEN (antonyms cannot be merged), and an
//     unreachable criterion is not kept. So verb equality was put into the verdict.
//     The "boundary" tests below keep that tightening from blinding the gate.
//     Synonyms with different verbs (view.close ≡ tab.remove and the like) are outside this gate — ① catches them.
//
// (b) RED evidence (measured, 2026-07-26): 1 alias declaration + 3 duplicate pairs.
//     - editor.close ≡ view.close (catalog.ts) — the description states "(same as view.close)", and
//       params `{ view* }` · returns `{ activePanelId, activeViewId }` match too.
//       The handler bodies match character for character (locateView → S().closeView).
//     - editor.open ≡ ui.intent.open (catalog.ts / catalogProjection.ts) — params
//       `{ path*, project }` · returns `{ viewId, panelId, existing }` match and both end in
//       openFileView. Split across files, it was invisible by eye.
//     - panel.resize ≡ sidebar.left.resize (catalog.ts) — params `{ project, split*, sizes* }` ·
//       returns `{}` match. split id has no type, so the signature does not identify which tree it is from.
//       (Plan §5 recorded 2 pairs — this third pair is added from measurement. R-A6)
//
// (c) The shell queries that produced those counts
//     # ① alias declarations = 1 (only a "same as" that names a command — gestures and regions excluded)
//     grep -rnE 'same as [a-z][A-Za-z]*\.[A-Za-z.]+' src/commands/catalog*.ts | grep -v '\.test\.'
//     #   → catalog.ts:2106  editor.close  "Close an editor view (same as view.close)."
//     # ② signature collision candidates — group by overlapping returns, then compare the params in those blocks
//     grep -rhE '^    returns:' src/commands/catalog*.ts | grep -v test | sort | uniq -c | sort -rn
//     grep -rn -B2 -A12 -E 'register\("(editor|view)\.(open|close)"|register\("ui\.intent\.open"' \
//       src/commands/catalog.ts src/commands/catalogProjection.ts
//     grep -rn -A14 -E 'register\("(panel|sidebar\.left)\.resize"' src/commands/catalog.ts
//     #   → 6 raw collision pairs, of which 3 pairs share the verb = the number this gate counts
//     # ③ rerun: npx vitest run src/commands/noAlias.test.ts
//
// The registry cannot be built without the app, so the source is read (same approach as commandMessages.test).
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const DIR = __dirname;

/** Files where core commands are registered — test files excluded. */
function catalogFiles(): string[] {
  return readdirSync(DIR)
    .filter((f) => /^catalog.*\.ts$/.test(f) && !f.endsWith(".test.ts"))
    .sort();
}

/** From the `{` position up to the matching `}`. Braces inside strings and comments are not counted. */
function balanced(src: string, open: number): string {
  let depth = 1;
  let i = open + 1;
  while (i < src.length && depth > 0) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      i += 1;
      while (i < src.length && src[i] !== quote) {
        if (src[i] === "\\") i += 1;
        i += 1;
      }
    } else if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i += 1;
    } else if (c === "/" && src[i + 1] === "*") {
      i = src.indexOf("*/", i) + 1;
    } else if (c === "{") depth += 1;
    else if (c === "}") depth -= 1;
    i += 1;
  }
  return src.slice(open + 1, i - 1);
}

/** Split on depth-0 commas only — commas inside nested objects and arrays are not entry boundaries. */
function topLevelEntries(inner: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < inner.length; i += 1) {
    const c = inner[i];
    // Comments are skipped before anything else, the way balanced() does it. An
    // English comment holds apostrophes (webview.recover's), and reading one as
    // a quote swallows every comma and brace until the next apostrophe — the
    // entries then merge and a parameter resolves to unknown. Measured
    // 2026-08-15: tab.close read (tab:unknown!) after its neighbouring comment
    // was translated, with the code byte-identical.
    if (c === "/" && inner[i + 1] === "/") {
      while (i < inner.length && inner[i] !== "\n") i += 1;
    } else if (c === "/" && inner[i + 1] === "*") {
      i = inner.indexOf("*/", i) + 1;
    } else if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      i += 1;
      while (i < inner.length && inner[i] !== quote) {
        if (inner[i] === "\\") i += 1;
        i += 1;
      }
    } else if ("{[(".includes(c)) depth += 1;
    else if ("}])".includes(c)) depth -= 1;
    else if (c === "," && depth === 0) {
      out.push(inner.slice(start, i));
      start = i + 1;
    }
  }
  out.push(inner.slice(start));
  return out.filter((e) => e.trim().length > 0);
}

type Param = { name: string; type: string; required: boolean };
type Command = {
  name: string;
  file: string;
  description: string;
  params: Param[];
  returns: string;
};

/** The catalog's shared parameter table (P) — resolves the type of references such as `P.view`.
 *
 *  One file owns the table and sibling catalogs import it. Resolving per file therefore turns every reference in
 *  a file without the table into unknown, and that unknown looks like a **silent pass**, not an error. */
function paramTable(src: string): Record<string, string> {
  const m = /\n(?:export )?const P = \{/.exec(src);
  if (!m) return {};
  const table: Record<string, string> = {};
  for (const entry of topLevelEntries(balanced(src, src.indexOf("{", m.index)))) {
    const key = /([A-Za-z_]\w*)\s*:/.exec(entry);
    const type = /type:\s*"([^"]+)"/.exec(entry);
    if (key) table[key[1]] = type ? type[1] : "unknown";
  }
  return table;
}

/** One field of one register block — up to the next field (a key indented 4 spaces). */
function field(block: string, key: string): string {
  const m = new RegExp(`\\n {4}${key}:`).exec(block);
  if (!m) return "";
  const rest = block.slice(m.index + m[0].length);
  const next = /\n {4}[A-Za-z_]\w*:/.exec(rest);
  return next ? rest.slice(0, next.index) : rest;
}

/** Concatenated string literals joined into one line — a description split across lines is read intact. */
function literalText(raw: string): string {
  return [...raw.matchAll(/"((?:[^"\\]|\\.)*)"|`([^`]*)`/g)]
    .map((m) => m[1] ?? m[2] ?? "")
    .join(" ")
    .replace(/\\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseParams(block: string, table: Record<string, string>): Param[] {
  const m = /\n {4}params:\s*\{/.exec(block);
  if (!m) return [];
  const inner = balanced(block, block.indexOf("{", m.index + m[0].length - 1));
  const out: Param[] = [];
  for (const entry of topLevelEntries(inner)) {
    const key = /([A-Za-z_]\w*)\s*:/.exec(entry);
    if (!key) continue;
    const value = entry.slice(entry.indexOf(":", key.index) + 1);
    const inline = /type:\s*"([^"]+)"/.exec(value);
    const ref = /P\.([A-Za-z_]\w*)/.exec(value);
    out.push({
      name: key[1],
      type: inline ? inline[1] : ref ? (table[ref[1]] ?? "unknown") : "unknown",
      required: /required:\s*true/.test(value),
    });
  }
  return out;
}

function commands(): Command[] {
  const out: Command[] = [];
  // The table is collected once across the whole catalog — a reference means the same whichever file holds it.
  const table: Record<string, string> = {};
  for (const file of catalogFiles()) {
    Object.assign(table, paramTable(readFileSync(join(DIR, file), "utf8")));
  }
  for (const file of catalogFiles()) {
    const src = readFileSync(join(DIR, file), "utf8");
    const marks = [...src.matchAll(/\n {2}register\("([^"]+)", \{/g)];
    marks.forEach((mark, i) => {
      const start = mark.index ?? 0;
      const end = i + 1 < marks.length ? (marks[i + 1].index ?? src.length) : src.length;
      const block = src.slice(start, end);
      out.push({
        name: mark[1],
        file,
        description: literalText(field(block, "description")),
        params: parseParams(block, table),
        returns: literalText(field(block, "returns")),
      });
    });
  }
  return out;
}

const ALL = commands();
const NAMES = new Set(ALL.map((c) => c.name));

/** Parameter name, type and required flag plus the shape of the answer. The description is not the signature. */
function signature(c: Command): string {
  const params = c.params
    .map((p) => `${p.name}:${p.type}${p.required ? "!" : ""}`)
    .sort()
    .join(",");
  return `(${params}) -> ${c.returns}`;
}

/** The last segment of the name — what that command does (the verb). */
function verb(name: string): string {
  return name.slice(name.lastIndexOf(".") + 1);
}

/** Groups of commands with the same signature — raw collisions (before the verb comparison). */
function collisions(): Command[][] {
  const bySig = new Map<string, Command[]>();
  for (const c of ALL) {
    // Commands that take nothing and return nothing are not evidence of one behavior even when their signatures
    // match — they simply declared nothing to distinguish them by.
    if (c.params.length === 0 && !/[A-Za-z]/.test(c.returns)) continue;
    const sig = signature(c);
    bySig.set(sig, [...(bySig.get(sig) ?? []), c]);
  }
  return [...bySig.values()].filter((group) => group.length > 1);
}

describe("what the gate counts is pinned first", () => {
  it("commands were actually read — an empty set does not pass as a pass", () => {
    expect(ALL.length).toBeGreaterThan(200);
    expect(NAMES.has("tab.close")).toBe(true);
    expect(NAMES.has("ui.intent.open")).toBe(true);
  });

  it("signatures were actually read — a silently empty parse reports 0 duplicates", () => {
    const tab = ALL.find((c) => c.name === "tab.close");
    expect(signature(tab!)).toBe(
      "(tab:string!) -> { tabId(closed), activePaneId, activeTabId }",
    );
    const resize = ALL.find((c) => c.name === "pane.resize");
    expect(signature(resize!)).toBe(
      "(edge:string!,pane:string,ratio:number!) -> { paneId, gutter:{pane,edge}(canonical), sizes }",
    );
  });
});

describe("one behavior has one name", () => {
  it("no command's own description declares it an alias of another command", () => {
    const aliases = ALL.flatMap((c) =>
      [...c.description.matchAll(/same as ([a-z][A-Za-z]*(?:\.[A-Za-z]+)+)/g)]
        .map((m) => m[1].replace(/\.$/, ""))
        .filter((target) => NAMES.has(target) && target !== c.name)
        .map((target) => `${c.name} → ${target} (${c.file})`),
    ).sort();
    expect(aliases).toEqual([]);
  });

  it("no command pair shares both a verb and a signature", () => {
    const pairs = collisions()
      .flatMap((group) => {
        const byVerb = new Map<string, Command[]>();
        for (const c of group) byVerb.set(verb(c.name), [...(byVerb.get(verb(c.name)) ?? []), c]);
        return [...byVerb.values()]
          .filter((same) => same.length > 1)
          .map(
            (same) =>
              `${same.map((c) => c.name).sort().join(" ≡ ")}  ${signature(same[0])}`,
          );
      })
      .sort();
    expect(pairs).toEqual([]);
  });
});

describe("the boundary — verb comparison does not blind the gate", () => {
  // The cost of putting verb equality into the verdict is kept visible here. The pairs below share a signature
  // but the behavior is opposite or different — this is the boundary that keeps unmergeable things from being
  // called violations, not an exception that softens signature comparison. If this list grows, the signature
  // itself no longer identifies its target: go back to §5 and rebuild the criterion.
  it("antonym pairs with the same signature exist — calling those violations makes GREEN unreachable", () => {
    const raw = collisions().map((group) => group.map((c) => c.name).sort().join(" ≡ ")).sort();
    expect(raw).toContain("plugin.disable ≡ plugin.enable");
    expect(raw).toContain("ui.projection.pin ≡ ui.projection.unpin");
  });

  it("a pair sharing a verb cannot hide in that antonym list", () => {
    expect(verb("plugin.enable")).not.toBe(verb("plugin.disable"));
    expect(verb("pane.resize")).toBe(verb("sidebar.left.resize"));
    expect(verb("tab.open")).toBe(verb("ui.intent.open"));
  });
});
