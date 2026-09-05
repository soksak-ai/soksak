---
kind: canonical
status: active
canonical: self
---

# The pane plane — one plane per space, laid out by the library

A space holds its panes on one plane of shared grid lines, and the plane is the
`split-pane` library's (the dependency in `frontend/package.json`). The core names
a pane, a side or a boundary and reads back the state the library produced;
every rect, divider and drop zone the core draws is read from that state in
px. Nothing in the core computes a rect.

## Scope

What the core replaced with the library, what the library does not hold and
the core keeps as a presentation over its state, and the rules with their gates.
The sidebar's sections keep their own split tree (`state/splitTree.ts`); a
sidebar is not inside a space.

Measured on 2026-09-05 in the named window unless another date is given.

---

# A. What replaced what

The core's former concepts, the library concept that takes each one's place, and
the verdict. A row marked *replaced* has no core implementation left.

| Core, before | Library | Verdict |
| --- | --- | --- |
| `SplitTree<Pane>`, a recursive tree with `sizes` ratios | `SplitPaneState`: shared lines `xs/ys` and a span per card (R1) | replaced |
| `computeSplitLayout` — percent cells and 0-width gutters | `rects()`, `dividers()` in px | replaced |
| `PANE_INSET` on every side of every cell | `gap`, the corridor (R5: half a gap on inner edges, flush at the border); the plane is the host inset by the pane inset | replaced, same geometry |
| `verticalLines.ts` — segments grouped by x within a tolerance, moved as one | R1: a boundary is one number; `moveBoundary(axis, line)` | replaced |
| `MIN_PANE_FRAC` and `minPaneFracForSpan` | `minSize` in px: `MIN_PANE_PX` = three header bands and the footer | replaced |
| `gutterAddress` by tree walk | a card's span names its edges' lines; the address form `pane+edge` is unchanged | replaced |
| `hitTestCells`, five zones | `zoneAt(x, y, {headerPx, footerPx, centreOnly})` | replaced |
| `insertBeside`, `removeLeaf`, remove-then-insert for a move | `splitToward` (R4), `close` (R7), `move` — one operation each | replaced |
| a rail station in percent over `(host − railWidth)`, `projectRailCssRect`, `unprojectRailX`, `snapRailStation`, `cleanRailLines` | the rail is a `fixed` card with a `width` (R2); `standings`, `insertAt`, `moveTo` | replaced |
| a pinned station stored as a number, validated against clean lines, `LAYOUT_CONFLICT` | the card's slot is where it stands, and a slot cannot be crossed (R3): `{mode: "pin"}` alone | replaced; the error code is gone |
| `railWidthResize` — a width change that kept the station | R5: a drag beside a card with a declared width changes that width, and the slot on the other side pays | replaced |
| `serializeSplitTree` and the restore migrations (`vlNormalized`, `railPlacementNormalized`) | `toJSON()` and `checkState()`; an older record is refused by name | replaced |

What the library does not hold. These are presentations computed over the
library's state in `state/panePlane.ts`, never a second geometry:

