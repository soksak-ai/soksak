// id scope gate — prefixed ids are used only for layout entities and shell sessions.
//
// (a) What this gate enforces (standard §1-4d scope rule)
//     The id format standard (`<prefix>-<base32 6>`) applies only to **layout entities + shell sessions**.
//       layout entities : workspace(`wsp-`) · space(`spc-`) · pane(`pan-`) · tab(`tab-`)
//       shell session   : pty.session(`sh-`)
//     window is absent from that table — `win-<uuid4>` stays as is and the core issues it (§1-1).
//     Every other axis (schedule · secret · data.kv · data.encrypt · registry · daemon · theme ·
//     settings · sidecar · webview · process · ui.projection) **keeps its natural
//     key**. Putting an opaque prefixed id where a natural key already has meaning violates C2.
//     So this gate fails when an out-of-scope axis issues a prefixed id.
//
//     The scope must exist in code as a table. Without the table there is nowhere to ask "is this axis in
//     scope", and with nowhere to ask, issuance becomes a local judgment every time — exactly the state now.
//
// (b) RED evidence (measured, 2026-07-26)
//     · No issuer. `src/state/ids.ts` is absent — no single truth holds the scope table.
//     · 0 prefixed-id issuance sites. Current issuance is `v${n}`·`g${n}`·`s${n}`·`c${n}`·`t${n}`
//       at `sessions.ts:396-399,936` — one-letter initials, not prefixes, with no notion of scope.
//     · So this gate's RED is not "there is out-of-scope issuance" but "there is no table to ask scope of".
//       0 out-of-scope issuances is true today, but counting only that goes inert the moment an issuer exists.
//       An issuance anchor (issuance sites inside the issuer ≥ 1) is counted too, so an empty set cannot pass.
//
// (c) The shell queries that produced those counts (from the repo root)
//     ls src/state/ids.ts
//       → No such file or directory                                     (0 issuers)
//     grep -rnE '`(wsp|spc|pan|tab|sh)-\$\{' src/state src/commands | wc -l
//       → 0                                                (0 prefixed issuance sites)
//     grep -rnE '`[a-z]{1,5}-\$\{' src/state src/commands | grep -v '\.test\.' | wc -l
//       → 0                                      (no prefixed issuance in production)
//     grep -nE 'const new[A-Za-z]+Id = ' src/state/sessions.ts
//       → `v${nextViewId++}` · `g${...}` · `s${...}` · `c${...}`  (current issuance = initials)
//
// The registry and store cannot be built without the app and the issuer does not exist yet, so the source is
// read (same approach as commandMessages.test.ts and windowAxis.test.ts).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** The issuer (single truth) — the scope table and the issue function are here. */
const ISSUER = join(__dirname, "ids.ts");

/** The two axes scanned — state (where issuance happens) and commands (where issuance is called). */
const SCANNED_DIRS = [__dirname, join(__dirname, "..", "commands")];

/** Every prefix the table declares. `win-` is issued by the host, not by
 *  issueId, and it is listed so that one table covers every prefix. */
const IN_SCOPE: Record<string, string> = {
  workspace: "wsp-",
  space: "spc-",
  pane: "pan-",
  tab: "tab-",
  split: "spl-",
  shellSession: "shl-",
  streamReceiver: "stm-",
  window: "win-",
};

/** Prefixes issued in this module. `win-` is absent: the host issues it. */
const ISSUED_HERE = new Set(["wsp", "spc", "pan", "tab", "spl", "shl"]);

/** §1-4d ② axes that keep a natural key — issuing a prefixed id here is a violation. */
const NATURAL_KEY_AXES = [
  "daemon",
  "data.encrypt",
  "data.kv",
  "process",
  "registry",
  "schedule",
  "secret",
  "settings",
  "sidecar",
  "theme",
  "ui.projection",
  "webview",
];

/**
 * Prefixes of derived labels, not of issuance — not counted as violations.
 *   w = window label (`win-<uuid4>`, core-owned, kept as is, §1-1)
 *   b = webview label (`browser.<win>.<tab>`, derived from window and tab, §1-4d ②)
 * Neither issues a new identity — each only points at something that already exists.
 */
const DERIVED_LABEL_PREFIXES = new Set(["win", "brw"]);

interface Site {
  file: string;
  line: number;
  prefix: string;
}

/** Production source files — the tests do not count themselves. */
function sourceFiles(): { path: string; rel: string }[] {
  const out: { path: string; rel: string }[] = [];
  for (const dir of SCANNED_DIRS) {
    for (const f of readdirSync(dir)) {
      if (!/\.tsx?$/.test(f) || f.includes(".test.")) continue;
      out.push({ path: join(dir, f), rel: f });
    }
  }
  return out;
}

