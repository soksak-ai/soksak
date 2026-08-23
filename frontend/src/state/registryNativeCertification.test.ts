import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("registry certification ownership", () => {
  it("uses the native verifier instead of WebKit WebCrypto", () => {
    const source = readFileSync(resolve(process.cwd(), "src/state/registry.ts"), "utf8");
    expect(source).toContain('"registry_certify"');
    expect(source).toContain("parseSignedRegistryIndex");
    expect(source).not.toContain("certifyRegistryIndex(");
  });
});
