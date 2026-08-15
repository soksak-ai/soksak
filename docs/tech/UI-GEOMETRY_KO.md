---
kind: canonical
status: active
canonical: tech/UI-GEOMETRY.md
---

# UI geometry — bands, boxes, and who draws which line

English is canonical: [`UI-GEOMETRY.md`](UI-GEOMETRY.md). Where the two differ, English wins.

Free, and exact. A theme sets the sizes, but a 1px misalignment must be **structurally impossible**
This claim is held by machines — the static gate `frontend/src/ui/cssContract.test.ts`, the contract
table `frontend/src/ui/borderContract.ts`, and, running against a live window, `ui.validate`
and `ui.expect`.

A red gate is not a gate to weaken. If the standard itself is wrong, state that and correct the
standard — silently working around it is the one move this document forbids outright.

## Scope

Each rule below comes with the measurement that produced it. A rule holds only for as long as its reason is true on this build
and no longer. The two that changed are recorded at the end of the document, with what changed and how.

---

# A. Alignment

## R1. A band's padding is the band's own

The vertical space inside a horizontal band is owned by the strip's `padding-block` variable, and nothing else. Items (chips·
buttons, controls) stretch to fill what is left.

- View tabs: `--tab-pad` → `.view-tabs` — header 33 − line 1 = interior 32, padding 4 → chip 24
- Workspace tabs: `--ws-pad` → `.tabs`·`.content-tabs` — 37 − 1 = interior 36, padding 5 → chip 26

Item height is therefore **derived**: band inside − padding×2. There are two results, and those two are the
point of this rule.

- Sibling boxes are the same height on the same axis by definition. A 1px difference between them **cannot be expressed.**
- With whole-pixel padding an item's position is whole too. Half-pixel centring cannot occur.

The rejected alternative was giving strips and items their own heights. When their parities disagreed the item landed on a half pixel
landed on it — centring a chip of 28 in an interior of 37 gives y=48.5, and top and bottom antialias differently.

A theme sets sizes through the padding variable only. `height:` on an item selector is refused by the gate
(`auto` excluded). The only exception is a place that is not a horizontal band — the square project rail, the vertical tab list.

**Parity.** The inner height of a band is set even (title bar 45−1=44, chrome row 37−1=36, group header
33−1=32). Even padding then yields an even chip, and even content inside the chip (icons at 12/14/16, a close box
16) are centered on integers. Instead of a half pixel recurring per component, every layer is corrected at once
disappears.

## R1a. Adjacent bands are one row

Bands standing side by side horizontally are one row: left header · space tabs · right header · left host
tabs. One pixel of difference between any two of them and the rule between them steps.

The height is owned by one rule (`--chrome-row-h`), and no individual block declares its own.

**The same rule holds between the sidebar and the content.** The sidebar header and the content header are one row,
The sidebar footer and the content footer are one row. Measured 2026-08-15: content header 33px, sidebar header
at 30px, and the two rows stood 3px apart along the whole seam. That misalignment was drawn in a different colour by each theme, so
it looked like a different defect in each theme.

## R2. flex owns alignment

A band is `display: flex; align-items: center`. Making something *look* right with absolute positioning, negative offsets, margin arithmetic or a translate
nudge is forbidden. Such a correction is correct for exactly one font, one zoom, and one
theme.

## R3. A divider is a boundary, not padding

A band's separator is drawn with `border` — it occupies layout. Symmetry is then judged as "the space above equals the space below the
below the line", and the border model satisfies that without anyone computing it.

The band height formula is `padding + item + padding + rule`, and every term is an integer: `.content-tabs` 37 =
5 + 26 + 5 + 1.

## R3a. A theme is variables, not CSS

A theme does not ship CSS. Arbitrary CSS re-breaks R1's structural guarantee per theme, and every time the application is
refactored, every external theme breaks silently.

A theme's freedom is the approved slots — the colour tokens, and the structural knobs (`--tab-pad` · `--ws-pad` · radius).
**With no knob, the right move is to add a slot.** A theme does not go past its slots.

## R4. One CSS rule owns the coordinate arithmetic

Assembling `calc(...)` strings in JSX and scattering them inline is forbidden. A layer that needs layout
receives four variables only (`--l` `--t` `--w` `--h`), and the arithmetic is held by one rule in App.css.

Dimension constants (`--header-h` · `--status-h` · `--pane-inset`) are **injected once from a single TS source**.

Inline placement is legitimate only with a stated reason — the persistent body slot that preserves a session, the boundary
itself — the split divider — and the drop indicator, which is an overlay.

## R5. An alignment claim is a number

"It looks right" is not evidence. Take the rect with `sok ui.measure '{"address":"…"}'` and confirm the sibling
Only after the y·h match and the margin symmetry are confirmed is it counted as done. The address comes from `sok ui.tree`, and a guessed
selector is not used — an element that is not exposed cannot be measured, and that is the purpose of this rule.

---

# B. Border ownership — which box draws which edge

The root cause of the 1px step and the missing line is that the side has no owner. **Every line has an owner
is exactly one.**

RED comes first: fix something only after the checker has caught the violation.

## B1. The perimeter is the frame's

A panel's four outer edges are the frame overlay's, exclusively. No inner element draws on an outer edge.

**Ownership is not display.** What the frame draws is the authority of the pane style token — `flat`
draws nothing, and the contract **asserts that absence as "a state that must not appear"**. Rather than leaving it
unsaid.

