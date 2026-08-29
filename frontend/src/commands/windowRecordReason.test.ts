// @vitest-environment jsdom
// A recording that stopped short names the reason.
//
// Measured 2026-08-16 on the running application: window.record with
// frameTimeoutMs=1 answered ok:true, frames:0, and nothing else. No directory
// was created and no reason was given, so a deadline every frame missed read
// exactly like a window with nothing to capture.
//
// The host already answers the reason — RecordReport.Stopped in
// frameworks/wails/capture_record.go names the frame and what stopped it. It
// was dropped at this layer, which took the frame count off the report and
// discarded the rest.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { invoke } from "../framework";

const { recordWindowFrames } = vi.hoisted(() => ({ recordWindowFrames: vi.fn() }));

vi.mock("../framework", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../framework")>()),
  invoke: vi.fn(),
  currentWindow: vi.fn(),
  windowByLabel: vi.fn(),
}));
vi.mock("../lib/webviewLabels", () => ({
  browserLabelPrefix: (label: string) => ["b", label, ""].join("-"),
  currentWindowLabel: () => "main",
}));
vi.mock("../state/windowBoot", () => ({ forgetWindowSlot: vi.fn() }));
vi.mock("./windowRecorder", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./windowRecorder")>()),
  recordWindowFrames,
}));
vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0));

import { registerCaptureCatalog } from "./catalogCapture";
import { execute, unregister } from "./registry";

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  registerCaptureCatalog();
});

afterEach(() => {
  for (const name of CAPTURE_COMMANDS) unregister(name);
});

// Every name registerCaptureCatalog puts on the table. Registering twice throws
// by name, so the table is left as it was found.
const CAPTURE_COMMANDS = [
  "window.snapshot",
  "window.pixels",
  "window.record",
  "capture.calibration",
  "capture.motion-anchors",
];

it("carries the host's reason when fewer frames landed than were asked for", async () => {
  recordWindowFrames.mockReturnValueOnce(Object.assign(Promise.resolve(0), {
    ready: Promise.resolve(),
    stopped: Promise.resolve("frame 0 could not be captured: the frame did not arrive within 1ms"),
  }));

  const result = await execute("window.record", { dir: "/evidence/deadline", frames: 3, intervalMs: 0 }, {});

  expect(result).toMatchObject({ ok: true });
  const data = (result as { data: Record<string, unknown> }).data;
  expect(data.frames).toBe(0);
  expect(String(data.stopped)).toContain("did not arrive");
});

it("says nothing about stopping when every frame landed", async () => {
  recordWindowFrames.mockReturnValueOnce(Object.assign(Promise.resolve(3), {
    ready: Promise.resolve(),
    stopped: Promise.resolve(undefined),
  }));

  const result = await execute("window.record", { dir: "/evidence/complete", frames: 3, intervalMs: 0 }, {});
  const data = (result as { data: Record<string, unknown> }).data;

  expect(data.frames).toBe(3);
  // Absent, not empty. A reason field that is always present makes a reader
  // check its contents to learn whether anything went wrong.
  expect(data.stopped).toBeUndefined();
});
