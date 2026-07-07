# soksak AI Control Surface — Substrate / Channel / Teaching (v1)

The canonical rules for how every soksak capability is given to AI. The three pieces (CLI · MCP · Skill) are not siblings: they form a **1 substrate + 2 transports + 1 teaching** hierarchy, and this file is the single source of truth for that relationship. Code comments, the Skill body, and the MCP design all reference this file — where they disagree, the code is wrong.

Korean copy: [AI-CONTROL.ko.md](./AI-CONTROL.ko.md) — the English text is canonical.

> Install/usage how-to lives in [`AI-CONTROL-GUIDE.md`](./AI-CONTROL-GUIDE.md) (the manual). This file covers design and rules (the why) only.

---

## 1. Mental model

```
              ┌──────────────────────────────────────────────┐
  TEACHING    │  Skill: soksak(-dev|-debug) (SKILL.md)             │
              │  Teaches agents how to use and discover the   │
              │  channels (never a command list — discovery)  │
              └───────────────┬──────────────────────────────┘
                              │ teaches how to use ↓
              ┌───────────────┴──────────────────────────────┐
  CHANNELS    │   CLI: sok            │   MCP: sok mcp         │
 (2 transport)│   sync calls in the   │   stdio bridge for     │
              │   terminal            │   external agents      │
              │   commands/help/run   │   (discovery meta-     │
              │   (discovery-shaped)  │    tools)              │
              └───────┬───────────────┴───────────┬──────────┘
                      │ JSON-RPC over socket       │ bridge→socket
                      ▼                            ▼
              ┌──────────────────────────────────────────────┐
  SUBSTRATE   │  Socket Server (ipc.rs)                       │
 (single      │   ~/.soksak/*.sock · multi-window route · seq │
  source of   │   · danger gate (permissionGate, remote only) │
  truth)      │   · events.subscribe push stream (P11)        │
              │  ────────────────────────────────────────    │
              │  Command Registry (registry.ts)               │
              │   Map<name,CommandSpec> · catalogJson()       │
              │   core ~140 + plugin contributions → one Map  │
              │  Activity Hub (activity.rs)                   │
              │   ring + seq · app-wide broadcast · persisted │
              └──────────────────────────────────────────────┘
                      ▲                            ▲
               core register()            plugin contributes.commands
```

- **Substrate (single source of truth)** = Command Registry (`src/commands/registry.ts`: `Map<string,CommandSpec>`, `catalogJson()`) + Socket Server (`src-tauri/src/ipc.rs`: Unix domain socket JSON-RPC, multi-window routing, danger gate) + Activity Hub (`src-tauri/src/activity.rs`: the execution stream, P11–P12). The only truth for a command's existence, schema, permission, and execution. Core `register()` calls (~140) and plugin `contributes.commands` converge into one Map.
- **Channels (transports)** = CLI (the `sok` binary, synchronous calls inside the terminal) + MCP (`sok mcp`, a stdio bridge for external agents). Both only **call** the substrate. Neither owns a command list; everything derives from `catalogJson()` / `state.commands`.
- **Teaching (above the channels)** = the Skill (soksak — per environment). It teaches agents **how to use** the channels — how to discover, not a command list. It is not a transport.

The three are not equal siblings but a dependency ladder with the substrate at the top. No channel can define a command around the substrate, and teaching reaches commands only through a channel.

---

## 2. Rules (P1–P13)

**Meta-principle — rules serve the goal.** If following a rule loses information or behavior you need, the rule is wrong: correct it rather than weaken it. Only legitimate corrections, though — lowering the bar for convenience is betrayal.

**P1 — The Command Registry is the single source of truth.** `catalogJson()` is the only truth for command existence, schema, permission, and execution. No channel maintains its own command list by hand. CLI help, MCP tools, Skill teaching, and docs all derive from this catalog — no duplication.
Evidence: `catalogJson()` (registry.ts) is exposed as `state.commands`, and the CLI's `fetch_commands()` calls it → CLI/MCP/docs all derive. The moment a channel lists commands separately, it drifts forever.

