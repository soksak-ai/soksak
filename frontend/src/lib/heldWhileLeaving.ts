import { useEffect, useRef, useState } from "react";

// What leaves the screen leaves with the space it stood in.
//
// A region's width travels with the panes — one motion owns the layout — and the sections standing
// in it are decided by a render. So when the last thing standing in a region goes away, the width
// takes the motion's length to close and the content is gone on the first frame of it: a strip with
// nothing in it, for as long as the motion lasts. Measured 2026-08-17 in the named three-pane
// window, 160 points wide and 160ms long.
//
// This holds the departing value for exactly that long. A **replacement** is not a departure: when
// one set takes another's place the new one is shown at once, because the space it stands in never
// closes. Only the walk to nothing is held.

/**
 * The value, held for `ms` after it becomes nothing.
 *
 * Returns what was passed while there is something to show; keeps the last one through the closing
 * motion; then nothing. A value replaced by a different value is passed straight through.
 *
 * `subject` names what the value is about — a region, a pane, whatever the caller holds one of. When
 * the subject changes, nothing is departing: the caller is asking about something else, and the last
 * answer to the previous question is not an answer to this one.
 */
export function useHeldWhileLeaving<T>(
  value: T | null | undefined,
  ms: number,
  subject: string = "",
): T | null {
  const [held, setHeld] = useState<T | null>(value ?? null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const asked = useRef(subject);

  useEffect(() => {
    if (asked.current !== subject) {
      asked.current = subject;
      if (timer.current !== null) {
        clearTimeout(timer.current);
        timer.current = null;
      }
      setHeld(value ?? null);
      return;
    }
    if (value !== null && value !== undefined) {
      if (timer.current !== null) {
        clearTimeout(timer.current);
        timer.current = null;
      }
      setHeld(value);
      return;
    }
    // Already nothing: nothing to hold, and no timer to start.
    if (timer.current !== null) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      setHeld(null);
    }, ms);
    return () => {
      if (timer.current === null) return;
      clearTimeout(timer.current);
      timer.current = null;
    };
  }, [value, ms, subject]);

  // The first render after a value arrives must already show it — waiting for the effect would put
  // one frame of nothing in front of every arrival, which is the defect this exists to prevent,
  // pointed the other way.
  if (value !== null && value !== undefined && value !== held) return value;
  // A question about another subject is not answered by what was held for the last one.
  if (asked.current !== subject) return value ?? null;
  return held;
}
