# soksak

An AI-native terminal workbench. Terminals, dual-engine browsers, editors, and file
views live as split panels inside project windows; a control-plane window orchestrates
them; and every capability — core and plugin alike — is a registry command exposed to
AI agents over the `sok` CLI, MCP, and skills.

## What it is

- **Workspace windows** — one window per project set. Terminals (OS PTY + xterm.js,
  WebGL renderer, shell integration, session restore), browsers on two engines side by
  side (the OS native webview and a bundled Chromium engine sidecar — tabs, bookmarks,
  DevTools), a CodeMirror editor, and a file tree, all as split panels.
- **Control plane** — the `main` window is the orchestrator: a project map, a live
  activity feed of every command exchange (request → progress → response), and a
  command console. Projects are opened and created here; each workspace window is an
  opaque `w-<uuid>` ([docs/NAMING.md](docs/NAMING.md), [docs/RESTORE.md](docs/RESTORE.md)).
- **Plugin platform** — plugins are independent git repos installed from a registry
  catalog: views, commands, editors, file viewers, formatters, icon sets, overlays
  ([docs/PLUGINS.md](docs/PLUGINS.md), [docs/PLUGIN-CONTRACT.md](docs/PLUGIN-CONTRACT.md)).
- **AI control surface** — every command is discoverable and callable over the `sok`
  CLI, an MCP server, and agent skills. Requests, progress deltas, and responses follow
  one envelope — `{ok, code, message, data}`
  ([docs/AI-CONTROL.md](docs/AI-CONTROL.md), [docs/MESSAGE-PROTOCOL.md](docs/MESSAGE-PROTOCOL.md),
  [docs/COMMANDS.md](docs/COMMANDS.md)).
- **Sidecars** — heavyweight engines (the Chromium browser engine, the workflow
  service) ship as separate artifacts the core loads or spawns without linking
  ([docs/SIDECARS.md](docs/SIDECARS.md)).
- **Identity homes** — release, dev, and debug each own a separate home
  (`~/.soksak`, `~/.soksak-dev`, `~/.soksak-debug`): data, plugins, sidecars, socket.

Architecture rules live in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Stack

- Frontend: React + Vite + TypeScript, `@xterm/xterm` (+WebGL/Unicode11/WebLinks/Clipboard), CodeMirror
- Backend: Rust + Tauri v2, `portable-pty` (PTY + ACK flow control), rusqlite (`app.data`)

## Requirements

- macOS (current build target: aarch64) — the OS webview and PTY are provided natively
- Rust toolchain (`cargo`, `~/.cargo/bin` in PATH)
- Node.js + `pnpm`

## Quick Start

```bash
make install   # install dependencies (idempotent)
make dev       # development server (HMR) — soksak-dev
```

## Commands

All build and run operations go through **Makefile targets** (idempotent,
version-controlled). `make help` lists everything; the essentials:

```bash
make dev          # development server (HMR) — soksak-dev
make build        # release bundle → soksak.app + sok CLI
make build-debug  # debug bundle → soksak-debug.app + sok-debug
make run          # launch release soksak.app
make run-debug    # launch debug soksak-debug.app
make verify       # tsc + cargo check (pre-commit gate)
make test         # Rust unit tests
make test-front   # frontend unit tests (vitest)
make docs         # regenerate docs/COMMANDS.md from the live catalog
```

The `sok` CLI talks to the running app over its socket — `sok help`, `sok commands`,
or any registry command (`sok window.list`, `sok term.exec '{"cmd":"ls"}'`).

## 3-Identity Distinction (dev / debug / release)

The three builds use separate names, icons, identifiers, and homes so they never share
state and stay visually distinct in the Dock.

| | soksak-dev | soksak-debug | soksak |
|---|---|---|---|
| Purpose | HMR development server | debug bundle (testing) | release bundle (daily use) |
| Command | `make dev` | `make build-debug` | `make build` |
| Home | `~/.soksak-dev` | `~/.soksak-debug` | `~/.soksak` |
| Dock name | `soksak-dev` | `soksak-debug` | `soksak` |
| Icon | green (`icons-dev/`) | orange (`icons-debug/`) | default (`icons/`) |
| Identifier | `com.soksak.dev` | `com.soksak.debug` | `com.soksak.app` |

`open -n` launches a new instance, so all three can run at the same time.

## Artifacts

- Release app: `src-tauri/target/release/bundle/macos/soksak.app`
- Debug app: `src-tauri/target/debug/bundle/macos/soksak-debug.app`
- Installer image: `src-tauri/target/release/bundle/dmg/soksak_<version>_aarch64.dmg`

---

한국어 안내는 [README.ko.md](README.ko.md).
