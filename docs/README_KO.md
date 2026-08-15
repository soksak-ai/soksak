---
kind: canonical
status: active
canonical: README.md
---

# Document manifest

The English canonical is [`README.md`](README.md). Where the two differ, English wins.

## Placement

```
docs/
├── README.md               this manifest
├── tech/                   technical contracts        (kind: canonical)
├── manual/                 procedures             (kind: guide)
└── investigations/<topic>/  hypotheses and experiments      (kind: investigation)
```

## Front matter

Every document has three fields.

| Field | Values |
| --- | --- |
| `kind` | `canonical` · `guide` · `reference` · `investigation` · `decision` · `snapshot` |
| `status` | `active` · `historical` · `superseded` |
| `canonical` | Path to the authoritative document, or `self` |

A detail document links up to its canonical. When an investigation settles into a contract, the conclusion moves into the canonical document
and the investigation document flips to `superseded`.

## Language

English canonical `X.md`, Korean companion `X_KO.md`. Where they differ, English wins. Both are fixed in the same commit.

## What goes here

Contracts and the technical reasons behind them. A reason is what stops the next violation, so keep it — with the measurement that produced it and
the date it was measured. Provenance is not a reason. Leave it out.

Where a schema exists, the schema is the single source of truth. Prose adds only what a schema cannot enforce.
Never restate what the schema already enforces, and never invent a constraint the schema does not back.

## The register

| Document | Contents |
| --- | --- |
| [`tech/ARCHITECTURE.md`](tech/ARCHITECTURE.md) | What the core owns, the four seams a plugin attaches through, principles A1–A9, coupling law C1–C5, one registry with several transports, identity |
| [`tech/NATIVE-LAYER.md`](tech/NATIVE-LAYER.md) | Why cgo is present, N1–N3, why purego is not used, capture, native surfaces |
| [`tech/UI-GEOMETRY_KO.md`](tech/UI-GEOMETRY_KO.md) | Bands, boxes, dividers — the alignment rules R1–R5, the border-ownership constitution B1–B8, the layer principle |
