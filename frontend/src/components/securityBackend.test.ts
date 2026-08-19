import { describe, expect, it } from "vitest";

import { securityLimitKey } from "./securityBackend";

describe("securityLimitKey", () => {
  it.each([
    ["keychain", "settings.security.limits.macos"],
    ["wincred", "settings.security.limits.windows"],
    ["libsecret", "settings.security.limits.linux"],
    ["none", "settings.security.limits.unavailable"],
    ["e2e", "settings.security.limits.test"],
  ] as const)("selects only the %s backend notice", (backend, key) => {
    expect(securityLimitKey(backend)).toBe(key);
  });

  it("does not guess the operating system for an unknown backend", () => {
    expect(securityLimitKey("future-store")).toBe("settings.security.limits.unknown");
  });
});
