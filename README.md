# soksak-core

This repository is the plugin-driven Wails desktop core, version `0.0.1`. The Go module, CLI, and
frontend runtime use the official Wails `v3.0.0-beta.12` release.

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
- `soksak-plugin-browser-native` implements that public backend interface and owns the
  WKWebView lifecycle, navigation, status, AppKit frame, visibility, alpha, and
  layer order in one main-thread batch.
- The core registers these plugins and declares DOM/layout only. It contains no
  PTY, xterm, AppKit, or WKWebView implementation.
- The implementation has no iframe compatibility path. Other Wails platforms
  require their own native child-surface backend before they can claim support.

## Reproducible commands

Install the exact upstream CLI before running the build tasks.

```sh
go install github.com/wailsapp/wails/v3/cmd/wails3@v3.0.0-beta.12
go test ./...
(cd frontend && pnpm test)
wails3 dev
```

This repository owns its desktop build tasks. Package installation and scripts use checked-in
lockfiles.

## Verification

RED tests live beside their owners:

- `frontend/src/layout.test.ts`: recursive layout, 64 successive splits, and
  sibling promotion on close.
- `frontend/src/splitDrag.test.ts`: divider geometry and contained pointer
  ownership without a global text-selection ban.
- `../wails-service-native-compositor`: snapshot, observer, stale rejection, receipt.
- `../soksak-plugin-browser-native`: WKWebView inventory and browser commands/status.
- `../soksak-plugin-terminal-xterm`: raw PTY bytes, terminal capabilities, lifecycle.

Visual evidence is stored outside the application repository in `../evidence`,
so generated screenshots do not become source files.
