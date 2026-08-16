---
kind: guide
status: active
canonical: self
---

# Evidence


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

## E6. An instrument that shares a source with its subject cannot fail

A reading answers about the thing. A reading assembled from the same record the thing was built
from agrees with that record whatever the thing is doing, and it reports success in exactly the
case the reading exists to catch.

Measured 2026-08-16, three of them in one day:

- **The capture drew from the ledger.** It asked each surface for its own pixels and drew them at
  the rectangle the inventory claimed, so a browser attached to the wrong window appeared in a
  picture of the right one while the pane a person was looking at was empty. Removed: a
  ScreenCaptureKit capture already holds every native child (NATIVE-LAYER), so the instrument reads
  the window and draws nothing. Gate: `frameworks/wails/capture_read_test.go`.
- **`surface.composition` answered one inventory for every window.** Two windows, one answer, zero
  drift, and only one of them had a browser in it. Fixed by keying every reading to the window it
  is about, and by the compositor reporting the window a surface actually landed in — read off the
  native object rather than restated from the declaration.
- **The restart digest could not see a renaming.** `state.fingerprint` holds no id, which is right
  for the shape it judges, so a change that renamed every id on restore passed it while breaking
  the terminal reattach key. The gate now asserts the names beside the digest.

So: **an observation surface reads the thing, and where it cannot, it says which claim it is not
making.** `surface.composition` names `misparented` from the native object; a capture note names
what it did not draw; `window.monitors` answers presence and states in GATES.md that it does not
answer whether a rectangle is in front of the person.

## E7. A gate is proven to bite, once, against the defect

AGENTS 3-1 requires a red before a fix. A gate written over behaviour that is already correct has
no red to show, and one that cannot fail is worth less than none — it reports safety.

So it is run against the defect deliberately: put the old behaviour back, watch the gate fail by
name, put it back. Measured 2026-08-16, four times — a rebuilt label assembly reported at
`lib/viewPark.ts:101`; a format-valid counter that failed the stream reload assertion with
`expected 'stm-aaaabb' not to be 'stm-aaaabb'`; a projection seed keyed the old way answering
`undefined` for the workspace root; the reminting restore answering `pan-ufetu2` where the pane id
had to be stable.

The probe is removed in the same sitting. A probe left behind is a defect nobody chose.
