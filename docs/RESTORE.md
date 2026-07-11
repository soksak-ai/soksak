# Restore

Workspace persistence and restore. Facet of [ARCHITECTURE.md](ARCHITECTURE.md); Korean copy: [RESTORE.ko.md](RESTORE.ko.md). The English text is canonical.

Restart brings the workspace back as it was: windows at their frames, tabs and splits, each terminal at its last working directory, with its shell still running where possible. The principles below govern every part of that path.

## Restore ladder

A restored terminal pane takes the highest rung available. The judge only adds earlier rungs — the repaint path itself stays one path (R-PATH).

1. **Live adoption** — the same app process remounts a still-live PTY (move-remounts within one run). Nothing is repainted.
2. **Warm reattach** — `soksak-ptyd` (an independent binary in the core workspace, staged into the identity home's `bin/`) owns every shell, so the shell and its children survive an app exit with their pids, and it owns the raw output ring with a monotonic sequence. A pane respawn with the same pane id reattaches over the daemon socket instead of spawning. The screen is repainted by the terminal-alacritty sidecar (`soksak-sidecar-terminal-alacritty`, terminal domain — not the core daemon): it consumes the daemon's per-session tee into a VT mirror and serves `rehydrate{window,pane}→{paint,uptoSeq,altActive}` — scrollback, the visible screen, alt-screen contents, private modes, and the cursor are synthesized from the mirror grid as SGR runs. The pane paints that, then attaches the daemon raw stream from `uptoSeq`; the sequence boundary keeps the handoff race-free. Because the synthesized paint is not a byte replay, it can never carry a DA1/DSR query for the front xterm to answer twice (the mirror never answers queries), and queries in the raw tail after `uptoSeq` are genuine — the live terminal answers them once. Byte survival, the ring, and reattach are the daemon's (core plumbing); screen synthesis is the sidecar's (terminal domain). Explicit quit detaches; it never kills daemon sessions.
3. **Cold byte restore** — the daemon owns a content-agnostic sealed-blob store; the checkpoint *policy* (when, and what to serialize) is the terminal-alacritty sidecar's. The sidecar serializes each session's flattened screen paint and pushes it to the daemon, which seals it to an app-owned X25519 public key (`soksak-seal` sealed box; the secret half lives only in the vault) and writes it under `<home>/pty/checkpoints` with tmp+rename, on the sidecar's debounce (300ms idle, 5s cap on output events). The daemon reads no byte of the blob — it holds the seal and the atomic write; the sidecar holds the meaning. A clean session end deletes the file, so a surviving checkpoint is evidence of the daemon's own death. On the next spawn of that pane the app opens the seal — only while the vault is unlocked — repaints the history as inert text (an active alt screen is flattened into the text flow: a dead session's TUI is a snapshot, not a live screen), prints a resolved loss notice ("restored from a sealed checkpoint — running processes were lost"), and deletes the consumed file. No plaintext screen byte ever reaches disk; while the vault is locked the file stays sealed and this rung yields to blocks repaint.
4. **Blocks repaint** — recent command blocks repaint as inert text (R-PATH). The only rung while the vault is locked, and the floor when every higher rung is unavailable.

When the daemon cannot be staged or reached, terminals fall back to in-process PTYs — the pre-daemon behavior — and the app announces the degradation on the activity feed (`pty.daemon.fallback`); daemon death is announced the same way (`pty.daemon.lost`). Silent degradation is forbidden.

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

- Explicit quit (Cmd+Q / `app.exit`) preserves every window's session — daemon-owned shells keep running detached. A user-initiated window close discards that window's snapshot, manifest slot, and PTY sessions (`kill_by_window` reaps the window's daemon shells, so no ghost shell outlives its window) — marked at `CloseRequested`, pruned at `Destroyed`, so the final unload save cannot resurrect it.
- Autosave is debounced and flushed on `pagehide`; window moves and resizes also trigger it.
- Runtime-created windows boot with `fresh=1` and never restore by label — reused `win-<seq>` labels must not revive crashed sessions.
- A missing project root demotes its tab (banner, volatile flag) instead of deleting it.

## Multi-window

The manifest (core kv `windows`) lists one slot per workspace window: label, roots, active root, logical frame, plus the last-focused label. `main` is the control plane (NAMING 4b) — it carries no workspace snapshot; its frame persists under its own key (`controlPlaneFrame`). On boot the control plane spawns every manifest slot (ghost slots without snapshots are cleaned), focuses the last-focused window, and on a true first run (no slots, no recents) opens one workspace window on the default project. Respawn spawns `w-*` slots only (NAMING 4b): a slot with any other label is refused with a loud error and its data left untouched — outside the capability scope such a window would boot deaf (every socket command times out). Previous-generation data was corrected once by the git-tracked one-shot migrations `scripts/migrations/20260704-window-label-uuid.sh` (win-<seq> → uuid) and `scripts/migrations/20260705-main-control-plane.sh` (the old main workspace becomes a w-<uuid> slot; main carries no workspace). Each respawned window restores its own snapshot (`window/<label>`) through the single restore path, claiming project roots through the global single-open registry (P6).

## Restore seam

`PluginViewContext.restore { cwd }` carries the observed working directory to the view provider on a restored mount. The terminal plugin spawns there instead of the project root; live PTY adoption still wins on move-remounts.
