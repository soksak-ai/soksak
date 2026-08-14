// Move after the click is confirmed (§12-④ revision) — slot activation (and the projection run and
// re-layout that follow it) runs at gesture completion, not at mousedown.
//
// Basis (measured focus trace): starting the move at mousedown lets the move curtain and the
// re-layout capture and kill the events of the rest of the gesture and of the following click. Also,
// on macOS window-activation clicks, mouseup was measured arriving before mousedown — waiting on
// mouseup alone misattributes the activation to the next unrelated click ("works, then doesn't").
// The completion signal is whichever of three arrives first:
//  ① mouseup (normal gesture) ② next mousedown (= the previous gesture definitely ended) ③ 350ms timer
//    (lost-signal fallback — activate 350ms into a hold, same feel as the former immediate activation).
// Whichever signal fires, the activation is attributed to the slot that started the gesture
// (straddle is structurally impossible).
const FALLBACK_MS = 350;

export function armSlotActivation(activate: () => void): void {
  let done = false;
  const fire = () => {
    if (done) return;
    done = true;
    window.removeEventListener("mouseup", fire, true);
    window.removeEventListener("mousedown", fire, true);
    window.clearTimeout(timer);
    activate();
  };
  window.addEventListener("mouseup", fire, { capture: true });
  window.addEventListener("mousedown", fire, { capture: true });
  const timer = window.setTimeout(fire, FALLBACK_MS);
}
