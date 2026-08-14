// The whole style surface this app applies to the document — the single list every gate reads.
//
// Style is not one file: the core's (App.css) and each framework's own
// (framework/<name>/styles.css) both apply to the document. A gate that reads one file only
// loses a rule the moment it moves to another file, and the constitution empties out with
// nothing failing.
//
// So the list exists here only. A new framework with its own stylesheet is one line here, and
// from then on every gate checks it too.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = dirname(dirname(fileURLToPath(import.meta.url)));

/** Stylesheet paths that form the surface — one for the core, one per framework. */
export function styleSheetPaths(): string[] {
  const out = [join(SRC, "App.css")];
  const fw = join(SRC, "framework");
  for (const name of readdirSync(fw)) {
    const p = join(fw, name);
    if (!statSync(p).isDirectory()) continue;
    const css = join(p, "styles.css");
    try {
      if (statSync(css).isFile()) out.push(css);
    } catch {
      /* Framework with no styles — the absence is the fact */
    }
  }
  return out;
}

/** Raw CSS of the whole surface (one newline per boundary, so rules do not join and confuse parsing). */
export function styleSurface(): string {
  return styleSheetPaths()
    .map((p) => readFileSync(p, "utf8"))
    .join("\n");
}

/** Declarations only — comments are stripped. Counting comments flags the rationale written
 *  about an incident as a violation, which forces the rule to erase its own rationale. */
export function styleSurfaceRules(): string {
  return styleSurface().replace(/\/\*[\s\S]*?\*\//g, "");
}
