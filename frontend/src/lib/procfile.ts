// Procfile parser and serializer (pure) — single truth for project daemon declarations. Follows the standard
// convention (foreman family, `name: command` lines) exactly and adds no non-standard extension. daemon.add/remove
// edit the file through this module, so a round trip preserving human-written comments, blank lines and order is the contract.

export interface ProcfileEntry {
  name: string;
  cmd: string;
}

/** Parse result for one line — either an entry, or raw text kept as-is (comment, blank line, non-conforming line). */
type Line = { kind: "entry"; name: string; cmd: string } | { kind: "raw"; text: string };

const ENTRY = /^([A-Za-z0-9_-]+):\s*(.+?)\s*$/;

function parseLines(text: string): Line[] {
  return text.split("\n").map((raw): Line => {
    const m = ENTRY.exec(raw);
    if (m && !raw.trimStart().startsWith("#")) return { kind: "entry", name: m[1], cmd: m[2] };
    return { kind: "raw", text: raw };
  });
}

/** Procfile body → daemon declaration list. On a repeated name the last declaration wins (standard practice). */
export function parseProcfile(text: string): ProcfileEntry[] {
  const out = new Map<string, string>();
  for (const l of parseLines(text)) {
    if (l.kind === "entry") out.set(l.name, l.cmd);
  }
  return [...out.entries()].map(([name, cmd]) => ({ name, cmd }));
}

/** Add or replace an entry — an existing name keeps its position and only cmd changes; otherwise it is appended at the end.
 *  Comments, blank lines and order are preserved as-is (respect human edits). */
export function upsertEntry(text: string, name: string, cmd: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error(tmsg("msg.daemon.nameInvalid", { name }));
  const lines = parseLines(text);
  let replaced = false;
  const out = lines.map((l) => {
    if (l.kind === "entry" && l.name === name && !replaced) {
      replaced = true;
      return `${name}: ${cmd}`;
    }
    return l.kind === "raw" ? l.text : `${l.name}: ${l.cmd}`;
  });
  if (!replaced) {
    // Not inserted before the trailing blank lines; appended as one line after the last content.
    while (out.length && out[out.length - 1].trim() === "") out.pop();
    out.push(`${name}: ${cmd}`);
  }
  // The tail is normalized to a single newline (inner blank lines preserved) — repeated edits do not grow the tail.
  return out.join("\n").replace(/\n*$/, "") + "\n";
}

/** Remove an entry — deletes only the declaration line with that name and preserves the rest. Absent name returns the original text. */
export function removeEntry(text: string, name: string): { text: string; removed: boolean } {
  const lines = parseLines(text);
  let removed = false;
  const out: string[] = [];
  for (const l of lines) {
    if (l.kind === "entry" && l.name === name) {
      removed = true;
      continue;
    }
    out.push(l.kind === "raw" ? l.text : `${l.name}: ${l.cmd}`);
  }
  return { text: out.join("\n"), removed };
}
