// A recording announces its end, and reading it does not change it.
//
// A caller had neither. `layout.trace.read` stopped the recording it read, so the answer depended
// on when it was asked and a second read was a different answer; and nothing said when a recording
// finished, so the one caller there is slept 1600ms over a 1500ms recording and hoped. Measured
// 2026-08-18 across the gate suite: that is the shape of every wait that fails one run in six.
//
// What replaces it is the shape the layout journal already had — subscribe, then read, so an end
// that lands between the two is not missed; a finite failure bound rather than a polling interval;
// and an answer for a run that has already ended, so asking twice answers twice.
import { afterEach, describe, expect, it, vi } from "vitest";
import { layoutTrace, startLayoutTrace, stopLayoutTrace, whenLayoutTraceEnds } from "./layoutTrace";

// A window that draws. startLayoutTrace refuses one that records nothing at all, which is right for
// the product and is not what these check.
function drawingWindow(): void {
  let frame = 0;
  vi.stubGlobal("requestAnimationFrame", (run: FrameRequestCallback) => {
    const handle = setTimeout(() => run(performance.now()), 1);
    frame += 1;
    return handle as unknown as number;
  });
  vi.stubGlobal("cancelAnimationFrame", (handle: number) => clearTimeout(handle));
  expect(frame).toBe(0);
}

describe("the end of a recording", () => {
  afterEach(() => {
    stopLayoutTrace();
    vi.unstubAllGlobals();
  });

  it("is announced to whoever is waiting, and says how it ended", async () => {
    drawingWindow();
    const started = await startLayoutTrace(40);
    expect(started.run, "a recording is named so a waiter can name which one").toBeGreaterThan(0);

    const ended = await whenLayoutTraceEnds(started.run, 2000);
    expect(ended, "it ran out its own clock").toBe("elapsed");
  });

  it("answers at once for a recording that has already ended", async () => {
    drawingWindow();
    const started = await startLayoutTrace(30);
    await whenLayoutTraceEnds(started.run, 2000);

    // Asked again, after the fact. A waiter that only ever hears a future announcement hangs here,
    // and a caller cannot tell that from a recording that never ends.
    await expect(whenLayoutTraceEnds(started.run, 2000)).resolves.toBe("elapsed");
  });

  it("says it was cut short rather than leaving the count to be guessed at", async () => {
    drawingWindow();
    const started = await startLayoutTrace(5000);
    const waiting = whenLayoutTraceEnds(started.run, 2000);
    stopLayoutTrace();
    await expect(waiting).resolves.toBe("stopped");
  });

  it("says a recording was replaced by the next one", async () => {
    drawingWindow();
    const first = await startLayoutTrace(5000);
    const waiting = whenLayoutTraceEnds(first.run, 2000);
    const second = await startLayoutTrace(30);
    expect(second.run, "the next recording is a different one").toBe(first.run + 1);
    await expect(waiting).resolves.toBe("replaced");
  });

  it("refuses a recording that never ends rather than waiting forever", async () => {
    drawingWindow();
    const started = await startLayoutTrace(5000);
    await expect(whenLayoutTraceEnds(started.run, 30)).rejects.toThrow(/still running after 30ms/);
  });

  it("reading it twice answers the same thing, and never stops it", async () => {
    drawingWindow();
    await startLayoutTrace(5000);
    const first = layoutTrace();
    expect(first.running, "reading does not end the recording").toBe(true);
    const second = layoutTrace();
    expect(second.running).toBe(true);
    expect(second.run).toBe(first.run);

    stopLayoutTrace();
    const after = layoutTrace();
    const again = layoutTrace();
    expect(again.frames.length, "two reads of a finished recording answer the same").toBe(after.frames.length);
    expect(again.endedBecause).toBe(after.endedBecause);
  });
});
