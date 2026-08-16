// Wire names of content view events — the vocabulary a plugin fills a pane with.
//
// The canonical source is core/contentview/events.go; TypeScript cannot read a Go constant, so this
// is a copy and contentview_gate_test.go compares the two. When they drift the events a host emits
// arrive nowhere, and an event that arrives nowhere raises no error.
//
// The names contain no `browser`. The entity the core owns is the content view, and "browser" is a
// plugin's word (C1). Plugins subscribe by short key (`app.webview.on(label, "nav", …)`), so this
// table is not exposed to plugins — do not assemble a name, **pick one from here**.
//
// This file holds names and nothing else. It used to also bridge an `<webview>` tag's own events —
// did-navigate, page-title-updated, did-start-loading — and ask the element canGoBack. That tag
// is the engine the preceding implementation ran on. In this build the surface is native and
// the plugin that owns it reports its own state. The bridge was reachable from its test alone
// (measured 2026-08-16), and history_gate_test.go now refuses its vocabulary here.

/**
 * Wire names of content view events.
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
