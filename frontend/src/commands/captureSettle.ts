// Capture settle — guarantees window.snapshot produces the exact frame on command, whatever the
// window state.
//
// For a non-foreground (covered/background) window, macOS stops document.timeline through
// occlusion. An entry transition (for example a dialog fade-in, opacity 0→1) then stays stuck at
// its first frame (opacity 0). arm_capture removes the occlusion and wakes rendering, but the
// timeline does not resume, so the stuck intermediate frame is what gets captured (the root of a
// modal captured transparent while open).
//
// So right before capture, finite-iteration animations are explicitly finished to their end
// state, producing the final frame that should be visible now. finish seeks the animation to its
// end and commits the style regardless of a stopped timeline. Infinite iterations (spinners and
// such) are a valid frame at any phase, so they are left alone.
// Plugin views mount inside a Shadow DOM, so the traversal recurses into shadowRoot.

export function isFiniteAnimation(iterations: number | undefined): boolean {
  return typeof iterations === "number" && Number.isFinite(iterations);
}

function collectAnimations(root: Document | ShadowRoot, out: Animation[]): void {
  const anyRoot = root as unknown as { getAnimations?: () => Animation[] };
  if (typeof anyRoot.getAnimations === "function") {
    for (const a of anyRoot.getAnimations()) out.push(a);
  }
  // A shadow root's getAnimations does not return its own tree → recurse into child shadowRoots.
  for (const el of root.querySelectorAll("*")) {
    if (el.shadowRoot) collectAnimations(el.shadowRoot, out);
  }
}

export function settleAnimationsForCapture(doc: Document = document): void {
  const anims: Animation[] = [];
  collectAnimations(doc, anims);
  for (const a of anims) {
    const iters = a.effect?.getComputedTiming?.().iterations;
    if (isFiniteAnimation(iters)) {
      // Ignore already-finished (InvalidState) or unsupported — do not block the rest of the settling.
      try {
        a.finish();
      } catch {
        /* noop */
      }
    }
  }
  void doc.documentElement.offsetHeight; // Force reflow — apply the finish styles before capture.
}
