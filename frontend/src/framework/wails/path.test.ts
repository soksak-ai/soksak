import { describe, expect, it, vi } from "vitest";

const invokeCommand = vi.hoisted(() => vi.fn());
vi.mock("./invoke", () => ({ invokeCommand }));

import { wailsFramework } from "./index";

describe("Wails path contract", () => {
  it("reads the resolved runtime directory from the public application environment", async () => {
    invokeCommand.mockResolvedValue({ runtime: "/runtime/com.soksak.capture" });

    await expect(wailsFramework.path.tempDir()).resolves.toBe("/runtime/com.soksak.capture");
    expect(invokeCommand).toHaveBeenCalledWith("app_environment");
  });
});
