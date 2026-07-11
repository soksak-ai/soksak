# Message Protocol

The single contract for every command soksak runs — core, plugin, and sidecar-backed. A command is a **request → (progress) → response** exchange, and all three parts have a fixed shape so any consumer (UI, orchestrator, `sok` CLI, MCP, phone) reads them without guessing. This is the standard; command handlers conform to it rather than each returning its own shape.

AI and remote clients are first-class consumers here, so every command must yield a standard, observable answer — request, progress, and response each have one fixed shape, and nothing else is accepted.

## 1. Request envelope

```
{ command: string, params: Record<name, value> }
```

`params` is validated against the command's `ParamSpec` schema (`{type, description, required?, enum?, default?}`) by a central `validate` — unknown keys are rejected, required keys enforced, defaults filled. This half is already standard across all ~158 core and ~328 plugin commands.

## 2. Progress delta (optional, streaming only)

Long-running commands surface *what they are doing* as they do it — the textdelta / thinking concept — instead of only the final answer.

```
{ kind: "command.progress", command, seq, ts, delta }
```

`delta` carries the salient content only (a URL, a node title) with no frame word — the feed renders it as `<command>: <delta>`, so the command name gives the context and the delta needs no translation (P0). It is published to the activity hub. Sources: ① sidecar events (the engine `event` channel; the service NDJSON `ev` stream) — **the consuming plugin translates them into standard progress and publishes** (the core stays a blind relay, honoring A14); ② terminal output; ③ AI thinking/stream. Single-shot commands emit none.

Deltas fold into their turn on two layers: with `payload.parentId` they attach by **exact correlation** (§4); without it, the consumer (the feed) folds by the window + command name + execution time-window heuristic — backward compatibility for the id-less world (plugin `events.progress`).

## 3. Response envelope (symmetric)

```
{ ok: boolean, code: string, message: string, window: string, data?: object, hint?: [{ cmd, why }] }
```

Success and failure share **one shape** — only `data` and `hint` are optional.

| field | meaning |
|---|---|
| `ok` | success / failure |
| `code` | result code — success `"OK"` (or domain `CREATED`/`NOOP`/`UNCHANGED`…), failure a closed `ErrCode` enum. The `error` string dialect is retired |
| `message` | the human-readable one-line **standard answer** (success *and* failure) — the bubble renders this. The command provides it; the core does not guess |
| `window` | the window label the command ran in — window-scoped answers (plugin lists, panes) explain themselves |
| `data` | machine payload (optional, **nested** — no flat spread, so it never collides with the reserved envelope keys) |
| `hint` | up to three follow-up suggestions `{ cmd, why }` — possibilities, not orders. Success hints come from the command's own `CommandSpec.hint(data, ctx)`; failure hints come from the command (receiving `{ code, message }`) or, as fallback, a standard per-error-code guide. An unknown command is matched against the registry catalog, so calling a not-installed plugin's command answers with its exact install command |

`message` is **owned by the command** — the required `CommandSpec.message(data) => string`. There is no guessing layer (shape derivation) and no `code`-echo fallback: every command knows its own answer. The sentence is resolved from the keyed i18n table (`msg.<name>`) via `tmsg` in the conversation language — adding a language is one table column (P0). `execute` normalizes each handler return into the envelope: reserved keys split off, the rest nests under `data`, and `message` is `spec.message(data)`.

Success and failure are symmetric because observation is first-class — a successful command still owes the observer a `code` and a `message`.

### Display and narration — two axes, producer-owned: message / speak

Every activity entry is **self-describing**: it carries its own display line (`message`) and optional narration (`speak`), composed by the producer in the producer's own i18n. Consumers (the sidebar feed, the orchestrator feed) do not enumerate kinds — they render `payload.message`, and a narrator speaks `payload.speak`. This holds uniformly across commands, core events, and plugin-contributed activity — adding a producer or a kind touches neither the core bridge nor the feed.

