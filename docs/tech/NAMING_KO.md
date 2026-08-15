---
kind: canonical
status: active
canonical: NAMING.md
---

# Naming

English canonical: [`NAMING.md`](NAMING.md). Where the two differ, English wins.

Every rule here has a gate. The gate is written with the rule.

## N1. id format

Format: `<three letters>-<six base32 characters>`. Example: `pan-7k2qx3`.

The prefix is exactly three letters. One or two letters do not separate the kinds in this product. `s-` fits space·split·
session; `v-` fits view and value; `w-` fits window, webview and workspace.

The body is six characters of RFC 4648 lowercase base32 (`a-z`, `2-7`). The digits `0` and `1` are not in that alphabet, so
are never confused with `o` and `l`. Six characters give about 10⁹ values. A collision resolves as `AMBIGUOUS` with candidates.

An id is not a counter. A counter restarts at 1 in each window and each run, so the same value names different
thing in two places.

| Kind | Prefix | Issuer |
| --- | --- | --- |
| project | `pjt-` | `frontend/src/state/ids.ts` |
| space | `spc-` | same |
| pane | `pan-` | same |
| tab | `tab-` | same |
| split node | `spl-` | same |
| shell session | `shl-` | same |
| window | `win-` | `frameworks/wails/window_rules.go` |

Why the split node is in the table: its identifier is stored and comes out through `state.tree` as part of `canonicalLayout`.

Why the host issues the window: a window outlasts the document inside it, and its name is the snapshot store's
is the key of `window/<name>`.

Gates: `frontend/src/state/ids.test.ts` (format, one prefix per kind),
`frontend/src/state/idScope.test.ts` (the prefix table, three-letter prefixes),
`frameworks/wails/window_rules_test.go` (window prefix).

## N1a. Command name

Shape: `<group>_<subject>_<verb>`, lowercase and underscores. The subject is omitted when the group is the subject —
`daemon_start`, `data_delete`, `clipboard_read`, `app_shutdown_commit`.

The verb comes from the set already in use: `list`, `get`, `set`, `read`, `write`, `delete`, `remove`,
`create`, `close`, `start`, `stop`, `status`, `send`, `spawn`, `scan`, `verify`, `sync`. For the same action
A second word for the same action splits the vocabulary — measured 2026-08-15, `new` stood alongside `create`.

A mode is not part of a name. `plugin_dev_new` put a development mode into the command name and so put the caller's context
onto the wire. A mode is what an argument or a permission takes. The name is `plugin_scaffold`, and for the same reason
`unit_dev_*` became `unit_source_*`.

## N2. Natural key

A prefixed identifier applies to layout entities and shell sessions only. These axes keep their own keys: `schedule`·
`secret`·`daemon`·`settings`·`theme`·`registry`·`process`·`sidecar`·`webview`·`data.kv`·
`data.encrypt`, `ui.projection`, `ai.session`. Their keys are either a name the user gave or `(ns, key)`
pair, which already identifies the entry.

Gate: `idScope.test.ts` reads both tables from `ids.ts`. It fails when an axis appears in both, or when a prefixed identifier is issued outside
It fails when a prefixed identifier is issued.

## N3. Label

A native child surface is part of one window. Its label includes that window's name — a browser child webview is
`brw-<window>-<view>`. The prefix follows N1.

The grammar is defined in `frontend/src/lib/webviewLabels.ts` only. Rebuilt elsewhere, the window name is
is omitted and two windows produce the same label. The second window's browser then fails to appear, or a reclaim takes another window's
surface.

Gates: `frontend/src/lib/webviewLabels.test.ts` — no inline `` `brw-${…}` `` outside the owner,
and no retired one- or two-letter prefix (`b-`, `w-`, `pv-`, `cv-`) anywhere under `src`, including fixtures.

## N4. Fixture

Test fixtures use the format the product issues. A fixture written as `t1` is a shape the product never produces, so
the code that reads a prefix is never run.

Gate: `frontend/src/state/idLiterals.test.ts` scans test files for identifier fields (`id`, `activeId`,
`paneId`, `tabId`, `viewId` and the rest) holding a counter-shaped string.

## N5. Public vocabulary

DOM declarations, addresses and command examples are the core's. The core cannot tell which host it runs on, so these
These names contain no framework name. Not `data-<vendor>-native-surface` but
`data-native-surface`. Addresses are minted by their producer, and the core does not parse a vendor segment out of one.

Gate: `frontend/src/framework/seamSweep.ts` and its test hold the list of vendor declarations. This leak is
is silent — an attribute with no vendor there to read it is ignored, and nothing throws.

## N6. Folder name

Framework-independent code is not placed under a framework's name. Frameworks are siblings — `core/` and
`frameworks/wails/`. Packages under `frameworks/wails/` may reference Wails. Packages above it
must not.
