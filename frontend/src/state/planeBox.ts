// The box every space's pane plane is laid out in: the content area's inner rectangle in px and
// the corridor the theme declares. One value for the window — every space of every workspace
// draws in the same content area, so a space that has never been on screen is laid out in the
// same box as the one that is.
//
// The host measures it (ResizeObserver on the content area) and a layout operation from a command
// reads it here, so a split asked for over the socket keeps the same floor a drag does.

import { create } from "zustand";
import type { PlaneBox } from "./panePlane";

interface PlaneBoxStore extends PlaneBox {
  set: (box: PlaneBox) => void;
}

export const usePlaneBox = create<PlaneBoxStore>((set) => ({
  // Before the first measurement: the size the library normalises to, and no corridor.
  width: 0,
  height: 0,
  gap: 0,
  set: (box) => set((s) =>
    s.width === box.width && s.height === box.height && s.gap === box.gap ? s : box),
}));

export const planeBox = (): PlaneBox => {
  const { width, height, gap } = usePlaneBox.getState();
  return { width, height, gap };
};

export const setPlaneBox = (box: PlaneBox): void => usePlaneBox.getState().set(box);