- **Each producer owns its sentences.** A command owns message (the answer) + speak (opt-in narration), resolved via `tmsg` at the instrumentation point (`effectiveSpeak`) and carried as `payload.speak`; the command line adds generic framing (`name ✓ (Nms) → message`) from generic trace metadata — no per-command knowledge in the consumer. Terminal activity is published by the **terminal plugin** (its own i18n, via `app.activity.publish`); core-domain events (turn detection, view management) by the core; plugins by `app.activity.publish`.
- **Narration is opt-in**: an entry is spoken only when it carries `speak` — there is no `message` fallback. `message` always shows; narrating every read and diagnostic would be noise, so the producer decides what is worth hearing. Empty `speak` (`""`) or absent = silent.
- **The ear never carries paths or identifiers** (window labels, hashes, URLs) — those are for `message`. E.g. `window.snapshot`: message carries the saved path, speak says "saved the screen".
- Producers that themselves narrate (`say`-style commands) declare `speak: () => ""` — the cut point preventing narration → record → narration.
- **`app.activity.publish(kind, { message, speak?, ...data })`** is the producer-facing surface: a plugin lays down its own self-describing entry (source stamped to its id) without any core kind-enumeration.
- The former `CommandSpec.tts` boolean and the `tts` wire field are retired — the ear axis is `speak` end to end (the spec field and the activity payload share the name, symmetric with `message`).

### Display media (optional)

A response that carries renderable content declares it — consumers never sniff data keys:

```
media?: { kind: string /* MIME, e.g. "image/png" */, base64?: string, path?: string }
```

`window.snapshot` sets `media` in both modes (file mode carries `path`, base64/rect mode carries `base64`); the feed renders it inline (a saved screenshot shows as an image, not as a path string; `path` is loaded lazily via `read_file_base64`); clicking the inline image enlarges it (lightbox, click/ESC to close).

## 4. Correlation (parentId) — the conversation set

Every execution born from a conversation turn binds to that turn: **prompt → commands → answer form one activity set.**

```
chat.prompt { text, turnId }                          ← opens the set (user's natural language)
command.progress { delta, parentId: turnId }          ← progress (agent stream, batched)
command.executed { …, parentId: turnId }              ← the commands the turn spawned
chat.answer { text, parentId: turnId, ok, code }      ← closes the set (agent's final answer)
```

