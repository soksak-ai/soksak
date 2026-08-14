/**
 * Name of the clock the presentation ledger uses — the name means "anchor once to unix, then
 * advance only on the monotonic presentation clock". It does not jump on OS time correction and
 * does not advance during system sleep.
 *
 * The producer of an observation declares the name and owner; the judging side reads them. Two
 * processes can use the same conversion rule and name and still have different origins, so
 * comparing two timestamps on one axis requires both name and owner to match.
 */
export const PRESENTATION_CLOCK = "unix-anchored-monotonic";
/** This process owns renderer/control-plane timestamps. Clock name alone is not an origin identity. */
export const PRESENTATION_CLOCK_OWNER = "core-renderer";

let unixOriginUs: number | null = null;

/**
 * Origin of the presentation epoch — anchored once per process.
 *
 * `performance.timeOrigin` is not a constant. WebKit recomputes it from the current wall clock on
 * every read (MonotonicTime::approximateWallTime), so an OS time correction during a run lands
 * directly in this value. Re-reading it each time makes this clock follow the wall clock instead
 * of staying monotonic, and it diverges from the native presentation clock anchored to uptime —
 * that difference then measures clock skew, not a defect.
 *
 * So the origin is anchored once on the first call and only the document monotonic clock is added
 * afterwards.
 */
function anchoredOriginMs(documentTimeMs: () => number): number {
  if (unixOriginUs === null) {
    const declaredOrigin = performance.timeOrigin;
    const originMs = Number.isFinite(declaredOrigin)
      ? declaredOrigin
      : Date.now() - documentTimeMs();
    unixOriginUs = Math.round(originMs * 1_000);
  }
  return unixOriginUs / 1_000;
}

function anchoredOriginUs(documentTimeMs: () => number): number {
  anchoredOriginMs(documentTimeMs);
  return unixOriginUs!;
}

function safeUnixUs(value: number): number {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`safe integer Unix microseconds required: ${String(value)}`);
  }
  return value;
}

/**
 * The monotonic Unix epoch shared by DOM layout and native presentation.
 */
export function presentationNowUnixMs(): number {
  const now = performance.now();
  return anchoredOriginMs(() => now) + now;
}

export function presentationNowUnixUs(): number {
  const now = performance.now();
  return safeUnixUs(anchoredOriginUs(() => now) + Math.round(now * 1_000));
}

/**
 * Convert one document monotonic clock timestamp to the same Unix epoch notation.
 *
 * A frame callback passes a timestamp on the `performance.now()` axis. Putting it in the ledger
 * requires the **same axis** as the current time — skipping this conversion and mixing in
 * Date.now() makes the presentation epoch and the observation epoch values of different clocks,
 * and the difference then measures clock skew, not a defect.
 */
export function presentationUnixMsFromDocumentTime(documentTimeMs: number): number {
  return anchoredOriginMs(() => performance.now()) + documentTimeMs;
}

/**
 * Convert the shared Unix presentation epoch to this document's monotonic timeline coordinate.
 *
 * When a layout transaction hands a native producer's absolute epoch to CSS/Web Animations, it
 * must use the same anchored origin as `presentationNowUnixMs`. Re-reading WebKit's
 * `performance.timeOrigin` splits the DOM and native presentation start by the wall-clock
 * correction applied during the run.
 */
export function presentationDocumentTimeFromUnixMs(unixMs: number): number {
  return unixMs - anchoredOriginMs(() => performance.now());
}

/** Safe-integer Unix microseconds are subtracted before conversion to document milliseconds. */
export function presentationDocumentTimeFromUnixUs(unixUs: number): number {
  return (safeUnixUs(unixUs) - anchoredOriginUs(() => performance.now())) / 1_000;
}

/**
 * Convert the wall epoch a native display callback recorded with that transaction to the current
 * document timeline. The long-lived monotonic ledger is for ordering inside the producer; an
 * independent process's origin is never reused in the renderer.
 */
export function presentationDocumentTimeFromWallBridgeUnixUs(unixUs: number): number {
  // This bridge's wall epoch is a wall fact from the same instant as the transaction callback, not
  // the long-lived document origin. WebKit's timeOrigin can keep the old mapping even after a
  // system wall correction, so subtracting it again arms the DOM animation seconds into the
  // future. Read the wall↔document pair once at the moment the arm event arrives, then add only
  // the remaining wall delta up to the candidate onto the document axis.
  const wallNowUs = Math.round(Date.now() * 1_000);
  const documentNowMs = performance.now();
  if (!Number.isFinite(documentNowMs)) {
    throw new Error(`finite document time required: ${String(documentNowMs)}`);
  }
  return documentNowMs + (safeUnixUs(unixUs) - wallNowUs) / 1_000;
}

export function __resetPresentationClockForTest(): void {
  unixOriginUs = null;
}