**P2 — CLI and MCP are transports; the Skill is teaching.** Never treat the three as equal siblings. Transports only call the substrate; teaching reaches commands only through a transport. Never bake a command list into the Skill — teach discovery only.

**P3 — Discovery beats injection.** Channels must not expose every command eagerly. Provide a discovery surface (list → schema → run). Never flatten the full command set into MCP `tools/list` — keep the three meta-tools (`soksak.commands` / `soksak.help` / `soksak.run`) fixed. With discovery, the tool count stays constant as commands grow.

**P4 — Exactly one permission gate, in the substrate.** Never reimplement permission logic per channel. The danger gate applies to remote calls (CLI/MCP/socket) only; UI (human) calls bypass it. Plugin commands flow their danger class through the same substrate gate.

**P5 — The Skill is orientation. No per-command catalog.** The Skill is standing knowledge in `.claude`/`.codex` — "run `sok commands`" alone leaves agents unable to even discover unknown domains, so the Skill carries **stable orientation** (mental model, address model, verification workflow, and a domain map as a table of contents). It never carries the volatile, bulky, plugin-dynamic per-command catalog — that is `sok commands`/`help`. The domain map derives from the live registry at install time (core fallback when the app is down). Never claim "every feature is documented" — it becomes false the moment the substrate grows.

**P6 — Do not blur the app / `sok mcp` boundary.** The app (`ipc.rs`) is not an MCP server; it is the app-internal command socket. The MCP server is the `sok mcp` subprocess, bridging to the socket only while the app runs. Never write "the app hosts MCP".

**P7 — Channels stay thin.** No logic in channel handlers. The `sok` CLI and MCP meta-tools do only `state.commands` fetches and `request()` pass-through. Validation, routing, gating, and identifier matching all live in the substrate. Thick channels fork bugs per channel.

**P8 — Teaching documents travel through channels only; never intercept the filesystem.** Live docs are delivered by (a) MCP resource (`resources/read soksak://skill` over stdio) and/or (b) write-through real files (regenerated on registry change). FUSE/userspace filesystem interception is forbidden — kext friction and per-platform drivers break multi-platform, and "open a path that does not exist and have a server fabricate it" is a trick we do not adopt. Both delivery paths derive from `sok commands` (P1) and behave identically on mac/linux/windows.

**P9 — the environment is the binary's identity; silent cross-env is betrayal.** There are three app identities (`com.soksak.{dev|debug|app}`) with separate sockets, and three real CLI binaries built together from one crate (`sok`→app, `sok-dev`→dev, `sok-debug`→debug — tiny entry points over a shared lib, so none can go stale; the name mechanism itself uses no links or copies (PATH installation may symlink the same-named real artifact — exposure, not fabrication)). Each binary's environment is fixed at compile time: there is **no human-settable channel** (`--env` and `SOKSAK_ENV` are abolished — they were exactly the betrayal path). The only higher authority is `SOKSAK_SOCKET`, injected by the app into its own PTYs — a machine-set claim by the host app, not a user override. If the binary's environment is not running, that is an **error** — never a substitution; use the other environment's own binary instead.

