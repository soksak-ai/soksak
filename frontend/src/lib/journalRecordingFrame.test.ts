// A journal record holds the frame a recording was on.
//
// `window.record` numbers the files it writes, and the plan names that number as the clock every
// journal shares: a record and the picture of the moment it describes are meant to line up. They
// did not — the numbers stood on one side, the pictures on the other, and nothing joined them.
//
// The join is one value for the window. The command that starts a recording has no layout record
// in scope, and a record opens deep inside a state write with no recording in scope; threading a
// parameter between them would put the recorder in the signature of everything that changes a
// layout.
import { beforeEach, describe, expect, it } from "vitest";
import { noteRecordingFrame, recordingFrame } from "./layoutTransitionJournal";

describe("the frame a record was opened on", () => {
  beforeEach(() => {
    noteRecordingFrame(null);
  });

  it("is absent when nothing is recording", () => {
    expect(recordingFrame(), "no recording is not frame zero").toBeNull();
  });

  it("is what the recorder announced last", () => {
    noteRecordingFrame(0);
    expect(recordingFrame()).toBe(0);
    noteRecordingFrame(7);
    expect(recordingFrame()).toBe(7);
  });

  it("is cleared when the recording ends", () => {
    // A record opened after the burst would otherwise carry its last frame — a number pointing at a
    // picture of an earlier moment, which is worse than no number because it looks like one.
    noteRecordingFrame(11);
    noteRecordingFrame(null);
    expect(recordingFrame()).toBeNull();
  });
});
