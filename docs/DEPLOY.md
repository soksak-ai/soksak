# Deployment & Hotswap (v1)

soksak ships in units and updates a running app with the fewest restarts. This
document is the canonical model for what a build produces, how it flows from a
commit to a live session, how a home receives it, how versions move, and how an
update lands without tearing the session down. Sidecar staging/distribution
mechanics live in SIDECARS.md §6; the restore ladder that makes a relaunch
seamless lives in RESTORE.md. This doc owns the orchestration across all of it.

## 1. What ships

Four artifact classes, each with its own delivery:

| Unit | Artifact | Delivery | CI gate |
|------|----------|----------|---------|
| Plugin | `<id>-<ver>-any.tgz` (bundled `main.js` + `plugin.json`) + `release.json` + conformance | signed registry index → verify owner manifest + artifact sha256 → extract archive to `<home>/plugins/<id>`. No git clone. | test + esbuild drift (`git diff --exit-code main.js`) → owner-immutable release |
| Sidecar | release asset `…-<ver>-<os>-<arch>.tar.gz` + sha256 | `gh release`, pinned by the consuming plugin's `reach.fetch` | tag `v*` → build → stage → tar (`-L`) → release |
| Contract | `<id>-<ver>.tgz` + `release.json` + `conformance.json` | registry release receipt; consumed as a build-time pin, never installed to a home | `node --test` / `cargo test` → owner-immutable release |
| App body | signed, notarized `.app` + `latest.json` + minisign `.sig` | `tauri-plugin-updater` (release channel) | build → codesign → notarytool → release |

A plugin ships a verified `.tgz` its consumer extracts from the signed installation
index — the app authenticates the Ed25519-signed index, verifies the owner manifest
and artifact sha256, then extracts the archive; there is no git clone/branch/latest
fallback. A sidecar is a native binary fetched by a sha256-pinned URL its consumer's
manifest declares. A contract publishes a release receipt but distributes nothing that
gets installed — both sides conform to it as a build-time pin. The app body is the only
thing an updater downloads and installs.

## 2. The pipeline — commit to running app

A change reaches a running session the same way for every unit, differing only
in the artifact:

1. **Author** commits to the unit's repo. A plugin tracks its built `main.js`; a
   sidecar and the app body build in CI.
2. **CI** runs the unit's gate. A plugin: test + an esbuild drift check that
   fails if `main.js` is stale against source. A sidecar: on a `v*` tag, build →
   `stage.sh` → tar (`-L`) + sha256 → `gh release`. A contract: its acceptance
   suite. The app body: on a `v*` tag, build → codesign → notarytool → release
   with `latest.json` + a minisign `.sig` (§8).
3. **Home** receives the artifact by its class (§4): a plugin by `git pull`, a
   sidecar by the sha256-pinned `reach.fetch` URL its consumer declares, the app
   body by `tauri-plugin-updater` reading `latest.json` — release channel only.
4. **Runtime** applies it with the fewest restarts (§6): `update.apply` rolls the
   hot axes in order and the restore ladder covers the one relaunch the app body
   needs.

