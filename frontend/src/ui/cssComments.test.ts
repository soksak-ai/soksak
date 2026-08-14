// CSS comment pairing — one mismatch and **the declarations after it disappear silently.**
//
// RED evidence (measured 2026-07-28, live window): the left and right borders of
// `.sidebar.rail-ground` never reached the screen — border-left-style was none and color was the
// initial value (rgb(0,0,0)). Sibling blocks on the same selector (background/box-shadow) applied
// fine and `--bd` resolved at that same site. The cause was not the cascade but a comment: one
// comment held `*/` in its body (`rail-ground-*/rail-pane-*`) and closed there, the leftover tail
// became top-level garbage, and CSS error recovery discarded **the entire next block**. At another
// site only the rules were deleted, leaving two comment header lines and the comment open.
//
// Nothing reports this defect as an error — the file is still valid CSS and the build passes.
// Only declarations vanish, so it surfaces only as "why is this line not showing". So a machine,
// not human eyes, pairs the comments. The parser uses the same rule as the browser: the **first**
// `*/` after `/*` closes it. There is no nesting.
//
// Do not lower the standard — when it trips, fix the comment (space out a `*/` in the body, delete leftover headers).

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(process.cwd(), "src");

function cssFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...cssFiles(p));
    else if (name.endsWith(".css")) out.push(p);
  }
  return out.sort();
}

type Finding = { where: string; what: string; text: string };

/** Pairs comments by the same rule as the browser — the first `*​/` after `/*` closes it. */
function scan(path: string): Finding[] {
  const src = readFileSync(path, "utf8");
  const lines = src.split("\n");
  const rel = relative(process.cwd(), path);
  const at = (pos: number) => src.slice(0, pos).split("\n").length;
  const found: Finding[] = [];
  const note = (pos: number, what: string) =>
    found.push({ where: `${rel}:${at(pos)}`, what, text: lines[at(pos) - 1].trim().slice(0, 90) });

  let i = 0;
  let inComment = false;
  let openedAt = 0;
  while (i < src.length - 1) {
    const two = src.slice(i, i + 2);
    if (!inComment && two === "/*") {
      inComment = true;
      openedAt = i;
      i += 2;
      continue;
    }
    if (inComment && two === "*/") {
      inComment = false;
      i += 2;
      continue;
    }
    // `/*` in a comment body — the next `*​/` closes the outer comment and shifts every later pair.
    if (inComment && two === "/*") {
      note(i, "`/*` inside a comment body");
      i += 2;
      continue;
    }
    // `*​/` outside a comment — error recovery starts here and the next block is discarded whole.
    if (!inComment && two === "*/") {
      note(i, "`*/` outside a comment");
      i += 2;
      continue;
    }
    i += 1;
  }
  if (inComment) note(openedAt, "unclosed comment");
  return found;
}

describe("CSS comment pairing", () => {
  const files = cssFiles(ROOT);

  // Oracle liveness — with an empty target set this check passes while guarding nothing.
  it("there is CSS to check", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files.map((f) => [relative(process.cwd(), f), f] as const))(
    "%s closes its comments where they were opened",
    (_rel, path) => {
      const found = scan(path);
      const report = found.map((f) => `  ${f.where}  ${f.what}\n    ${f.text}`).join("\n");
      expect(found, `comment pairing is broken — the declarations after it disappear silently:\n${report}`).toEqual([]);
    },
  );
});
