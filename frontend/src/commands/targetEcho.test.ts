// Target echo gate — a command that takes a target axis reports the resolved axis in its answer.
//
// (a) The rule this gate enforces
//   A core command that takes a target axis (workspace · space · panel/pane · view/tab) as a
//   parameter states in returns what that axis resolved to. An omitted axis is filled silently
//   from "caller context", so if the answer does not state the resolution the caller has no way
//   to tell where it ran. Verification then goes GREEN on a guess — real incident: a call with
//   the axis omitted went to "whatever was registered first" and answered success, and a wrong
//   verification passed across 6 runs.
//   One echo name per axis: workspace→projectId · space→spaceId · panel→panelId ·
//   pane→paneId · view→viewId · tab→tabId. If the name varies per axis the comparison itself
//   becomes impossible.
//
// (b) RED evidence (measured, 2026-07-26)
//   Of the 226 register blocks in src/commands/catalog*.ts, 46 commands take a target axis as a
//   parameter. 39 of those do not put the resolved axis in returns — 44 axis instances
//   (workspace 30 · space 3 · view 6 · pane 5; five commands omit two axes at once).
//   Example: space.activate takes workspace·space and answers with neither; panel.split takes
//   workspace and answers with panelId·viewId only.
//   The plan (enchanted-waddling-hollerith §5) recorded 35 here but the measurement is 39 — the
//   plan's number is not reproducible, so the measurement is canonical (R-A6).
//   The registry cannot be built without the app, so the sources are read instead
//   (the commandMessages.test · windowAxis.test approach).
//
// (c) The shell query that produced those numbers
//   npx vitest run src/commands/targetEcho.test.ts        # canonical — same numbers as the query below
//
//   node --input-type=module -e '
//   import {readdirSync,readFileSync} from "node:fs";
//   const d="src/commands",A={workspace:"projectId",space:"spaceId",panel:"panelId",pane:"paneId",view:"viewId",tab:"tabId"};
//   let n=0,o=[];
//   for(const f of readdirSync(d).filter(f=>/^catalog.*\.ts$/.test(f)&&!f.includes(".test."))){
//     const s=readFileSync(d+"/"+f,"utf8"),m=[...s.matchAll(/register\("([^"]+)", \{/g)];
//     m.forEach((x,i)=>{const b=s.slice(x.index,i+1<m.length?m[i+1].index:s.length);
//       const p=b.indexOf("params:"),r=b.indexOf("returns:",p);
//       const P=b.slice(p,r),R=b.slice(r).split(/\n {4}(?:message|errors|handler|examples|hint):/)[0];
//       const ax=Object.keys(A).filter(a=>new RegExp("\\n\\s+"+a+":").test(P));
//       if(!ax.length)return; n++;
//       const miss=ax.filter(a=>!new RegExp("\\b"+A[a]+"\\b").test(R));
//       if(miss.length)o.push(x[1]+" ["+miss.join(",")+"]");});}
//   console.log("axis-taking:",n,"offenders:",o.length);console.log(o.join("\n"));'
//
// The window axis (windowLabel) is outside this gate — the envelope already names that window,
// and windowAxis.test enforces that axis's identity separately.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** Axis name → the echo name required in the answer. One per axis. */
const AXIS_ECHO = {
  workspace: "projectId",
  space: "spaceId",
  panel: "panelId",
  pane: "paneId",
  view: "viewId",
  tab: "tabId",
} as const;
type Axis = keyof typeof AXIS_ECHO;
const AXES = Object.keys(AXIS_ECHO) as Axis[];

/** Spec keys that follow returns — the returns text is cut at the first of these. */
const AFTER_RETURNS =
  /\n {4}(?:message|errors|handler|examples|hint|triggers|danger|confirm|deprecated|schema):/;

type Block = { file: string; name: string; params: string; returns: string };

/** Every register("<name>", { ... }) block in the core catalog sources — up to the next register. */
function blocks(): Block[] {
  const dir = join(__dirname);
  const out: Block[] = [];
  for (const file of readdirSync(dir)) {
    if (!/^catalog.*\.ts$/.test(file) || file.includes(".test.")) continue;
    const src = readFileSync(join(dir, file), "utf8");
    const marks = [...src.matchAll(/register\("([^"]+)", \{/g)];
    marks.forEach((m, i) => {
      const start = m.index ?? 0;
      const end = i + 1 < marks.length ? (marks[i + 1].index ?? src.length) : src.length;
      const body = src.slice(start, end);
      // The params region runs from params: to just before returns: — the same name in the
      // handler body is not mistaken for a parameter. The returns region runs to the next spec key.
      const p = body.indexOf("params:");
      const r = body.indexOf("returns:", p < 0 ? 0 : p);
      const params = p < 0 ? "" : body.slice(p, r < 0 ? body.length : r);
      const tail = r < 0 ? "" : body.slice(r);
      const cut = tail.search(AFTER_RETURNS);
      out.push({
        file,
        name: m[1],
        params,
        returns: r < 0 ? "" : tail.slice(0, cut < 0 ? tail.length : cut),
      });
    });
  }
  return out;
}

/** Target axes that block takes as parameters. */
function axesOf(b: Block): Axis[] {
  return AXES.filter((a) => new RegExp(`\\n\\s+${a}:`).test(b.params));
}

/** Axes missing from the answer. */
function missingEcho(b: Block): Axis[] {
  return axesOf(b).filter((a) => !new RegExp(`\\b${AXIS_ECHO[a]}\\b`).test(b.returns));
}

const ALL = blocks();
const AXIS_TAKING = ALL.filter((b) => axesOf(b).length > 0);

describe("target echo — a command taking an axis answers what it resolved to", () => {
  it("the population is non-empty — an empty set must not pass as a green", () => {
    // If parsing breaks, violations become 0 and the gate dies silently. Pin the population first.
    expect(ALL.length).toBeGreaterThan(150);
    expect(AXIS_TAKING.length).toBeGreaterThan(30);
  });

  it("every command taking a target axis names that axis in returns", () => {
    const offenders = AXIS_TAKING.filter((b) => missingEcho(b).length > 0)
      .map((b) => `${b.name} [${missingEcho(b).join(",")}] (${b.file})`)
      .sort();
    expect(offenders).toEqual([]);
  });

  it("one echo name per axis — returns uses no other spelling of the axis name", () => {
    // Writing projectId as workspace_id or pjtId passes the check above but the caller cannot read it.
    const offenders: string[] = [];
    for (const b of AXIS_TAKING) {
      for (const a of axesOf(b)) {
        const wrong = new RegExp(`\\b(?:${a}_id|${a}Ident|${a}Key)\\b`, "i");
        if (wrong.test(b.returns)) offenders.push(`${b.name} [${a}] (${b.file})`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
