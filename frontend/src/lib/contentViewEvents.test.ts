// The content view emits events — without them subscribers starve **silently**.
//
// The app subscribes to the global `browser-<event>` events filtered by label
// (src/plugins/deps.ts:60). On Tauri webview.rs emits them. On a framework whose content is inside
// the DOM nobody emitted them — app.webview.on(label, "nav") is never called. No error is recorded
// anywhere.
//
// The five names and their payloads are unchanged from the original (that adapter's webview contract):
//   content-view-navigated            { label, url, inPage }
//   content-view-title          { label, title }
//   content-view-loading        { label, loading, canBack, canForward }
//   content-view-status         { label, url }
//   content-view-open-external  { label, url }
// Changing a name or a field makes the same subscriber code see something different per framework.
import { beforeEach, describe, expect, it, vi } from "vitest";

const emit = vi.fn();
vi.mock("../framework", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../framework")>()),
  invoke: vi.fn(async () => undefined),
  engineProvision: { chromium: true, nativeChildWebview: false },
  emitLocal: (name: string, payload: unknown) => emit(name, payload),
}));

async function load() {
  vi.resetModules();
  return import("./contentViewEvents");
}

/**
 * The events `<webview>` actually emits — **fields are set directly on the event object.**
 *
 * Not in CustomEvent detail. A fake built on detail passes even when the bridge reads detail, and
 * that pass shows up in the live app as "the address bar stops at about:blank" (measured
 * 2026-07-28: the page rendered but the URL bar did not follow). When the fake differs from the
 * real thing, the only thing verified is my own interpretation.
 */
function tagEvent(name: string, fields: Record<string, unknown>): Event {
  return Object.assign(new Event(name), fields);
}

/** Element faking the events the <webview> tag emits — jsdom has no such element. */
function fakeTag() {
  const el = document.createElement("div");
  el.setAttribute("data-content-view", "brw-1");
  Object.assign(el, {
    canGoBack: () => true,
    canGoForward: () => false,
    getURL: () => "https://x/page",
  });
  document.body.appendChild(el);
  return el;
}

