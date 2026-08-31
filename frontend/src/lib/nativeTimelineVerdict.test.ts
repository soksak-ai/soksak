import { describe, expect, it } from "vitest";
import { nativeTimelineVerdict } from "./nativeTimelineVerdict";

const frame = (atUnixMs: number, x: number) => ({
  atUnixMs, drawn: true,
  surfaces: [{ id: "browser", visible: true, dom: { x, y: 20, w: 100, h: 80 } }],
});
const applied = (appliedAtUnixMs: number, x: number) => ({
  appliedAtUnixMs,
  surfaces: [{ id: "browser", appliedVisible: true, applied: { x, y: 20, w: 100, h: 80 } }],
});

describe("DOM frames joined to compositor-owned native Apply time", () => {
  it("uses the newest native sample no later than each frame, never bridge response order", () => {
    const verdict = nativeTimelineVerdict(
      [frame(100, 0), frame(116, 10), frame(132, 20)],
      [applied(90, 0), applied(110, 10), applied(128, 20)],
    );
    expect(verdict).toMatchObject({ comparedFrames: 3, unmatchedFrames: 0, wrongFrames: 0, worstOff: 0 });
    expect(verdict.maxAppliedAgeMs).toBe(10);
  });

  it("reports the magnitude and continuous duration of a native surface left behind", () => {
    const verdict = nativeTimelineVerdict(
      [frame(100, 0), frame(116, 20), frame(132, 40), frame(148, 40)],
      [applied(90, 0), applied(140, 40)],
    );
    expect(verdict.worstOff).toBe(40);
    expect(verdict.wrongFrames).toBe(2);
    expect(verdict.longestWrongMs).toBe(16);
  });

  it("rejects a moved host whose browser viewport remains at the previous drag width", () => {
    const verdict = nativeTimelineVerdict(
      [{
        atUnixMs: 116,
        drawn: true,
        surfaces: [{
          id: "browser",
          visible: true,
          dom: { x: 0, y: 20, w: 160, h: 80 },
        }],
      }],
      [{
        appliedAtUnixMs: 110,
        surfaces: [{
          id: "browser",
          appliedVisible: true,
          // The clipping host followed the pane, so this alone looks correct.
          applied: { x: 0, y: 20, w: 160, h: 80 },
          // WKWebView is what displays the page; it is still at the pre-drag width.
          settled: { x: 0, y: 20, w: 100, h: 80 },
        }],
      }],
    );
    expect(verdict).toMatchObject({ wrongFrames: 1, worstOff: 60 });
  });

  it("does not call an unobserved native instant correct", () => {
    const verdict = nativeTimelineVerdict([frame(100, 0)], []);
    expect(verdict).toMatchObject({ comparedFrames: 0, unmatchedFrames: 1 });
  });
});
