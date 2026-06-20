# soksak Sidebar — The Placement-Host Facet (v1)

This is a child of `docs/ARCHITECTURE.md` (the skeleton contract). It governs the three placement hosts — `sidebar-left`, `sidebar-right`, `footer` — and nothing else. The parent contract wins on any conflict. Where this document and code disagree, fix the code. Where this document and a single-source-of-truth schema disagree, the schema wins for what it can enforce and this document wins for everything it cannot.

This facet inherits every principle of the parent (A1–A13). It does not restate them. It states only what the sidebar placement host adds.

---

## 1. Scope

The placement host is the chrome that surrounds a plugin-contributed sidebar or footer view. It is one of four placements a `PluginViewProvider` can target (`content`, `sidebar-left`, `sidebar-right`, `footer`). The `content` placement is governed by the parent and by the hosting facet; this document governs the three peripheral placements.

The placement host owns the frame. The plugin owns the body. There is no third thing.

---

## 2. What the Host Owns

The host renders the frame and only the frame. The frame is:

- The **tab strip** — one selectable tab per registered view at that placement.
- The **body slot** — one bare container the active view's provider mounts into.
- The **footer slot** — the `footer` placement's container, same mount contract.
- **Width** — the placement's allocated width (sidebars) or height (footer), owned by the host layout, mutated through commands.
- **Visibility** — open/collapsed state of the placement, owned by the host, mutated through commands.

The host renders no content inside the body slot beyond the provider mount contract (parent A1). A tab label, an icon, and a placement are routing metadata, not a license to embed an implementation.

---

## 3. Principles (S1–S10)

These are HARD. They are stated absolutely on purpose.

### S1. The host renders the frame only.
Tab strip, body slot, footer slot, width, and visibility are the host's. Everything inside the body slot is the plugin's. The host attaches no renderer, no toolbar, no per-view chrome beyond the tab that selects the view. A control that belongs to one view lives in that view, not in the frame.

### S2. No hardcoded FILES tab.
The host special-cases no view. There is no built-in FILES tab, no built-in terminal tab, no built-in anything in the strip. Every tab in every placement arrives from a registered `PluginViewProvider`. A tab the host knows by name is a lock-in (parent A4) and is prohibited.

### S3. Empty sidebar is the frame and nothing else.
A placement with zero registered views renders the frame only — an empty strip and an empty slot, or a collapsed rail. The host invents no placeholder content, no "no views" feature surface, no default view. Empty is a valid, stable state, not a defect to paper over.

### S4. The view context is the only channel into a sidebar view.
A sidebar view receives state through exactly `{ projectId, root, paneId, setBadge }` and through `app.*` capabilities. It must not import core Zustand stores, read the layout tree, or reach into `sessions`/`settings`/`ui` (parent A2). The context carries identity and the badge setter; it carries nothing the host has not chosen to hand over. `paneId` identifies the host pane instance so a view rendered in two placements or two windows keeps per-instance state separate.

### S5. Tab selection and keep-alive are the host's, with fallback on unregister.
The host owns which tab is active and keeps inactive views alive (parked, not unmounted) so state survives a tab switch. When a view unregisters — plugin disabled, reloaded, removed — the host falls back: it selects another registered tab at that placement, or, if none remain, returns to the empty-frame state (S3). The host never leaves a dangling selection pointing at a gone view. A reloaded view reconciles from current state (parent A6); it does not assume a clean mount.

### S6. Theme via host CSS variables.
A sidebar view inherits theme strictly through host-injected CSS custom properties propagated into its shadow root (parent A10). It must not read the theme store, hardcode palette values, or branch on theme name. Recoloring the host recolors every conforming sidebar view with no plugin change.

### S7. cwd-following is opt-in and capability-driven.
A view that follows the working directory reads its context `paneId` and subscribes through `app.terminal` (`getCwd`, `onCwd`, `onCommandFinished`). The followed pane is `cwdPaneOf` — the focused terminal of the active group. The host does not push cwd into the view; the view pulls it through the capability. A view that does not follow cwd subscribes to nothing and pays nothing.

