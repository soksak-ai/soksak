# Working in this repository

The development discipline for this project. Read it before reading, writing or changing code, and before every commit, merge and release.

English canonical: [`AGENTS.md`](AGENTS.md). Where the two differ, English wins. Both are changed in one commit.

## 1. Project variables

Discovered in the repository and settled there. Never put to the user.

| Variable | Value |
|---|---|
| `WORKTREE_ROOT` | `../worktrees/soksak-core/<branch>` |
| Observation interface | `bin/sok`(the control-plane client), `bin/soksak`(the app) |
| Test runner | `go test` (Go), `vitest run` (TypeScript) |
| Test location | Core tests in the core, plugin tests in each plugin |
| Commit language | English |
| i18n framework | Its own key table — `frontend/src/i18n.ts` + `i18n.ko.ts` / `i18n.en.ts`. Nothing in Go yet |
| Default / supported locales | `ko` / `ko`, `en` |

Paths are resolved by declaration and discovery. Symlinks are never used. Modules are never joined by a guessed
does not link up.

## 2. The accumulation gate

G0 through G5 is not a sequence of implementation steps but a graph of completion criteria. Dozens of hypotheses arise in between.

**What accumulates**: a settled product rule · a numeric RED that reproduces the defect · a verified observation interface · accumulated
every accumulated gate · current canonical documents.

**What does not accumulate**: an implementation that passes only a narrow test · an implementation that fails on the real screen · one that a later step
an abstraction that does not hold · a temporary fallback·compatibility path·workaround code · a hack added to prop up a failed implementation.

The next fix is never stacked on a failed hypothesis. Remove the failed implementation, return to the last verified point, and then
start a new hypothesis. If it is already committed, stack a removal commit.

A commit is a verified vertical contract, not a development step.

### Revert

1. Is it harmful? Revert immediately.
2. If it does no harm, is the change itself right?
   - If it is not correct, or unnecessary, remove it.
   - If it is correct, keep it. If it is unrelated to the original work, do not commit it as that work's rationale. Write the real reason
     Split into a separate commit.

The test is harmful-or-right, not intended-or-not. The code lands correct; the record states fact.

## 3. Verification and observation

### 3-1. RED → GREEN

1. Write a RED that reproduces the problem. When it cannot be reproduced, write a RED that assumes the problem.
2. Confirm the RED actually fails. A RED that does not fail is not RED.
3. Improve it.
4. Confirm the same test turns GREEN.

A fix without a RED has no evidence that it fixed anything. Never report completion without evidence.

### 3-2. Capture and numeric conversion

- Screen captures and recordings are used during development. Nothing is developed unseen.
- A capture never takes window focus. Focus stealing costs the user their machine.
- **A capture cannot be the basis for a pass verdict.** A person must read it.
- Every observed phenomenon is converted into a mechanical pass/fail.

| Observed symptom | Numeric evidence |
|---|---|
| The animation jumps | Coordinates and timing per frame. Compare before and after the fix |
| The DOM and the webview composition are misaligned | Measure both coordinates and judge by whether they are equal |
| It is slow | Elapsed time per interval. Judge against a threshold |
| It fails sometimes | Identify the failure condition from the log. Judge by the repeat success rate |

When no basis can be built, that fact and its reason are reported.

### 3-3. Command exposure

"There was no command to verify with" is not something to state. Exposing the command is part of the work —
a status that reads state, a command that causes the action, a log point that records the measurement. Observation interfaces added this way
Such interfaces accumulate; they are not made temporarily and deleted.

### 3-4. Idempotence

- Nothing is patched to look like it works now.
- It must be observable and mechanical, and an occurrence must be evident without a search for it.
- The next run behaves the same.

### 3-5. Script and test placement

- No throwaway scripts. In that time it goes in as a feature, idempotent.
- Unit and E2E tests are managed in git.
- Code and tests are separate files. `x.go`/`x_test.go`, `x.ts`/`x.test.ts`. A grown file is split not by size
  split by the rule it holds, not by size.
