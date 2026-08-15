---
kind: canonical
status: active
canonical: self
---

# UI geometry — bands, boxes, and who draws which line

Free, and exact. A theme decides sizes; a one-pixel misalignment is structurally
impossible. That is the whole claim, and it is held by machines: the static gate
`frontend/src/ui/cssContract.test.ts`, the contract table
`frontend/src/ui/borderContract.ts`, and the live checks `ui.validate` and
`ui.expect` on the running window.

A gate that fails is not a gate to weaken. If the standard itself is wrong, say
so and correct the standard — silently working around it is the one move this
document forbids outright.

## Scope

Each rule below carries the measurement that produced it. A rule holds only
while its reason holds on this build; two rules are recorded as changed at the
end, with what changed and why.

---

# A. Alignment

## R1. A band's padding is the band's

The vertical space inside a horizontal band belongs to the strip's
`padding-block` variable, and nothing else. Items — chips, buttons, controls —
stretch to fill what is left.

- view tabs: `--tab-pad` on `.view-tabs` — header 33 − rule 1 = 32 inside, pad 4
  → chip 24
- workspace tabs: `--ws-pad` on `.tabs` and `.content-tabs` — 37 − 1 = 36
  inside, pad 5 → chip 26

Item height is therefore *derived*: band inside − padding × 2. Two consequences
follow, and both are the point:

- Sibling boxes are the same height on the same axis by definition. A
  one-pixel difference between them cannot be expressed.
- Integer padding means integer item positions. Half-pixel centring cannot
  occur.

The rejected alternative was giving strips and items their own heights. When
their parities disagreed the item landed on a half pixel — a 28 chip centred in
37 sits at y=48.5, and the top and bottom antialias differently.

A theme sets sizes through the padding variable only. `height:` on an item
selector is refused by the gate (`auto` excepted). The exceptions are the places
that are not horizontal bands: the square workspace rail, and vertical tab lists.

**Parity.** A band's inside height is even — titlebar 45 − 1 = 44, chrome row
37 − 1 = 36, group header 33 − 1 = 32. Even padding then yields an even chip,
and even content inside the chip (icons at 12/14/16, a 16 close box) centres on
integers. Half pixels disappear at every level at once, rather than being chased
one component at a time.

## R1a. Neighbouring bands are one row

Bands that stand side by side horizontally are a single row: the left header,
the space tabs, the right header, the left host tabs. One pixel of difference
between any two of them and the rule between them steps.

The height belongs to one rule — `--chrome-row-h` — and no individual block
declares its own.

**The same applies vertically between the sidebar and the content.** The sidebar
header and the content header are one row; the sidebar footer and the content
footer are one row. Measured 2026-08-15 on this build: the content header was
33px and the sidebar header 30px, and the two rows stood three pixels apart
along the whole seam. The misalignment looked like a different defect in each
theme, because each theme drew it in a different colour.

## R2. Flex owns alignment

A band is `display: flex; align-items: center`. Making something *look* centred
with absolute positioning, negative offsets, margin arithmetic, or a translate
nudge is forbidden. Those corrections are correct for exactly one font, one
zoom, and one theme.

## R3. A rule is a boundary, not a margin

A band's separator is drawn with `border`, which occupies layout. Symmetry is
then judged as "space above equals space below the line", and the border model
satisfies that without anyone computing it.

Band height is `padding + item + padding + rule`. Every term is an integer:
`.content-tabs` is 37 = 5 + 26 + 5 + 1.

## R3a. A theme is variables, never CSS

A theme does not ship CSS. Arbitrary CSS re-breaks R1's structural guarantee
per theme, and every refactor of the application silently breaks every external
theme.

A theme's freedom is the approved slots: the colour tokens, and the structural
knobs — `--tab-pad`, `--ws-pad`, the radii. **When a knob is missing, the right
move is to add a slot**, not to let a theme reach past the slots.

## R4. Coordinate arithmetic belongs to one CSS rule

Assembling `calc(...)` strings in JSX and scattering them inline is forbidden.
A layer that needs placing receives four variables — `--l`, `--t`, `--w`, `--h`
— and the arithmetic lives in one App.css rule.

