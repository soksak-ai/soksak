import { describe, expect, it } from "vitest";

import { isRateLimited, retryAfterMs } from "./registryRetryAfter";

describe("what a registry means by 429", () => {
  it("reads whole seconds", () => {
    expect(retryAfterMs({ "Retry-After": "2" }, 0)).toBe(2000);
    expect(retryAfterMs({ "retry-after": "0" }, 0)).toBe(0);
  });

  it("reads an HTTP date against the clock it is given", () => {
    const now = Date.parse("2026-08-18T00:00:00Z");
    expect(retryAfterMs({ "Retry-After": "Tue, 18 Aug 2026 00:00:03 GMT" }, now)).toBe(3000);
  });

  // A date already past is not a negative wait.
  it("never asks for a wait in the past", () => {
    const now = Date.parse("2026-08-18T00:00:10Z");
    expect(retryAfterMs({ "Retry-After": "Tue, 18 Aug 2026 00:00:03 GMT" }, now)).toBe(0);
  });

  it("answers nothing when the registry asked for nothing", () => {
    expect(retryAfterMs({}, 0)).toBeNull();
    expect(retryAfterMs({ "Retry-After": "soon" }, 0)).toBeNull();
  });

  it("names the one status that is a limit rather than a fault", () => {
    expect(isRateLimited(429)).toBe(true);
    expect(isRateLimited(500)).toBe(false);
    expect(isRateLimited(404)).toBe(false);
  });
});