- Core tests in the core folder, plugin tests in each plugin folder.

### 3-6. Safe order for destructive commands

Finding and changing are not combined from the start. One false match breaks many files.

1. Run search commands only (`grep`, `git grep`, `rg --files-with-matches`).
2. Check every result. Confirm the count and the targets match what was expected.
3. If it is right, combine it with the edit command.
4. With many targets, apply it to one and confirm, then widen.

`xargs sed -i`, `find -exec rm` and bulk replacement come only after step 3. Measured 2026-08-15: an unchecked
`sed -i` and `perl -0pi` broke four files in one session, each one silently.

### 3-7. Standards

Failing to reach a standard and then lowering it is a betrayal. It is never done.

A standard that is itself wrong is raised and corrected without exception. Lowering a standard and correcting a wrong one are
different acts. Failing to tell them apart means it is the former.

## 4. Structure

### 4-1. Core and plugin

The core is strongly coupled to nothing. Everything is open and ruled, so plugins meet only through declared
meet only through declared interfaces.

**What the core exposes**: every DOM node — an exposed node takes clicks, drags, and dispatched events from outside.
every command — a connection goes through a command. Every status.

**Plugins**: plugins are not tightly coupled to each other. The relation is a declared dependency, and the data is a declared
crosses only through declared interfaces.

**Boundary decision**: what is common goes in the core — otherwise a plugin reinvents it. A plugin's feature
is not handed to the core. When it is unclear the test is one question — do several plugins need the same thing? Yes: core,
Otherwise a plugin.

**No coupling**: no relative-path guessing, no symlink. One plugin does not reference another plugin's internals directly.
The core never assumes a specific plugin exists. Enforcement: C1–C3 in [`docs/tech/ARCHITECTURE.md`](docs/tech/ARCHITECTURE.md).

### 4-2. Simplicity

The simplest implementation that fully satisfies the current requirement.

Not built: abstraction for an uncertain future, a configuration switch with one branch, an indirection
layer with one caller, an extension point for later.

**Grow vertically**: start from the smallest version that works end to end. On top of a working product, features
go on one at a time. A working product is never traded for unfinished complexity.

**File splitting**: the criterion is role, not line count. Two concerns in one file, split it.

### 4-3. Backward compatibility

No compatibility layer, fallback or migration is bolted on. The old path is removed.

This is a rule about internal code. It does not mean hiding a breaking change in a published API — make it, but mark it as semver
Mark it honestly as MAJOR (§7-5).

### 4-4. Dependencies

Check them in that order.

1. Does an existing dependency cover it? Check the documentation and the type definitions for real. Do not conclude it is absent.
2. Is there a proven library that cuts complexity or raises reliability? If so, prefer it.
3. Is there a clear reason? Without one, do not reimplement a common feature by hand.

### 4-5. Polling

Polling is the alternative when nothing direct exists. It is not the primary means.

Order: events and subscriptions → callbacks and hooks → an explicit command call → polling.

was taken, one comment sentence states the reason and why the correct way is impossible.

### 4-6. No stopgaps

Architecture is settled for the long term. A stopgap that works now and must be replaced later is not accepted.

When the correct way is impossible and a workaround is used, it is stated exactly. What the correct way is, why it is impossible now, which workaround
was taken, and what would have to change to return. An unstated workaround is never permitted.

## 5. i18n

i18n cannot be added later. Not one hardcoded string, but the whole sentence structure built by concatenation
becomes untranslatable.

### 5-1. Strings

A user-visible string is never written in code. It is referenced by key and resolved from the resource bundle. A sentence
are never assembled in code — word order differs by language. Use placeholders.

```
BAD:  t("delete") + " " + count + " " + t("items")
GOOD: t("file.delete_confirm", { count })
      ko: "파일 {count}개를 삭제합니다"
      en: "Delete {count} files"
```

Keys are an English hierarchy, named for meaning and not for the value.