Dimension constants (`--header-h`, `--status-h`, `--pane-inset`) are injected
once, from a single TypeScript source.

Inline placement is legitimate only with a stated reason: the persistent body
slot that preserves a session, a split divider which *is* the boundary, and a
drop indicator, which is an overlay.

## R5. An alignment claim is a number

"It looks right" is not evidence. Take the rect with
`sok ui.measure '{"address":"…"}'`, confirm sibling y and h agree and the
margins are symmetric, and only then say it is done. Addresses come from
`sok ui.tree`, never from a guessed selector — an element that is not exposed
cannot be measured, and that is the point.

## R5a. The whole layout is one number

`ui.measure` reads one node. A split layout is many, and reading them one at a
time leaves the subtraction — and the R4 arithmetic it needs — to whoever is
asking.

`sok layout.verify` does it for the active space: for every pane it answers the
declared rect (a percentage of the space box), the rect that percentage should
produce under the R4 rule, the measured viewport rect, and their difference.
**Judgement: `worst` is 0 within one device pixel.** A pane the arrangement
names but the screen does not draw comes back in `missing`; a pane on screen
the arrangement does not name comes back in `unexpected`. Neither is a small
difference, so neither is reported as one.

The command recomputes the position from the percentage instead of reading it
back from the element. A verifier that shares the renderer's arithmetic agrees
with the renderer about everything, including its mistakes.

**Read `settled` first.** A pane in a layout transition is interpolated toward
where it is going, so during one every number describes a frame and not the
layout. The answer carries `settled` and the open transaction ids rather than
leaving that to memory — measured 2026-08-16, verifying between rapid splits
gave differences above 100px and 32 panes counted as missing, all of which came
to 0.013px and 0 once the transitions closed. Wait with
`sok layout.transaction.wait` and ask again.

A cell smaller than the chrome that has to fit in it is refused, not drawn:
`pane.split` answers `TOO_SMALL` with the measurement and the floor. The floor
is the inset pair, below which the cell has no interior and CSS clamps the
width to 0 — the point where the declaration stops being true on screen. Every
resulting cell is checked, because a split redistributes the whole row and the
cell that runs out of room is usually one nobody named.

The rail counts. It is inserted into the row, so every cell keeps its
percentage and loses pixels in proportion: the row is the space box less the
rail's whole width. Measured 2026-08-16, a single pane in a 999px space with
the rail open was 827px — 999 less 160 of rail and 12 of inset pair.

---

# B. Border ownership — which box draws which edge

The root cause of a one-pixel step or a missing line is that nobody owns the
edge. **Every line has exactly one owner.**

Red before green: the validator finds the violation first, and only then is
anything changed.

## B1. The perimeter is the frame's

A panel's four outer edges belong to the frame overlay, exclusively. No inner
element draws on an outer edge.

**Owning is not showing.** Whether the frame draws anything is the pane-style
token's decision — `flat` shows none, and the contract asserts that absence as a
state that must not appear, rather than leaving it unsaid.

## B2. The body draws nothing

A body — terminal, editor, webview slot — owns no border. Opaque content covers
its own border, so the border would exist and be invisible.

The boundary next to a body is owned by the adjacent chrome band, on the side
facing the body: headers own their bottom, footers their top, left chrome its
right, right chrome its left.

## B3. Chrome meeting chrome

When two chrome surfaces meet, the one further from the body owns the line: the
titlebar its bottom, the rail its right.

## B4. Two tokens, and no colours

A structural line is `var(--bd)` — application chrome, perimeters, floating
surfaces — or `var(--bd-soft)` for a rule inside a panel, derived by
`color-mix` so it needs no theme slot of its own. Emphasis is `--accbg`.

A literal colour in a border declaration fails the build. The gate reads every
border declaration for this.

## B5. The frame's pixel budget

The frame is an overlay, so an element that touches an outer edge pays that
edge's pixel out of its own budget: DOM chrome bands pay it with padding, in
`card` and `floating`.

A native child webview pays nothing, because of the layer principle below — the
DOM draws above the webview, so the frame's border is always visible. What
remains is integer snapping of the hole's rect; a fractional rect is refused.

## B6. A boundary tool owns no line

