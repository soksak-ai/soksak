---
kind: guide
status: active
canonical: EVIDENCE.md
---

# Evidence

English canonical: [`EVIDENCE.md`](EVIDENCE.md). Where the two differ, English wins.

How a visual claim is settled.

## E1. The verdict comes from numbers, not from pictures

"It looks right" is not evidence, and neither is "it looks wrong". A capture shows what happened;
the verdict comes from a command that returns numbers.

Measured 2026-08-15: a report that a pane's right outline was missing was argued from screenshots for half a day. `ui.measure`
answered only top and bottom borders. Once it answered all four edges the cause appeared in one reading —
The web view was one point larger than the window, so the document's last column was outside it. "Drawn but invisible" and "not drawn"
are identical in a picture and are different defects.

## E2. The command comes first

If no command produces the number, write it. A visual axis with no numeric judge is not a judgement call but
unfinished work.

## E3. A capture does not take focus

Capture uses this process's own window content, so it needs no screen-recording permission, and it does not raise a window
or give it focus, and it works while occluded. A capture that steals focus changes the thing it was measuring.

## E4. Where evidence goes

`evidence/` in the workspace, outside the application repository. It keeps a generated image from becoming a source file.
One directory per gate run.

## E5. The frame number is the shared clock

`window.record` reports a frame number as each PNG finishes writing, starting at zero. Every journal entry
that number, so a stored pixel and a recorded measurement point at the same instant. Two reads split across two moments
it produces a frame that was never on screen.
