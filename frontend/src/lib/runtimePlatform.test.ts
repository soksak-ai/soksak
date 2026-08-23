import { describe, expect, it } from "vitest";

import { detectPlatform } from "./runtimePlatform";

describe("runtime platform identity", () => {
  it("maps the three product platforms from browser facts", () => {
    expect(detectPlatform("MacIntel", "")).toBe("darwin");
    expect(detectPlatform("Win32", "")).toBe("win32");
    expect(detectPlatform("Linux x86_64", "")).toBe("linux");
  });

  it("uses the user agent when navigator.platform is empty", () => {
    expect(detectPlatform("", "Mozilla/5.0 (Macintosh)")).toBe("darwin");
  });
});
