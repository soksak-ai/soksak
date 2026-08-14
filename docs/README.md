---
kind: canonical
status: active
canonical: self
---

# Document manifest

Korean edition: [`README_KO.md`](README_KO.md). English is canonical.

## Layout

```
docs/
├── README.md              this manifest
├── tech/                  technical contracts        (kind: canonical)
├── manual/                procedures                 (kind: guide)
└── investigations/<topic>/ hypotheses and experiments (kind: investigation)
```

## Front matter

Every document carries three fields.

| Field | Values |
| --- | --- |
| `kind` | `canonical` · `guide` · `reference` · `investigation` · `decision` · `snapshot` |
| `status` | `active` · `historical` · `superseded` |
| `canonical` | path to the authoritative document, or `self` |

Detail documents link up to their canonical. When an investigation settles into a contract,
the conclusion moves into the canonical document and the investigation flips to `superseded`.

## Language

English is canonical: `X.md`. Korean is supplementary: `X_KO.md`. Where they differ, English
wins. Both change in the same commit.

## What belongs here

Contracts and the technical reasons behind them. A reason is what stops the next violation —
keep it, dated with the measurement that produced it. Provenance is not a reason; leave it out.

Schemas are the single source of truth where a schema exists. Prose adds only what a schema
cannot enforce. Never restate what the schema already enforces, and never invent a constraint
the schema does not back.

## Register

| Document | Contents |
| --- | --- |
| _(none yet)_ | |
