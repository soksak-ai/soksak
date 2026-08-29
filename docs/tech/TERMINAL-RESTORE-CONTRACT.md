# Terminal restore contract

Restore is a session continuation, not a clean-terminal reset.

## Required sequence

1. Hydrate the persisted workspace layout and pane identity.
2. Resolve the persisted PTY session (or an archived checkpoint when the PTY is gone).
3. Wait until the pane has real dimensions before attaching a renderer.
4. Apply one authoritative frame/snapshot with its exact output sequence.
5. Attach the renderer lease to the existing PTY session and deliver only bytes after that sequence.
6. Publish `ready` only after the renderer has applied the frame and the input owner is writable.

The PTY owns shell continuity and scrollback. The renderer owns its painted viewport. A restored
screen may therefore contain earlier commands and intentional blank lines; that is evidence of the
same session, not a duplicated shell. `terminal.clear` clears the engine screen but does not erase
the shell's process or daemon history.

## Boundary comparison

| Concern | Workspace restore | Terminal Kit restore |
|---|---|---|
| Layout | Hydrates tabs, pane tree, focus and pane-to-session mappings | Hydrates pane tree, focus, engine, title and CWD |
| Session ownership | Reconnect plan advertises persisted PTY ids before pane mount | `pty.pane` checks ownership, then `terminal.rehydrate` issues a lease |
| First paint | Waits for a mounted manager and usable dimensions | Applies the exact `frame`/snapshot before `ready` |
| Live continuation | Daemon stream resumes after the checkpoint sequence | `pty.attachLease` resumes after `uptoSeq` |
| Dead session | Explicitly reports unavailable/reconnect state | Shows an archived frame, then starts a new shell and marks the outcome |
| Input readiness | Input probes wait for the restored pane to be ready | warm snapshots allow input after attach; fresh byte renderers wait for first output |

Any implementation that paints a cached string without its sequence, opens a second shell for an
owned pane, or accepts input before the ready boundary is RED. The screenshot alone cannot certify
this contract; use recovery/status sequence fields and an independent input marker.

## Input readiness

Kit 0.0.91 keeps a fresh byte renderer non-writable after `attach` and changes it to writable only
when the first PTY output has reached the renderer. Warm restore already applied an authoritative
snapshot before attach and can accept input immediately. The output event fixes the ordering without
a timer or polling loop.

Kit 0.0.91 and xterm Plugin 0.0.68 close the installed runtime row. A fresh mount rendered once
while accepted-input and PTY-write sequences were both zero; 32 public key events then produced 32
accepted inputs and 32 writes with the expected marker and prompt. After application restart the
pane reported `recoveryOutcome=continued`, retained the first marker, and 30 more public key events
produced 30 accepted inputs and 30 writes with a second marker and prompt.

## Selection and scroll evidence

The public drag route dispatches a single primary-button press and document-owned move/release
events. In the isolated runtime, dragging the rendered `SELECT_ME_1234567890` marker made
`selection`, `copy`, and an independent `clipboard.read` return the same 20 characters.

Contract 0.0.19, Kit 0.0.93, and xterm Plugin 0.0.70 make viewport ownership observable. An offset
of zero is `follow`; a positive offset is `pinned`. With 85 history rows, the installed runtime
reported `0/85 follow`, a public ten-line scroll returned and published `10/85 pinned`, and a public
bottom scroll returned and published `0/85 follow`. The pinned capture showed rows 43 through 71;
the bottom capture showed rows 52 through 80 and the prompt. Command replies, status, and pixels
therefore described the same viewport state.

Every registry-consumed contract release must seal every file reachable from its public export.
The 0.0.18 artifact omitted `src/pane-key.ts` and failed in the first consuming Kit build; it remains
immutable. Contract 0.0.19 adds the missing sealed file and a repository boundary test, and its
consumer build is GREEN.
