---
kind: guide
status: active
canonical: self
---

# Evidence

Korean edition: [`EVIDENCE_KO.md`](EVIDENCE_KO.md). English is canonical.

How a visual claim is settled.

## E1. A number decides, a picture does not

"It looks right" is not evidence, and neither is "it looks wrong". A capture shows what happened;
the verdict comes from a command that returns numbers.

Measured 2026-08-15: a missing outline on the right of a pane was argued from screenshots for an
afternoon because `ui.measure` answered only top and bottom borders. Once it answered all four
edges the cause appeared in one reading — the web view was one point larger than its window, so the
document's last column was outside it. "Drawn but invisible" and "not drawn" are identical in a
picture and are different defects.

## E2. The command comes first

If no command produces the number, write it. A visual axis with no numeric judge is unfinished
work, not a judgement call.

## E3. A capture does not take the focus

Capture uses this process's own window content, so it needs no screen-recording permission, does not
raise or focus a window, and works while the window is occluded. A capture that steals focus changes
the thing it is measuring.

## E4. Where evidence is kept

Under `evidence/` in the workspace, outside the application repository, so generated images never
become source files. One directory per gate run.

## E5. The frame number is the shared clock

`window.record` reports a frame number as each PNG finishes writing, starting at zero. Every journal
entry carries that number, so a stored pixel and a recorded measurement refer to the same instant.
Two reads taken at two moments produce a frame that was never on screen.
