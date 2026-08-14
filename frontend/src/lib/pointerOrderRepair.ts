// Pointer order repair — close the phantom hold.
//
// Measured (focus trace): the macOS window-activation click can lose the mouseup or deliver it before the
// mousedown (6104ms mousedown, next up 2.7s later). A consumer that never got the up (xterm, ghostty
// selection service, and so on) treats the button as held and draws later physical movement as a drag
// selection — "one click, huge selection". The core input boundary tracks hold state, and on a mousemove
// with buttons=0 (not actually held) it synthesizes a mouseup on the last mousedown target and closes it
// at once. Normal drag (buttons=1) and the real mouseup path are untouched. 3 listeners, no polling.
export function startPointerOrderRepair(): () => void {
  let heldTarget: EventTarget | null = null;

  const onDown = (e: MouseEvent) => {
    heldTarget = e.target;
  };
  const onUp = () => {
    heldTarget = null;
  };
  const onMove = (e: MouseEvent) => {
    if (!heldTarget || e.buttons !== 0) return;
    const target = heldTarget;
    heldTarget = null; // Cleared before dispatch — the synthetic up re-entering onUp is then harmless
    target.dispatchEvent(
      new MouseEvent("mouseup", {
        bubbles: true,
        composed: true,
        clientX: e.clientX,
        clientY: e.clientY,
        button: 0,
        buttons: 0,
      }),
    );
  };

  window.addEventListener("mousedown", onDown, true);
  window.addEventListener("mouseup", onUp, true);
  window.addEventListener("mousemove", onMove, true);
  return () => {
    window.removeEventListener("mousedown", onDown, true);
    window.removeEventListener("mouseup", onUp, true);
    window.removeEventListener("mousemove", onMove, true);
  };
}