describe("content view event bridge", () => {
  beforeEach(() => {
    emit.mockClear();
    document.body.innerHTML = "";
  });

  it("navigation goes out as content-view-navigated — name and fields unchanged from the original", async () => {
    const m = await load();
    const el = fakeTag();
    m.bridgeContentViewEvents(el, "brw-1");
    el.dispatchEvent(tagEvent("did-navigate", { url: "https://x/page" }));
    expect(emit).toHaveBeenCalledWith("content-view-navigated", {
      label: "brw-1",
      url: "https://x/page",
      inPage: false,
    });
  });

  /** **Whether the move stays inside the same document is the fact.** Without that axis the
   *  consumer cannot separate the two, a rule such as "reset the previous title to the URL" runs on
   *  every navigation, and since the engine does not emit the title again the real title stays
   *  overwritten by the URL (measured 2026-08-02: the tab read www.google.com, not "Google"). */
  it("a move inside the same document is separated by inPage", async () => {
    const m = await load();
    const el = fakeTag();
    m.bridgeContentViewEvents(el, "brw-1");
    el.dispatchEvent(tagEvent("did-navigate-in-page", { url: "https://x/page#a" }));
    expect(emit).toHaveBeenCalledWith("content-view-navigated", {
      label: "brw-1",
      url: "https://x/page#a",
      inPage: true,
    });
  });

  it("the title goes out as content-view-title", async () => {
    const m = await load();
    const el = fakeTag();
    m.bridgeContentViewEvents(el, "brw-1");
    el.dispatchEvent(tagEvent("page-title-updated", { title: "T" }));
    expect(emit).toHaveBeenCalledWith("content-view-title", { label: "brw-1", title: "T" });
  });

  // canBack and canForward are camelCase — the core payload is `rename_all = "camelCase"`, so those
  // are the names actually sent, and published plugins read `p.canBack`. This check once pinned
  // snake_case: a wrong baseline makes the check protect the defect (measured 2026-08-01, baseline
  // corrected).
  it("loading state goes out as content-view-loading with back and forward availability", async () => {
    const m = await load();
    const el = fakeTag();
    m.bridgeContentViewEvents(el, "brw-1");
    el.dispatchEvent(new Event("did-start-loading"));
    expect(emit).toHaveBeenCalledWith("content-view-loading", {
      label: "brw-1", loading: true, canBack: true, canForward: false,
    });
    el.dispatchEvent(new Event("did-stop-loading"));
    expect(emit).toHaveBeenCalledWith("content-view-loading", {
      label: "brw-1", loading: false, canBack: true, canForward: false,
    });
  });

  it("a link hover emits content-view-status, and leaving it emits an empty string", async () => {
    const m = await load();
    const el = fakeTag();
    m.bridgeContentViewEvents(el, "brw-1");
    el.dispatchEvent(tagEvent("update-target-url", { url: "https://y" }));
    expect(emit).toHaveBeenCalledWith("content-view-status", { label: "brw-1", url: "https://y" });
    el.dispatchEvent(tagEvent("update-target-url", { url: "" }));
    expect(emit).toHaveBeenCalledWith("content-view-status", { label: "brw-1", url: "" });
  });

  /** A window-open request **is not reported by the tag.** The `new-window` event is gone in this
   *  engine (instrumented 2026-08-02: 0 firings on a new-tab link click, 5 for
   *  `page-title-updated` on the same tag). A dead subscription raises no error and does nothing,
   *  so there was no path for the new-tab/new-window setting to apply. Re-attaching it is caught by
   *  this check. */
  it("the tag's new-window is not subscribed — this engine has no such event", async () => {
    const m = await load();
    const el = fakeTag();
    m.bridgeContentViewEvents(el, "brw-1");
    el.dispatchEvent(tagEvent("new-window", { url: "https://z" }));
    expect(emit).not.toHaveBeenCalledWith(
      "content-view-open-external",
      expect.objectContaining({ url: "https://z" }),
    );
  });

  /** The live path is the framework — it reports through a handle (webContents id). The seam
   *  converts it to a label and re-emits it in the contract shape. Passing the handle through
   *  as-is leaves consumers silently receiving nothing on a framework that has no such handle. */
  it("a framework report keyed by handle is converted to a label and emitted under the contract name", async () => {
    const m = await load();
    const el = document.createElement("div");
    el.setAttribute("data-content-view", "brw-9");
    Object.assign(el, { getWebContentsId: () => 42 });
    document.body.appendChild(el);
    let raw: ((p: Record<string, unknown>) => void) | null = null;
    const off = m.relayFrameworkContentViewEvents((name: string, cb: typeof raw) => {
      expect(name).toBe("content-view-open-external:raw");
      raw = cb;
      return () => {};
    });
    raw!({ id: 42, url: "https://z" });
    expect(emit).toHaveBeenCalledWith("content-view-open-external", {
      label: "brw-9",
      url: "https://z",
    });
    off();
    document.body.innerHTML = "";
  });

  /** An unresolved handle is dropped — emitting with an empty label sends consumers an event for no view. */
  it("an unresolved handle emits nothing", async () => {
    const m = await load();
    let raw: ((p: Record<string, unknown>) => void) | null = null;
    m.relayFrameworkContentViewEvents((_n: string, cb: typeof raw) => {
      raw = cb;
      return () => {};
    });
    emit.mockClear();
    raw!({ id: 999, url: "https://z" });
    expect(emit).not.toHaveBeenCalled();
  });

  it("after unsubscribe nothing goes out — a subscription left behind a closed view emits under a dead label", async () => {
    const m = await load();
    const el = fakeTag();
    const off = m.bridgeContentViewEvents(el, "brw-1");
    off();
    el.dispatchEvent(tagEvent("did-navigate", { url: "https://x" }));
    expect(emit).not.toHaveBeenCalled();
  });
});