Resizers and drag handles are zero-width overlays. The line is drawn by whoever
owns it under B2 or B3.

One exception: a seam between two opaque contents — two terminals across a
split — has no DOM owner to hold a border. There, in a `solid` divider theme,
the boundary tool *displays* a one-pixel centre line by delegation. Under
`overlay` it is fully transparent at rest.

## B7. A row of mixed content centres in the container

A row that mixes text and icons is `flex; align-items: center` on the container.
Icons are never placed on the baseline flow. Vertical centring is judged on
visible pixels — after borders and overlays are subtracted — not on the box.

## B8. The contract must be total

The validator only sees surfaces that are registered. Three gates keep that
honest:

1. **CSS to contract** — a selector that draws a structural border must be in
   the contract, or be classified explicitly as a widget outline (a closed
   shape, not a boundary). An unknown boundary is a failure.
2. **Contract to CSS** — a rule in the contract must have a declaration
   answering it. A rule about nothing is not a rule.
3. **Every state** — conditional surfaces must cover the whole `paneStyle ×
   divider` space with no gap and no contradiction, asserting both the states
   that must exist and **the states that must not**.

The remaining gap — a new surface with neither a line nor a contract entry — is
closed by procedure: when `sok ui.expect '{"selector":"…"}'` answers "no rule",
registering the surface comes first.

---

# L. The DOM is always on top

A native child webview competes with the main webview's DOM for z-order in the
OS view hierarchy. Following the framework's default puts every DOM overlay —
modals, menus, drop indicators, focus rings — underneath it. Hiding the browser
while an overlay is open works around that and costs a repaint of the page every
time a menu opens. The structure here is the inverse:

1. **Inverted z-order.** A child webview is placed *below* the main webview
   immediately after creation.
2. **A transparent hole.** The main webview does not paint its own background,
   the root CSS chain is transparent, and each surface owns an opaque
   background. Only the browser slot is transparent — that is the hole, and the
   webview beneath shows through it. The colour of everything unpainted is the
   native window's background, which the theme engine keeps equal to `bg`.
3. **Delegated hit testing.** A pointer inside the hole is handed to the webview
   below by the native hit test. The hole's single truth is the visible child
   webview's frame itself; there is no registry. While an overlay is up,
   delegation is blocked, so "click outside to close" holds — the browser is
   visible and inactive, which is what a modal means.

Corollaries: every DOM layer draws above the browser, so hiding it is never the
answer. Restoring an opaque background anywhere on the root chain plugs the
hole. A cell whose active view is a browser paints no background in its body.

**Measured 2026-08-15, on this build.** The webview was opaque, because this
framework's `MacBackdropNormal` leaves it drawing its own background and its
`BackgroundType` field is read on Linux and Windows and ignored on darwin. Every
region nobody painted was the engine's white — in every theme, in every
workspace window. The transparent hole is not a browser feature; it is what the
whole stylesheet stands on.

---

# Judged, and changed

**Kept, with the reason still true.** R1, R1a, R2, R3, R3a, R4, R5, B1–B8, L.
None of them depends on a particular framework: they are statements about boxes,
about who owns a line, and about proving a claim with a number.

**Changed — R1a now spans the sidebar.** The row contract first covered only
bands standing side by side horizontally. The same argument applies to the
sidebar and content bands facing each other across a vertical seam, and this
build had them at 33 and 30. The rule is one rule now, and one source answers
both sides.

**Changed — the sidebar's frame is not its plugin's.** The sidebar footer used
to exist only when a plugin declared a footer view, and took its height from
that plugin's content. A frame that depends on its content is not a frame: a
build with no plugins had no sidebar footer at all, so that window's skeleton
differed from every other window's. The place is the theme's; a plugin puts text
or an icon into it and never decides how tall it is.

**A contradiction, recorded rather than resolved.** `App.css` says the chrome row
heights are "owned by the theme"; R4 says dimension constants are injected once
from a single TypeScript source. Both cannot be true. R4 is the rule this build
follows, because R1 derives heights from the padding knobs a theme *does* own —
so a theme still decides the size, through the slot, and the derivation is what
keeps the two sides equal. The comment is the outlier and is corrected where it
sits.
