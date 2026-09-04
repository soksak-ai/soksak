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
  // The picture is what the surface painted, and the surface paints its own dim (surface.dim). So
  // it is drawn as it was taken: an opacity of its own would apply the amount a second time — the
  // pane darkened by 9 across the window the moment it parked (measured 2026-09-04).
  it("draws the picture as it was taken", () => {
    act(() => root.render(<ParkedPicture viewId="v-1" style={{}} />));
    const img = host.querySelector<HTMLImageElement>(".parked-picture")!;
    expect(img.style.opacity).toBe("");
    expect(host.querySelector(".parked-picture-veil"), "the surface's dim is in the picture").toBeNull();
  });

  it("draws nothing when no picture is held", () => {
    __resetParkedPicturesForTest();
    act(() => root.render(<ParkedPicture viewId="v-1" style={{}} />));
    expect(host.querySelector(".parked-picture")).toBeNull();
  });
});
