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

`delta` is a human-readable line or a structured fragment, published to the activity hub. Sources: ① sidecar events (the engine `event` channel; the service NDJSON `ev` stream) — **the consuming plugin translates them into standard progress and publishes** (the core stays a blind relay, honoring A14); ② terminal output; ③ AI thinking/stream. Single-shot commands emit none.

## 3. Response envelope (symmetric)

```
{ ok: boolean, code: string, message: string, data?: object }
```

Success and failure share **one shape** — only `data` is optional.

| field | meaning |
|---|---|
| `ok` | success / failure |
| `code` | result code — success `"OK"` (or domain `CREATED`/`NOOP`/`UNCHANGED`…), failure a closed `ErrCode` enum. The `error` string dialect is retired |
| `message` | the human-readable one-line **standard answer** (success *and* failure) — the bubble renders this. The command provides it; the core does not guess |
| `data` | machine payload (optional, **nested** — no flat spread, so it never collides with the reserved envelope keys) |
| `tts` | narration override (optional) — a string speaks that sentence instead of `message`; `false` mutes this one response. See "Narration (tts)" below |

`message` comes from `CommandSpec.summarize?(data) => string`. When a command has no `summarize`, `execute` echoes the `code` into `message` (`"OK"`) — an echo, not a derived/parsed transformation. `execute` normalizes every handler return (free object or `{ok:false,…}`) into this envelope: reserved keys split off, the rest nests under `data`.

Success and failure are symmetric because observation is first-class — a successful command still owes the observer a `code` and a `message`.

### Narration (tts)

Every command execution is narration material by default: activity-log consumers (a TTS narrator plugin) read the entry's effective sentence aloud. The effective sentence is computed once, at the instrumentation point (`effectiveTts` in the registry), and rides the activity entry as `payload.tts`:

- `CommandSpec.tts` — omitted = `true` (default: this command's executions are read; sentence = `message`). `false` = **never read, no matter what the response says**. Only commands that themselves perform narration (`say`-style) declare `false`; this is the single cut point that prevents infinite propagation (narration → activity entry → narration …).
- envelope `tts` — a string replaces `message` as the spoken sentence for this response; `false` mutes this one response.
- Consumers do not invent their own read/skip rules: an entry with `payload.tts` is read (in arrival order, no skipping), an entry without it is silent. `turn.ended` (AI utterances) never carries `tts`.

### Display media (optional)

A response that carries renderable content declares it — consumers never sniff data keys:

```
media?: { kind: string /* MIME, e.g. "image/png" */, base64?: string, path?: string }
```

`window.snapshot` sets `media` in both modes (file mode carries `path`, base64/rect mode carries `base64`); the feed renders it inline (a saved screenshot shows as an image, not as a path string; `path` is loaded lazily via `read_file_base64`); clicking the inline image enlarges it (lightbox, click/ESC to close).

## Command labels

Display surfaces (the orchestrator feed and any future consumer) never show a raw command key. The label ownership is structured to scale to any number of languages:

- **Plugin commands** — the manifest `contributes.commands[].title` (LocalizedText), owned and translated by the plugin author. The loader carries it into the registered spec, and `execute` instrumentation carries it on the activity stream (`title`), so a window that never loaded the plugin (the orchestrator) still resolves the label. The stream is self-sufficient.
- **Core commands** — `cmd.<name>` keys in the per-language message tables. Adding a language means adding one table; command definitions are untouched. Full coverage is enforced by the `commandTitles.test.ts` gate — a core command without a label fails the build.
- If neither exists, the command's English `description` shows — a raw key is never rendered.

## Sidecar boundary (A14)

A sidecar's own wire (engine C-ABI / service stdio / iroh socket) is opaque to the core by contract — the core relays bytes it does not interpret. **The standard governs the command surface** (core + plugin + sidecar-exposed commands), not the sidecar wire. The plugin adapter that fronts a sidecar (`main.js`, `adapter.ts`) ① translates sidecar events into standard `command.progress`, ② maps the final result into the response envelope. Unifying the three sidecar wires into one is out of scope (A14); progress exposure delivers "what the sidecar did."

## Enforcement

- **Core `execute`** normalizes handler returns into the envelope, injects `message` from `summarize` (or the `code` echo), and reserves `ok`/`code`/`message`.
- **The plugin loader** warns at registration when a plugin command provides no `summarize` — the standard answer degrades to the `code` echo. runbook's `ok()/err()` pair is the reference. `PluginCommandSpec.summarize` flows into the core spec, so plugin answers ride the same normalization.

## Migration

M1 established the standard: envelope type, `summarize` contract, `command.progress` kind, orchestrator bubble (request→delta→message), docs. M2 filled all core commands. M4 wires sidecar adapters through the plugin API `events.progress(command, delta)` publisher: the workflow plugin translates exec-stage child events (`{ev:add}` lines) into live deltas, and the chromium plugin announces open/navigate loads. M3 (per-plugin `error`→`code`/`message` + `summarize` sweeps) proceeds plugin-by-plugin under the loader warning.

Reserved-key rule (was: no top-level `id`/`ok`/`code`/`message` in handler data) is now structural — handlers return free data, `execute` nests it under `data`, and the envelope owns the reserved keys.