**P10 — Install is idempotent and scoped by ownership.** Regenerate what is ours wholesale; preserve what is the user's.
- **Fully-owned artifacts** — the control skill lives in a per-environment directory (`soksak/`, `soksak-dev/`, `soksak-debug/` — one per identity home, each pinning its own binary path and socket at generation). The target directories are pure output, regenerated wholesale. The authored body and its companions are source — `src-tauri/cli/skill/` (BODY.md, references/) in the core repo, compiled into the CLI (`include_str!`) and emitted at install/refresh; renames and surface changes sweep them in the same commit as the code. The generator forces the frontmatter `name:` to the environment and appends an environment sentence to the description; the body lands as a "Working style (authored)" section. Installation records a `skill-refresh.json` manifest in the identity home; the app spawns `sok skill refresh` whenever the enabled-plugin set changes, so the files are a write-through view of the live registry (no filesystem interception — P8).
- **Shared files** (`.mcp.json` / codex `config.toml` / gemini `settings.json` — one file shared with the user's other entries) get **our entry upserted only**, everything else preserved. MCP registration is delegated to the native CLIs (`claude/codex/gemini mcp add`) — each tool owns its config format, merging, and idempotency (P7). Merging TOML/JSON ourselves risks corrupting user config.

**P11 — The event stream mirrors the command surface.** The core owns a subscription surface symmetric to the command surface — the completion of the no-polling rule. The hub is a Rust singleton (cross-window single truth; entries carry a monotonic `seq` and epoch-ms `ts`); the socket serves it as `events.subscribe`, handled at the transport level (the connection becomes the stream; connection lifetime = subscription lifetime). `kinds` filters server-side (prefix match); `since` backfills from the ring (exclusive cursor). Subscriber queues are bounded and drop-oldest — a slow consumer never blocks publishing, and loss shows up as a `seq` gap the client heals with a `since` reconnect. Shell-less MCP clients use `activity.recent {since}` cursor reads instead of push — a catch-up query at request time is not polling (decided).

**P12 — Execution visibility.** Everything an orchestrator makes soksak execute — registry commands, terminal commands, AI turns — is visible to a human. The execution feed is a persisted record (core/activity records, retention-trimmed), and any UI is a view over that record. Two supply lines: ① plugin events (terminal command start/finish, turn end, view activation), ② `registry.execute()` instrumentation — command name, ui/remote source, danger class, duration, and the standard response envelope (`ok`/`code`/`message`, plus `data` for detail). The `message` (from `CommandSpec.summarize`) is the human-readable answer the feed renders; `data` is the machine payload shown on demand. **Secret-keyed values (`pass`/`token`/`secret`/`auth`…) are masked, never emitted** — the security invariant is preserved by masking, not by withholding the whole answer (superseding the earlier "parameter keys only, values never enter the stream": observation is first-class here, so the answer must be visible while secrets stay masked). Streaming commands also emit `command.progress` deltas (see MESSAGE-PROTOCOL.md). Orchestrator-issued commands are exactly this path, so without ② "watch what runs" does not exist.

**P13 — Transport neutrality.** A local window and a phone consume the same stream and the same command surface. The danger gate and remote.confirm key off the **call origin**, not the transport. The core contains zero phone-specific code — a remote transport (e.g. the iroh sidecar) forwards `events.subscribe` and the command socket as-is.

---

## 3. Per-channel listing (audience / capability / mechanism / what / why)

### Substrate (Registry + Socket + Activity Hub)
- **Audience**: all three channels plus the UI (humans) — the terminus of every call.
- **Capability**: Command Registry (register/getSpec/catalogJson) + Unix socket JSON-RPC (multi-window routing, timeout, client-id/seq matching) + danger gate (permissionGate for remote only, UI bypass) + activity stream (publish/recent/subscribe). Core ~140 + plugin contributions in one Map.
- **Mechanism**: core `register()` (`catalog*.ts`) + plugin `contributes.commands` → `registerCommand`. `ipc::start(app)` binds the socket. No channel hand-maintains a list; everything derives from `catalogJson()`.
- **What**: freeze `registry.ts`/`ipc.rs`/`activity.rs` as the canonical substrate. Keep `catalogJson()` the only command-list origin.
- **Why**: both transports and the teaching derive from here → they cannot disagree with the code. The gate must live in the substrate so it is never reimplemented per channel.

### CLI (`sok`)
- **Audience**: humans in the terminal + agents in the terminal (claude/codex running `sok` inside a PTY).
- **Capability**: any command `sok <cmd> '{json}'`, discovery `sok commands`/`help <cmd>`/`docs`, stream follow `sok events [--kinds] [--since]` (JSONL, Ctrl-C to stop), MCP bridge `sok mcp`, teaching install `sok skill install` / print `sok skill print` (live SKILL.md to stdout — prompt material for headless agents). SOKSAK_PANE/WINDOW/SOCKET auto-detection targets "where I am" by default; `--window <label>` overrides the target window explicitly (beats `SOKSAK_WINDOW` — the vehicle for agents whose shell permission only admits `sok …` prefixes).
- **Correlation**: `SOKSAK_PARENT` (injected by the orchestrator into agents it spawns) rides every request as meta `parent` → activity entries carry `payload.parentId`, binding the executions to their conversation turn (MESSAGE-PROTOCOL §4). Same env-context model as PANE/WINDOW; MCP `soksak.run` passes the same point.
- **Mechanism**: the workspace `cli` crate → `sok` binary. `resolve_socket` (env→`~/.soksak` scan). `run_request`/`run_help`/`run_docs` all derive from `fetch_commands()` = `state.commands`; `run_events` switches the connection into the push stream.
- **What**: keep the current implementation. help/docs derive from `catalogJson` as a fixed rule. No hardcoded static command lists.
- **Why**: transport 1 — low-latency synchronous calls inside the terminal. Already discovery-shaped; the same pattern applies to MCP.
- **Note — `orchestrator.ask` over the socket**: the command registers only in the control plane, so target it explicitly (`sok --window main orchestrator.ask '{"text":"…","timeoutMs":300000}'`) and pass a large `timeoutMs` — a turn can run minutes; the socket clamp ceiling is one hour (a longer turn keeps running; only the caller times out).

### MCP (`sok mcp`)
- **Audience**: agents on external MCP clients (Claude Desktop and other stdio MCP connections).
- **Capability**: `sok mcp` = stdio JSON-RPC 2.0 MCP server. Three discovery meta-tools: `soksak.commands` (catalog), `soksak.help` (single schema), `soksak.run` (arbitrary command dispatch). Bridges to the substrate only while the app runs. Shell-less clients read the activity stream via `activity.recent {since}` cursors (P11).
- **Mechanism**: the `sok mcp` subprocess (not the app). `initialize`/`tools/list`/`tools/call`. `tools/list` returns only the meta-tools; `soksak.run` forwards `request(method,args)` to the socket. Tool schemas come on demand from `soksak.help`. Additionally `resources/list` + `resources/read soksak://skill` serve the live SKILL.md over stdio (P8 — zero files/FUSE).
- **What**: eager flattening replaced with the three meta-tools; the app vs `sok mcp` boundary documented.
- **Why**: transport 2 — the external-agent channel. Eager exposure violated P3 and exploded client context; discovery keeps it consistent with the CLI.

### Skill (soksak — per environment)
- **Audience**: coding agents using the CLI/MCP channels (claude/gemini/codex). They learn usage on top of the channels.
- **Capability**: address model, verification workflow, domain map, discovery-command guidance. How to discover — not a command list.
- **Mechanism**: `sok skill install` writes a **trigger skill** (SKILL.md with frontmatter name+description) — `--claude`→`.claude/skills/soksak(-dev|-debug)/`, `--codex`/`--gemini`→`.agents/skills/soksak(-dev|-debug)/` (shared). The body derives the live domain map via `skill_doc()` (core fallback when the app is down). The description auto-triggers.
- **What**: static catalog replaced by discovery orientation. AGENTS.md/GEMINI.md marker blocks abolished (obsolete, P5).
- **Why**: teaching — an education layer, not a transport. Copying the list would drift from the substrate. Trigger skills are task-scoped.

---

## 3.5 Invocation/trigger model (natural language is canonical; slash is auxiliary)

Triggering happens through **descriptions (natural language)**. Slash/explicit invocation is never required.
- **Skill** — the `SKILL.md` frontmatter `description` is the trigger (identical across Claude/Codex/Gemini — confirmed against 2026 official docs). The model auto-invokes on task match. Slash `/soksak` (or `/soksak-dev`, `/soksak-debug`) is auxiliary.
- **MCP** — meta-tool `description`s are the trigger. The model calls `soksak.commands`→`help`→`run` from natural language. Zero slash.
- Two consumption contexts: shell-having agents (Claude Code/Codex/Gemini terminals) go Skill→`sok` (Bash); shell-less ones (Claude Desktop) use the MCP meta-tools. Both natural language. Trigger quality = description quality.

Client conventions (2026 official docs): trigger skills = Claude `.claude/skills/<name>/SKILL.md` (+`~/.claude/skills/`), Codex/Gemini `.agents/skills/<name>/SKILL.md` (shared; Gemini skills preview v0.23+). MCP registration = native `claude/codex/gemini mcp add --env SOKSAK_SOCKET=<sock> <name> -- sok mcp` (env pin = environment binding, consistent with P9).

---

## 4. Inventory — exists / was missing / done

### Exists (verified)
- Command Registry single truth: `catalogJson()` (handler-stripped serialization) = the single origin of `sok commands`/`help`/`docs`/MCP tool definitions.
- Unix socket JSON-RPC server: `~/.soksak/{id}.sock` bound 0600; envelope `{id?,method,params?,pane?,window?,timeoutMs?}`.
- Multi-window routing: `route()` = `window ?? LAST_FOCUSED ?? 'main'`, `emit_to` (target window only, not broadcast), client id echo + internal u64 seq matching.
- Danger gate (substrate): `ctx.remote && spec.danger` → permissionGate, UI bypass. Plugin commands gate end-to-end via `PluginCommandSpec.danger`.
- CLI complete: `resolve_socket`/`request` (SOKSAK_PANE/WINDOW injection)/`run_request`/`run_help`/`run_docs`/`run_events`.
- MCP implemented: `sok mcp` = stdio JSON-RPC 2.0 (initialize/ping/tools/list/tools/call), discovery meta-tools.
- Skill installer: trigger-skill writer with AUTO-GENERATED header.
- PTY env auto-injection: SOKSAK_PANE + SOKSAK_SOCKET (+ SOKSAK_WINDOW).
- Plugin command contribution: `contributes.commands` → `plugin.<id>.<name>`, flowing into the same registry → auto-exposed to CLI/MCP.
- Activity hub (P11–P12): ring cap 2000 + monotonic seq, app-wide `activity` broadcast, core/activity persistence with retention, `activity.recent` command, `events.subscribe` socket push (kinds filter, since backfill, bounded drop-oldest subscribers), registry execute instrumentation (param keys only).

### Was missing → resolved in v1.1 (implemented, tested, live-verified)
- ✅ Discovery-shaped MCP (U1): `tools/list` = three meta-tools; eager flattening abolished; `soksak://skill` resource.
- ✅ Trigger skill (U2): `skill_doc()` orientation + live domain map; per-command catalog removed (P5); marker blocks abolished; AUTO-GENERATED header (P10).
- ✅ app/`sok mcp` boundary (U3): comment corrected (P6).
- ✅ Plugin danger visibility (U4): `ContributedCommand.danger` + parseManifest validation; manifest danger is authoritative (contradiction → reject); consent modal renders dangerousCommands. No gate weakening.
- ✅ SOKSAK_WINDOW PTY injection (U5): symmetric with PANE; `sok` inside a terminal defaults to its own window.
- ✅ Environment binding / betrayal cut (U8): `resolve_socket` — app-injected SOKSAK_SOCKET, else the binary's compiled environment (P9). App·CLI paired builds.
- ✅ MCP client registration (U7): `sok mcp install` — native `claude/codex/gemini mcp add` shell-out, env pin.
- ✅ Canonical rules (U6): this document (P1–P13 + meta-principle). Code comments reference it.

### Follow-up (v1.1.1)
- ✅ danger declared in plugin manifests: kanban (node.remove·reset), mailbox (delete·clear·import), lgtv-remote (text-input), dom-picker (selection.set·selection.clear·probe) = 9 commands, matching runtime (reload 0-rejected).
- ✅ Consent modal renders `dangerousCommands` as a ⚠ section (right after permissions — the most decisive spot). PNG-verified.

> Never assert a fixed total command count (instant staleness). Core ~140 (register calls) + installed plugin contributions. The live truth is always `sok commands` — the direct corollary of P1·P3.

---

Version: 1.2.0
Source: soksak AI control surface v1 — field measurements (8 agent workflows) + adversarial review (2 skeptics) + client-convention research (Claude/Codex/Gemini 2026 official docs). P11–P13 added with the activity hub and socket streaming (orchestration A1–A2).
