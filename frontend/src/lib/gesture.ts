// Continuous gesture — pairs presentation and action in one place.
//
// A drag does two things: it follows the screen every frame (presentation), and it leaves the spot
// where the hand let go (action). The two differ — presentation streams at 60fps, the action happens
// once.
//
// While that difference is scattered without a name, no rule can stand. The gate that counts where
// the UI calls a store directly (ui-through-commands-scan) had no mechanical way to separate "is this
// presentation or action", so it either counted one mid-drag update as a violation or the whole rule
// had to be loosened.
//
// So the pairing is enforced. Using `preview` requires writing `commit` with it (the type requires
// it) — a gesture with presentation and no action cannot be constructed. That is exactly the shape of
// the defect fixed today: the drag changed the screen but went through no command, so the ledger got
// nothing.
//
// The runtime is thin. The value of this file is in the declaration: where the presentation is and
// what the action is are written in the code, and the gate reads that declaration.

export interface Gesture<T> {
  /**
   * Per-frame update — this is presentation. Calling the store directly here is not a bypass:
   * sending intermediate values as commands buries the ledger under dozens of lines per drag.
   */
  preview: (value: T) => void;
  /**
   * Landing — this is the action. It always goes through a command. The caller takes the same path as
   * the CLI and AI, and that fact stays in the ledger.
   */
  commit: (value: T) => void;
}

export interface RunningGesture<T> {
  /** Value of one frame. The last value is used for the landing. */
  move: (value: T) => void;
  /** The hand let go — commit with the last value. With no value ever seen, nothing happens. */
  end: () => void;
}

/**
 * Opens a gesture. The landing value is held here, so call sites do not track it themselves —
 * scattered tracking reproduces "last frame lost = snap back" in a different shape at each site.
 */
export function beginGesture<T>(g: Gesture<T>): RunningGesture<T> {
  let last: T | null = null;
  let landed = false;
  return {
    move(value) {
      last = value;
      g.preview(value);
    },
    end() {
      // Never land twice — mouseup and the cleanup path can both call this.
      if (landed || last === null) return;
      landed = true;
      g.commit(last);
    },
  };
}
