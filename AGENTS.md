# Working in this repository

The development discipline for this project. Read it before reading, writing or changing code,
and before every commit, merge and release.

Korean edition: [`AGENTS_KO.md`](AGENTS_KO.md). English is canonical; both change in one commit.

## 1. Project variables

Discovered in the repository, not asked for.

| Variable | Value |
|---|---|
| `WORKTREE_ROOT` | `../worktrees/soksak-core/<branch>` |
| Observation interface | `bin/sok` (control plane client), `bin/soksak` (application) |
| Test runner | `go test` (Go), `vitest run` (TypeScript) |
| Test location | Core tests in the core, plugin tests in each plugin |
| Commit language | English |
| i18n framework | Own key table: `frontend/src/i18n.ts` with `i18n.ko.ts` / `i18n.en.ts`. Go has none yet |
| Default / supported locales | `ko` / `ko`, `en` |

Paths are resolved by declaration and discovery. Symlinks are never used. Modules are never
joined by a guessed relative path.

## 2. The accumulation gate

G0 to G5 are not implementation steps but a graph of completion criteria. Dozens of hypotheses
happen along the way.

**Accumulated**: settled product rules · numeric red tests that reproduce a defect · verified
observation interfaces · implementations that clear every accumulated gate · current canonical
documents.

**Not accumulated**: implementations that pass only their own narrow test · implementations that
fail on the real screen · abstractions no later stage supports · temporary fallbacks,
compatibility paths and workarounds · additional hacks propping up a failed implementation.

A next change is never stacked on a failed hypothesis. Remove the failed implementation, return
to the last verified point, then start a new hypothesis. If it is already committed, stack a
removal commit.

A commit is a verified vertical contract, not a development step.

### Reverting

1. Is it harmful? Revert immediately.
2. If not harmful, is the change itself right?
   - Wrong or unnecessary: remove it.
   - Right: keep it. If it is unrelated to the original work, it does not get committed under
     that work's reason. State the real reason in its own commit.

The test is harmful-or-right, not intended-or-not. The code lands correct; the record states
fact.

## 3. Verification and observation

### 3-1. Red to green

1. Write a red test that reproduces the problem. If it cannot be reproduced, write a red test
   that assumes it.
2. Confirm the red actually fails. A red that passes is not a red.
3. Fix.
4. Confirm the same test goes green.

A fix with no red has no evidence. Completion is not reported without evidence.

### 3-2. Captures and numbers

- Screen captures and recordings are used during development. Nothing is developed unseen.
- A capture never takes window focus. Focus stealing costs the user their machine.
- **A capture is never a pass verdict.** It needs a person to read it.
- Every observed phenomenon is converted into a mechanical pass/fail check.

| Observed | Numeric basis |
|---|---|
| The animation jumps | Per-frame coordinates and timing. Compare before and after |
| DOM and webview composition disagree | Measure both positions; equal or not |
| It is slow | Time each stage. Judge against a threshold |
| It fails sometimes | Log the failing condition. Judge by success rate over repeats |

When no basis can be built, that fact and its reason are reported.

### 3-3. Exposing commands

"There was no command to verify with" is not something to say. Exposing the command is part of
the work: a status that reads state, a command that causes the action, a log point that records
the measurement. Such interfaces accumulate; they are not made and deleted.

### 3-4. Idempotence

- Nothing is patched to look like it works.
- Events are observable and mechanical, and an occurrence is known without looking for it. A
  structure that has to be searched is a failure.
- The next run behaves the same.

### 3-5. Scripts and test placement

- No throwaway scripts. Whatever a script would do goes in as a feature, idempotent, in the same
  time it took to write the script.
- Unit and end-to-end tests are version controlled.
- Code and tests are separate files. `x.go`/`x_test.go`, `x.ts`/`x.test.ts`. A grown file is
  split by the rule it carries, not by size.
- Core tests in the core folder, plugin tests in each plugin folder.

### 3-6. The safe order for destructive commands

Finding and changing are not combined from the start. One false match breaks many files.

