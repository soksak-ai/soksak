---
kind: canonical
status: active
canonical: self
---

# Document manifest


## Layout

```
docs/
├── README.md              this manifest
├── tech/                  technical contracts        (kind: canonical)
├── manual/                procedures                 (kind: guide)
└── design-flow documents  human-readable decisions   (kind: changelog)
```

## Front matter

Every document carries three fields.

| Field | Values |
| --- | --- |
| `kind` | `canonical` · `guide` · `reference` · `changelog` · `translation` |
| `status` | `active` · `historical` |
| `canonical` | path to the authoritative document, or `self` |

Detail documents link up to their canonical. A canonical document must explain the current product
without requiring history. When a major contract transition needs a readable explanation, a
`kind: changelog` document explains the problem, decision, result, and evidence. It is design flow
for people, not a file-by-file development log and not a source of current rules. Git remains the
exact record of commits and diffs.

## Language

English is canonical. A reader-facing document may have a Korean translation at the matching
`.ko.md` path. The translation identifies its English canonical in front matter and defines no
independent rule. Comments, commit messages, identifiers, logs, error codes, test names, and API
field names remain English (AGENTS 6-1). Korean inside code remains confined to `ko` resource values.

## What belongs here

Contracts and the technical reasons behind them. A reason is what stops the next violation —
keep it, dated with the measurement that produced it. Provenance is not a reason; leave it out.

Schemas are the single source of truth where a schema exists. Prose adds only what a schema
cannot enforce. Never restate what the schema already enforces, and never invent a constraint
the schema does not back.

## A heading and its body are one claim

Where they disagree, that disagreement **is** the defect, and neither half may be taken as the
rule. The code is the arbiter: read what it does, decide which half is right, and correct the
other — in the document and in the code if the code is the wrong one.

Measured 2026-08-16. `RESTORE.md` R3 was headed "Ids are minted again, and that is the contract"
while its body named split ids alone, and the code matched the body. Reading the heading as the
rule and changing the code to match it broke the terminal reattach key — a session is keyed by
`windowLabel + "|" + paneId` — and the restart gate could not see it, because the digest holds no
id. The heading was the half that was wrong, and a whole day was spent on the wrong side of it.

A rule with no gate rots the same way and is not stated without one. Where the gate has to be
written, the document names the file that must hold it and what it must refuse; `NAMING.md` N3 did
that on the same date and the gate landed against it.

## Register