```
BAD:  t("삭제하시겠습니까")   // the source text as key breaks everything when the text changes
BAD:  t("msg_042")            // the meaning cannot be determined
GOOD: t("file.delete_confirm")
```

The same source text in a different context is a different key. English "Open" is a verb in one place and an adjective in another.

### 5-2. Plurals

Do not branch on `if (n === 1)`. Plural rules differ by language (Korean one form, English two, Russian
three, Arabic six). Use the framework's plural feature (ICU MessageFormat or equivalent).

```
BAD:  count === 1 ? t("one_item") : t("many_items")
GOOD: t("item.count", { count })   // {count, plural, one {...} other {...}}
```

### 5-3. Locale-dependent data

Never formatted directly in code. Use the platform's locale API.

| Subject | Forbidden | Use |
|---|---|---|
| Date and time | `` `${y}-${m}-${d}` `` | `Intl.DateTimeFormat` or an equivalent API |
| Numbers | Manual thousands separators | `Intl.NumberFormat` |
| Currency | Hardcoded symbols | `Intl.NumberFormat` currency style |
| Sorting | Code point comparison | `Intl.Collator` |
| Relative time | Building "3 days ago" | `Intl.RelativeTimeFormat` |

Time is stored in UTC and converted at display. Local time is not stored. A currency value is an amount and a currency
code.

### 5-4. Layout

**Text expands.** A translation is longer than the source (en→de over 30%). Do not put text in a fixed-width container
does not.

**RTL.** Use logical properties instead of physical ones.

```
BAD:  margin-left, padding-right, text-align: left, left: 0
GOOD: margin-inline-start, padding-inline-end, text-align: start, inset-inline-start: 0
```

An icon whose direction has meaning (back, progress) is mirrored in RTL. Text is never baked into an image.

### 5-5. Input and storage

- Encoding is UTF-8 everywhere.
- Length checks separate byte count from character count. A user-visible limit counts graphemes.
- No country-specific format is forced on a name, address, phone number or postal code. Split given and family names, a required postal code,
  required states are all regional assumptions.
- Case conversion names its locale. Turkish `i` breaks without one.

### 5-6. Locale resolution

- An untranslated key falls back to the default locale. The key string is never shown.
- Order of decision: explicit user setting → account setting → browser or OS setting. IP-based guessing is not used.

### 5-7. Validation

i18n is verified with numbers too. Skimming it by eye lets it leak.

- **Hardcoded strings**: a lint for user-visible strings that skip the bundle. Zero is GREEN.
- **Key consistency**: compare the key set of the default locale against each locale. Report the missing and orphan counts as numbers.
- **Placeholder parity**: the placeholder set for one key matches across locales. A mismatch is a runtime error.
- **Layout regression**: render in a pseudo-locale (1.4x the source length) and measure overflow in coordinates.

They are built as exposed commands and run in CI. They are not written as throwaway scripts.

## 6. Language and prose

### 6-1. Code is English

**Natural language in code is English without exception** — comments, commit messages, identifiers, logs, error codes, test
names, API field names, all of it.

The only place Korean remains is the `ko` value of the resource bundle. Nowhere else.

### 6-2. Dry, short, exact

Scope: comments, commit logs, resource bundle values, documents. Every locale.

What to write — what a thing is, what is missing, what to do about it. Facts and the next action, nothing else. The longer
it is, the more of it is wrong. A reason takes one sentence, with the date it was measured.

- One comment line is the norm. Past two, look first at whether the code is wrong.
- A commit subject is one line. A body only when needed, facts only.
- No narrative, no history, no impressions in a commit message.

### 6-3. Banned vocabulary

Code is not explained with personification, metaphor or rhetoric.

**한글** — 산다 · 말한다 · 돈다 · 센다 · 싣는다 · 싣고 · 답한다 · 꽂으면 · 나간다 · 달고 ·
흘린다 · 흘려보낸다 · 가리킨다 · 밝힌다 · 안다 · 소속은 · 고아 · 회수 · 물어야 · 자리에 ·
두지 · 낸다 · 투영 · 침묵 · 1급 · 걸려 있다 · 건다

