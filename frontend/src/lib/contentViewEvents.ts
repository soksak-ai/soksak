// Content view event bridge — re-emits what the <webview> tag fires under the names the app uses.
//
// The app subscribes to `browser-<event>` filtered by label (src/plugins/deps.ts). On Tauri
// webview.rs emits those, but in a framework where the content is inside the DOM the event is
// already in this renderer — no reason to send it out of the process and take it back. emitLocal
// is that slot.
//
// **Names and fields are exactly the source's.** A subscriber gets no information about their
// origin, and if they differ the same code sees different things per framework.
//
// The source is the core: the payload in `webview.rs` is `#[serde(rename_all = "camelCase")]`, so
// the names actually emitted are `canBack`/`canForward`. Consumers read those too (the shipped
// browser-native and browser-chromium read `p.canBack`). This slot once emitted snake_case and the
// comment and the check enforced that wrong standard — meanwhile nobody could read the events this
// framework emitted, and the symptom was not an error but a **permanently disabled back button**
// (measured 2026-08-01).
import { emitLocal } from "../framework";

/** Event names — the canonical source is the content view spec (the webview-event-scan gate
 *  compares the two values). TS cannot read the core constants, so this is a copy; if they
 *  diverge, the events this framework emits arrive nowhere. */
/**
 * Wire names of content view events — the canonical source is the content view spec.
 *
 * The names contain no `browser`. The entity the core owns is the content view, and "browser" is
 * a plugin's word (C1). Plugins subscribe by short key (`app.webview.on(label, "nav", …)`), so
 * this table is not exposed to plugins — do not assemble a name, **pick one from here**.
 */
export const CONTENT_VIEW_EVENT = {
  nav: "content-view-navigated",
  title: "content-view-title",
  loading: "content-view-loading",
  status: "content-view-status",
  openExternal: "content-view-open-external",
  /** The user clicked this view — the only fact pane binding must follow (spec-content-view ACTIVATED). */
  activated: "content-view-activated",
  /** Window-open request the framework reported by handle — the seam converts it to a label and
   *  re-emits it as `openExternal`. The reason for the separate name is in the
   *  spec-content-view OPEN_EXTERNAL_RAW preamble. */
  openExternalRaw: "content-view-open-external:raw",
} as const;

/**
 * Fields of the events the tag fires — **they sit directly on the event object.**
 *
 * They are not a CustomEvent detail. Read through detail the value is always undefined, so no
 * event is emitted, and that silence is not an error but "the address bar stops at about:blank"
 * (measured 2026-07-28: the page rendered but the URL bar did not follow).
 */
function field<T>(e: Event, key: string): T | undefined {
  return (e as unknown as Record<string, T>)[key];
}

/** Tag event → app event. The source is that adapter's webview contract. */
type Tag = HTMLElement & {
  canGoBack?: () => boolean;
  canGoForward?: () => boolean;
};

/**
 * Navigation — emits the URL together with **whether the document changed**.
 *
 * Without `inPage` a consumer cannot tell a new document from a move inside the same document, and
 * a rule like "reset the title to the URL so the previous title does not linger" runs on every
 * navigation. On a repeat navigation to the same document the engine does not re-emit the title,
 * so the real title is overwritten by the URL (measured 2026-08-02: the tab name froze at
 * `www.google.com` instead of "Google" — every event arrived and each later nav overwrote it).
 */
function nav(label: string, inPage: boolean) {
  return (e: Event) => {
    const url = field<string>(e, "url");
    if (typeof url === "string") emitLocal(CONTENT_VIEW_EVENT.nav, { label, url, inPage });
  };
}

/**
 * Query the tag — **if the query fails, that failure is the answer.**
 *
 * `canGoBack`/`canGoForward` internally resolve the guest id (`getWebContentsId`). Called from a
 * load event that arrives before `dom-ready` they throw, and because the call is inside an event
 * handler the exception escapes as **Uncaught** and breaks the boot path (measured 2026-08-01
 * stack: canGoBack → getWebContentsId).
 *
 * Being unable to query yet is a fact: before readiness there is no history, so `false` is
 * correct. Emit that value instead of skipping silently — the first event after readiness
 * delivers the true value.
 */
