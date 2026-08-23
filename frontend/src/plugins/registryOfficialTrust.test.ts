import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { OFFICIAL_REGISTRY_TRUST } from "./registryOfficialTrust";

describe("official registry trust", () => {
  it("matches the public build input exactly", () => {
    const publicTrust = JSON.parse(
      readFileSync(resolve(import.meta.dirname, "../../../build/registry-trust.json"), "utf8"),
    );
    expect(OFFICIAL_REGISTRY_TRUST).toEqual(publicTrust);
  });
});
