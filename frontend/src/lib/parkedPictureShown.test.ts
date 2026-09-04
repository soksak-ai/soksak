// The report and the wait are two async paths, and either can be first.
//
// A surface is taken off only after the document has drawn the picture that stands in for it. If a
// wait that arrives after the report never ended, the surface would stay up and the overlay would
// stay under it — worse than the frame this ordering exists to remove.
import { beforeEach, describe, expect, it } from "vitest";
import {
  __resetParkedPicturesForTest,
  __setParkedPictureForTest,
  markParkedPictureShown,
  releaseParkedPicture,
  whenParkedPictureShown,
} from "./parkedPicture";

describe("waiting for a parked picture to be on screen", () => {
  beforeEach(() => __resetParkedPicturesForTest());

  it("ends when the report arrives after the wait", async () => {
    let ended = false;
    const waited = whenParkedPictureShown("v-1").then(() => { ended = true; });
    expect(ended).toBe(false);
    markParkedPictureShown("v-1");
    await waited;
    expect(ended).toBe(true);
  });

  it("ends at once when the report arrived first", async () => {
    markParkedPictureShown("v-1");
    await whenParkedPictureShown("v-1");
  });

  it("waits again after the picture is released", async () => {
    __setParkedPictureForTest("v-1", "data:image/png;base64,AAAA");
    markParkedPictureShown("v-1");
    releaseParkedPicture("v-1");
    let ended = false;
    void whenParkedPictureShown("v-1").then(() => { ended = true; });
    await Promise.resolve();
    expect(ended, "a released picture is not on screen").toBe(false);
  });
});
