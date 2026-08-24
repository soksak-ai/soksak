// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { scopedStorage } from "./scopedStorage";

describe("identity-scoped synchronous cache", () => {
  it("keeps two application identities disjoint on one origin", () => {
    localStorage.clear();
    const first = scopedStorage(localStorage, "com.soksak.gate.first");
    const second = scopedStorage(localStorage, "com.soksak.gate.second");
    first.setItem("soksak.windows", "first");
    second.setItem("soksak.windows", "second");
    expect(first.getItem("soksak.windows")).toBe("first");
    expect(second.getItem("soksak.windows")).toBe("second");
    first.clear();
    expect(second.getItem("soksak.windows")).toBe("second");
  });
});
