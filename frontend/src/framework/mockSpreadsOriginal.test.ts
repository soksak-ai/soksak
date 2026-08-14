// @vitest-environment node
// Never mock a module with a hand-written export list — when the contract grows, whatever is not on
// that list becomes undefined.
//
// When a test mocks the framework entry point and hand-writes the exported names, every time the
// contract gains one axis the tests missing from that list fail **for reasons unrelated to
// themselves**. Measured 2026-08-08: adding `setWindowZoom` alone to the contract broke three tests
// one after another that do not even use that name, all three from the same cause (the same spot was
// fixed three times in one turn).
//
// What to fix is not the tests but the way of mocking: spread the real module (`importOriginal`) and
// override only the names being replaced. Then the tests still hold as the contract grows.
//
// This rule applies to the framework entry point only — that module is the contract surface resolved
// by adapter selection, and the growing axes collect there. Widening it to other modules is not
// supported by this measurement.
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "..");
const SELF = "mockSpreadsOriginal.test.ts";

function sources(dir = ROOT, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) sources(p, out);
    else if (/\.test\.tsx?$/.test(entry.name)) out.push(p);
  }
  return out;
}

/** Sites that mock the framework entry point without spreading the real module.
 *
 * What is measured is **whether it spreads**, not what the callback was named — measuring by name
 * flags a correct site that calls `importOriginal` `orig` as a violation (measured: the first
 * version misjudged one such case).
 */
export function handListedFrameworkMock(source: string): boolean {
  const at = source.search(/vi\.mock\(\s*["'][^"']*\/framework["']\s*,/);
  if (at < 0) return false;
  // Search the factory head for "spread what was awaited". On one line or awaited into a variable then spread — same fact.
  const head = source.slice(at, at + 400);
  return !/\.\.\.\s*\(?\s*await\b/.test(head) && !/await\s+\w+\(\)[\s\S]{0,200}\.\.\./.test(head);
}

describe("a framework module mock spreads the real module", () => {
  it("no test imitates the framework with a hand-written list", () => {
    const offenders = sources()
      .filter((f) => !f.endsWith(SELF))
      .filter((f) => handListedFrameworkMock(readFileSync(f, "utf8")))
      .map((f) => f.slice(ROOT.length + 1));
    expect(offenders, "a new axis on the contract fails these places for an unrelated reason").toEqual([]);
  });

  // The gate is qualified by planting a violation.
  it("a planted hand-written list is caught", () => {
    const planted = ["vi.mock(", '"../framework"', ", () => ({ invoke }));"].join("");
    expect(handListedFrameworkMock(planted)).toBe(true);
  });

  it("the spread shape is not caught", () => {
    const spread = [
      "vi.mock(",
      '"../framework"',
      ", async (importOriginal) => ({ ...(await importOriginal()), invoke }));",
    ].join("");
    expect(handListedFrameworkMock(spread)).toBe(false);
    // The callback name is not the rule — the await-into-variable-then-spread shape must pass too.
    const named = [
      "vi.mock(",
      '"../framework"',
      ", async (orig) => { const real = await orig(); return { ...real, invoke }; });",
    ].join("");
    expect(handListedFrameworkMock(named)).toBe(false);
  });

  it("a mock of another module is ignored", () => {
    const other = ["vi.mock(", '"../i18n"', ', () => ({ tmsg: () => "" }));'].join("");
    expect(handListedFrameworkMock(other)).toBe(false);
  });
});