/**
 * id issuance sites — the form `` `<prefix>-${...}` `` or `"<prefix>-" + ...`.
 * Only 1 to 5 lowercase letters in the prefix position are matched (the head of the standard `<prefix>-<base32 6>`).
 */
function issuanceSites(): Site[] {
  const sites: Site[] = [];
  const patterns = [/`([a-z]{1,5})-\$\{/g, /"([a-z]{1,5})-"\s*\+/g];
  for (const { path, rel } of sourceFiles()) {
    const src = readFileSync(path, "utf8");
    const lines = src.split("\n");
    lines.forEach((text, i) => {
      for (const re of patterns) {
        re.lastIndex = 0;
        for (const m of text.matchAll(re)) {
          sites.push({ file: rel, line: i + 1, prefix: m[1] });
        }
      }
    });
  }
  return sites;
}

const at = (s: Site) => `${s.file}:${s.line} (${s.prefix}-)`;

/** Issuer source — an empty string when absent (that fact alone is RED). */
function issuerSource(): string {
  return existsSync(ISSUER) ? readFileSync(ISSUER, "utf8") : "";
}

/** Reads the entity→prefix table from `export const ID_PREFIX = { workspace: "wsp-", ... }`. */
function declaredPrefixTable(): Record<string, string> {
  const src = issuerSource();
  const block = /export const ID_PREFIX[^{]*\{([\s\S]*?)\}/.exec(src);
  if (!block) return {};
  const table: Record<string, string> = {};
  for (const m of block[1].matchAll(/(\w+)\s*:\s*"([a-z]{1,5}-)"/g)) table[m[1]] = m[2];
  return table;
}

/** Reads the out-of-scope axis list from `export const NATURAL_KEY_AXES = [ ... ]`. */
function declaredNaturalAxes(): string[] {
  const src = issuerSource();
  const block = /export const NATURAL_KEY_AXES[^[]*\[([\s\S]*?)\]/.exec(src);
  if (!block) return [];
  return [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort();
}

describe("id scope — a prefixed id is used only for layout entities and shell sessions", () => {
  it("there is exactly one issuer with the scope table", () => {
    expect({ issuer: "src/state/ids.ts", exists: existsSync(ISSUER) }).toEqual({
      issuer: "src/state/ids.ts",
      exists: true,
    });
  });

  it("the issuer's prefix table has five layout entities and one shell session — the window is not in it", () => {
    expect(declaredPrefixTable()).toEqual(IN_SCOPE);
  });

  // **A prefix is exactly three letters** (user rule 2026-08-15). One or two letters cannot separate the kinds —
  // a single `s-` does not separate space, split and session. Then the kind cannot be determined from the id
  // alone and the reader must check the context every time. Derived labels (window, browser
  // child webview) fall under the same rule — a label is also a name that must identify what it is by itself.
  it("every prefix is exactly three letters — issued ids and derived labels alike", () => {
    const short = [
      ...Object.entries(declaredPrefixTable()).map(([kind, p]) => `${kind}=${p}`),
      ...[...DERIVED_LABEL_PREFIXES].map((p) => `label=${p}-`),
    ].filter((row) => !/=[a-z]{3}-$/.test(row));
    expect(short).toEqual([]);
  });

  it("the issuer has the natural-key axes as a table — there is one place to ask what is out of scope", () => {
    expect(declaredNaturalAxes()).toEqual([...NATURAL_KEY_AXES].sort());
  });

  it("a natural-key axis does not appear in the prefix table — no axis is on both sides", () => {
    const both = Object.keys(declaredPrefixTable()).filter((k) =>
      declaredNaturalAxes().some((axis) => axis.split(".").pop() === k),
    );
    expect(both).toEqual([]);
  });

  it("a prefixed id is issued only inside the issuer", () => {
    const sites = issuanceSites();
    const outside = sites
      .filter((s) => s.file !== "ids.ts" && ISSUED_HERE.has(s.prefix))
      .map(at);
    const inside = sites.filter((s) => s.file === "ids.ts" && ISSUED_HERE.has(s.prefix));
    // inside anchor — with 0 issuance sites, "0 issuances outside" counted nothing.
    expect({ outside, issued: inside.length >= 1 }).toEqual({ outside: [], issued: true });
  });

  it("no prefixed id is issued for an out-of-scope axis", () => {
    const inScope = new Set(Object.values(IN_SCOPE).map((p) => p.slice(0, -1)));
    const offenders = issuanceSites()
      .filter((s) => !inScope.has(s.prefix) && !DERIVED_LABEL_PREFIXES.has(s.prefix))
      .map(at);
    expect(offenders).toEqual([]);
  });
});
