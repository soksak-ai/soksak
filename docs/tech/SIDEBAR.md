---
kind: canonical
status: active
canonical: self
---

# Sidebars — the three places one stands, and what moves when focus does

A sidebar is a set of sections standing in one of three places. Two of them are
the window's own edges and do not move; the third is the rail between the panes,
one persistent node on a vertical line through the layout. Which line is a
solved fact, not a stored one, and the solve is a pure function of the grid and
the focus. **Everything below is judged by numbers from `layout.arrangement`,
`layout.transition.journal` and `ui.focus.state`** — never by a picture (L6).

## Scope

This says which places there are, which one a sidebar stands in, and what the
screen does while the rail moves. A section's body is a plugin surface; a build
with no plugin installed has empty places (S3 below).

---

# P. Places

## P1. Three places, and the place is the rule

| Place | Where | Whose set |
| --- | --- | --- |
| `left` | the window's left edge | one set for the whole installation, whatever is focused |
| `rail` | between the panes | the focused plugin's |
| `right` | the window's right edge | the focused plugin's |

An edge does not move. It takes a width a person drags, and it either draws over
the content or takes room from it (`overlay` / `push`, one setting per edge).
The rail travels with the focus, which is what all of T below is about.

**There is no mode switch between the places.** A switch would let two of them
behave the same way, and then there is no reason for there to be two. Which
place a set stands in is settled by the link — or, for the left edge, by
`sections.left` — and by nothing else.

`left` meant the rail until 2026-08-18. The stored key is versioned rather than
migrated (L11c): a value that reads correct and means somewhere else is worse
than no value. `railPlacement` was `leftRailPlacement` for the same reason, and
a window stored under the old name comes back with the rail where it stands by
default (RESTORE R1).

## P2. A view declares a surface, never a place

`contributes.views[].surfaces` is `tab`, `side`, or both. `tab` is a content tab
a person opens and closes; `side` stands beside the work. A view that named a
place would be arranging the window from inside the plugin, and the same `side`
view stands in all three places without knowing which one it is in.

`placements` and `defaultPlacement` are deleted, not mapped. A manifest carrying
either is **refused by name** — read and dropped, the view would stand somewhere
its author never chose.

Measured before the change: no consumer told `left` from `right`, and of the 46
manifests in the sample corpus 26 name a place. Those are refused, and the check
tells that kind of refusal from any other by reading the manifest rather than a
list somebody keeps up to date.

## P3. A set names no place, and a link names no set twice

A **set** is an ordered list of section keys with a title. It says what stands
together, not where.

A **link** ties one plugin to one set in one place — `rail` or `right`, the two
that follow the focus. The left edge takes `sections.left` instead, because it
holds one set for the installation and belongs to no plugin.

`sections.list` answers **one** list of available sections rather than one per
place: a `side` view is standable in every place, so a list per place would be
three copies of the same answer.

Refusal is by name. A set holding a view that lives only on a tab is refused
with that view named — dropped silently, the person reads it as the plugin
failing rather than as the set being wrong.

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

## S4. A place is present when it is open and a set stands in it

Both terms, all three places, one function — `placePresent` in `state/sectionSets.ts`. A place a
person opened with nothing standing in it reserves its width and draws nothing, and a strip of
reserved nothing reads as a view that failed to draw.

The rail asked both terms and the right edge asked only whether it was open, so the right stood
empty whenever it had been opened once — measured 2026-08-17, visible as a dark strip in every
capture of that day. Two readers now share the rule: the plane that draws the place, and the hole
reported to the native hit test for the surface underneath it, which would otherwise take clicks
away from that surface for a strip nobody sees.

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

A place that owns width is not a decoration. An outline can be taken away for a
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

The sections standing in a place are decided by a render and the rail's width
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
recordingFrame                                 — the window.record frame, absent when nothing records
```

**GREEN**: every record holds exactly 1 rail surface while a set stands in the
rail, `traveling` included (T1); a PIN focus change leaves `dStation` 0 and
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

No `filter` and no `opacity` on a content subtree. Pane-local black rectangles
outside the content paint idle and blocked panes exactly once; focused and exempt
panes paint nothing. A full-window SVG luminance mask is forbidden: it makes
WebCore rebuild a luminance image buffer while geometry moves.

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

- **The grouping is stated but not decided.** Said on 2026-08-17 against a
  screenshot: in a shape like this one, things near each other should be
  grouped, and they read as foreign. That is the whole of it — nothing was said
  about the rail's height, width, frame or where it stands, and nothing here may
  be invented from the picture (L6). The same day a requirement nobody asked for
  was written into a gate and the window was changed to satisfy it, which costs
  what a defect costs and is harder to see because it passes. What can be done
  without deciding anything is measurement: `layout.alignment` answers each
  pane's box, each pane's frame, the focus boundary and every place's box, so
  the gaps and the bands are numbers whenever the grouping is stated.

---

# N. Notes on the readings

- **`rail.settled` is a command and a check, from one function.** It answers
  whether a departing rail was left behind, with no verdict mid-journey. The
  check of that name inside `ui.verify` reads the same function, so the two
  cannot disagree.
- **A record carries the frame it opened on.** `window.record` numbers every
  frame it writes and that number is the common clock across journals. A layout
  record stamps `recordingFrame` when a recording is running and omits it when
  none is — absent is not frame zero, and a number from a finished burst would
  point at a picture of an earlier moment, which is worse than no number because
  it looks like one.