1. Run the search alone (`grep`, `git grep`, `rg --files-with-matches`).
2. Read the whole result. Check the count and the targets against what was expected.
3. Only then combine with the change.
4. With many targets, apply to one, check, then widen.

`xargs sed -i`, `find -exec rm` and bulk replacement come after step 3. Measured 2026-08-15: an
unchecked `sed -i` and `perl -0pi` broke four files in one session, each one silently.

### 3-7. Standards

Failing to reach a standard and then lowering it is a betrayal. It is never done.

A standard that is itself wrong is raised and corrected. Lowering a standard and correcting a
wrong one are different acts; failing to tell them apart means it is the former.

## 4. Structure

### 4-1. Core and plugins

The core is strongly coupled to nothing. Everything is open and ruled, and plugins meet each
other through declared interfaces.

**The core exposes**: every DOM node — an exposed node is clickable, draggable and dispatchable
from outside; every command — connections go through commands; every status.

**Plugins**: no strong coupling between plugins. Relations are declared dependencies, and data
crosses only through declared interfaces.

**Where a thing belongs**: what is common goes in the core, so plugins do not reinvent it. A
plugin's own feature is not handed to the core. When it is unclear the test is one question — do
several plugins need the same thing? Yes: core. No: plugin.

**Forbidden couplings**: no guessed relative paths, no symlinks; no plugin reads another
plugin's internals; the core never assumes a specific plugin exists. Enforcement: C1–C3 in
[`docs/tech/ARCHITECTURE.md`](docs/tech/ARCHITECTURE.md).

### 4-2. Simplicity

The simplest implementation that fully satisfies the current requirement.

Not built: abstraction for an uncertain future, a configuration switch with one branch, an
indirection layer with one caller, an extension point for later.

**Grow vertically**: start from the smallest version that works end to end. Add one feature at a
time on top of a working product. A working product is never traded for unfinished complexity.

**Splitting files**: the test is responsibility, not line count. Two concerns in one file means
two files.

### 4-3. Backward compatibility

No compatibility layers, fallbacks or migrations. The old path is deleted.

This is about internal code. A breaking change in a published API is not hidden — it is made and
marked honestly as a semver MAJOR (§7-5).

### 4-4. Dependencies

In order:

1. Can an existing dependency do it? Read its documentation and type definitions. Do not
   conclude it cannot.
2. Is there a proven library that reduces complexity or raises reliability? Prefer it.
3. Is there a clear reason? Without one, a common feature is not reimplemented.

### 4-5. Polling

Polling is the alternative when nothing direct exists. It is not the primary means.

Order: events and subscriptions → callbacks and hooks → an explicit command call → polling.

When polling is used, one comment sentence states why and why the direct route is impossible.

### 4-6. No stopgaps

Architecture is decided for the long term. A stopgap that works now and must be replaced later is
not accepted.

When the correct way is impossible and a workaround is used, it is stated exactly: what the
correct way is, why it is impossible now, what workaround was taken, and what would have to
change to return. An unstated workaround is never permitted.

## 5. i18n

i18n cannot be added later. The problem is not one hardcoded string but the sentence structure
built by concatenation, which becomes untranslatable.

### 5-1. Strings

A user-visible string is never written in code. It is referenced by key and resolved from the
resource bundle. Sentences are never assembled in code — word order differs by language. Use
placeholders.

```
BAD:  t("delete") + " " + count + " " + t("items")
GOOD: t("file.delete_confirm", { count })
      ko: "파일 {count}개를 삭제합니다"
      en: "Delete {count} files"
```

Keys are an English hierarchy named for meaning, not for the value.

```
BAD:  t("삭제하시겠습니까")   // the source text as key breaks everything when the text changes
BAD:  t("msg_042")            // carries no meaning
GOOD: t("file.delete_confirm")
```

The same source text in a different context is a different key. English "Open" is a verb in one
place and an adjective in another.

### 5-2. Plurals

No `if (n === 1)`. Plural rules differ by language — Korean has one form, English two, Russian
three, Arabic six. Use the framework's plural feature (ICU MessageFormat or equivalent).

