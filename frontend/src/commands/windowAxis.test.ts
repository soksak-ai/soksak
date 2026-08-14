// Window axis standard — a target the envelope already named is not required again as a parameter.
//
// RED evidence (measured, 2026-07-26): only window.close treated label as effectively required. The
// envelope had already named that window, yet the call died on a missing argument
// (`missing required key label` → INTERNAL), and the e2e gate could not close its own window, so
// each run left 3 more browser views behind (6 runs = 18).
//
// Writing the definition per command splits its meaning and its default. The window axis has one
// definition, P.windowLabel, and this gate holds that identity. The registry cannot be built without
// the app, so the source is read instead (same method as commandMessages.test).
//
// The webview axis (webview.recover's label = b-<win>-<view>) is a different id space — one window
// has several webviews, so omission has no single meaning; it is outside this rule and required is
// correct there.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The catalog is split across files (window, capture, health, DOM…). Hard-coding which file it is in
// means that the day the code moves, the gate silently counts an empty set and passes — the file
// list is discovered from the tree.
const SRC = readdirSync(__dirname)
  .filter((f) => /^catalog.*\.ts$/.test(f) && !f.endsWith(".test.ts"))
  .map((f) => readFileSync(join(__dirname, f), "utf8"))
  .join("\n");

/** register("<name>", { ... }) blocks — up to the next register. */
function blocks(): { name: string; body: string }[] {
  const out: { name: string; body: string }[] = [];
  const marks = [...SRC.matchAll(/ {2}register\("([^"]+)", \{/g)];
  marks.forEach((m, i) => {
    const start = m.index ?? 0;
    const end = i + 1 < marks.length ? (marks[i + 1].index ?? SRC.length) : SRC.length;
    out.push({ name: m[1], body: SRC.slice(start, end) });
  });
  return out;
}

/** The declared parameter section only — a label in the returns description or the handler body is
 *  not mistaken for a parameter. */
function paramsOf(body: string): string {
  const i = body.indexOf("params:");
  if (i < 0) return "";
  const j = body.indexOf("returns:", i);
  return body.slice(i, j < 0 ? body.length : j);
}

/** Commands that target a window and declare a label parameter. */
function windowAxis(): { name: string; body: string }[] {
  return blocks().filter(
    (b) => b.name.startsWith("window.") && /\blabel:/.test(paramsOf(b.body)),
  );
}

describe("the window axis has one definition", () => {
  it("commands that target a window exist — an empty set does not pass as a pass", () => {
    expect(windowAxis().map((b) => b.name).sort()).toEqual([
      "window.close",
      "window.focus",
      "window.maximize",
      "window.place",
      "window.restorePrevious",
    ]);
  });

  it("all use P.windowLabel — meaning and default do not diverge per command", () => {
    const offenders = windowAxis()
      .filter((b) => !/label: P\.windowLabel/.test(paramsOf(b.body)))
      .map((b) => b.name);
    expect(offenders).toEqual([]);
  });

  it("the window label is not required — the envelope already named the target", () => {
    expect(/windowLabel: \{[^}]*required: true/.test(SRC)).toBe(false);
  });

  it("all use the same resolution — a diverging shape drops omission handling somewhere", () => {
    const offenders = windowAxis()
      .filter((b) => !/windowTarget\(p\)/.test(b.body))
      .map((b) => b.name);
    expect(offenders).toEqual([]);
  });

  it("p.label does not pass straight to the backend — omission died there as a missing argument", () => {
    const offenders = windowAxis()
      .filter((b) => /label: p\.label\b/.test(b.body))
      .map((b) => b.name);
    expect(offenders).toEqual([]);
  });

  it("a missing window answers TARGET_NOT_FOUND — no internal argument error escapes", () => {
    const offenders = windowAxis()
      .filter((b) => !/"TARGET_NOT_FOUND"/.test(b.body))
      .map((b) => b.name);
    expect(offenders).toEqual([]);
  });
});

describe("a command that destroys itself flushes the reply first", () => {
  // RED evidence (measured, 2026-07-26): window.close called on its own window closed the window and
  // still returned WINDOW_DESTROYED — the channel that answers dies with that destruction. The
  // caller read success as failure, and e2e could not tell whether the reclaim happened.
  // window.reload already uses the same shape for the same reason: flush the reply first, run on the
  // next tick.
  const self = blocks().find((b) => b.name === "window.close")?.body ?? "";

  it("its own window is destroyed after setTimeout", () => {
    expect(/currentWindowLabel\(\)\) \{[\s\S]*setTimeout\(/.test(self)).toBe(true);
  });

  it("another window is destroyed at once — that channel is still open", () => {
    expect(/await invoke\("window_close", \{ label \}\);/.test(self)).toBe(true);
  });
});
