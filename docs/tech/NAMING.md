---
kind: canonical
status: active
canonical: self
---

# Naming

Korean edition: [`NAMING_KO.md`](NAMING_KO.md). English is canonical.

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
| project | `pjt-` | `frontend/src/state/ids.ts` |
| space | `spc-` | same |
| pane | `pan-` | same |
| tab | `tab-` | same |
| split node | `spl-` | same |
| shell session | `shl-` | same |
| window | `win-` | `frameworks/wails/window_rules.go` |

The split node is included because its identifier is stored and appears in `state.tree` as part
of `canonicalLayout`.

The window is issued by the host because a window outlives the document inside it, and its name
is the key of `window/<name>` in the snapshot store.

Gates: `frontend/src/state/ids.test.ts` (format, one prefix per kind),
`frontend/src/state/idScope.test.ts` (prefix table, three-letter prefixes),
`frameworks/wails/window_rules_test.go` (window prefix).

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

## N3. Labels

A native child surface belongs to one window. Its label carries the window name:
`brw-<window>-<view>` for a browser child webview. The prefix follows N1.

The grammar is defined in `frontend/src/lib/webviewLabels.ts` only. Rebuilt elsewhere, the window
name is omitted and two windows produce the same label. The second window's browser then fails to
appear, or a reclaim closes another window's surface.

Gates: `frontend/src/lib/webviewLabels.test.ts` — no inline `` `brw-${…}` `` outside the owner,
and no retired one- or two-letter prefix (`b-`, `w-`, `pv-`, `cv-`) anywhere under `src`,
including fixtures.

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
