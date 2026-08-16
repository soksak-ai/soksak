---
kind: canonical
status: active
canonical: self
---

# The rail — where the sidebar stands, and what moves when focus does

The left rail is one persistent node that stands on a vertical line through the
layout. Which line is a solved fact, not a stored one, and the solve is a pure
function of the grid and the focus. **Everything below is judged by numbers from
`layout.arrangement`, `layout.transition.journal` and `ui.focus.state`** — never
by a picture (L6).

## Scope

This says where the rail stands and what the screen does while it moves. The
rail's body is a plugin surface and is empty in this build (S3 below).

---

# S. Standing

## S1. One solve is read, never recomputed

`solveArrangement` answers the station, the clean lines, the cells and whether
the focused pane was switched to the front — all from one input. A consumer
reads that answer. Recomputing any part of it from the same inputs makes two
answers that agree until they do not, and the second one is drawn.

The invariant that makes the answer usable: **the station of a solution is
always a clean line over that solution's cells.** A clean line is a vertical
line the full height of the space that crosses no pane. Projecting a station
that is not one throws during render, and a throw during render blanks the whole
window — measured in the preceding implementation, exposed nodes 64 → 0.

## S2. FLOW and PIN

**FLOW** stands the rail on the focused pane's left clean line. When that line
is blocked, the nearest clean line in front of it. Focus moves, the rail
follows.

**PIN** freezes a station. It is snapped to the nearest clean line when set, and
after that **a focus change moves neither the rail nor a pane.** An unresolved
focus holds the current position; it is not an instruction to go to 0.

Measured 2026-08-16: under FLOW, four focus changes across two panes each put
the station on the focused pane's left clean line, alternating 0 and 50 with
clean lines at 0, 50 and 100. Under PIN, focusing another pane wrote no
arrangement record at all — nothing changed to record.

## S3. An empty rail is the frame, not a gap

The rail's body comes from a plugin. With none installed the rail is empty, and
that is a settled state rather than a missing one. No hardcoded body and no
stub: a placeholder is a plugin the core wrote, which is the lock-in A1 exists
to prevent.

## S4. A region is present when it is open and a set stands in it

Both terms, both regions, one function — `regionPresent` in `state/sectionSets.ts`. A region a
person opened with nothing linked to it reserves its width and draws nothing, and a strip of
reserved nothing reads as a view that failed to draw.

The left asked both terms and the right asked only whether it was open, so the right stood empty
whenever it had been opened once — measured 2026-08-17, visible as a dark strip in every capture of
that day. Two readers now share the rule: the plane that draws the region, and the hole reported to
the native hit test for the surface underneath it, which would otherwise take clicks away from that
surface for a strip nobody sees.

---

# T. Travel

## T1. The relationship outline is a destination mark, not a surface that moves

When a FLOW transition begins, the rail's visual surface, its border and its
input area are removed. One surface appears at the destination after landing.
The persistent host survives — a duplicate would split the plugin's lifetime.

## T2. Two solves are never mixed

The source station applies to the source rect and the target station to the
target rect. Mixing them produces a box stretched from the departing rail to the
far edge of the destination pane, which is a shape that was never in either
solve.

## T3. The journal is the judgement

`layout.transition.journal` writes one record per phase:

```
sequence  phase          station  dStation  cleanLines[]
cells[]   {id, rect}
moved[]   {id, dLeft, dTop, dWidth, dHeight}   — a pane that did not move is absent
appeared[] gone[]                              — a pane with a rectangle on one side only
railSurfaces                                   — counted in the document
frame                                          — the window.record frame, or null
```

**GREEN**: a `traveling` record holds 0 rail surfaces and the record after it
exactly 1; a PIN focus change leaves `dStation` 0 and `moved` empty; a FLOW
focus change leaves the station on the focused pane's left clean line.

The surface is counted in the document rather than read from the declaration.
The declaration is an intention and the count is what a person sees; they agree
only when the render did what it was told.

A pane that did not move is left out of `moved`, so "nothing moved" is read
rather than computed — which is the whole of the PIN judgement. A pane with a
rectangle on one side only is named in `appeared` or `gone`: there is no delta
against a rectangle that did not exist, and one measured against zero says a
pane moved the width of the window.

Measured 2026-08-16, three splits deep: settled/1, settled/1, traveling/0,
settled/1 — every traveling record 0 and every settled record exactly 1.

---

# L. Lighting

## L1. The light is outside the content

No `filter` and no `opacity` on a content subtree. One SVG plane outside the
content lays a base veil and opens an aperture over the focused pane.

An ancestor `filter` breaks a WebGL terminal's glyph compositing, and it does
not reach a native surface at all — that content is not in the document, so a
document-side dim leaves it at full brightness while everything around it dims.

## L2. Where the light is, as an address

`ui.focus.state` answers `lighting`:

| Field | What it is |
| --- | --- |
| `scope` | the space this plane is for, null when no plane is drawn |
| `base` | the veil over everything |
| `aperture` | the hole the focused pane shows through, null when nothing is focused |
| `cutouts[]` | holes for panes that are not the focused one |
| `exempt[]` | bands the veil does not cover, such as the rail |
| `blocked[]` | panes dimmed harder for being between the rail and a focus it could not reach |

Each carries `{ node, target, rect }`. **GREEN: the aperture's `target` is the
focused pane.** Measured 2026-08-16 — one pane, aperture on the active pane;
after a split, aperture on the new pane with the station at its left clean line.

Four lists rather than one, because they are four different reasons a pixel is
not dimmed, and one list makes an exempted rail look like a cut-out pane. A
plane with a veil and no aperture is reported as it stands: every pane dimmed
and none lit is a real state.

---

# K. Known, and not fixed

- **The journal's `frame` is null.** `window.record` numbers every frame it
  writes and that number is meant to be the common clock across journals. The
  arrangement records are not yet stamped with it, so a record cannot be lined
  up with a saved picture. The numbers above stand on their own; the pairing
  does not exist yet.
- **`rail.settled` is a check, not a command.** It lives inside the validation
  surface (`ui.validate`) and answers whether a departing rail was left behind.
  The plan names it as a command; the check reports the same fact and nothing
  reads it as a command yet.
