import { describe, expect, it, vi } from "vitest";

import { createTerminalMountScheduler, isRenderableTerminalHost } from "./terminalMount";

describe("terminal view mount lifecycle", () => {
  it("defers xterm sizing until the connected host has layout", () => {
    const frames: FrameRequestCallback[] = [];
    const task = vi.fn();
    const scheduler = createTerminalMountScheduler((callback) => {
      frames.push(callback);
      return frames.length;
    });

    scheduler.afterPaint(task);
    expect(task).not.toHaveBeenCalled();
    frames[0](16);
    expect(task).toHaveBeenCalledOnce();

    expect(isRenderableTerminalHost({ isConnected: true, clientWidth: 640, clientHeight: 480 })).toBe(true);
    expect(isRenderableTerminalHost({ isConnected: false, clientWidth: 640, clientHeight: 480 })).toBe(false);
    expect(isRenderableTerminalHost({ isConnected: true, clientWidth: 0, clientHeight: 480 })).toBe(false);
  });

  it("does not run a queued sizing task after disposal", () => {
    const frames: FrameRequestCallback[] = [];
    const task = vi.fn();
    const scheduler = createTerminalMountScheduler((callback) => {
      frames.push(callback);
      return frames.length;
    });

    scheduler.afterPaint(task);
    scheduler.dispose();
    frames[0](16);
    expect(task).not.toHaveBeenCalled();
  });
});
