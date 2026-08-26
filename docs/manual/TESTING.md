---
kind: guide
status: active
canonical: self
---

# Testing


What has to pass, and what a test is for here.

## T1. One command

`go tool wails3 task verify` runs every gate. A commit that has not cleared it does not land.

| Gate | Command |
| --- | --- |
| `verify:go` | `go build ./...`, `go vet ./...`, `go test ./...` |
| `verify:application` | builds current `soksak` and `sok`, then runs capture-only restore, capture-focus and native-close gates |
| `verify:headless` | `go test ./core/...` — the core answers with no window |
| `verify:windows` | `CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build ./...` |
| `verify:frontend` | `pnpm typecheck`, `pnpm test` |
| installed fleet | owned by `min-median-max/soksak-terminal-tests`; installs immutable releases through Core |

Owner tests run in their repositories. Core does not execute sibling source or infer checkout
locations. Cross-repository product verification consumes released artifacts through the installer
and `environment.json`.

## T2. Gates increase monotonically

A gate that is added stays added, and every later commit clears all of them. A gate that cannot
block is not a gate — it is a backlog entry.

## T3. A failing gate is not lowered

When a test is red, the implementation, the fixture or the document changes. The standard does not.

The exception is a standard that is itself wrong, and then it is raised as a problem and corrected
with the reason written down. Working around it quietly is the one move this document forbids.

## T4. Red before green

A defect gets a test that reproduces it before the fix. The commit order is `test:` then `fix:`,
so the record shows the defect existed and that this change is what closed it.

A gate is also planted and removed once, to show it bites. A gate nobody has seen fail is a gate
nobody records the shape of.

## T5. Tests are files beside what they check

Go: `x.go` and `x_test.go`. TypeScript: `x.ts` and `x.test.ts`. No inline tests.

A file that grows is split by what it is a rule about, never by size or alphabet.

## T6. A capture is evidence, not a verdict

A visual defect is observed with a capture and judged by a number. See EVIDENCE.md.

If no command produces that number, writing the command is the work — not a detour from it.

## T7. Capture-only and native input are different gates

Local visual and parity gates use compositor-resident, alpha-zero, non-key windows and must preserve
the user's foreground process. Their `ui.input.*` commands prove the exposed browser-event route;
they do not claim operating-system input.

WebKit requires an active key window for native keyboard delivery. The terminal system repository's
`make system-native-input TARGET=<darwin-target>` therefore runs only on an unattended native runner
with an isolated interactive application. It uses `window.input.pointer.click` and
`window.input.key.press`, verifies terminal-to-PTY delivery, and records the native route. Both
matrices are required; neither may be renamed to stand in for the other.

Every application gate waits for `soksak.host.ready` rather than polling and records its process,
window, socket, home, runtime and open/recorded sidecar ownership. GREEN cleanup means graceful
application exit and zero remaining test-owned sidecars.