| Document | Contents |
| --- | --- |
| [`tech/GATES.md`](tech/GATES.md) | Which of G0–G5 stand, the command that judges each, and what it answered |
| [`tech/GATES.CHANGELOG.md`](tech/GATES.CHANGELOG.md) | Gate ownership and executable-target design history |
| [`tech/ARCHITECTURE.md`](tech/ARCHITECTURE.md) | What the core owns, the four seams a plugin attaches through, principles A1–A9, coupling law C1–C6, one registry with several transports, identity |
| [`tech/ARCHITECTURE.CHANGELOG.md`](tech/ARCHITECTURE.CHANGELOG.md) | Why domain features left Core and runtime implementations became installed components |
| [`tech/NAMING.md`](tech/NAMING.md) | Identifier format and prefixes, natural-key axes, labels, fixtures, public vocabulary, folder names — each with its gate |
| [`tech/NATIVE-LAYER.md`](tech/NATIVE-LAYER.md) | Why cgo is present, N1–N3, why purego is not used, capture, native surfaces |
| [`tech/NATIVE-SURFACES.md`](tech/NATIVE-SURFACES.md) | Content outside the document — the seven-attribute declaration, the label shape, one inventory per window per delivery, and the declared-versus-applied numbers the seam is judged by |
| [`tech/RESTORE.md`](tech/RESTORE.md) | What is stored, what comes back after a restart, and the one digest the two are compared by |
| [`tech/RESTORE.CHANGELOG.md`](tech/RESTORE.CHANGELOG.md) | Why restore rejects invalid records instead of repairing them |
| [`tech/SIDEBAR.md`](tech/SIDEBAR.md) | The three places a sidebar stands in and the two surfaces a view is drawn on, where the rail stands and what moves when focus does — FLOW and PIN, the travel journal, and the focus lighting read as addresses |
| [`tech/SIDEBAR.CHANGELOG.md`](tech/SIDEBAR.CHANGELOG.md) | Why plugins declare surfaces while workspaces own placement |
| [`tech/REPO-LAYOUT.md`](tech/REPO-LAYOUT.md) | Which folder declares what, the workspace and the application tree, two binaries, where a document goes |
| [`tech/REPOSITORY-GOVERNANCE.md`](tech/REPOSITORY-GOVERNANCE.md) | Canonical branches, fork improvement lines, historical archives, and the no-source-loss rule |
| [`tech/BUILD-TOOLCHAIN.md`](tech/BUILD-TOOLCHAIN.md) | Tool version owners, discovery, preparation, upgrades and precondition failures |
| [`tech/IDENTITY.md`](tech/IDENTITY.md) | One derivation for home, socket, CLI name and axis; the core reads no ambient; one backend per home |
| [`tech/ENVIRONMENT-AND-INSTALLATION.md`](tech/ENVIRONMENT-AND-INSTALLATION.md) | Runtime component environment, local/registry release transport, and installer ownership |
| [`tech/ENVIRONMENT-AND-INSTALLATION.CHANGELOG.md`](tech/ENVIRONMENT-AND-INSTALLATION.CHANGELOG.md) | Why local component state became one atomic environment |
| [`tech/CONTROL-PROTOCOL.md`](tech/CONTROL-PROTOCOL.md) | One line of JSON, the envelope, the greeting that negotiates, the command table, the socket address |
| [`tech/CONTROL-PROTOCOL.CHANGELOG.md`](tech/CONTROL-PROTOCOL.CHANGELOG.md) | Why the control plane requires one self-describing response shape |
| [`tech/COMMAND-LINE.md`](tech/COMMAND-LINE.md) | Public dotted command names, name-value and JSON object parameter forms, discovery, output and quoting |
| [`tech/TERMINAL-UX-HANDOFF.md`](tech/TERMINAL-UX-HANDOFF.md) | Unresolved terminal UX defects, workspace ownership map and verified baseline |
| [`tech/PROCESS-MONITOR.md`](tech/PROCESS-MONITOR.md) | Process ownership contract and the RED boundary for the process-monitor sidebar |
| [`tech/TERMINAL-UX-EXECUTION.md`](tech/TERMINAL-UX-EXECUTION.md) | Required RED-to-GREEN order for renderer parity, view visibility, native close and test isolation |
| [`tech/TERMINAL-STANDARD-AUDIT.md`](tech/TERMINAL-STANDARD-AUDIT.md) | Provider-by-provider standards evidence; unverified and RED rows remain explicit |
| [`tech/MESSAGE-PROTOCOL.md`](tech/MESSAGE-PROTOCOL.md) | Request and response shape, progress deltas, correlation by parent id |
| [`tech/SIDECARS.md`](tech/SIDECARS.md) | A plugin in its own process: one envelope, lifetime, distribution, declaration |
| [`tech/PLUGIN-CONTRACT.md`](tech/PLUGIN-CONTRACT.md) | What a plugin declares, who owns each definition, the generated contract.json, permissions, and contract ids |
| [`tech/I18N.md`](tech/I18N.md) | Who reads a sentence decides where it lives, the key table and the Go mechanism, what a test may assert |
| [`tech/UI-GEOMETRY.md`](tech/UI-GEOMETRY.md) | Bands, boxes, and which box draws which line — the alignment rules R1–R5, the border-ownership constitution B1–B8, and the layer principle |
| [`manual/TESTING.md`](manual/TESTING.md) | What `go tool wails3 task verify` runs, why gates only increase, red before green, where tests live |
| [`manual/EVIDENCE.md`](manual/EVIDENCE.md) | A number decides a visual claim, captures take no focus, where evidence is kept, the frame clock, why an instrument may not share a source with its subject, and proving a gate bites |
| [`manual/AGENT-CONTROL.md`](manual/AGENT-CONTROL.md) | The registry as single source, thin channels, one permission gate, event symmetry, what is visible |
| [`manual/DEVELOPMENT.md`](manual/DEVELOPMENT.md) | Order of a change, no compatibility layers, deleting failed attempts, reverting, prose |

## Outside this folder

| Document | Contents |
| --- | --- |
| [`../AGENTS.md`](../AGENTS.md) | The development discipline. Read before any of these |
