// The window ledger is user intent — it is not split by which host opened the window.
//
// The ledger (`windows`) records the fact "this workspace should be open", and that is a user asset.
// Writing the opening host's name into it makes the window that framework's property — a user who
// turns Tauri off and Electron on loses every window. Switching frameworks is not discarding assets.
//
// So the axis is occupancy, not ownership: if some host currently holds the window with that label,
// do not create it. Occupancy is a runtime fact, so it is not written to the ledger, and it clears
// itself when the process dies — the same model as store ownership (A22).
//
// cored holds the truth of occupancy. `window_census` answers, per label, how many hosts hold it —
// a process that counts only its own windows reads the other host's window as absent and creates the
// same label again.
//
// Measured 2026-08-01: with the same label alive in two processes, the later window drew nothing
// (181 KB against 832 KB for the healthy window). Blocking the overlap brought that window back to 891 KB.
import { describe, it, expect } from "vitest";
import {
  restorableSlots,
  forgetWindow,
  frameworkScopedKey,
  type WindowManifest,
} from "./windowPersistence";

const slot = (label: string) => ({
  label,
  roots: [`/r/${label}`],
  activeRoot: `/r/${label}`,
});

describe("what the window ledger restores", () => {
  it("restores a window no host holds — whichever framework wrote it", () => {
    const m: WindowManifest = { slots: [slot("win-a"), slot("win-b")] };
    expect(restorableSlots(m, new Set()).map((s) => s.label)).toEqual(["win-a", "win-b"]);
  });

  it("does not create a window that is already alive — whichever host holds it", () => {
    // A window held by the other framework is also a live window. Looking only at your own process creates it twice.
    const m: WindowManifest = { slots: [slot("win-a"), slot("win-b")] };
    expect(restorableSlots(m, new Set(["win-a"])).map((s) => s.label)).toEqual(["win-b"]);
  });

  it("main is not restored — boot already created that window", () => {
    const m: WindowManifest = { slots: [slot("main"), slot("win-a")] };
    expect(restorableSlots(m, new Set()).map((s) => s.label)).toEqual(["win-a"]);
  });

  it("occupancy unreadable — restore nothing", () => {
    // Creating without reading occupancy brings the overlap back silently. Not opening recovers on
    // the next boot, but an overlapped window stays on screen drawing nothing — the two failures weigh differently.
    const m: WindowManifest = { slots: [slot("win-a")] };
    expect(restorableSlots(m, null)).toEqual([]);
  });

  it("returns the ledger unchanged — a restore does not rewrite user intent", () => {
    const m: WindowManifest = { slots: [slot("win-a")] };
    expect(restorableSlots(m, new Set())[0]).toEqual(m.slots[0]);
  });
});

// A closed window is removed from the ledger — left in, the next boot restores it.
//
// App exit is different. Exit closes every window but must not clear the ledger (the next run would
// open nothing). So the removal happens on the close command, not on the exit path.
describe("the slot of a closed window", () => {
  it("is removed from the ledger", () => {
    const m: WindowManifest = { slots: [slot("win-a"), slot("win-b")] };
    expect(forgetWindow(m, "win-a").slots.map((s) => s.label)).toEqual(["win-b"]);
  });

  it("that window was the last focused — the record is cleared too", () => {
    const m: WindowManifest = { slots: [slot("win-a")], focusedLabel: "win-a" };
    expect(forgetWindow(m, "win-a").focusedLabel).toBeUndefined();
  });

  it("another window's focus record is left alone", () => {
    const m: WindowManifest = { slots: [slot("win-a"), slot("win-b")], focusedLabel: "win-b" };
    expect(forgetWindow(m, "win-a").focusedLabel).toBe("win-b");
  });

  it("an absent label changes nothing", () => {
    const m: WindowManifest = { slots: [slot("win-a")] };
    expect(forgetWindow(m, "win-zzz")).toEqual(m);
  });
});

// Some values a process must remember only for itself — the position of its own window.
//
// `controlPlaneFrame` is the position and size of the main window. Shared, the control planes of two
// frameworks open stacked at the same spot. Nothing is lost here: each remembers the position of its
// own window, which is not a user asset.
describe("the framework axis of the own-window position key", () => {
  it("the key includes the framework", () => {
    expect(frameworkScopedKey("controlPlaneFrame", "tauri")).toBe("controlPlaneFrame/tauri");
    expect(frameworkScopedKey("controlPlaneFrame", "electron")).toBe("controlPlaneFrame/electron");
  });

  it("framework unknown — the old key stays; no new key is minted under an unknown name", () => {
    expect(frameworkScopedKey("controlPlaneFrame", null)).toBe("controlPlaneFrame");
  });
});