### S8. The file explorer's cwd-follow is the explorer's toggle, not the host's mode.
Cwd-following is a header toggle owned by the file-explorer view, defaulting to **project root**. The host has no "follow cwd" concept. Flipping the toggle changes which root the explorer lists; it changes nothing in the frame. Any view may implement its own follow toggle the same way, or none — the host is indifferent.

### S9. The view appears only through the placement seam.
A sidebar view attaches through `contributes.views[]` (declaring `placements`) plus `registerView(viewId, provider)`. There is no other path into the strip. The host calls `provider.mount(container, ctx)` / `unmount(container)` and nothing more (parent Section 3, seam 2). Anything a view cannot express through this seam plus `app.*` capabilities, the view must not do.

### S10. Verify, never assume.
Sidebar conformance is proven, not asserted (parent A12, Section 6). "The sidebar looks right" is not conformance. A grep that finds a view name hardcoded in the host is a failing S2 test, not a stylistic note. UI conformance requires a captured snapshot read directly, confirming the view inherits host theme variables (S6) and renders without native-layer bleed-through — not a headless DOM assertion.

---

## 4. The View Context

The sidebar `PluginViewContext` is exactly:

| Field | Meaning |
|-------|---------|
| `projectId` | Identity of the project this host instance belongs to. |
| `root` | The project root path. The default listing root for explorers (S8). |
| `paneId` | The host pane instance. Per-instance state key; cwd-follow subscription target (S7). |
| `setBadge` | The only write channel back to the frame — sets the tab's unread/count badge. |

The host hands over no store, no layout tree, no theme object, no window handle. A view that needs more than this needs a generic capability (parent Section 5), not a wider context.

---

## 5. Generic Capabilities a Sidebar View May Depend On

A sidebar view is a thin client over the substrate. It may depend on exactly these generic capabilities, each gated by a declared permission. None is named after the sidebar; each is feature-neutral (parent A3).

| Capability | Permission | Use |
|-----------|-----------|-----|
| `app.fs.list(path)` / `app.fs.watch(path, cb)` | filesystem read | List and watch directory contents — the file explorer's data source. |
| `app.git.status(root)` | git read | Decorate entries with VCS state. |
| `app.terminal.getCwd(paneId)` / `onCwd(paneId, cb)` / `onCommandFinished(paneId, cb)` | terminal read | cwd-following (S7), keyed on `cwdPaneOf` — the focused terminal of the active group. |
| `editor.open` command (open-path-as-content) | commands | Open a file the view selected; the skeleton routes to whichever plugin registered a viewer for that file type (parent A11). |
| Host theme CSS variables | none (ambient) | Inherit theme through the shadow root (S6). Not a method — a propagated style surface. |

A view that needs a capability absent from this set has found a gap in the substrate. Close the gap generically (parent A9), never carve a private path through the host.

---

## 6. Conformance

Sidebar conformance is a slice of the parent's separation and combination tests (parent Section 6).

### Frame-only test (S1, S2)
- **Grep gate:** searching the host for a view name, a FILES literal, or a built-in tab definition must return **zero** matches. A nonzero count is a failing test.
- The strip and slot render only what `registerView` supplied at that placement.

### Empty-state test (S3)
- A placement with no registered views renders the frame and nothing else — no placeholder, no default view. Verified by snapshot.

### Fallback test (S5)
- Unregister the active view; the host selects another registered tab or returns to the empty frame, with no dangling selection and no orphaned mount.

### cwd-follow test (S7, S8)
- With the explorer toggle off, the listing root is `root` (project root). With it on, the listing root tracks `cwdPaneOf` and updates on `onCwd` / `onCommandFinished`. Driven through the command/socket surface, proven RED→GREEN.

### Visual verify (S6, S10)
- Capture with `window.snapshot`, read the PNG, confirm the view inherits host theme variables and renders without native-layer bleed-through, then iterate until correct.

---

Version: 1.0.0
Status: AUTHORITATIVE
Parent: `docs/ARCHITECTURE.md` (A1–A13 inherited, not restated)
Single source of truth: `src/plugins/spec.ts`, `src/plugins/viewRegistry.ts`, `src/commands/registry.ts`
This document adds only the advice those schemas cannot enforce.
