import { describe, expect, it } from "vitest";
import { OFFICIAL_REGISTRY_DESCRIPTOR, registryRequestHeaders } from "./registry";

describe("official registry transport", () => {
  it("uses the GitHub contents endpoint instead of the mutable raw cache URL", () => {
    expect(OFFICIAL_REGISTRY_DESCRIPTOR.indexUrl).toBe(
      "https://api.github.com/repos/soksak-ai/soksak-plugin-registry/contents/registry-signed.json",
    );
    expect(registryRequestHeaders(OFFICIAL_REGISTRY_DESCRIPTOR)).toEqual({
      accept: "application/vnd.github.raw+json",
    });
  });
});
