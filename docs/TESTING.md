# Testing

Two standard targets across every repo — core, plugins, sidecars. A repo exposes them as
`make test-unit` / `make test-e2e` (Makefile) or the same-named `npm` scripts.

## The two targets

- **`test-unit`** — deterministic, no LLM, no running app. Pure logic and type checks that
  a machine can settle offline. Core: `spec-gate` (plugin-spec/plugin-api build + headless
  manifest gate), `typecheck` (tsc), `check` (cargo check), `test` (cargo test), `test-front`
  (vitest). A plugin: its vitest/cargo suite. This is the pre-commit gate; it must be green
  before every commit.
- **`test-e2e`** — drives a running app over its socket. Idempotent and self-cleaning:
  each harness creates its own windows/projects, asserts, and tears them down, never touching
  the user's workspace. Takes an identity (`IDENTITY=debug` by default). Core suite:
  orchestrator, project-rail, nl-console, browser-restore, multiwindow, resize.

## Harness methodology

- **Idempotent scenario files, not throwaway scripts.** A harness reruns cleanly: it cleans
  its leftovers on entry, works only inside its own fixtures, and removes what it made. Never
  write a one-shot script for something a reusable harness should own.
- **Fixture roots live under `~/.soksak-e2e`**, reused idempotently — separate from the app
  homes (`~/.soksak`, `~/.soksak-dev`, `~/.soksak-debug`). State is reclaimed through the
  window lifecycle (teardown closes the window), not by minting a fresh temp dir each run.
- **Introspect, don't skip.** When a check "can't be tested," add the introspection command
  that exposes the fact (a status query, a measurement) rather than skipping. "No mechanism"
  is not an excuse — extend the surface.
- **Separate deterministic assertions from LLM-dependent steps.** Deterministic checks assert
  exact outcomes; steps that call an LLM (agent turns) retry with tolerance, never gate on a
  specific model output.
- **Measure the real signal.** Read the actual runtime fact (`term.read` for terminal output,
  `stty size` for the live winsize, pixel brightness for render) — not a static or inferred
  value.

## Harness rules (learned the hard way)

- **Never let a harness restart the app in a loop.** Recovery from a wedged state runs at
  most once, then fails loudly with the diagnostic — a restart→respawn→rescan loop is not a
  recovery.
- **A socket read that hits EOF raises**, it does not spin: `recv` returning empty forever is
  a hang, so treat EOF as an error.
- **Unwrap the response envelope once, in the rpc helper.** Machine payload nests under
  `data` (MESSAGE-PROTOCOL); flatten it in the helper so assertions read flat fields.
- **Target a workspace window explicitly.** `main` is the control plane with no workspace, so
  a harness that measures a project must open its own `w-*` window and route every command to
  it — an unaddressed command lands on the control plane and measures nothing.

## Plugin & sidecar repos

A plugin repo's `test-unit` is its own suite (vitest or cargo). A repo with a build step
(TypeScript `src/`) builds before it publishes; a plugin also wires `soksak-plugin-doctor`
into `prepublishOnly` so the integrity gate (theme/permission/naming/envelope) runs before
release. A test script that runs `vitest` with zero test files is a false green — either add
a real test or drop the script.

---

한국어 안내는 [TESTING.ko.md](TESTING.ko.md).
