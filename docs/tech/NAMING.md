---
kind: canonical
status: active
canonical: self
---

# Naming


Every rule here has a gate. The gate is named with the rule.

## N1. Identifier format

Format: `<three letters>-<six base32 characters>`. Example: `pan-7k2qx3`.

The prefix is exactly three letters. One or two letters do not separate the kinds in this
product: `s-` fits space, split and session; `v-` fits view and value; `w-` fits window, webview
and workspace.

The body is six characters of RFC 4648 lowercase base32 (`a-z`, `2-7`). The digits `0` and `1`
are not in that alphabet, so they are never confused with `o` and `l`. Six characters give about
10⁹ values. A collision resolves as `AMBIGUOUS` with candidates.

Identifiers are not counters. A counter restarts at 1 in each window and each run, so the same
value names different things in two places.

| Kind | Prefix | Issuer |
| --- | --- | --- |
| workspace | `wsp-` | `frontend/src/state/ids.ts` |
| space | `spc-` | same |
| pane | `pan-` | same |
| tab | `tab-` | same |
| split node | `spl-` | same |
| shell session | `shl-` | same |
| window | `win-` | `frameworks/wails/window_id.go` (body), `frameworks/wails/window_rules.go` (prefix) |

The split node is included because its identifier is stored and appears in `state.tree` as part
of `canonicalLayout`.

The host issues the window name, and no other kind. A window outlives the document inside it, so
no document can mint it; the name is the key of `window/<name>` in the snapshot store and the
frontend's capability glob assumes `win-*`, so it is a wire fact on both sides.

Issuing it outside `ids.ts` is not licence to spell it differently. Measured 2026-08-16:
`newWindowID` produced sixteen hex characters, so this product had two identifier formats and the
window was the one kind this table described wrongly. It produces six base32 characters as of that
date. `WINDOW_ID_RE` in `frontend/src/state/ids.ts` reads `^win-[0-9a-f]{16}$` and no source
outside that file reads it (measured 2026-08-16); it matches this format or it goes.

Gates: `frontend/src/state/ids.test.ts` (format, one prefix per kind),
`frontend/src/state/idScope.test.ts` (prefix table, three-letter prefixes),
`frameworks/wails/window_rules_test.go` (window prefix), `frameworks/wails/window_id_test.go`
(window body: six characters, the base32 alphabet with no character outside it, no repeat over
4096 draws).

## N1a. Command names

Shape: `<group>_<subject>_<verb>`, lowercase with underscores. The subject is omitted when the group
is the subject: `daemon_start`, `data_delete`, `clipboard_read`, `app_shutdown_commit`.

The verb comes from the set already in use: `list`, `get`, `set`, `read`, `write`, `delete`,
`remove`, `create`, `close`, `start`, `stop`, `status`, `send`, `spawn`, `scan`, `verify`, `sync`.
A second word for the same action splits the vocabulary — `new` alongside `create` was the case
measured on 2026-08-15.

A mode is not part of a name. `plugin_dev_new` named a development mode in the command, which puts
a caller's context into the wire; the mode belongs to an argument or a permission. The name is
`plugin_scaffold`, and `unit_dev_*` became `unit_source_*` for the same reason.

## N2. Natural keys

Prefixed identifiers apply to layout entities and shell sessions only. These axes keep their own
keys: `schedule`, `secret`, `daemon`, `settings`, `theme`, `registry`, `process`, `sidecar`,
`webview`, `data.kv`, `data.encrypt`, `ui.projection`, `ai.session`. Their keys are a
user-chosen name or an `(ns, key)` pair, which already identifies the entry.

Gate: `idScope.test.ts` reads both tables from `ids.ts`. It fails when an axis appears in both,
and when a prefixed identifier is issued outside the issuer.

## N3. Composite identifiers

A composite identifier is one value built out of identifiers already issued. This product has one:
the native surface label, which names one surface, of one kind, in one window, for one view.

Grammar: `<kind>.<window>.<view>`. Three fields, one delimiter, that order.

### The delimiter is `.`, and no field admits it

An N1 body is `a-z2-7` and an N1 prefix is three letters; a window name body admits `a-zA-Z0-9`,
`-` and `_` (`validWindowName`, `frameworks/wails/window_rules.go`); a kind is lowercase letters,
digits and `-`. So `-` occurs inside all three fields and cannot separate them. `/` is the
separator of the store key `window/<name>` and of the topology path, and a label holding one adds
an address segment.

Of what is left, `.` is the character the public node address keeps. `contentViewNodePath`
(`frontend/src/lib/compositionParticipants.ts`) folds every character outside `[a-z0-9.-]` to `-`,
so `:`, `~`, `@` and `|` all arrive at the address as `-` and put the ambiguity back where the
ledger counts.

