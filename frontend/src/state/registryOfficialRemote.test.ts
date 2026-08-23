import { describe, expect, it } from "vitest";
import { OFFICIAL_REGISTRY_DESCRIPTOR, registryRequestHeaders } from "./registry";

describe("official registry transport", () => {
  it("uses the immutable Registry release asset", () => {
    expect(OFFICIAL_REGISTRY_DESCRIPTOR.indexUrl).toBe(
      "https://github.com/soksak-ai/soksak-plugin-registry/releases/latest/download/registry.json",
    );
    expect(registryRequestHeaders(OFFICIAL_REGISTRY_DESCRIPTOR)).toEqual({
      accept: "application/json",
    });
  });
});
