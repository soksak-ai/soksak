// Border ownership contract table — machine truth (the human constitution is docs/UI.md §B1~B7).
// Declares "which token's 1px line must exist on which edge of which DOM".
//   - Consumers: the runtime validator (ui.validate/ui.expect — borderValidate.ts) and
//     the static gate (cssContract.test.ts).
//   - Edges absent here are not judged. "none" asserts that no line may exist.
//   - when conditions are evaluated against root data-* (the theme engine injects chrome tokens).
//   - Editing the table = editing the standard. Do not edit it to make a check pass —
//     if the standard is wrong, correct the matching clause in docs/UI.md first.

import { tmsg } from "../i18n";

export type EdgeName = "top" | "right" | "bottom" | "left";
export const EDGE_NAMES: readonly EdgeName[] = ["top", "right", "bottom", "left"];

// bd = app chrome / perimeter / floating surface, bd-soft = panel inner line (§B4), none = no-line assertion.
export type EdgeExpect = "bd" | "bd-soft" | "none";

// Root data-* condition (theme chrome token). The rule is active only for the listed values.
// (Standard corrected 2026-06-12: "transparent" on tabBar/titlebar is a background-only token —
// live validation confirmed it is unrelated to line ownership/display, so it left the when axis.)
export interface RuleWhen {
  paneStyle?: readonly string[]; // data-pane-style
  gutter?: readonly string[]; // data-gutter (theme seam token — stamped from theme.chrome.gutter)
}

export interface BorderRule {
  id: string;
  selector: string;
  // kind "edges": judges the 4 edge borders. kind "seam": a boundary tool's 1px center line
  // (§B6 exception) — solid asserts the token color exists in the background gradient,
  // overlay asserts full transparency at rest.
  kind: "edges" | "seam";
  edges?: Partial<Record<EdgeName, EdgeExpect>>;
  seam?: "bd-soft" | "rest-transparent";
  when?: RuleWhen;
  note: string; // Cited clause (§B…) required
}