## B2. The body draws nothing

The body (terminal, editor, webview slot) owns no border. Opaque content covers its own border, so
so that border exists and is invisible.

The boundary next to a body is owned by the adjacent chrome band **on the side facing the body**: a header owns bottom, a footer
top, left chrome its right, right chrome its left.

## B3. When chrome meets chrome

When two chrome surfaces meet, the one **further** from the body owns the line: the titlebar its bottom, the rail its right.

## B4. Two tokens, no literal color

A structural line is `var(--bd)` (application chrome, perimeters, floating surfaces), or `var(--bd-soft)` for a rule inside a panel
(`color-mix` derived — it adds no theme slot). The accent is `--accbg`.

A literal colour in a border declaration fails the build. The gate reads every border declaration for this rule.

## B5. The pixel budget of a frame

The frame is an overlay, so an element that touches an outer edge pays that edge's 1px out of its own budget —
DOM chrome bands pay it with padding, in `card` and `floating`.

A native child webview pays nothing, because of the layer principle below — the DOM draws above the webview, so
the frame's border is always visible. What remains is integer snapping of the hole's rect, and a fractional rect is refused.

## B6. A boundary tool does not own the line

Resizers and drag handles are zero-width overlays. The line is drawn by whoever owns it under B2 or B3.

One exception — for a seam between opaque contents (two split terminals, say), a DOM owner to hold the border
does not exist. There, in a `solid` divider theme, the boundary tool **displays** a 1px centre line (ownership delegated).
Under `overlay` it is fully transparent at rest.

## B7. A mixed row is centered by its container

A row that mixes text and icons has the container own `flex; align-items: center`. An icon
is never placed on the baseline flow. Vertical centring is judged on **visible pixels**, not on the box
(after subtracting border and overlay).

## B8. A contract must be exhaustive

The validator only sees surfaces that are registered. Three gates keep that honest.

1. **CSS → contract** — a selector that draws a structural border is either listed in the contract or a "widget outline" (a closed curve — the boundary face
   not) must be classified explicitly. An unknown boundary is a failure.
2. **Contract → CSS** — a rule in the contract must have a matching declaration. A rule that points at nothing is
   is not a rule.
3. **Every state** — conditional surfaces must cover the whole `paneStyle × divider` space with no gap and no contradiction, and
   **both the state that must exist and the state that must not exist** have to be asserted.

The remaining gap — a new surface with neither a line nor a contract entry — is closed by procedure: when `sok ui.expect
'{"selector":"…"}'` reports "no rule", registering the contract is a prior obligation.

---

# L. The DOM is always on top

A native child webview competes with the main webview's DOM for z-order in the OS view hierarchy. Following the framework's default
puts every DOM overlay — modals, menus, drop indicators, focus rings — underneath it. Hiding the browser while an overlay
is up works around that, but the page repaints every time a menu opens. The structure here is the inverse.

1. **z-order inversion.** A child webview is moved **below** the main webview immediately after creation.
2. **Transparent hole.** The main webview does not paint its own background, the root CSS chain is transparent, and each surface
   owns its own opaque background. Only the browser slot is transparent — that is the hole, and the webview below shows through.
   the colour of an unpainted region is the native window background, and the theme engine keeps it equal to `bg`.
3. **hitTest delegation.** The native hitTest hands a pointer inside the hole to the webview below. The hole's single
   truth is the frame of the visible child webview itself, and there is no registry. While an overlay is up,
   delegation is blocked, so "click outside = close" holds — the browser is visible but inert, and that is what a modal
   is the original meaning.

Corollary: every DOM layer draws above the browser, so hiding it is never the answer. An opaque
background restored anywhere on the root chain plugs the hole. A cell whose active view is a browser paints no background in its body.

**Measured 2026-08-15, this build.** The web view was opaque — this framework's `MacBackdropNormal`
does not touch the webview, and the `BackgroundType` field is read only on linux·windows, and on darwin it is
is ignored. Every region nobody painted was the engine's white — in every theme, in every workspace window.
The transparent hole is not a browser feature but **the ground the whole stylesheet stands on**.

---

# Judged, and changed

**Kept as written because the basis is still true.** R1 · R1a · R2 · R3 · R3a · R4 · R5 · B1–B8 · L. None
of them depends on a particular framework — a statement about boxes, a statement about who owns a line, a statement that a claim
It is the statement that a claim is proved with a number.

**Change — R1a extends to the sidebar.** The row contract at first covered only bands set side by side horizontally
was written that way. The same argument applies to the sidebar·content bands facing each other across a vertical seam, and this build
were 33 and 30. The rule is one now, and one source answers both.

**Change — the sidebar frame is not the plugin's.** For the sidebar footer, a plugin contributes the footer view
existed only when it was declared, and took its height from that plugin's content. A frame that depends on its content is not a
frame: a build with no plugins had no sidebar footer at all, and only that window's skeleton differed from every other window's.
The place is the theme's, and a plugin only puts text or an icon into it and does not set the height.

**A contradiction recorded, not resolved.** `App.css` stated that the chrome row height is "owned by the theme", and R4
states that dimension constants are injected once from a single TS source. Both cannot be true. This build
follows it — R1 derives the height from the padding knobs a theme **actually owns**, so a theme still
Size is set through the slot, and the derivation keeps both sides identical. The side that drifted is that comment, and on the spot
correct it.
