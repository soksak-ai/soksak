// @vitest-environment jsdom
import { expect, it, vi } from "vitest";

const { captureWindowPixels, invoke, stream } = vi.hoisted(() => ({
  captureWindowPixels: vi.fn(async () => ({
    png: "YWJj",
    note: { documentOnly: false, nativeComposed: true, surfaces: 1, drawn: 1 },
  })),
  invoke: vi.fn(async (command: string, args?: Record<string, unknown>) => command === "window_record"
    ? { frames: args?.frames }
    : { path: args?.path, bytes: 3 }),
  stream: { onmessage: (_frame: number) => {}, close: vi.fn() },
}));

vi.mock("./windowCapture", () => ({ captureWindowPixels }));
vi.mock("../framework", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../framework")>()),
  invoke,
  createStream: vi.fn(() => stream),
  frameworkPath: {
    join: vi.fn(async (...parts: string[]) => parts.join("/")),
    tempDir: vi.fn(),
  },
}));

import { recordWindowFrames } from "./windowRecorder";

it("records every capture-only frame through native surface composition", async () => {
  const recording = recordWindowFrames({
    dir: "/evidence/composed",
    frames: 2,
    intervalMs: 0,
  });
  stream.onmessage(0);
  await recording.ready;
  await expect(recording).resolves.toBe(2);

  expect(captureWindowPixels).toHaveBeenCalledTimes(2);
  expect(invoke).not.toHaveBeenCalledWith("window_record", expect.anything());
  expect(invoke).toHaveBeenCalledWith("write_file_base64", {
    path: "/evidence/composed/f0000.png",
    base64: "YWJj",
  });
  expect(invoke).toHaveBeenCalledWith("write_file_base64", {
    path: "/evidence/composed/f0001.png",
    base64: "YWJj",
  });
});