**English** — lives · sits · says · tells · knows · asks · reaches · carries · belongs ·
watches · learns · decides · reflects

The lists are examples. Personification or poetry is forbidden whether or not it is listed. The test: does this sentence state a
state a fact, or set a mood.

### 6-4. Correction examples

```
// BAD: The registry knows about every plugin that lives in the core.
// GOOD: Registry maps plugin id to instance. Core has no plugin imports.

BAD:  feat: let the scheduler decide when workers should wake
GOOD: feat(scheduler): trigger worker on queue push

BAD:   ko: "설정을 찾지 못했습니다. 어딘가에 있을 수 있으니 확인이 필요합니다."
GOOD:  key: config.missing
       ko: "설정 파일이 없습니다. {path}를 만들어 주세요."
       en: "Config file not found. Create {path}."
```

## 7. Git

### 7-1. Branches

- Work happens on a branch. Never directly on main.
- Commit per feature. Commit messages in English.
- Commit in small steps. Without commits there is no way to trace what intent arrived here.

| State | Handling |
|---|---|
| Merged into main | Rename with `merged/` in front of the branch name |
| Developed but not merged by explicit instruction | Rename with `backup/` in front of the branch name |

`merged/` and `backup/` stay local only.

**Remote hygiene**: a merged branch is not left on the remote. No backup is left either. What was explicitly requested
Nothing else is kept on the remote.

### 7-2. Worktrees

Work happens in a folder under `WORKTREE_ROOT`, with the same lifecycle rules as its branch. Never joined by a symlink
does not.

### 7-4. No loss

Commands that can lose source are not allowed, `git reset --hard` included. Neither code nor
is not lost. `git checkout -- <path>`, `git clean -fd` and `git restore` delete uncommitted work too, so
count the same.

### 7-5. Commit truthfulness and version

- Recording an unrelated thing as related makes that record false.
- A correct fix unrelated to the original work is split into its own commit with its real reason stated.
- If a failed hypothesis is already committed, a removal commit is stacked.

follows semver.

| Distinction | Criterion |
|---|---|
| PATCH | A bug fix that keeps backward compatibility |
| MINOR | A feature addition that keeps backward compatibility |
| MAJOR | A change that breaks backward compatibility |

**Before release**: keeping a mature version number from ever being committed while unreleased is
is the goal. A version is a fact of its moment and is not injected. Correcting a version back to 0.0.1 is not itself
is not — it should have been 0.0.1 to begin with. An unavoidable patch bump is allowed.

### 7-6. Synchronization

Source, comments, documents and README stay in sync. Updating documents and memory is part of the work. Code alone
alone and leaving the documents is not completion.

## 8. Exit gate

Everything passes before completion is reported. One miss means not done.

```sh
go test ./... && go vet ./...
go test ./core/...                                       # headless: the core answers with no window
CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build ./...   # N3
(cd frontend && pnpm test && pnpm typecheck)
```

Gates increase monotonically. Once a gate stands, every later commit passes it. A gate that cannot block is not a
No. Visual evidence goes to `../evidence/<gate>/` outside the repository — so that a generated screenshot does not
become a source file.

- [ ] Was there a RED, and is it GREEN now? Is there a numeric basis?
- [ ] Is any temporary fallback, compatibility path or workaround code left?
- [ ] Is any failed hypothesis accumulated in commits? If so, was a removal commit stacked?
- [ ] Are commits split per feature and messages matched to the real reason?
- [ ] Is all natural language in code English? Is any Korean left outside the resource bundle?
- [ ] Is every user-visible string referenced by key? Do dates, numbers, currency and sorting go through the locale API?
- [ ] Do the key and placeholder parity checks pass across locales?
- [ ] Are source, comments, documents and README in sync?
- [ ] Does the version change match semver?
- [ ] Was the branch handled per its lifecycle rule?
- [ ] If a workaround was used, was it stated?
- [ ] If a rule was broken, was it reported?
