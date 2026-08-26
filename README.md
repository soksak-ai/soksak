# soksak-core

This repository is the plugin-driven Wails desktop core, version `0.0.3`. `go.mod` owns the Go
module and Wails CLI; `.node-version` and `frontend/package.json` own the frontend toolchain.

## Current contract

- The workspace is one recursive `leaf | split` tree. A leaf is either a real
  PTY terminal or a browser surface. There is no configured nesting limit.
- Every leaf exposes right/below split actions for both terminal and browser,
  plus close. Closing promotes the sibling subtree into the removed parent's
  place; the final leaf cannot be closed.
- Dividers are pointer-captured and draggable. Only a pointer stream that
  begins on the divider is contained, so normal terminal/browser text remains
  selectable and copyable.
- `soksak-kit-plugin-terminal` owns terminal view registration, PTY and recovery lifecycle, resize,
  status, waits, and the standard command surface. `soksak-plugin-terminal-xterm` supplies only its
  Xterm renderer adapter, screen buffer, theme, input and IME behavior, and optional commands.
- `wails-service-native-compositor` is registered through Wails v3's official
  `application.Service` lifecycle, observes public DOM declarations, and serializes one
  complete generation/sequence inventory with an applied receipt.
- `soksak-plugin-browser-wails3` implements that public backend interface and owns the
  WKWebView lifecycle, navigation, status, AppKit frame, visibility, alpha, and
  layer order in one main-thread batch.
- The core registers these plugins and declares DOM/layout only. It contains no
  PTY, xterm, AppKit, or WKWebView implementation.
- The implementation has no iframe compatibility path. Other Wails platforms
  require their own native child-surface backend before they can claim support.

## Reproducible commands

```sh
make prepare REGISTRY=http://host:port/
make preflight
make verify REGISTRY=http://host:port/
make build TARGET=aarch64-apple-darwin REGISTRY=http://host:port/
go tool wails3 dev
```

The frontend depends on `@soksak-ai/plugin-spec`, so every `make` invocation that installs requires
`REGISTRY` on the make command line, `https://registry.npmjs.org/` included once the package is
published there. A value from the environment is refused. The Makefile reads the requirement from
`frontend/package.json` and refuses `REGISTRY required: this package depends on @soksak-ai/...` when
it is absent. No `.npmrc` takes part.

The build input is identified by the `frontend/pnpm-lock.yaml` integrity, not by `REGISTRY`. pnpm
fetches from `REGISTRY` only a package whose integrity its content-addressable store does not already
hold, so a second install of the same lockfile on the same machine reads the store and never contacts
`REGISTRY`. `go tool wails3 dev` installs without registry flags and therefore runs after
`make prepare REGISTRY=http://host:port/` has filled the store.

The version owners, upgrade transaction and precondition classes are defined in
[`docs/tech/BUILD-TOOLCHAIN.md`](docs/tech/BUILD-TOOLCHAIN.md).

## Verification

RED tests live beside their owners:

- `frontend/src/layout.test.ts`: recursive layout, 64 successive splits, and
  sibling promotion on close.
- `frontend/src/splitDrag.test.ts`: divider geometry and contained pointer
  ownership without a global text-selection ban.
- `../wails-service-native-compositor`: snapshot, observer, stale rejection, receipt.
- `soksak-plugin-browser-wails3`: browser surface declarations and commands/status.
- `soksak-plugin-terminal-xterm`: Xterm rendering, IME, ordered output queue, and terminal capabilities.

Visual evidence is stored outside the application repository in `../evidence`,
so generated screenshots do not become source files.