- **Carrier**: when the orchestrator (`orchestrator.ask`) spawns the agent it injects env `SOKSAK_PARENT=turnId`. `sok` puts it on the request envelope as meta `parent` (same model as `SOKSAK_PANE`/`SOKSAK_WINDOW`), and it rides socket → executor `ctx.parent` → registry trace `parentId` → activity entry `payload.parentId`. MCP (`soksak.run`) passes the same point, so it is covered automatically.
- **Anchor**: the set's display unit is the parent (`chat.prompt`) — card visibility follows the parent, so the set shows whole even when children ran in other windows (w-*). Orphaned children whose parent fell off the ring/buffer display standalone (nothing is lost).
- **Order is factual**: an execution already in flight when the turn is stopped lands after the answer and is shown as-is — the set is a seq-ordered record, not a staged narrative.
- **Narration**: `chat.prompt` (the user's own words), `chat.answer` (AI utterance), and progress deltas never carry `speak` — silent. `command.executed` children narrate per their own speak spec (§3).
- **Trace opt-out** `CommandSpec.trace: false` — duplicate-record prevention only (§5 R2): declared solely by `orchestrator.ask` (chat.prompt/answer are that turn's canonical record).

## 5. What qualifies as activity — recording and exposure are separate axes

- **R1 Falsehoods die at the emitter** — a mark for something that never happened is contamination, not a record: D (finished) is emitted only paired with C (executed) (shell-integration.zsh — the first prompt / empty Enter emits no D), and boot restore is not project.created (diff reseed).
- **R2 Facts are always recorded** — everything that actually ran is recorded: component self-reads (project.recent, backfill activity.recent), narration runs (say), scheduled firings. The only legitimate use of `trace:false` is **duplicate-record prevention for the same fact** (`orchestrator.ask` — chat.prompt/answer are that turn's canonical record). trace:false for noise suppression is forbidden — that's the exposure axis's job.
- **R3 Exposure selects** — origin (the actor) decides display and narration, never recording: omitted = human (normal display, narrated per speak spec) / `"schedule"` = scheduled intent (dimmed + "schedule" label, silent) / `"internal"` = automation & self-reads (dimmed, silent). System origins get speak erased at the registry instrumentation point — the narration→record→narration loop is cut on this axis (recording itself is linear, not feedback). Environment facts (view.activated, turn.ended) are quiet one-liners, silent.
- **R2a A record is an observation summary** — `command.executed` never carries the response `data` (command, code, message, paramKeys, media reference, and the correlation axes are the whole record). Measured incident: a read's record swallowed its own query result (including earlier records) and self-amplified to 75MB rows → a 226MB malloc during json parsing → instant process death. Persistence additionally strips `media.base64` and enforces a per-row invariant (256KB; overflow degrades to a summary keeping the correlation axes) — only the live layer (ring, events) carries originals.
- **R4 No retention zero-sum** — low-signal entries (with an origin) never compete with the signal for retention: separate persistence scopes `app` (signal) / `app-low` (low signal), each capped at 5000. The ring (live view, 2000) stays mixed — liveness is a time window; history is persistence's job. seq resumes from the max across both scopes.

origin carrier: Rust-internal firing (the scheduler) passes `request_command(origin:"schedule")`; plugin automation self-declares via `app.commands.execute(name, params, {origin:"internal"})`; a handler's nested executions inherit through `inv.execute` — riding ctx → trace → entry payload.origin. New automation classes extend by adding an origin value.

## Command labels

Display surfaces (the orchestrator feed and any future consumer) never show a raw command key. The label ownership is structured to scale to any number of languages:

- **Plugin commands** — the manifest `contributes.commands[].title` (LocalizedText), owned and translated by the plugin author. The loader carries it into the registered spec, and `execute` instrumentation carries it on the activity stream (`title`), so a window that never loaded the plugin (the orchestrator) still resolves the label. The stream is self-sufficient.
- **Core commands** — `cmd.<name>` keys in the per-language message tables. Adding a language means adding one table; command definitions are untouched. Full coverage is enforced by the `commandTitles.test.ts` gate — a core command without a label fails the build.
- If neither exists, the command's English `description` shows — a raw key is never rendered.

## Sidecar boundary (A14)

A sidecar's own wire (engine C-ABI / service stdio / iroh socket) is opaque to the core by contract — the core relays bytes it does not interpret. **The standard governs the command surface** (core + plugin + sidecar-exposed commands), not the sidecar wire. The plugin adapter that fronts a sidecar (`main.js`, `adapter.ts`) ① translates sidecar events into standard `command.progress`, ② maps the final result into the response envelope. Unifying the three sidecar wires into one is out of scope (A14); progress exposure delivers "what the sidecar did."

**Plugin service (PS7 re-legislation, docs/PLUGIN-SERVICE.md):** for the third form — a `bind:"service"` command owned by a resident plugin service — the adapter role is absorbed by the wire contract itself (`soksak-service-spec@1`): progress `ev` frames map to standard `command.progress` in the core, and the `res` envelope carries `message` and `hints` as first-class fields. Ownership is unchanged — the human sentence is still owned by the command implementation; it arrives over the wire instead of a JS closure. The registry accepts an envelope-provided `message`/`hints` **only** for a spec marked `envelope: "service"` (set solely by the core-synthesized proxy); every other command keeps the runtime-function seam. A missing wire message degrades to the label exactly like the loader rule below — never a refusal.

## Enforcement

- **Core `execute`** normalizes handler returns into the envelope, injects `message` from `summarize` (or the `code` echo), and reserves `ok`/`code`/`message`.
- **A build gate** (`commandMessages.test.ts`) fails the core build when a command lacks its `msg.<name>` key, and the `en`/`ko` key sets must match (P0 language parity).
- **The plugin loader** warns at registration when a plugin command provides no `message` and its answer degrades to the command label — a load-time rejection would brick a plugin on any message regression, so the gate lives at the publish boundary instead: `sok plugin.conformance <id>` reports `commands.messagesMissing`, and `plugin-doctor` R5 rejects the retired `ok:false,error:` dialect.

## Migration

M1 established the standard: envelope type, the `message` contract, `command.progress` kind, orchestrator bubble (request→delta→message), docs. M2 gave every core command its own `message` (the guessing layer and the `summarize` name are gone) resolved from the keyed i18n table. M4 wires sidecar adapters through the plugin API `events.progress(command, delta)` publisher: the workflow plugin translates exec-stage child events (`{ev:add}` lines) into live deltas, and the chromium plugin announces open/navigate loads. M3 (per-plugin `error`→`code`/`message` + `summarize` sweeps) proceeds plugin-by-plugin under the loader warning.

Reserved-key rule (was: no top-level `id`/`ok`/`code`/`message` in handler data) is now structural — handlers return free data, `execute` nests it under `data`, and the envelope owns the reserved keys.
