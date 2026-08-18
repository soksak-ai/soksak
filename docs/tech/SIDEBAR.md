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

## S5. A surface is dimmed by its own alpha

The focus veil is an SVG painted over the document, and a native surface is composited above it, so
the veil does not reach one. Measured 2026-08-17: the same rectangle inside a browser page read a
mean brightness of 184.7 whether its pane was focused or not, while the CSS above the veil stated it
painted "over a native child outside the document".

One strength, computed once per pane, read by three: the cell, the slot, and the view. A view drawn
on a surface applies it to that surface's alpha — the compositor carries alpha per surface already,
so nothing new is declared for it.

The strength travels in the same object as the view's visibility. They are one fact about one
moment, and two channels would let a view answer a dim from one frame with a visibility from
another — a surface dimming after it was hidden.

Measured after: 118.2 unfocused, 223.2 focused, the same rectangle.

---

# T. Travel

## T1. The rail stays on the screen while the panes travel

A region that owns width is not a decoration. An outline can be taken away for a
transition and nothing is missing from the screen; a rail holds a strip of the
window, and taking it away leaves that strip to nobody while the panes are still
travelling into it.

Its surface used to be removed for the phase, so a pane could pass behind it: a
native surface is composited above the document, so a page crossing the rail
would be drawn over it. What travels during a glide is a stand-in — the phase
does not start unless every moving surface can be covered by one — so nothing
native crosses the rail, and `layout.alignment` answers `over` for the case where
one does.

Measured 2026-08-17 in a window with a terminal top left, a browser under it and
a browser on the right, over all six ways focus can move: with the rail removed,
165 points belonged to nobody for 183–194ms on every move that changed which pane
the rail follows, and the recorded frames show the strip empty. With the rail
kept and travelling on the panes' own interpolation, the hole is 0 in all six and
`over` is 0 in all six.

The persistent host survives either way — a duplicate would split the plugin's
lifetime.

## T1a. What leaves, leaves with the space it stood in

The sections standing in a region are decided by a render and the region's width
travels with the panes, so a section removed in the render leaves an empty strip
for the whole closing motion — 160 points for 160ms, measured the same day. The
departing set is held for exactly that motion (`useHeldWhileLeaving`), and a set
**replaced** by another is not held: the space it stands in never closes.

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

**GREEN**: every record holds exactly 1 rail surface while a set stands in the
region, `traveling` included (T1); a PIN focus change leaves `dStation` 0 and
`moved` empty; a FLOW focus change leaves the station on the focused pane's left
clean line.

The surface is counted in the document rather than read from the declaration.
The declaration is an intention and the count is what a person sees; they agree
only when the render did what it was told.

A pane that did not move is left out of `moved`, so "nothing moved" is read
rather than computed — which is the whole of the PIN judgement. A pane with a
rectangle on one side only is named in `appeared` or `gone`: there is no delta
against a rectangle that did not exist, and one measured against zero says a
pane moved the width of the window.

Measured 2026-08-16, three splits deep: settled/1, settled/1, traveling/0,
settled/1. The 0 was the rule of that day and is the defect now — T1 states what
it cost and what the six moves answer since.

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
- **`rail.settled` is a command and a check, from one function.** It answers
  whether a departing rail was left behind, with no verdict mid-journey. The
  check of that name inside `ui.verify` reads the same function, so the two
  cannot disagree.
