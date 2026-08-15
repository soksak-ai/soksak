---
kind: guide
status: active
canonical: self
---

# Testing


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

It runs where the work is, not in CI: the sibling modules resolve through `replace` and have no
remotes yet, so a workflow file would look like a gate and never run. When they gain remotes, CI
calls this same task.

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
nobody knows the shape of.

## T5. Tests are files beside what they check

Go: `x.go` and `x_test.go`. TypeScript: `x.ts` and `x.test.ts`. No inline tests.

A file that grows is split by what it is a rule about, never by size or alphabet.

## T6. A capture is evidence, not a verdict

A visual defect is observed with a capture and judged by a number. See EVIDENCE.md.

If no command produces that number, writing the command is the work — not a detour from it.
