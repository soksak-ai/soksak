# soksak

A standalone Tauri desktop terminal following a complete xterm.js setup. Includes a left-panel file tree sidebar
(`@pierre/trees`), terminal/file-view tabs in the content area, and a CodeMirror file viewer.
Extended with a JS plugin system (soksak-plugin-spec v1) for views, formatters, editor extensions, and commands
— [docs/PLUGINS.md](docs/PLUGINS.md).

- Frontend: React + Vite + TypeScript, `@xterm/xterm` (+WebGL/Unicode11/WebLinks/Clipboard)
- Backend: Rust + Tauri v2, `portable-pty` (PTY + ACK flow control)

## Requirements

- macOS (current build target: aarch64)
- Rust toolchain (`cargo`, `~/.cargo/bin` in PATH)
- Node.js + `pnpm`

## Quick Start

```bash
make install   # install dependencies (idempotent)
make dev       # development server (HMR)
```

## Commands

All build and run operations go through **Makefile targets** rather than ad-hoc commands (idempotent, version-controlled).

```bash
make help         # list available targets
make install      # install dependencies
make icons        # regenerate dev/debug icons (tinted base icon)
make dev          # development server (HMR) — soksak-dev
make build        # release bundle → soksak.app
make build-debug  # debug bundle → soksak-debug.app
make run          # launch release soksak.app (new instance)
make run-debug    # launch debug soksak-debug.app (new instance)
make verify       # tsc + cargo check (pre-commit gate)
make clean        # remove build artifacts
make stop         # stop running development server
```

## 3-Identity Distinction (dev / debug / release)

The three builds use separate names, icons, and identifiers so they are visually distinct in the macOS Dock.
The base config (`tauri.conf.json`) represents the dev identity; build-time `--config` overrides resolve the others.

| | soksak-dev | soksak-debug | soksak |
|---|---|---|---|
| Purpose | HMR development server | debug bundle (testing) | release bundle (daily use) |
| Command | `make dev` | `make build-debug` | `make build` |
| Dock name | `soksak-dev` | `soksak-debug` | `soksak` |
| Icon | green (`icons-dev/`) | orange (`icons-debug/`) | default (`icons/`) |
| Identifier | `com.soksak.dev` | `com.soksak.debug` | `com.soksak.app` |
| Badge | DEV badge | — | — |

- HMR (`make dev`) is **not a bundle** — the binary name (`soksak-dev`) appears directly in the Dock.
  Additionally, the title bar shows a green **DEV badge** (`import.meta.env.DEV`).
- Debug and release are bundles, so productName, icon, and identifier make them separate Dock entries.

### Running Simultaneously

```bash
make build && make run      # release soksak — for regular work
make build-debug && make run-debug   # debug soksak-debug — for testing new features
```

`open -n` launches a **new instance**, so all three versions can run at the same time.

## Artifacts

- Release app: `src-tauri/target/release/bundle/macos/soksak.app`
- Debug app: `src-tauri/target/debug/bundle/macos/soksak-debug.app`
- Installer image: `src-tauri/target/release/bundle/dmg/soksak_<version>_aarch64.dmg`

## Plugins

The right sidebar (⌥⌘B) is the plugin area. Plugins are single JS files that add views (right/left sidebar,
content tabs), code formatters (⇧⌥F), editor extensions (CM6), and commands (automatically exposed via sok/MCP).
Installed from GitHub repositories.

```bash
sok plugin.install '{"source":"user/repo"}'   # install, then grant permissions and activate in the ⚙ panel
make example-repos                            # create 6 example plugins as independent git repos
```

Authoring, API, and security model: [docs/PLUGINS.md](docs/PLUGINS.md). Examples: [examples/plugins/](examples/plugins/).

## Structure

```
src/
  components/   PaneTree, ViewTabs, LeftSidebarHost, PluginSidebar, FileViewer
  terminal/     createTerminal, paneHosts, shellIntegration, theme
  state/        sessions (project→view state), plugins (plugin runtime/consent)
  plugins/      spec (manifest·principles), loader, api, hooks, view/editorRegistry
  commands/     registry (single source of truth) + catalog (+Plugins/Git)
src-tauri/src/
  pty.rs        PTY session + ACK flow control
  fs.rs         directory listing / file read (text·base64) / theme
  plugins.rs    plugin install (git) · dedicated storage
  git.rs        read-only git queries (log/show/diff)
  lib.rs        command registration + PTY cleanup on exit
```
