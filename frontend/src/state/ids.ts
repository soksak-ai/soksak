// Entity id issuer. Prefixes, scope, and format are defined here only.
//
// Format: `<3-letter prefix>-<6 base32>`. Ids are globally unique and are not
// counters, so no value repeats across runs or windows. Counter ids (`g5`)
// encoded neither the kind nor the window.
//
// Prefix length is exactly three (user rule, 2026-08-15). One or two letters are
// ambiguous across the kinds in this product: `s-` matches space, split and
// session; `v-` matches view and value.
//
// Scope: layout entities and shell sessions. Axes such as schedule, secret and
// daemon use natural keys — a user-chosen name, or an (ns, key) pair — which are
// already unique and carry meaning, so an opaque id there removes information
// (C2). Violations fail the idScope gate.

/** Every id prefix in this product, including one issued elsewhere.
 *
 *  `win-` is issued by the host (frameworks/wails/window_rules.go), not by
 *  issueId: a window outlives the document inside it, and its name is also the
 *  key `window/<name>` in the snapshot store. It is listed here so that one
 *  table covers every prefix and no two kinds can take the same one. */
export const ID_PREFIX = {
  project: "pjt-",
  space: "spc-",
  pane: "pan-",
  tab: "tab-",
  // A split node also carries an id, and that id is stored and returned in
  // `state.tree` as part of canonicalLayout. It was once a counter, on the
  // ground that an internal node appears in no address, command or document.
  // That was not true of canonicalLayout.
  split: "spl-",
  shellSession: "shl-",
  // Issued by the host, not here. `WINDOW_ID_RE` below is its format.
  window: "win-",
} as const;

export type IdKind = keyof typeof ID_PREFIX;

/** The kinds this module issues. The window is issued by the host. */
export type IssuedKind = Exclude<IdKind, "window">;

/** Axes that keep natural keys. Issuing a prefixed id for one fails the idScope gate. */
export const NATURAL_KEY_AXES = [
  "daemon",
  "data.encrypt",
  "data.kv",
  "process",
  "registry",
  "schedule",
  "secret",
  "settings",
  "sidecar",
  "theme",
  "ui.projection",
  "webview",
] as const;

// base32 (RFC 4648 lowercase). The alphabet has no 0 or 1, so no value is
// confused with o or l. Six characters is 32^6, about 10^9. At this product's
// scale (tens of entities per window) a collision is not expected, and one
// resolves as `AMBIGUOUS` with candidates rather than as a wrong answer.
const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
const LEN = 6;

function randomBody(): string {
  let body = "";
  // crypto.getRandomValues exists in the renderer and in node (tests).
  // Math.random is not used.
  const buf = new Uint8Array(LEN);
  globalThis.crypto.getRandomValues(buf);
  for (const b of buf) body += ALPHABET[b % 32];
  return body;
}

/** Issues a new entity id. The only issuance point; assembling a prefix string
 *  elsewhere fails the gate.
 *
 *  The prefixes are written as literals, not read from the table: the idScope
 *  gate finds issuance points statically, and a dynamic lookup would hide one
 *  from it. The ids gate checks that the literals match the table. */
export function issueId(kind: IssuedKind): string {
  const body = randomBody();
  switch (kind) {
    case "project":
      return `pjt-${body}`;
    case "space":
      return `spc-${body}`;
    case "pane":
      return `pan-${body}`;
    case "tab":
      return `tab-${body}`;
    case "split":
      return `spl-${body}`;
    case "shellSession":
      return `shl-${body}`;
  }
}

/** Format of an issued entity id. Used by migration, the gates, and address
 *  resolution. */
export const ID_RE = /^(pjt|spc|pan|tab|spl|shl)-[a-z2-7]{6}$/;

/** Format of a workspace window name. The body is host-issued hex rather than
 *  base32, and the reserved orchestrator name `main` is outside it. */
export const WINDOW_ID_RE = /^win-[0-9a-f]{16}$/;

/** Reads the kind from the prefix. null for anything outside the format. */
export function kindOf(id: string): IdKind | null {
  if (!ID_RE.test(id)) return null;
  const prefix = `${id.slice(0, id.indexOf("-"))}-`;
  for (const [kind, p] of Object.entries(ID_PREFIX)) {
    if (p === prefix) return kind as IdKind;
  }
  return null;
}
