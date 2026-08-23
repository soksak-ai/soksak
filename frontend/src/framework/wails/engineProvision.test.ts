import { describe, expect, it } from "vitest";

import { wailsEngineProvision } from "./engineProvision";

describe("Wails native engine provision", () => {
  it("advertises a child webview only where the native driver exists", () => {
    expect(wailsEngineProvision("darwin").nativeChildWebview).toBe(true);
    expect(wailsEngineProvision("linux").nativeChildWebview).toBe(false);
    expect(wailsEngineProvision("win32").nativeChildWebview).toBe(false);
  });
});
