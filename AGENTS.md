# Working in this repository

Korean edition: [`AGENTS_KO.md`](AGENTS_KO.md). English is canonical; both change in one commit.

## Loading order

1. This file
2. [`docs/README.md`](docs/README.md) — the document manifest
3. The canonical document for the area you are touching (`docs/tech/`) or the procedure
   (`docs/manual/`)

A canonical document beats this file where they disagree.

## Commits

- Order: `test:` → `fix:`/`feat:` → `docs:`. A reproducing red test comes before the fix.
- A commit is a verified vertical contract, not a development step.
- An implementation that does not clear every accumulated gate does not land. If one already
  landed, stack a removal commit rather than patching over it.
- Unrelated but correct fixes go in their own commit under their real reason.

## Rules the code must satisfy

- **Tests sit beside their owner, in their own file.** Core tests in the core folder, plugin
  tests in the plugin folder. `x.go`/`x_test.go`, `x.ts`/`x.test.ts`. No inline tests.
  Split a grown file by what rule it carries, not by size.
- **Three surfaces of transparency.** Every feature exposes command, status, and DOM.
  Exposed DOM is clickable, draggable, and dispatchable from outside. Missing any of the
  three means unfinished. Enforcement: C1–C3 in [`docs/tech/ARCHITECTURE.md`](docs/tech/ARCHITECTURE.md).
- **No polling.** Use event boundaries — observers, receipts, `settled()`. Using polling
  requires a written reason at the call site.
- **No symlinks.** A named path wins; with no name, fail carrying every location searched.
  Never slide down a discovery chain.
- **No backward compatibility.** No compatibility layers, fallbacks, or migrations. Delete
  the old path.
- **No throwaway scripts.** Verification is a `sok` command or a versioned test.
- **Windows stays cgo-free.** See N3 in [`docs/tech/NATIVE-LAYER.md`](docs/tech/NATIVE-LAYER.md).

## Verdicts

Captures and the Wails MCP server are observation tools, not verdicts. Pass/fail always comes
from a numeric command or a test. Captures never steal window focus.

## Gates

```sh
go test ./... && go vet ./...
go test ./core/...                                       # headless boundary: core answers with no window
CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build ./...   # N3
(cd frontend && pnpm test && pnpm typecheck)
```

Gates increase monotonically. Once a gate stands, every later commit passes all gates so far.
A gate that cannot block is not a gate.

Visual evidence goes to `../evidence/<gate>/`, outside this repository, so generated
screenshots never become source files.