```
BAD:  count === 1 ? t("one_item") : t("many_items")
GOOD: t("item.count", { count })   // {count, plural, one {...} other {...}}
```

### 5-3. Locale-dependent data

Never formatted by hand. Use the platform's locale API.

| Subject | Forbidden | Use |
|---|---|---|
| Date and time | `` `${y}-${m}-${d}` `` | `Intl.DateTimeFormat` or equivalent |
| Numbers | Manual thousands separators | `Intl.NumberFormat` |
| Currency | Hardcoded symbols | `Intl.NumberFormat` currency style |
| Sorting | Code point comparison | `Intl.Collator` |
| Relative time | Building "3 days ago" | `Intl.RelativeTimeFormat` |

Time is stored in UTC and converted at display. Local time is not stored. A currency value is
stored with its currency code, never as a bare number.

### 5-4. Layout

**Text expands.** A translation is longer than the source (English to German, 30% and more).
Text does not go in a fixed-width container.

**RTL.** Logical properties, not physical ones.

```
BAD:  margin-left, padding-right, text-align: left, left: 0
GOOD: margin-inline-start, padding-inline-end, text-align: start, inset-inline-start: 0
```

An icon whose direction carries meaning (back, progress) mirrors in RTL. Text is never baked
into an image.

### 5-5. Input and storage

- UTF-8 everywhere.
- Length checks separate byte count from character count. A user-visible limit counts graphemes.
- No country-specific format is forced on a name, address, phone number or postal code. Split
  given and family names, required postal codes and required states are all regional assumptions.
- Case conversion names its locale. Turkish `i` breaks without one.

### 5-6. Choosing a locale

- An untranslated key falls back to the default locale. The key string is never shown.
- Locale order: explicit user setting → account setting → browser or OS setting. IP-based
  guessing is not used.

### 5-7. Verification

i18n is verified by numbers. Reading through it lets leaks past.

- **Hardcoded strings**: a lint rule for user-visible strings that skip the bundle. Zero is green.
- **Key parity**: compare the default locale's key set with each locale's. Report missing and
  orphaned counts.
- **Placeholder parity**: the placeholder set for one key must match across locales. A mismatch
  is a runtime error.
- **Layout regression**: render with a pseudo-locale (source text at 1.4× length) and measure
  overflow by coordinates.

These are exposed commands run in CI, not throwaway scripts.

## 6. Language and prose

### 6-1. Code is English

**Natural language inside code is English, without exception**: comments, commit messages,
identifiers, logs, error codes, test names, API field names.

The only place Korean remains is the `ko` values of the resource bundle. Nowhere else.

### 6-2. Dry, short, exact

Applies to comments, commit logs, resource bundle values and documents, in every locale.

Write what a thing is, what is missing, and what to do about it. Facts and the next action, and
nothing else. The longer it is, the more of it is wrong. A reason takes one sentence, with the
date it was measured.

- One comment line is the norm. Past two, look first at whether the code is wrong.
- A commit subject is one line. A body only when needed, facts only.
- No narrative, no history, no impressions in a commit message.

### 6-3. Forbidden vocabulary

Code is not explained with personification, metaphor or rhetoric.

**Korean** — 산다 · 말한다 · 돈다 · 센다 · 싣는다 · 싣고 · 흘린다 · 흘려보낸 · 꽂으면 ·
달고 · 가리킨다 · 밝힌다 · 고아 · 물어야 · 1급

**English** — lives · sits · says · tells · knows · asks · reaches · carries · belongs ·
watches · learns · decides · reflects

The lists are examples. Personification or poetry is forbidden whether or not it is listed. The
test: does this sentence state a fact, or set a mood?

### 6-4. Corrected examples

```
// BAD: The registry knows about every plugin that lives in the core.
// GOOD: Registry maps plugin id to instance. Core has no plugin imports.

// BAD: This value flows down to the renderer and finally reaches the view.
// GOOD: Renderer reads this value. No transform between store and view.
```

