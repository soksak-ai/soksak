import { describe, expect, it } from "vitest";
import { parseRegistry } from "./index";

const registry = () => ({ id: "official", sequence: 1, issuedAt: "2026-08-24T00:00:00Z", expiresAt: "2026-09-24T00:00:00Z", plugins: [], signature: { algorithm: "ed25519", keyId: "fixture", value: btoa(String.fromCharCode(...new Uint8Array(64))) } });

describe("the authenticated plugin registry", () => {
  it("accepts plugins without independent component arrays", () => {
    expect(parseRegistry(registry())).toMatchObject({ ok: true });
  });
  it("rejects schema discriminators and install profiles", () => {
    expect(parseRegistry({ ...registry(), spec: "soksak-spec-registry@0.0.1" }).ok).toBe(false);
    expect(parseRegistry({ ...registry(), profiles: [] }).ok).toBe(false);
  });
});
