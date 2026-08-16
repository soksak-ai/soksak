import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// A surface the core mounts has a way in.
//
// The plugin manager — install, consent, enable and disable, update, remove, and the reason a plugin
// was refused — hung off the right sidebar's icon rail. The rail went with the region rule (A2a) and
// the manager moved to a modal, and nothing called it: the only `setPluginManagerOpen` in the build
// was the modal closing itself. Measured 2026-08-17. The comment above it stated that it opened from
// a command and from settings; neither existed.
//
// So the rule is not about that one surface. Every open flag this store holds is set to true
// somewhere other than the component it opens, and a flag that only closes itself fails here.
const SRC = join(process.cwd(), "src");

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) sources(path, out);
    else if (/\.tsx?$/.test(entry.name) && !/\.test\./.test(entry.name)) out.push(path);
  }
  return out;
}

const ui = readFileSync(join(SRC, "state", "ui.ts"), "utf8");
const files = sources(SRC);

/** Every `setXOpen`-shaped setter this store declares. */
const setters = [...ui.matchAll(/^\s{2}(set\w*Open):\s*\(/gm)].map((m) => m[1]);

describe("an open flag the ui store holds", () => {
  it("declares at least one, so this rule is measured", () => {
    expect(setters.length).toBeGreaterThan(0);
  });

  it.each(setters)("%s is called with true from outside the surface it opens", (setter) => {
    const openers = files.filter((file) => {
      if (file.endsWith(join("state", "ui.ts"))) return false;
      const body = readFileSync(file, "utf8");
      const calls = [...body.matchAll(new RegExp(`${setter}\\(([^)]*)\\)`, "g"))];
      return calls.some((call) => call[1].trim() === "true");
    });
    expect(openers, `nothing opens ${setter}; the surface it mounts cannot be reached`).not.toEqual([]);
  });
});
