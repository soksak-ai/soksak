// Declarative vendor leak sweep — the pure logic the gate uses.
//
// An import leak is easy to catch statically and fails loudly (a missing module kills the build). A
// **declarative** leak throws nothing: the attribute is present with no meaning, the CSS property is ignored,
// and a global that does not exist is just `undefined`. With no caller, nothing happens at all.
//
// So **every** kind must be listed. Hunting one kind after hearing a symptom means waiting for the next
// symptom too — that is how `data-tauri-drag-region` was found (2026-07-28, no log at all until the user
// reported "the header does not drag").

/** Places a vendor leaks through declarations. When adding a framework, list its leaks here too. */
export const VENDOR_DECL: { re: RegExp; what: string }[] = [
  { re: /data-tauri-[a-z-]+/g, what: "attribute the Tauri webview intercepts" },
  { re: /-webkit-app-region/g, what: "Electron window drag CSS" },
  { re: /__TAURI__|__TAURI_INTERNALS__/g, what: "Tauri injected global" },
  { re: /tauri:\/\//g, what: "Tauri URL scheme" },
  { re: /asset:\/\//g, what: "Tauri asset protocol" },
  { re: /convertFileSrc/g, what: "Tauri asset URL conversion" },
  { re: /window\.electron\b/g, what: "Electron injection surface" },
];

/**
 * Strips comments — flagging a sentence that **explains** vendor behavior would delete that explanation, and
 * then the next person has no record of why the workaround exists (measured: a comment stating the reason for
 * **not** using `asset://` was flagged). Only what stays in code is a leak.
 *
 * A line comment counts only when the character before it is not `:`, a quote, or a word character — treating
 * the `//` in `tauri://` as a comment would hide that scheme leak forever.
 */
export function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/(^|[^:"'`\w])\/\/.*$/, "$1"))
    .join("\n");
}

/** Leaks found in one file. An empty array means clean. */
export function leaksIn(rel: string, source: string): string[] {
  const body = stripComments(source);
  const out: string[] = [];
  for (const { re, what } of VENDOR_DECL) {
    for (const m of body.matchAll(new RegExp(re.source, "g"))) {
      out.push(`${rel} → ${m[0]} (${what})`);
    }
  }
  return out;
}
