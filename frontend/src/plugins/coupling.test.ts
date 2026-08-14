import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = dirname(dirname(fileURLToPath(import.meta.url)));

// Which plugins exist is one decision, and it lives in the composition root.
// That directory is the whole cost of adding a plugin; everything above it
// routes by opaque id. This gate names what it forbids, so it exempts itself.
const EXEMPT = ["boot", join("plugins", "coupling.test.ts")];

const PLUGIN_ID = /soksak-plugin-/;

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

describe("plugin coupling", () => {
  const files = sources(SRC);

  it("scans a non-empty tree", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it("never names a concrete plugin outside the boot door", () => {
    const offenders = files
      .filter((path) => !exempt(path))
      .filter((path) => PLUGIN_ID.test(readFileSync(path, "utf8")))
      .map((path) => relative(SRC, path))
      .sort();

    // Adding a plugin must cost the core zero lines. A core that spells a
    // plugin id has already made that plugin non-removable.
    expect(offenders).toEqual([]);
  });
});
