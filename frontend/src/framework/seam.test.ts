import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// frontend/src — the scan root. A gate whose root vanishes reports zero
// violations and passes while enforcing nothing, so an empty scan fails loudly.
const SRC = dirname(dirname(fileURLToPath(import.meta.url)));

// The one leaf allowed to know the vendor, plus this gate, which cannot avoid
// naming what it forbids. Nothing else joins this list without a stated reason.
const EXEMPT = [join("framework", "wails"), join("framework", "seam.test.ts")];

const VENDOR = /wails/i;

function sources(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      sources(path, found);
    } else if (/\.tsx?$/.test(entry)) {
      found.push(path);
    }
  }
  return found;
}

const exempt = (path: string) =>
  EXEMPT.some((prefix) => relative(SRC, path) === prefix || relative(SRC, path).startsWith(prefix + sep));

describe("framework seam", () => {
  const files = sources(SRC);

  it("scans a non-empty tree", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it("keeps the vendor inside its adapter leaf", () => {
    const offenders = files
      .filter((path) => !exempt(path))
      .filter((path) => VENDOR.test(readFileSync(path, "utf8")))
      .map((path) => relative(SRC, path))
      .sort();

    // The core declares intent; the adapter translates it. A core file that
    // names the framework makes that framework an unremovable premise.
    expect(offenders).toEqual([]);
  });
});
