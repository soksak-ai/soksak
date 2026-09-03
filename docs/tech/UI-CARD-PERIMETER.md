# The card and rail perimeter contract

This is the canonical document for making the sidebar, a pane, a DOM surface and a
native surface use one card rule. It states the contract an implementation follows,
not the state an implementation is in.

## C1. The card is the only perimeter unit

The sidebar and a pane both have the `layout-card` structure. A role is told apart by
adding the `layout-card--sidebar` or `layout-card--pane` modifier and nothing else. No
role gets its own DOM order, its own perimeter calculation, or its own spacing formula.

A card's public structure is in this order.

```text
layout-card
└── card-chrome
└── card-surface
└── card-status
```

A native surface consumes the same card rect and the same card tokens. The same rect is
drawn as a native decoration only where a native surface would cover the DOM border.
That is not a second perimeter — it is the one perimeter drawn in a different medium.

## C2. The theme settles the card's shape

The theme declares a card's radius, border token and width, background, and shadow. The
DOM and the native decoration consume one normalised result rather than each reading the
declaration. `flat`, `card` and `floating` differ in presentation tokens only, never in
structure.

## C3. The rect is calculated once

The layout solver calculates one `CardRect` and publishes it. The sidebar, a pane, a
surface slot, a native perimeter and the inspector read that `CardRect`. A second
calculation that rebuilds the same rectangle out of `railStation`, `targetRect` and
`railWidth` is not usable as a card perimeter.

The published state has at least `cardId`, `role`, `rect`, `themeRevision` and
`geometryOwner` in it. One card has exactly one `geometryOwner`.

## C4. The rail is a connector, separate from the card

The rail is a connecting line, distinct from a card perimeter. It crosses the grid's gap
and enters and leaves a card perimeter, so it is not merged into one shape with the
card's own border.

The rail's geometry has one owner, a single `rail-connector`. The connector's endpoints
and bends are derived from the inner outline of the canonical `CardRect`, never from a
`railStation + railWidth + targetRect` recalculation. Where the connector meets a card it
uses the card border's token and stroke rules; where it crosses the gap it uses the
connector rules.

A relation overlay draws no rail, pane, or union card perimeter. The rail connector and
the card perimeter have different owners and consume the same rect and theme revision.

## C5. What the gates measure

RED detects these mechanically.

- The sidebar and a pane missing the shared `layout-card` structure or order
- More than one `geometryOwner` on one `cardId`
- A DOM rect and a native perimeter rect that disagree
- A relation overlay producing a rail, pane, or union perimeter path
- One rail connector produced by more than one layer
- A rail connector meeting a card away from the canonical `CardRect` perimeter
- A radius or border token that differs between themes

GREEN verifies the DOM and the native side each against the same `CardRect` and tokens,
and a person confirms the perimeter over every native surface with `window.snapshot`.