Steps 1–2 are per-repo CI (the unit and app workflows). A unit that publishes a
GitHub Release (spec, SDK, plugin, contract) cuts it from a manual main workflow
through an owner-immutable App-token publisher, not a tag push — see §9. Steps 3–4
are the core's job — the install primitives (`download_unpack_verify`,
`install_git_into`, `tauri-plugin-updater`) and the `update.*` orchestrator. A build artifact the app
consumes (a plugin's bundled `main.js`, a sidecar binary, the `@soksak-ai/
plugin-spec` dist) must be rebuilt in step 2 whenever its source moves — unit
tests read source and stay green while a running app reads the stale artifact, so
a source-only change is not deployed until its artifact is rebuilt and fetched.

## 3. VER — versioning

Unit and app releases move by semver:

- **PATCH** — backward-compatible bug fix.
- **MINOR** — backward-compatible feature. In the `0.x` range a breaking change
  is still MINOR (the pre-1.0 convention pins the MAJOR slot at 0).
- **MAJOR** — a breaking change, once `1.0` is out.

A contract's major (`@N`) is a **separate axis**: it bumps only when the
contract's *content* breaks, never for an implementation's version. Renaming a
contract id without changing its content is not a content break — it is a MINOR
for every unit that now carries the new wire/discovery key, and the contract
stays `@1`.

## 4. HOME — per-home distribution

The identity home decides where each unit comes from (`home.rs`, ARCHITECTURE
A17):

- **dev** (`~/.soksak-dev`) — app body built locally; plugins mix local
  development and downloads (the development home of record).
- **debug** (`~/.soksak-debug`) — app body built locally (`make build-debug`,
  the core author's own check); every plugin and sidecar is a GitHub artifact.
  Local checkouts are irrelevant here — a distributed unit is integrated against
  a locally-built core.
- **release** (`~/.soksak`) — app body, plugins, and sidecars are all GitHub
  artifacts (the real-user home).

Consequence: the **app-body remote updater runs on the release channel only**. A
debug app updates its body by a local rebuild (seamless via the restore ladder);
**unit** hot-reload (fetch + reload / respawn) is common to debug and release,
because both take units from GitHub.

## 5. HS — the hotswap laws

**HS1 — restart-minimize.** If a new build can take effect without a process
restart, it does. Axes in ascending disruption:

- **Plugin** (JS, one webview): `plugin.update` + `plugin.reload` — zero app
  restart.
- **Terminal engine** (separate service process): respawn + rehydrate from the
  daemon tee + checkpoint — zero app or shell restart.
- **PTY daemon** (`soksak-ptyd`): fd-handoff drain — the shell survives with no
  SIGHUP (§7).
- **App body + in-process engine dylib**: relaunch — but the restore ladder
  brings terminals and windows back, so the restart reads as seamless.

**HS2 — the fd-ownership invariant.** A PTY master fd is owned by `soksak-ptyd`
and survives app, engine, and daemon generations. A handoff transfers fd
*ownership* (a dup), it never migrates a process; the shell is attached to the
slave side and never learns the server changed. No failure path closes the final
master fd — a committed upgrade exits without signaling any pane process group.

**HS3 — never-unload stands.** An in-process engine dylib is never unloaded
(SIDECARS.md §4) — a dlclose hotswap would dangle live symbols. A new build of
such an engine takes effect on app relaunch; an engine that needs no-downtime
lives as a separate process (the terminal engine already does) and respawns
instead.

## 6. Update orchestrator — `update.check` / `update.apply`

`update.check` surveys without applying: the app body (release channel only — a
debug/dev build reports `available:false`), plus a count of the hot axes
`update.apply` can roll (installed plugins, the running daemon).

`update.apply` applies across every hot axis, least-disruptive first, and
announces each on the activity bus (never silent):

1. **Plugins** — `git pull` + reload. Zero restart. Dev-sourced plugins are
   skipped (not update targets).
2. **Sidecars** — `sidecar_ensure` fetches each named asset (sha256-pinned,
   atomic install), then the engine respawns and rehydrates.
3. **PTY daemon** — fd-handoff drain (§7).
4. **App body** — release channel only: `tauri-plugin-updater` downloads and
   installs the signed bundle, then relaunches. The body is last; the restore
   ladder brings the session back.

The app-body step is gated to the release channel; on a debug/dev home it is
skipped with a loud notice, and the other axes still apply. The body relaunches
only when a newer release actually exists.

## 7. PTY daemon live drain — fd-handoff

`pty.daemon.upgrade` rolls a new `soksak-ptyd` generation without restarting
shells. The running daemon stages the new binary, then hands each live shell's
PTY master fd to a new daemon by fd inheritance — the kernel's fd refcount keeps
the master open across the old daemon's exit, so the slave side (the shell) sees
no SIGHUP. It snapshots the session set atomically (a tmp file + rename), spawns
the new daemon, and waits. The new daemon adopts the inherited fds, resumes the
tee from each session's ring sequence, and acks; the old daemon then exits
without signaling any pane (HS2). A failure before the ack rolls back — the old
daemon resumes and keeps ownership, and no fd is closed. The app reattaches warm
via `from_seq`; a micro-gap is absorbed by the consumer replaying the ring and
announced as `pty.warm.gap`.

Distinct from `pty.daemon.restart`, which kills every shell.

## 8. Signing (values deferred)

The app CI wires codesign (Developer ID) + notarytool + a minisign signature for
`latest.json` by **secret name**. The signing certificate, the Apple
ID/team/app-password, and the minisign keypair are registered as secret *values*
separately — the code, the workflow, and the secret references are fully wired,
so filling the values activates signed distribution with no further code change.

## 9. Publication boundary — how a unit release is cut

A unit that publishes a GitHub Release (the platform spec, the SDK, a plugin, a
contract) cuts it from a manual `workflow_dispatch` on `main`, never a tag push.
The version, tag, archive name, and manifest are derived from the owner manifest
(`package.json` + the unit's `build-release`), so a later product version flows
through by changing metadata alone — no version is pinned in the workflow or the
build script. Contract schema ids (`soksak-spec-*@N`) and validator tool versions
sit on their own axis and are never substituted. The workflow:

1. checks out the exact source (`fetch-depth: 0`, `persist-credentials: false`);
2. runs the unit's full gate from that clean checkout;
3. binds publication to `main` at the exact checkout (`release-context.mjs`);
4. mints a least-privilege GitHub App token (Administration read, Contents write)
   — the built-in `GITHUB_TOKEN` is never used;
5. drives a resumable fail-closed publisher (`publish-release.mjs`): it requires
   owner-enforced immutable releases, creates the tag only after validating the
   assets, uploads only the missing assets keyed on the release manifest, and
   never deletes-and-replaces. Re-running an already-published release is
   idempotent; a partial draft resumes its missing assets.

The publisher validates every asset's sha256 against the release manifest and
fails closed if the artifact directory diverges from the declared asset set. The
declared set differs by unit kind — a plugin ships its tgz, `release.json`, and
`conformance-*.json` reports; a contract ships its tgz, `release.json`, and a
single `conformance.json` — but the boundary (owner manifest → validated assets →
App-token immutable publish) is the same.