export const BORDER_RULES: readonly BorderRule[] = [
  // ── B1 perimeter exclusivity ──────────────────────────────────────────────
  // A conditional surface must cover the state space with no gap (§B8 exhaustiveness gate):
  // assert both the states where the line must exist and the states where it must not.
  {
    id: "perimeter-frame",
    selector: ".pane-border",
    kind: "edges",
    edges: { top: "bd", right: "bd", bottom: "bd", left: "bd" },
    when: { paneStyle: ["card", "floating"] },
    note: tmsg("msg.ui.border.perimeterFrame"),
  },
  {
    id: "perimeter-frame-flat",
    selector: ".pane-border",
    kind: "edges",
    edges: { top: "none", right: "none", bottom: "none", left: "none" },
    when: { paneStyle: ["flat"] },
    note: tmsg("msg.ui.border.perimeterFrameFlat"),
  },
  // A rail projection card is a floating surface too — same 4-edge exclusivity as a content pane.
  // While it was absent from this table, nothing owned this card's lines, so it looked "closed"
  // only in layouts where the side resizers and the relation stroke resembled a border. Absent
  // from the table the validator runs no check, so the defect is never reported as a defect —
  // ownership is stated here.
  {
    id: "rail-card-perimeter",
    selector: ".sidebar-body .projection",
    kind: "edges",
    edges: { top: "bd", right: "bd", bottom: "bd", left: "bd" },
    when: { paneStyle: ["card", "floating"] },
    note: tmsg("msg.ui.border.railCardPerimeter"),
  },
  {
    id: "rail-card-perimeter-flat",
    selector: ".sidebar-body .projection",
    kind: "edges",
    edges: { top: "none", right: "none", bottom: "none", left: "none" },
    when: { paneStyle: ["flat"] },
    note: tmsg("msg.ui.border.railCardPerimeterFlat"),
  },

  // ── B3 app chrome (outside the card area) — the side away from the body owns it, tone bd ──
  {
    id: "titlebar-bottom",
    selector: ".titlebar",
    kind: "edges",
    edges: { bottom: "bd" },
    note: tmsg("msg.ui.border.titlebarBottom"),
  },
  {
    id: "space-tabs-bottom",
    selector: ".space-tabs:not(.vertical)",
    kind: "edges",
    edges: { bottom: "bd" },
    note: tmsg("msg.ui.border.spaceTabsBottom"),
  },
  {
    id: "ft-header-bottom",
    selector: ".ft-header",
    kind: "edges",
    edges: { bottom: "bd" },
    note: tmsg("msg.ui.border.ftHeaderBottom"),
  },
  {
    id: "proj-frame-header-bottom",
    selector: ".projection-header",
    kind: "edges",
    edges: { bottom: "bd" },
    note: tmsg("msg.ui.border.projFrameHeaderBottom"),
  },
  {
    id: "plugin-side-head-bottom",
    selector: ".plugin-side-head",
    kind: "edges",
    edges: { bottom: "bd" },
    note: tmsg("msg.ui.border.pluginSideHeadBottom"),
  },
  {
    id: "plugin-side-status-top",
    selector: ".plugin-side-status",
    kind: "edges",
    edges: { top: "bd" },
    note: tmsg("msg.ui.border.pluginSideStatusTop"),
  },
  {
    id: "left-host-tabs-bottom",
    selector: ".sidebar-body-tabs",
    kind: "edges",
    edges: { bottom: "bd" },
    note: tmsg("msg.ui.border.leftHostTabsBottom"),
  },

  // Vertical boundary between the left sidebar and the body — **the sidebar owns right**.
  // §B2 already mandated "left chrome = right", but CSS never drew it and this table lacked it,
  // so the validator never checked it (measured 2026-07-31: ui.expect ".sidebar-body" → rules: []).
  // Absent from the table a violation is never reported as a violation — an element present with
  // 0 rules is not a pass, it is no judgement. The resizer cannot draw this line (§B6): it is a
  // zero-width overlay, so color appears only on hover and at rest nothing owned the boundary.
  // Tone is bd-soft — body and sidebar are inside the same panel area (both take --pane-inset),
  // so this is a panel inner line (§B4), not an app chrome boundary (rail right, tone bd).
  {
    id: "left-sidebar-body-edge",
    selector: ".sidebar-body",
    kind: "edges",
    edges: { right: "bd-soft" },
    note: tmsg("msg.ui.border.leftSidebarBodyEdge"),
  },

  // Sidebar header/footer bands — one row with the content-side bands (R1a), and a band owns the
  // body-side edge (§B2: header kind = bottom, footer kind = top). Tone is bd-soft — an inner line
  // inside the same panel area as the sidebar body, not an app chrome boundary (§B4).
  //
  // Both were created on 2026-08-15 and went a day without being listed in the contract. The static
  // gate judged listing by substring, so it read the `.sidebar-body` rule as covering them, and
  // only the runtime `ui.expect` answered "no rules". Fixing the judge exposed this slot.
  {
    id: "left-sidebar-header-band",
    selector: ".sidebar-body-header",
    kind: "edges",
    edges: { bottom: "bd-soft" },
    note: tmsg("msg.ui.border.leftSidebarHeaderBand"),
  },
  {
    id: "left-sidebar-footer-band",
    selector: ".sidebar-body-footer",
    kind: "edges",
    edges: { top: "bd-soft" },
    note: tmsg("msg.ui.border.leftSidebarFooterBand"),
  },

  // ── B2 vertical chrome — one rail perimeter owner in every station ────────
  // Position changes when the rail travels; the perimeter contract does not.
  // Keeping one rule prevents an edge station from silently dropping its outer
  // line or delegating it to a different surface.
  {
    id: "rail-perimeter",
    selector:
      '.sidebar.rail-ground, .sidebar.rail-pane',
    kind: "edges",
    edges: { left: "bd", right: "bd" },
    note: tmsg("msg.ui.border.railCardPerimeter"),
  },
  // Each window edge owns the one line facing the work. Written as two entries, not one shared
  // selector, because they own opposite sides — a single rule could only name one of them.
  {
    id: "sidebar-edge-left-inner",
    selector: ".sidebar-edge-left",
    kind: "edges",
    edges: { right: "bd" },
    note: tmsg("msg.ui.border.sidebarEdgeLeftInner"),
  },
  {
    id: "sidebar-edge-right-inner",
    selector: ".sidebar-edge-right",
    kind: "edges",
    edges: { left: "bd" },
    note: tmsg("msg.ui.border.sidebarEdgeRightInner"),
  },
  {
    id: "plugin-rail-right",
    selector: ".plugin-rail",
    kind: "edges",
    edges: { right: "bd" },
    note: tmsg("msg.ui.border.pluginRailRight"),
  },
  {
    id: "workspace-rail-right",
    selector: ".workspace-rail",
    kind: "edges",
    edges: { right: "bd" },
    note: tmsg("msg.ui.border.workspaceRailRight"),
  },

  // ── B2 panel inner line — the chrome band owns the body-side edge, tone bd-soft ──
  {
    id: "tabs-wrap-bottom",
    selector: ".tabs-wrap",
    kind: "edges",
    edges: { bottom: "bd-soft" },
    note: tmsg("msg.ui.border.tabsWrapBottom"),
  },
  {
    id: "pane-title-bottom",
    selector: ".pane-title",
    kind: "edges",
    edges: { bottom: "bd-soft" },
    note: tmsg("msg.ui.border.paneTitleBottom"),
  },
  {
    id: "pane-status-top",
    selector: ".pane-status",
    kind: "edges",
    edges: { top: "bd-soft" },
    note: tmsg("msg.ui.border.paneStatusTop"),
  },

  // ── B2 body no-border assertion ───────────────────────────────────────────
  {
    id: "tab-body-none",
    selector: ".tab-body",
    kind: "edges",
    edges: { top: "none", right: "none", bottom: "none", left: "none" },
    note: tmsg("msg.ui.border.tabBodyNone"),
  },

  // ── B6 boundary tool no-ownership assertion ───────────────────────────────
  {
    id: "resizer-no-line",
    selector:
      ".sidebar-resizer, .sidebar-edge-left-resizer, .sidebar-edge-right-resizer, .workspace-rail-resizer",
    kind: "edges",
    edges: { top: "none", right: "none", bottom: "none", left: "none" },
    note: tmsg("msg.ui.border.resizerNoLine"),
  },

  // ── B6 exception: seam between opaque content (consumes the gutter token) ──
  {
    id: "pane-gutter-seam-solid",
    selector: ".pane-gutter",
    kind: "seam",
    seam: "bd-soft",
    when: { gutter: ["solid"] },
    note: tmsg("msg.ui.border.paneGutterSeamSolid"),
  },
  {
    id: "pane-gutter-seam-overlay",
    selector: ".pane-gutter",
    kind: "seam",
    seam: "rest-transparent",
    when: { gutter: ["overlay"] },
    note: "§B6",
  },

  // ── Panel inner auxiliary bands (B2, tone bd-soft) ────────────────────────

  // ── Vertical-mode content tabs (settings-conditional — 0 matches skips naturally) ──
  {
    id: "space-tabs-vertical-right",
    selector: ".space-tabs.vertical",
    kind: "edges",
    edges: { right: "bd" },
    note: tmsg("msg.ui.border.spaceTabsVerticalRight"),
  },

  // ── Floating surfaces (B4, tone bd) ───────────────────────────────────────
  {
    id: "float-surfaces",
    selector: ".dmodal-card, .space-tab-menu, .space-tab-submenu, .cm-find",
    kind: "edges",
    edges: { top: "bd", right: "bd", bottom: "bd", left: "bd" },
    note: tmsg("msg.ui.border.floatSurfaces"),
  },
  {
    id: "dmodal-head-bottom",
    selector: ".dmodal-head",
    kind: "edges",
    edges: { bottom: "bd" },
    note: tmsg("msg.ui.border.dmodalHeadBottom"),
  },

  // ── Settings modal 2-pane inner lines (B2, tone bd-soft) ──────────────────
  {
    id: "settings-nav-right",
    selector: ".settings-nav",
    kind: "edges",
    edges: { right: "bd-soft" },
    note: tmsg("msg.ui.border.settingsNavRight"),
  },
  {
    id: "settings-row-bottom",
    selector: ".settings-row",
    kind: "edges",
    edges: { bottom: "bd-soft" },
    note: tmsg("msg.ui.border.settingsRowBottom"),
  },

  // ── Orchestrator window (A3) inner lines — header/map/console each own a boundary ──
  {
    id: "orch-header-bottom",
    selector: ".orch-header",
    kind: "edges",
    edges: { bottom: "bd-soft" },
    note: tmsg("msg.ui.border.orchHeaderBottom"),
  },
  {
    id: "orch-map-right",
    selector: ".orch-map",
    kind: "edges",
    edges: { right: "bd-soft" },
    note: tmsg("msg.ui.border.orchMapRight"),
  },
  {
    id: "orch-console-top",
    selector: ".orch-console",
    kind: "edges",
    edges: { top: "bd-soft" },
    note: tmsg("msg.ui.border.orchConsoleTop"),
  },
];
