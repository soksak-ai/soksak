import { describe, expect, it } from "vitest";
import { parseRegistryPayload } from "./index";

const registry = () => ({ id: "official", sequence: 1, plugins: [], sidecars: [], kits: [], contracts: [], specs: [] });

describe("the direct registry index", () => {
  it("accepts all five direct release arrays", () => {
    expect(parseRegistryPayload(registry())).toMatchObject({ ok: true });
  });
  it("rejects schema discriminators and install profiles", () => {
    expect(parseRegistryPayload({ ...registry(), spec: "soksak-spec-registry@0.0.1" }).ok).toBe(false);
    expect(parseRegistryPayload({ ...registry(), profiles: [] }).ok).toBe(false);
  });
});