An address is not a composite identifier. `window/<name>/view/<id>/content/<label>` is a path, its
separator is `/`, and each segment is percent-encoded at the one site that builds it
(`contentCompositionTopologyPath`). Encoding each segment and choosing a delimiter no field admits
are two answers to the same failure; a value that travels as a single field takes the second.

### The order is kind, window, view

Widest scope first. A view id is unique inside one window, the window name is what makes the value
unique across the application, and the kind partitions the plugins above both. With that order a
comparison of the first two fields selects one window's surfaces of one kind
(`surfaceLabelPrefixIn`), and a sorted list groups them the same way.

### A reader splits, and never scans

Split on the delimiter into exactly three fields, then index. A count other than three is not a
label of this grammar, and the reader answers nothing rather than picking which field is which.

Scanning is the failure this rule exists for: `indexOf("-" + window + "-")` matches the window name
at whatever position it occurs, so a kind ending in a window name yields a view id taken from the
wrong field. AGENTS 3-4 — a structure that has to be searched is a failure.

Measured 2026-08-16, the running application: `browser-win-8ed56cd7d9305935-tab-2trqyu`, from a host
started before the window body was corrected the same day (N1). The three fields are joined with
`-`, each field contains `-`, `viewIdFromSurfaceLabel` locates the view with
`indexOf("-" + windowLabel + "-")`, and `orphanSurfaceLabels` matches a window with
`includes("-" + name + "-")` (`frontend/src/lib/surfaceLabels.ts`, lines 47 and 60). Neither
decomposes the value.

### Where the grammar is defined, and what the first field is

`frontend/src/lib/surfaceLabels.ts`, since 2026-08-16. `frontend/src/lib/webviewLabels.ts` held it
until that date and now holds one thing, the name of the window this document is. Rebuilt anywhere
else, the window field is dropped, two windows produce one value, and the second window addresses
the first window's surface.

The first field is not `brw-`. It is the word of the plugin that declared the surface — `browser`,
from `soksak-plugin-browser-native`, the same word the declaration puts in `data-native-surface`
(measured 2026-08-16). The core writes no kind down: `brw-` was the core's own name for one
plugin's surface, so that plugin could not have been replaced without an edit to the core, and a
second kind of surface had nowhere to obtain a label. N1's three-letter prefix governs the
identifiers the second and third fields are built from, not the kind.

Gates:

- `history_gate_test.go` — `TestTheCoreWritesDownNoSurfaceKind` fails the build on a surface kind
  written down under `core/`, `frameworks/` or `frontend/src`.
- `frontend/src/lib/surfaceLabels.test.ts` — the shape, and that a kind this core does not name
  still reads back to a view.
- `frontend/src/lib/webviewLabels.test.ts` — no retired one- or two-letter prefix (`b-`, `w-`,
  `pv-`, `cv-`) anywhere under `src`, fixtures included.

No gate judges the delimiter. Measured 2026-08-16: nothing in this repository refuses a field
holding the delimiter, and nothing refuses a reader that scans. That gate goes in
`frontend/src/lib/surfaceLabels.test.ts`, and it refuses three things.

1. A field outside its alphabet — a kind holding `.`, or anything but lowercase letters, digits and
   `-`. The assembler throws instead of returning a value nothing can decompose.
2. A value that does not split into exactly three fields. The reader answers null for four fields
   as well as for two.
3. `indexOf`, `includes`, `search` and `match` over a label, read off the source of
   `frontend/src/lib/surfaceLabels.ts`. A rule against scanning that no scan enforces is prose.

## N4. Fixtures

Test fixtures use the format the product issues. A fixture written as `t1` exercises a shape the
product never produces, so the code that reads a prefix is never run.

Gate: `frontend/src/state/idLiterals.test.ts` scans test files for identifier fields (`id`,
`activeId`, `paneId`, `tabId`, `viewId`, and the rest) holding a counter-shaped string.

## N5. Public vocabulary

DOM declarations, addresses and command examples belong to the core. The core does not know which
host it runs on, so these names do not contain a framework name: `data-native-surface`, not
`data-<vendor>-native-surface`. Addresses are minted by their producer; the core does not parse a
vendor segment out of one.

Gate: `frontend/src/framework/seamSweep.ts` and its test hold the list of vendor declarations.
These leak silently — an attribute that the vendor is not there to read is ignored, and nothing
throws.

## N6. Folder names

Framework-independent code is not placed under a framework's name. Frameworks are siblings:
`core/` and `frameworks/wails/`. Packages under `frameworks/wails/` may reference Wails. Packages
above it may not.
