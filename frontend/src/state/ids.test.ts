// Entity id format — `<3-char prefix>-<6-char base32>`.
//
// (a) The rule this gate enforces
//     Every issued entity id matches /^(wsp|spc|pan|tab|spl|shl)-[a-z2-7]{6}$/.
//     **The prefix is exactly three characters and is 1:1 with the kind** — workspace=wsp /
//     space=spc / pane=pan / tab=tab / split=spl / shell session=shl. The string alone must show
//     what it is, and it must not be a counter so that it is globally unique. Window labels
//     (`win-<16 hex>`) are issued by the host but follow the same three-character rule.
//
// (b) RED evidence (measured, 2026-07-26)
//     The issuers in `src/state/sessions.ts` are counters — of the form `v${nextViewId++}`, so
//     newIds() produces `t2`, `v2`, `g2`, `s1`, `c2`. The prefix is unrelated to the name
//     (workspace is `t`, space is `c`), and it reseeds on every run so the same value reappears
//     across windows. So `{"panel":"g5"}` alone cannot determine which g5.
//
// (c) The shell query that produced those numbers
//     $ grep -nE '`[a-z]\$\{next[A-Za-z]*Id' src/state/sessions.ts | wc -l   # → 10
//       (5 issuers: newViewId, newGroupId, newSplitId, newContentId, workspace `t${nextProjectId++}`
//        + 5 previews: workspace, view, group, split, content in newIds())
//     $ npx vitest run src/state/ids.test.ts
//
// The rule stands without a registry or a window, so the app is not launched. Issued values are
// read through newIds() (a non-destructive preview — exactly the next value to be issued), and the
// shape of the issuers is counted by reading the source (the commandMessages.test approach).
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { newIds } from "./sessions";

const SRC_ROOT = join(__dirname, "..");

/** Entity id format — a three-character prefix plus 6 base32 (RFC4648 lowercase) characters. */
const ENTITY_ID = /^(wsp|spc|pan|tab|spl|shl)-[a-z2-7]{6}$/;
/** Counter shape — `t1`, `g5`, `v7`. Not globally unique, and the prefix is unrelated to the kind. */
const COUNTER_ID = /^[a-z]+\d+$/;

/** newIds() axis → the vocabulary entity and its prefix. */
const ENTITY_AXIS: {
  axis: "workspace" | "content" | "group" | "view" | "split";
  name: string;
  prefix: string;
}[] = [
  { axis: "workspace", name: "workspace", prefix: "wsp" },
  { axis: "content", name: "space", prefix: "spc" },
  { axis: "group", name: "pane", prefix: "pan" },
  { axis: "view", name: "tab", prefix: "tab" },
  { axis: "split", name: "split", prefix: "spl" },
];

const SRC = readFileSync(join(__dirname, "sessions.ts"), "utf8");
/** `x${nextXId...}` — where a counter is frozen into a string (the issuer and its preview). No
 *  exceptions: split uses the issuer too (corrected 2026-08-15), so no letter freezes a counter. */
const COUNTER_LITERAL = /`[a-z]\$\{next[A-Za-z]*Id/g;

describe("entity id format", () => {
  it("the counted set exists — an empty set does not pass as a pass", () => {
    const ids = newIds();
    expect(ENTITY_AXIS.map((e) => e.axis).every((a) => typeof ids[a] === "string")).toBe(true);
  });

  for (const { axis, name, prefix } of ENTITY_AXIS) {
    it(`a ${name} id is the ${prefix}- prefix plus 6 base32 characters`, () => {
      const id = newIds()[axis];
      expect(id).toMatch(ENTITY_ID);
      expect(id.startsWith(`${prefix}-`)).toBe(true);
    });
  }

  it("no counter-shaped id is issued — across windows the same value reappears", () => {
    const ids = newIds();
    const counters = ENTITY_AXIS.map((e) => ids[e.axis]).filter((id) => COUNTER_ID.test(id));
    expect(counters).toEqual([]);
  });

  it("each kind has its own prefix — a shared prefix makes the kind unreadable from the string alone", () => {
    const ids = newIds();
    const prefixes = ENTITY_AXIS.map((e) => ids[e.axis].split("-")[0]);
    expect(new Set(prefixes).size).toBe(ENTITY_AXIS.length);
  });
});

describe("the issuer itself does not freeze a counter", () => {
  it("the source has 0 `x${nextXId}` forms on an entity axis — fixing only the preview leaves issuing unchanged", () => {
    expect(SRC.match(COUNTER_LITERAL) ?? []).toEqual([]);
  });
});

// This section used to lock the opposite direction: "internal nodes have no name, so leave them as
// counters." That basis was not true — a split node's id is persisted and goes out in the
// canonicalLayout of `state.tree`. If the outgoing name is `s1`, two windows' trees share the same
// name and the reader can determine neither what it is nor which window it came from
// (corrected 2026-08-15).
describe("internal nodes of the layout tree take a prefix too", () => {
  it("a split id is the spl- prefix plus 6 base32 characters", () => {
    expect(newIds().split).toMatch(ENTITY_ID);
    expect(newIds().split.startsWith("spl-")).toBe(true);
  });

  it("two issues give two different values — counting does not restart at 1 per window", () => {
    expect(newIds().split).not.toBe(newIds().split);
  });
});

// The N1 body is generated in one place.
//
// docs/tech/NAMING.md N1 fixes one format for every identifier in this product.
// A second generator is a second definition of it: the two agree until one is
// edited, and the day they differ half the product's identifiers change shape
// with nothing reporting it.
//
// Measured 2026-08-16: frontend/src/framework/wails/streams.ts held its own copy
// — the same 32-letter alphabet, the same length, the same getRandomValues —
// and idScope.test.ts scans src/state and src/commands only, so that copy was
// under no gate at all.
it("generates the identifier body nowhere but here", () => {
  const OWNER = "state/ids.ts";
  const SELF = "state/ids.test.ts";
  // The alphabet is the mark. It cannot be written by accident and it has no
  // other use: a file holding it is generating an N1 body.
  const N1_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (!/\.tsx?$/.test(entry.name)) continue;
      const rel = path.slice(SRC_ROOT.length + 1);
      if (rel === OWNER || rel === SELF) continue;
      if (readFileSync(path, "utf8").includes(N1_ALPHABET)) offenders.push(rel);
    }
  };
  walk(SRC_ROOT);

  expect(offenders, "an identifier body comes from state/ids.ts").toEqual([]);
});
