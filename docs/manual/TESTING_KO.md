---
kind: guide
status: active
canonical: TESTING.md
---

# Testing

English canonical: [`TESTING.md`](TESTING.md). Where the two differ, English wins.

What has to pass, and what a test is for here.

## T1. One command

`task verify` runs every gate. A commit that has not cleared it does not land.

| Gate | Command |
| --- | --- |
| `verify:go` | `go build ./...`, `go vet ./...`, `go test ./...` |
| `verify:headless` | `go test ./core/...` — the core answers with no window |
| `verify:windows` | `CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build ./...` |
| `verify:frontend` | `pnpm typecheck`, `pnpm test` |
| `verify:modules` | `go vet` and `go test` in each sibling module |

Run it where the work happens, not in CI. The sibling module resolves through `replace` and has no remote yet, so
A workflow file would look like a gate and never run once. When a remote appears, CI calls the same task
task.

## T2. Gates increase monotonically

A gate that is added stays added, and every later commit clears all of them. A gate that cannot block is not a
but a backlog entry.

## T3. A failing gate is not lowered

When a test is RED, the implementation, the fixture or the document is fixed. The standard stays as it is.

The exception is a standard that is itself wrong, and then it is raised as a problem and corrected with the reason written down. Working around it quietly
is the one move this document forbids.

## T4. RED first, GREEN next

A defect gets a test that reproduces it before the fix. The commit order is `test:` then `fix:`,
so the record shows the defect existed and that this change is what closed it.

A gate is also planted and removed once, to show it bites. A gate nobody has seen fail is a gate whose shape
is a gate whose shape nobody has seen.

## T5. A test is a separate file next to its subject

Go uses `x.go` and `x_test.go`, TypeScript `x.ts` and `x.test.ts`. There are no inline tests.

A file that grows is split by what it is a rule about, not by size or alphabet.

## T6. A capture is evidence, not a judge

A visual defect is observed with a capture and judged by a number. See EVIDENCE.md.

If no command produces that number, writing the command is the work — not a detour from it.