function ask(el: Tag, name: "canGoBack" | "canGoForward"): boolean {
  // Call it bound to the tag — detached, the function has no `this` and throws on its own.
  try {
    return el[name]?.() ?? false;
  } catch {
    return false;
  }
}

function loading(el: Tag, label: string, on: boolean) {
  return () => {
    emitLocal(CONTENT_VIEW_EVENT.loading, {
      label,
      loading: on,
      // Back/forward availability is a fact of the load moment — the source emits the three together.
      canBack: ask(el, "canGoBack"),
      canForward: ask(el, "canGoForward"),
    });
  };
}

/**
 * Bridges one content view's events. Return value = unsubscribe.
 *
 * Without the unsubscribe the listeners survive closing the view and emit under a dead label —
 * subscribers read that label as still alive.
 */
export function bridgeContentViewEvents(el: Tag, label: string): () => void {
  const wired: [string, EventListener][] = [
    ["did-navigate", nav(label, false)],
    ["did-navigate-in-page", nav(label, true)],
    [
      "page-title-updated",
      (e) => {
        const title = field<string>(e, "title");
        if (typeof title === "string") emitLocal(CONTENT_VIEW_EVENT.title, { label, title });
      },
    ],
    ["did-start-loading", loading(el, label, true)],
    ["did-stop-loading", loading(el, label, false)],
    [
      "update-target-url",
      (e) => {
        // Leaving a link gives an empty string — that is an event too, so do not filter it out
        // (the status bar must go empty).
        const url = field<string>(e, "url");
        emitLocal(CONTENT_VIEW_EVENT.status, { label, url: typeof url === "string" ? url : "" });
      },
    ],
    // `new-window` is not listened to here. **That event is gone in this engine** — measured
    // 2026-08-02: clicking a new-tab link fired it 0 times (`page-title-updated` on the same tag
    // fired 5 times). A dead subscription raises no error and simply does nothing, so there was no
    // path for the new-tab/new-window setting to take effect. The live path is the framework's
    // window-open handler, which emits under the contract name.
  ];
  for (const [name, fn] of wired) el.addEventListener(name, fn);
  return () => {
    for (const [name, fn] of wired) el.removeEventListener(name, fn);
  };
}

/**
 * Converts the raw event the framework emitted **into the contract shape** and re-emits it.
 *
 * A framework whose content is out of process can only speak in its own handle (webContents id).
 * That handle is a trace of how it was resolved, not a fact — if a subscriber reads it, nothing
 * happens, silently, on a framework without that mechanism. The fact is **which view**, and the
 * answer to that is the label.
 *
 * So the seam translates once. The app handles only the one contract shape.
 */
export function activatedLabelOf(id: unknown, doc: Document = document): string | null {
  if (typeof id !== "number") return null;
  for (const el of doc.querySelectorAll<HTMLElement & { getWebContentsId?: () => number }>(
    "[data-content-view]",
  )) {
    try {
      if (el.getWebContentsId?.() === id) return el.getAttribute("data-content-view");
    } catch {
      // A tag not attached yet throws the moment it is queried — same result as not found.
    }
  }
  return null;
}

/**
 * Re-emits the raw event the framework emitted **in the contract shape** — installed once per window.
 *
 * A framework whose content is in another process can only speak in its own handle (webContents
 * id). That handle is a trace of how it was resolved, not a fact. The fact is **which view**, and
 * the answer is the label. If a consumer reads the handle, nothing happens, silently, on a
 * framework without that mechanism.
 *
 * The return value is the unsubscribe. An unresolved handle is **dropped** — the view is either
 * not attached yet or already dead, and emitting with an empty label sends a consumer an event
 * that maps to no view.
 */
export function relayFrameworkContentViewEvents(
  listen: (name: string, cb: (p: Record<string, unknown>) => void) => () => void,
): () => void {
  const off = listen(CONTENT_VIEW_EVENT.openExternalRaw, (p) => {
    const label = activatedLabelOf(p.id);
    const url = typeof p.url === "string" ? p.url : "";
    if (label && url) emitLocal(CONTENT_VIEW_EVENT.openExternal, { label, url });
  });
  return off;
}
