# Wails v3 Beta terminal/browser workspace

This repository is a desktop spike pinned to the official Wails
`releases/v3-beta` candidate at commit
`3ae6893b9c119c4ddbf3cfc890a2f6fd6f9b4967`. The framework is resolved by the
local `replace` directive in `go.mod`; it does not use the globally installed
Wails alpha CLI.

## Current contract

- The workspace is one recursive `leaf | split` tree. A leaf is either a real
  PTY terminal or a browser surface. There is no configured nesting limit.
- Every leaf exposes right/below split actions for both terminal and browser,
  plus close. Closing promotes the sibling subtree into the removed parent's
  place; the final leaf cannot be closed.
- Dividers are pointer-captured and draggable. Only a pointer stream that
  begins on the divider is contained, so normal terminal/browser text remains
  selectable and copyable.
- PTY sessions are owned by `(id, generation)`. Replacement is atomic and a
  stale close/read completion cannot remove the new process.
- xterm is measured only after its connected host receives layout. Disposal
  cancels queued measurement.
- Browser leaves own native `WKWebView` child surfaces on macOS. DOM reports the
  host rectangle; the native service applies that rectangle on the AppKit main
  thread and returns the requested/applied frame with
  `(id, generation, sequence)`. React layout commits and external window
  resizes share that publisher; stale asynchronous frame writers are rejected.
- The implementation has no iframe compatibility path. Other Wails platforms
  require their own native child-surface backend before they can claim support.

## Reproducible commands

The beta CLI is built outside this repository at `../bin/wails3` from the
pinned framework checkout.

```sh
cd ../app
go test ./...
cd frontend && PATH=/opt/homebrew/bin:/usr/bin:/bin pnpm test
cd .. && PATH=../bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin wails3 dev
```

The generated beta template omitted its desktop `build/` tree and referenced
mobile task files that were not generated. This repository vendors the build
assets from the same pinned Wails commit and keeps only the desktop task
includes. Package installation and scripts use the checked-in pnpm lockfile.

## Verification

RED tests live beside their owners:

- `frontend/src/layout.test.ts`: recursive layout, 64 successive splits, and
  sibling promotion on close.
- `frontend/src/splitDrag.test.ts`: divider geometry and contained pointer
  ownership without a global text-selection ban.
- `frontend/src/nativeBrowserFrame.test.ts`: ordered layout frame publication.
- `frontend/src/terminalMount.test.ts`: post-layout xterm sizing and disposal.
- `terminalservice_test.go`: generation-safe PTY ownership.
- `nativebrowser/service_test.go`: native browser frame and generation ownership.

Visual evidence is stored outside the application repository in
`../evidence` so generated screenshots do not become
source files.
