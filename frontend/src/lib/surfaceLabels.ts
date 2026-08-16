// The shape of a native surface's label — and nothing about what kind of surface it is.
//
// A surface label is `<kind>-<window>-<viewId>`. Two of those three parts are the core's business:
// a view id is already unique inside a window (state/ids.ts), and the window name is what makes the
// value unique across the whole application. Reclaiming a surface and filtering out labels whose
// parent window is gone both read that middle part.
//
// The kind is the plugin's word. This module never writes one down. Until 2026-08-16 it did — the
// core held `brw-` and handed a browser its own identifier through `app.webview.label(viewId)`, so
// the one plugin that owns a browser could not have been replaced without editing the core, and a
// second kind of surface had nowhere to get a label from.
//
// [RULE] Rebuilding a label inline drops the window part, and two windows then produce the same
// value (second window: no surface, or a surface nobody can address). Labels come from here only —
// surfaceLabels.test.ts fails the build on an inline rebuild.
import { currentWindowLabel } from "./webviewLabels";

/** The delimiter, and the alphabets that keep it out of every field (NAMING N3).
 *
 *  `-` occurs inside all three fields — a window name is `win-<body>`, a view id is `tab-<body>`,
 *  and a kind may hold one — so it cannot separate them. `/` is the separator of the store key
 *  `window/<name>` and of the topology path. `.` is what remains, and it is also the one character
 *  the public node address keeps rather than folding to `-`. */
const FIELD = ".";

/** A kind is the plugin's word: lowercase letters, digits and `-`, and nothing else.
 *
 *  Refused at assembly rather than at the reader. A value holding the delimiter has four fields and
 *  decomposes to nothing, and it would be handed to the compositor, written onto an element, and
 *  read back by a lookup that answers null with no fault reported anywhere. */
const KIND = /^[a-z][a-z0-9-]*$/;

/** The second and third fields are identifiers already issued (N1), which admit no delimiter. This
 *  refuses one that does, so an assembled label always decomposes. */
const FIELD_FREE = /^[^.]+$/;

function checkField(what: string, value: string, shape: RegExp): string {
  if (!shape.test(value)) {
    throw new Error(
      `a surface label ${what} is ${JSON.stringify(value)}; a field holds no ${JSON.stringify(FIELD)} and a kind is lowercase letters, digits and a dash`,
    );
  }
  return value;
}

/** The label a surface of this kind takes in a named window. */
export function surfaceLabelIn(kind: string, windowLabel: string, viewId: string): string {
  return `${surfaceLabelPrefixIn(kind, windowLabel)}${checkField("view", viewId, FIELD_FREE)}`;
}

/** Everything before the view id, for a surface of this kind in a named window.
 *
 *  Kind then window, widest scope first (N3): a comparison of these two fields selects one window's
 *  surfaces of one kind, and a sorted list groups them the same way. */
export function surfaceLabelPrefixIn(kind: string, windowLabel: string): string {
  return `${checkField("kind", kind, KIND)}${FIELD}${checkField("window", windowLabel, FIELD_FREE)}${FIELD}`;
}

/** The label a surface of this kind takes in this window. */
export function surfaceLabel(kind: string, viewId: string): string {
  return surfaceLabelIn(kind, currentWindowLabel(), viewId);
}

/** The three fields of a label, or null when the value is not one.
 *
 *  Exactly three. Fewer or more is not this grammar, and answering anyway would mean picking which
 *  field is which — the guess this rule exists to remove. */
function fieldsOf(label: string): [kind: string, window: string, view: string] | null {
  const parts = label.split(FIELD);
  if (parts.length !== 3) return null;
  if (parts.some((part) => part === "")) return null;
  return parts as [string, string, string];
}

/**
 * The view a surface label names, or null when the label is another window's.
 *
 * Kind-blind on purpose: a reader that matched on a kind would answer null for every surface except
 * the ones it had been taught about, and a new plugin's surface would be a label with no view
 * rather than an error.
 *
 * Split and indexed, never scanned. Locating the window by searching for it matched the name at
 * whatever position it occurred, so a kind ending in a window name yielded a view id taken from the
 * wrong field (measured 2026-08-16).
 */
export function viewIdFromSurfaceLabel(
  label: string,
  windowLabel: string = currentWindowLabel(),
): string | null {
  if (!windowLabel) return null;
  const fields = fieldsOf(label);
  if (!fields) return null;
  return fields[1] === windowLabel ? fields[2] : null;
}

/**
 * The labels whose parent window is gone.
 *
 * A surface outliving its window names no live window in its window field, so a window-local
 * comparison never sees it — a browser from a closed window floating over an empty one is that
 * shape.
 *
 * The window field alone, read by position. A label whose kind ends in a live window's name is an
 * orphan like any other, and the scan this replaces would have spared it.
 */
export function orphanSurfaceLabels(labels: string[], windows: string[]): string[] {
  return labels.filter((label) => {
    const fields = fieldsOf(label);
    return fields === null || !windows.some((name) => fields[1] === name);
  });
}

/**
 * The label a view's surface was actually declared under, read off the declaration.
 *
 * Read, not rebuilt. Rebuilding needs the kind, and the kind is the plugin's; the plugin has
 * already written both onto the element (`data-native-surface`, `data-native-surface-id`), so the
 * answer is there to be taken. A rebuild also agrees with itself about a label the plugin never
 * used, which is a lookup that finds nothing and reports no fault.
 *
 * Null when this view declares no surface — a terminal or a plugin body, which is most views.
 */
export function surfaceLabelOfView(viewId: string, doc: Document = document): string | null {
  const host = doc.querySelector<HTMLElement>(`[data-node="layout/tab/${cssIdent(viewId)}"]`);
  if (host) {
    const inside = host.querySelector<HTMLElement>("[data-native-surface-id]");
    const declared = inside?.dataset.nativeSurfaceId;
    if (declared) return declared;
  }
  // The pane holding no declaration is not the same as the view holding no surface. A surface
  // travelling between panes, or parked, is declared on an element the pane does not contain right
  // now, and answering null there would unpark nothing and park nothing.
  for (const el of doc.querySelectorAll<HTMLElement>("[data-native-surface-id]")) {
    const declared = el.dataset.nativeSurfaceId;
    if (declared && viewIdFromSurfaceLabel(declared) === viewId) return declared;
  }
  return null;
}

// A view id goes into a selector, and escaping exists in some environments and not others. Where it
// does not, an id with a special character silently selects something else — a lookup that finds
// the wrong pane rather than none.
function cssIdent(value: string): string {
  // Called on CSS, never detached: a bare reference has no `this` and throws where the environment
  // implements the WebIDL binding strictly.
  const css = (globalThis as { CSS?: { escape?: (v: string) => string } }).CSS;
  return css?.escape ? css.escape(value) : value.replace(/["\\]/g, "\\$&");
}
