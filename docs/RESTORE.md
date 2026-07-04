# Restore

Workspace persistence and restore. Facet of [ARCHITECTURE.md](ARCHITECTURE.md); Korean copy: [RESTORE.ko.md](RESTORE.ko.md). The English text is canonical.

Restart brings the workspace back as it was: windows at their frames, tabs and splits, each terminal at its last working directory, with its recent command blocks repainted. The principles below govern every part of that path.

## Principles

### R-OWN — Ownership delegation

Every piece of history has exactly one owner, and soksak never duplicates it.

- Shell history is owned by the terminal plugin as command blocks in `app.data` records (`command_blocks`, project scope). One block per completed command: command line, output, cwd, exit code, timestamps.
- TUI-internal history (claude, codex) is owned by the TUI's own session files. soksak records only the lineage link — pane to session id — via fs-watch observation, never a transcript copy.
- The workspace snapshot owns structure only: projects, contents, splits, view parameters.

### R-PATH — One re-hydrate path

Restart restore and vault unlock re-hydrate run the same code: query the view's blocks, repaint them as inert text under a dim `[복원됨]` marker. Nothing re-executes. A block with a verified session lineage offers a resume affordance (`sok terminal.resume {…}`); running it is the user's act. Blocks saved while the vault was locked are unverified and never offer resume.

### R-EVIDENCE — Activity is event-sourced

`lastActivity` per view updates only on evidence: command start and finish, turn end, view activation, PTY output (throttled per pane). No sampling, no estimation. The observed cwd persists the same way, from shell-integration OSC events.

### R-ATOMIC — Atomic look, lazy resources

A restored window paints all tabs and splits at once. Only views actually on screen mount their bodies immediately; hidden views stay cold and are promoted the moment they become visible, or by a one-shot idle chain in `lastActivity` order. The filling-in is never visible.

### R-CLEAN — Integrity

- Explicit quit (Cmd+Q / `app.exit`) preserves every window's session. A user-initiated window close discards that window's snapshot and manifest slot — marked at `CloseRequested`, pruned at `Destroyed`, so the final unload save cannot resurrect it.
- Autosave is debounced and flushed on `pagehide`; window moves and resizes also trigger it.
- Runtime-created windows boot with `fresh=1` and never restore by label — reused `win-<seq>` labels must not revive crashed sessions.
- A missing project root demotes its tab (banner, volatile flag) instead of deleting it.

## Multi-window

The manifest (core kv `windows`) lists one slot per window: label, roots, active root, logical frame, plus the last-focused label. On boot, main restores itself, respawns every other slot with its label and frame (ghost slots without snapshots are cleaned), then focuses the last-focused window. Respawn spawns `w-*` slots only (NAMING 4b): a slot with any other label is refused with a loud error and its data left untouched — outside the capability scope such a window would boot deaf (every socket command times out). Previous-generation data was corrected once by the git-tracked one-shot migration `scripts/migrations/20260704-window-label-uuid.sh` (snapshot key rename + manifest label swap, values untouched). Each respawned window restores its own snapshot (`window/<label>`) through the single restore path, claiming project roots through the global single-open registry (P6).

## Restore seam

`PluginViewContext.restore { cwd }` carries the observed working directory to the view provider on a restored mount. The terminal plugin spawns there instead of the project root; live PTY adoption still wins on move-remounts.