```
BAD:  feat: let the scheduler decide when workers should wake
GOOD: feat(scheduler): trigger worker on queue push

BAD:  fix: the orphan node no longer asks the parent for its position
GOOD: fix(layout): compute detached node position from viewport origin
```

```
BAD:   ko: "설정을 찾지 못했습니다. 어딘가에 있을 수 있으니 확인이 필요합니다."
GOOD:  key: config.missing
       ko: "설정 파일이 없습니다. {path}를 만들어 주세요."
       en: "Config file not found. Create {path}."
```

## 7. Git

### 7-1. Branches

- Work happens on a branch. Never directly on main.
- Commit per feature, in English.
- Commit in small steps. Without commits there is no record of how this point was reached.

| State | Handling |
|---|---|
| Merged to main | Rename with a `merged/` prefix |
| Developed but explicitly not merged | Rename with a `backup/` prefix |

`merged/` and `backup/` stay local.

**Remote hygiene**: no merged branches on the remote, no backups on the remote. Nothing but
explicitly requested branches.

### 7-2. Worktrees

Work happens in a folder under `WORKTREE_ROOT`, with the same lifecycle rules as its branch.
Never joined by a symlink.

### 7-4. No loss

Commands that can lose source are not allowed, `git reset --hard` included. Neither code nor
commits are lost. `git checkout -- <path>`, `git clean -fd` and `git restore` delete uncommitted
work and count the same.

### 7-5. Truthful commits and versions

- Recording an unrelated thing as related makes the record false.
- A correct fix unrelated to the current work is a separate commit with its real reason.
- A failed hypothesis already committed is removed by a commit stacked on top.

semver:

| Level | Basis |
|---|---|
| PATCH | A backward-compatible bug fix |
| MINOR | A backward-compatible feature |
| MAJOR | A change that breaks compatibility |

**Before release**: the goal is that no mature version number was ever committed while unreleased.
A version is a fact of its moment and is not injected. Correcting a version back to 0.0.1 is not
itself something to record — it should have been 0.0.1 to begin with. An unavoidable patch bump
is allowed.

### 7-6. Synchronisation

Source, comments, documents and README stay in sync. Updating documents and memory is part of
the work. Code alone is not done.

## 8. Exit gate

Everything here passes before completion is reported. One miss means not done.

```sh
go test ./... && go vet ./...
go test ./core/...                                       # headless: core answers with no window
CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build ./...   # N3
(cd frontend && pnpm test && pnpm typecheck)
```

Gates increase monotonically. Once a gate stands, every later commit passes every gate so far. A
gate that cannot block is not a gate. Visual evidence goes to `../evidence/<gate>/`, outside this
repository, so generated screenshots never become source files.

- [ ] Was there a red, and is it green now? Is there a numeric basis?
- [ ] No temporary fallback, compatibility path or workaround left?
- [ ] No failed hypothesis accumulated in commits? If there is, was a removal commit stacked?
- [ ] Commits split per feature, messages matching the real reason?
- [ ] All natural language in code English? No Korean outside the resource bundle?
- [ ] Every user-visible string referenced by key? Dates, numbers, currency and sorting through
      the locale API?
- [ ] Key and placeholder parity checks passing across locales?
- [ ] Source, comments, documents and README in sync?
- [ ] Version change matching semver?
- [ ] Branch handled per its lifecycle rule?
- [ ] Any workaround stated?
- [ ] Any rule broken, and was it reported?

## 9. Project-specific rules

These beat the rules above where they conflict. Conflicts are reported.

- **Commit order**: `test:` → `fix:`/`feat:` → `docs:`.
- **Three surfaces of transparency**: every feature exposes command, status and DOM. Missing any
  of the three means unfinished.
- **Captures and the Wails MCP server are observation tools, not verdicts.** Pass/fail comes from
  a numeric command or a test.
- **Windows stays cgo-free.** See N3 in [`docs/tech/NATIVE-LAYER.md`](docs/tech/NATIVE-LAYER.md).
- **One backend per home.** The socket is claimed before anything is opened or drawn.
