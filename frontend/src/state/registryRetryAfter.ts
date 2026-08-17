// What a registry means when it answers 429.
//
// It is not a registry that failed. It is one holding this build off, with a header naming how
// much longer — whole seconds or an HTTP date. A build that reads that as a failure reports the
// network's rate limit as its own catalogue being unreadable: measured 2026-08-18, the gate that
// checks a running build for faults failed for a day on official -> error (HTTP 429), 0 units,
// and nothing was wrong with the build.
//
// So the wait is honoured, and a limit that outlasts the patience here is answered as a limit rather
// than as a fault.

/** How long the registry asked to be left alone, in milliseconds. Null when it asked for nothing. */
export function retryAfterMs(headers: Record<string, string>, now: number): number | null {
  const raw = headerOf(headers, "retry-after");
  if (raw === null) return null;
  const seconds = Number(raw.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const at = Date.parse(raw);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - now);
}

/** A header by name, whatever case the server sent it in. */
function headerOf(headers: Record<string, string>, name: string): string | null {
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (key.toLowerCase() === name) return value;
  }
  return null;
}

/** The longest this build will wait on one rate limit before answering with it.
 *
 *  A registry that holds this build off for a minute holds it longer than anyone watching a window
 *  and a wait nobody sees the end of is a hang. Past this the limit is the answer. */
export const retryAfterCeilingMs = 5_000;

/** Whether a status is the registry asking to be tried again rather than failing. */
export function isRateLimited(status: number): boolean {
  return status === 429;
}
