import { describe, expect, it } from "vitest";
import {
  CONTRACT_ID_RE,
  parseManifest,
  SPEC_VERSION,
} from "../src/spec";

const PROVIDER = { id: "soksak-spec-plugin-fixture-tasks", version: "0.0.1" };
const REQUIREMENT = {
  id: "soksak-spec-plugin-fixture-tasks",
  range: ">=0.0.1 <1.0.0",
};

function base(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    spec: SPEC_VERSION,
    id: "demo",
    name: "Demo",
    version: "0.0.1",
    description: "contract fixture",
    permissions: [],
    ...overrides,
  };
}

function errorsOf(raw: unknown): string[] {
  return parseManifest(raw, "demo").validation.errors;
}

describe("domain contract references", () => {
  it("keeps the base id independent from provider versions", () => {
    expect(CONTRACT_ID_RE.test(PROVIDER.id)).toBe(true);
    expect(CONTRACT_ID_RE.test(`${PROVIDER.id}@${PROVIDER.version}`)).toBe(false);
  });

  it("accepts exact provider declarations and ranged consumer declarations", () => {
    const { manifest, validation } = parseManifest(base({
      implements: [PROVIDER],
      consumes: [REQUIREMENT],
    }), "demo");
    expect(validation).toEqual({ ok: true, errors: [], warnings: [] });
    expect(manifest?.implements).toEqual([PROVIDER]);
    expect(manifest?.consumes).toEqual([REQUIREMENT]);
  });

  it("does not accept a name@version string in either direction", () => {
    expect(errorsOf(base({ implements: [`${PROVIDER.id}@0.0.1`] }))).not.toEqual([]);
    expect(errorsOf(base({ consumes: [`${PROVIDER.id}@0.0.1`] }))).not.toEqual([]);
  });

  it("requires provider version and consumer range with no shadow fields", () => {
    for (const implementsValue of [
      [{ id: PROVIDER.id }],
      [{ ...PROVIDER, range: "*" }],
      [{ ...PROVIDER, version: "0.0" }],
    ]) {
      expect(errorsOf(base({ implements: implementsValue }))).not.toEqual([]);
    }
    for (const consumesValue of [
      [{ id: REQUIREMENT.id }],
      [{ ...REQUIREMENT, version: "0.0.1" }],
      [{ ...REQUIREMENT, range: "latest" }],
    ]) {
      expect(errorsOf(base({ consumes: consumesValue }))).not.toEqual([]);
    }
  });

  it("rejects duplicate provider ids and duplicate consumer ids", () => {
    expect(errorsOf(base({ implements: [PROVIDER, { ...PROVIDER }] })).some((e) => e.includes("duplicate"))).toBe(true);
    expect(errorsOf(base({ consumes: [REQUIREMENT, { ...REQUIREMENT }] })).some((e) => e.includes("duplicate"))).toBe(true);
  });
});

describe("programs.viewContract", () => {
  function withProgram(viewContract: unknown): Record<string, unknown> {
    return base({
      permissions: ["programs", "commands"],
      contributes: {
        commands: [{ name: "run", title: "Run" }],
        programs: [{ id: "agent", title: "Agent", kind: "view", view: "content", viewContract }],
      },
    });
  }

  it("is a ranged consumer declaration", () => {
    const { manifest, validation } = parseManifest(withProgram(REQUIREMENT), "demo");
    expect(validation.ok).toBe(true);
    expect(manifest?.contributes.programs[0].viewContract).toEqual(REQUIREMENT);
  });

  it("rejects exact name@version and provider-shaped objects", () => {
    expect(errorsOf(withProgram(`${REQUIREMENT.id}@0.0.1`))).not.toEqual([]);
    expect(errorsOf(withProgram(PROVIDER))).not.toEqual([]);
  });
});