| Not in the library | The core's seam |
| --- | --- |
| exchanging a focused pane with one at its left so the rail can stand beside it | `pullToFront`: the nearest exchange in the same row that frees the line, each pane at its own width; displayed, never stored |
| showing one pane over the whole space | `soloPlane`: a plane of that pane and the rail, on the side the rail stood on |
| evening every slot on an axis | `equalizeAxis` (`centerBoundary` is the library's) |
| SIDEBAR S2, the line a rail stands on for a focused pane | `flowRailLine`: the nearest standing at or before the pane's left edge, measured on the plane without the rail |

Not the library's and kept in the core, with inputs in px: the relation border
between the rail and the pane beside it, the arrangement phase and its journal
(SIDEBAR T), the rect tracker that interpolates a command-driven change, and the
staging of native surfaces before a move. The library's DOM binding
(`SplitPaneView`) is not used: a pane here is six layers (cell, frame, focus
boundary, slot, picture, lighting) placed by one CSS rule, and its slot is
keyed by the view so a move between panes never remounts it — one element per
card would.

---

# P. The plane

## P1. One plane per space, and the library owns it

`Space.layout` is the library's state; `Space.panes` is what each pane holds.
The two are joined by pane id, and every card on the plane but the rail is a
pane (`normalizeActiveGroupC` throws otherwise). `state/panePlane.ts` is the
only file that imports `split-pane`.

Gate: `frontend/src/state/panePlane.test.ts`, `frontend/src/state/paneInvariant.test.ts`.

## P2. The plane is in px, and the box is measured

The plane is the content area's inner rectangle — the host inset by
`--pane-inset` on every side (UI-GEOMETRY R1b) — and its corridor is twice that
inset. The host measures it into `state/planeBox.ts`, and a command over the
socket lays out in the same box a drag does. Before the first measurement the
box is 0×0: the first render draws in it and lights no rail, and the store lays
nothing out on it (on a 0-wide plane every standing is at px 0, and the line
chosen for a focused pane was the last one).

The declared rect and the drawn rect agree to the device pixel: `layout.verify`
answered `settled true, worst 0` on one pane and `worst 0.009–0.016` on three
panes with the rail standing, across split, resize, move, maximize and restore.

Gate: `frontend/src/components/GroupArea.render.test.tsx`,
`frontend/src/commands/catalogLayoutVerify.test.ts`.

## P3. A boundary is named by a pane and an edge

A line's index shifts when a line is added before it, so an index is not a
name. `pane.resize` and `pane.equalize` address a boundary as `{pane, edge}`;
the canonical form is the right|bottom edge of the first pane in reading order
whose edge stands on that line, and left|top are input aliases. The divider in
the DOM has the same address (`gutter/<pane>/<edge>`).

`ratio` is the slot before the boundary over the two slots that meet there,
**measured where the boundaries stand**. A slot with a declared width (the
rail) is drawn at that width and holds a share of the lines that is not it: a
drag of 80px beside the rail landed 26.5px over while the ratio was read from
the lines.

Gate: `frontend/src/lib/gutterAddress.test.ts`, `frontend/src/commands/paneGutter.test.ts`.

## P4. A split under the floor is refused by the plane

`splitWithNewView` answers `TOO_SMALL` and performs nothing when no half would
keep a pane at `MIN_PANE_PX`. The floor is the library's, not a measurement of
the DOM.

Gate: `frontend/src/commands/paneSplitFloor.test.ts`.

---

# R. The rail on the plane

## R1. The rail is a card, and it is stored with the plane

While a set stands in it, the rail is a `fixed` card of a declared width on
the active space's plane, stored with the plane. `settleRail` stands it beside
the focused pane under FLOW and leaves it under PIN; it withdraws it when no
set stands, and the room goes back to the slot it took it from (R5), so the
panes keep their proportions. A withdraw drops the line the slot leaves with no
card on it (`tidy`): kept, every later stand landed beside it, and the plane
had four lines for two columns, then five with a coincident pair.

Gate: `frontend/src/state/sessions.railPlacement.test.ts`, `frontend/src/state/panePlane.test.ts`.

## R2. The rail's width is the plane's while it stands

A drag on either boundary of the rail changes its width on the plane (R5) and
the place's width follows in memory, written down when the gesture ends;
`sidebar.width` writes both. The setting is read when a rail is stood for the
first time; one that stands keeps its width — settling on boot applied the
setting (320) to a rail the plane held at 399.7 after a drag.

Gate: `frontend/src/state/sessions.moveBoundary.test.ts`.

## R3. A travel is a translate of the same box

The phase animates the panes whose box moved without changing shape. A width
or a shift within half the corridor is the same box: a rail landing on the
plane's border charges its neighbours half a gap (R5), and that 2.7px made
every rail travel a snap with no journey. `layout.transition.journal` shows the
travel: `traveling` with the focused pane's neighbour moved by the rail's width
and `railSurfaces 1`, then `settled`.

Gate: `frontend/src/lib/railArrangement.test.ts`.

## R4. `rail.position` takes a line

`rail.position {mode: "pin", line}` moves the rail to a standing line of the
active space's plane (`standingLines`) and pins it; a line the rail cannot
stand on is refused. `effectiveStation` and `cleanLines` are in px.

Gate: `frontend/src/commands/catalogRailPosition.test.ts`.

---

# S. Stored

A stored space is `{groups, plane}`: what each pane holds, and the plane as the
library states it — the lines, every card's span, the rail's slot and width,
and `paidBy`. A record with a split tree under `layout` predates 2026-09-05 and
is refused by name; a rail placement of another shape is presentation and
costs that field only (RESTORE R1). The window `win-j6jvtf` came back with
three panes and the rail on its line after a restart.

Gate: `frontend/src/state/windowSnapshot.test.ts`, `frontend/src/state/windowSnapshotShape.test.ts`,
`frontend/src/state/restoreKeepsIds.test.ts`.

---

# K. Known, and not fixed

- The plane's border exception (R5) changes a neighbour's width by up to half
  a gap when the rail lands on or leaves the border. It is the library's rule
  and it is drawn as such; the core tolerates it in R3 rather than hiding it.
- A stored plane from a build without `tidy` may hold a line no card is on. It
  goes with the next close or withdraw; nothing rewrites a stored record.
