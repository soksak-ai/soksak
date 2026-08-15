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
| [`tech/NAMING_KO.md`](tech/NAMING_KO.md) | Identifier format and prefixes, natural-key axes, labels, fixtures, public vocabulary, folder names — each with its gate |
| [`tech/NATIVE-LAYER.md`](tech/NATIVE-LAYER.md) | Why cgo is present, N1–N3, why purego is not used, capture, native surfaces |
| [`tech/REPO-LAYOUT_KO.md`](tech/REPO-LAYOUT_KO.md) | Which folder declares what, the workspace and the application tree, two binaries, where a document goes |
| [`tech/IDENTITY_KO.md`](tech/IDENTITY_KO.md) | One derivation for home, socket, CLI name and axis; the core reads no ambient; one backend per home |
| [`tech/CONTROL-PROTOCOL_KO.md`](tech/CONTROL-PROTOCOL_KO.md) | One line of JSON, the envelope, the greeting that negotiates the version, the command table, the socket address |
| [`tech/MESSAGE-PROTOCOL_KO.md`](tech/MESSAGE-PROTOCOL_KO.md) | Request and response shape, progress deltas, correlation by parent id |
| [`tech/PLUGIN-CONTRACT_KO.md`](tech/PLUGIN-CONTRACT_KO.md) | What a plugin declares, who owns each definition, the generated contract.json, permissions, contract ids |
| [`tech/UI-GEOMETRY_KO.md`](tech/UI-GEOMETRY_KO.md) | Bands, boxes, dividers — the alignment rules R1–R5, the border-ownership constitution B1–B8, the layer principle |
| [`manual/TESTING_KO.md`](manual/TESTING_KO.md) | What `task verify` runs, gates increase monotonically, RED first, where tests are kept |
| [`manual/EVIDENCE_KO.md`](manual/EVIDENCE_KO.md) | A number judges a visual claim, captures take no focus, where evidence is kept, the frame clock |
| [`manual/AGENT-CONTROL_KO.md`](manual/AGENT-CONTROL_KO.md) | The registry as single source, thin channels, one permission gate, event symmetry, what is visible |
| [`manual/DEVELOPMENT_KO.md`](manual/DEVELOPMENT_KO.md) | Order of a change, no compatibility layers, deleting failed attempts, reverting, prose |

## Outside this folder

| Document | Contents |
| --- | --- |
| [`../AGENTS_KO.md`](../AGENTS_KO.md) | The development discipline. Read before any of these |
| `../local/README.md` | What is local to this machine. Gitignored, so a fresh clone does not have it, and its absence is normal |

## What is not established yet

The source is in `local/carried/`, outside the record — because it names where its rules came from. Each entry below names what has to exist before the document does.

| Source | Waits for |
| --- | --- |
| `PLUGINS.md` | Plugin loading. An authoring guide(quick start, manifest reference, SDK), and every instruction in it needs a loader to be true. Becomes `manual/PLUGIN-AUTHORING.md`. |
| `PLUGIN-SERVICE.md` | A service sidecar. The contract level is in `tech/SIDECARS.md`, and the PS1–PS16 detail describes a drive mode this build does not run. |
| `NATIVE-SURFACES.md` | G3. Written when the native browser surface lands, with the declared-versus-applied numbers that judge it. |
| `SIDEBAR.md` | G4. Written when the rail contract lands. |
| `RESTORE.md` | G5. Written when restore lands. |
| `PLUGIN-DATA-ENCRYPTION.md` | An encrypted namespace in the store. |
| `I18N.md`, `PERFORMANCE.md`, `DEPLOY.md`, `license-system-design.md` | Judgement pending. A contract this build does not have yet. |
