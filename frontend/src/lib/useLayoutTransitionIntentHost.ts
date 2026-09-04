import { useLayoutEffect, useRef } from "react";
import {
  registerLayoutTransitionIntentHost,
  type LayoutTransitionIntent,
} from "./layoutTransitionIntent";
import type { PreparedLayoutTransition } from "./layoutTransitionHost";

/** Keeps one intent owner registered for one workspace while using the latest prepare implementation. */
export function useLayoutTransitionIntentHost(
  ownerKey: string,
  prepare: (
    intent: LayoutTransitionIntent,
    signal: AbortSignal,
  ) => Promise<PreparedLayoutTransition>,
): void {
  const latest = useRef(prepare);
  latest.current = prepare;
  useLayoutEffect(
    () => registerLayoutTransitionIntentHost(ownerKey, {
      prepare: (intent, signal) => latest.current(intent, signal),
    }),
    [ownerKey],
  );
}
