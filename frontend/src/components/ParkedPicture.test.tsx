// @vitest-environment jsdom
// A picture stands in for the surface, and it stands where the surface stood.
//
// The surface is composited above the document, so the lighting veil never reached it: an unfocused
// pane read 191 on white — the surface at its declared alpha over the dimmed document. The picture
// is in the document, under that veil, so a parked pane read 127 and the pane visibly darkened the
// moment an overlay opened (measured 2026-09-04).
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ParkedPicture } from "./ParkedPicture";
import { __setParkedPictureForTest, __resetParkedPicturesForTest } from "../lib/parkedPicture";

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  __resetParkedPicturesForTest();
  __setParkedPictureForTest("v-1", "data:image/png;base64,AAAA");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  __resetParkedPicturesForTest();
});

describe("the picture a parked surface leaves", () => {
  // The picture draws above the lighting veil, so the veil is the one dim and the image is drawn at
  // the alpha its surface was declared with. A veil of its own here would apply the amount twice — the
  // pane read 96 on white where the live one read 191 (measured 2026-09-04).
  it("draws the image at the alpha the surface was declared with, and no dim of its own", () => {
    act(() => root.render(<ParkedPicture viewId="v-1" dim={0.5} />));
    const img = host.querySelector<HTMLImageElement>(".parked-picture")!;
    expect(img.style.opacity).toBe("0.5");
    expect(host.querySelector(".parked-picture-veil"), "the veil is the plane's, not the picture's").toBeNull();
  });

  it("draws an opaque image for a pane nothing dims", () => {
    act(() => root.render(<ParkedPicture viewId="v-1" dim={0} />));
    expect(host.querySelector<HTMLImageElement>(".parked-picture")!.style.opacity).toBe("1");
  });

  it("draws nothing when no picture is held", () => {
    __resetParkedPicturesForTest();
    act(() => root.render(<ParkedPicture viewId="v-1" dim={0.5} />));
    expect(host.querySelector(".parked-picture")).toBeNull();
  });
});
