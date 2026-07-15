import { readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import { parseConformanceReport } from "../src/conformanceWire.js";
import { parseRegistryPublicKey, parseSignedRegistryIndex } from "../src/registry.js";
import { parseReleaseManifest } from "../src/release.js";
import { MAX_SEMVER_LENGTH } from "../src/semver.js";

const PACKAGE_ROOT = join(import.meta.dirname, "..");
const FIXTURES = join(PACKAGE_ROOT, "test/fixtures/platform-wire");
const SCHEMAS = join(PACKAGE_ROOT, "schema");

function json(path: string): any {
  return JSON.parse(readFileSync(path, "utf8"));
}

describe("portable platform wire artifacts", () => {
  it("publishes strict draft-2020-12 schemas for every public JSON boundary", () => {
    const release = json(join(SCHEMAS, "unit-release.schema.json"));
    const conformance = json(join(SCHEMAS, "conformance-report.schema.json"));
    const registry = json(join(SCHEMAS, "registry-index.schema.json"));
    const registryPublicKey = json(join(SCHEMAS, "registry-public-key.schema.json"));

    for (const schema of [release, conformance, registry, registryPublicKey]) {
      expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
      expect(schema.additionalProperties).toBe(false);
    }
    expect(release.properties.spec.const).toBe("soksak-spec-release@0.0.1");
    expect(conformance.properties.spec.const).toBe("soksak-spec-conformance@0.0.1");
    expect(registry.properties.spec.const).toBe("soksak-spec-registry@0.0.1");
    expect(registryPublicKey.properties.algorithm.const).toBe("ed25519");
    expect(release.$id).toBe("urn:soksak:spec:release:0.0.1");
    expect(conformance.$id).toBe("urn:soksak:spec:conformance:0.0.1");
    expect(registry.$id).toBe("urn:soksak:spec:registry:0.0.1");
    expect(registryPublicKey.$id).toBe("urn:soksak:spec:registry-public-key:0.0.1");

    for (const schema of [release, conformance, registry]) {
      expect(schema.$defs.semver.maxLength).toBe(MAX_SEMVER_LENGTH);
    }

    const indexedUnit = registry.$defs.unit;
    expect(Object.keys(indexedUnit.properties).sort()).toEqual([
      "id",
      "kind",
      "manifest",
      "reports",
      "version",
    ]);
    for (const forbidden of ["artifacts", "dependencies", "docs", "name", "source"]) {
      expect(indexedUnit.properties).not.toHaveProperty(forbidden);
    }
  });

  it("keeps the checked-in language-neutral corpus accepted by the executable parsers", () => {
    for (const kind of ["kit", "plugin", "sidecar"]) {
      expect(parseReleaseManifest(json(join(FIXTURES, `release-${kind}.json`))).ok, kind).toBe(true);
    }
    for (const name of [
      "conformance-kit-kind.json",
      "conformance-kit-release.json",
      "conformance-plugin-kind.json",
      "conformance-plugin-release.json",
      "conformance-sidecar-interface.json",
      "conformance-sidecar-kind.json",
      "conformance-sidecar-release.json",
    ]) {
      expect(parseConformanceReport(json(join(FIXTURES, name))).ok, name).toBe(true);
    }
    expect(parseSignedRegistryIndex(json(join(FIXTURES, "registry-signed.json"))).ok).toBe(true);
    expect(parseRegistryPublicKey(json(join(FIXTURES, "registry-public-key.json"))).ok).toBe(true);
  });

  it("compiles every schema and accepts the same valid cross-language corpus", () => {
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    addFormats(ajv);
    const validators = {
      release: ajv.compile(json(join(SCHEMAS, "unit-release.schema.json"))),
      conformance: ajv.compile(json(join(SCHEMAS, "conformance-report.schema.json"))),
      registry: ajv.compile(json(join(SCHEMAS, "registry-index.schema.json"))),
      publicKey: ajv.compile(json(join(SCHEMAS, "registry-public-key.schema.json"))),
    };

    for (const kind of ["kit", "plugin", "sidecar"]) {
      const valid = validators.release(json(join(FIXTURES, `release-${kind}.json`)));
      expect(valid, JSON.stringify(validators.release.errors)).toBe(true);
    }
    for (const name of [
      "conformance-kit-kind.json",
      "conformance-kit-release.json",
      "conformance-plugin-kind.json",
      "conformance-plugin-release.json",
      "conformance-sidecar-interface.json",
      "conformance-sidecar-kind.json",
      "conformance-sidecar-release.json",
    ]) {
      const valid = validators.conformance(json(join(FIXTURES, name)));
      expect(valid, `${name}: ${JSON.stringify(validators.conformance.errors)}`).toBe(true);
    }
    expect(
      validators.registry(json(join(FIXTURES, "registry-signed.json")),),
      JSON.stringify(validators.registry.errors),
    ).toBe(true);
    expect(
      validators.publicKey(json(join(FIXTURES, "registry-public-key.json"))),
      JSON.stringify(validators.publicKey.errors),
    ).toBe(true);
  });

  it("rejects entrypoint paths that the portable archive extractor cannot create", () => {
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    addFormats(ajv);
    const validate = ajv.compile(json(join(SCHEMAS, "unit-release.schema.json")));
    for (const path of [
      "한글/plugin.json",
      "safe:name/plugin.json",
      "CON/plugin.json",
      `a${"b".repeat(512)}`,
    ]) {
      const release = json(join(FIXTURES, "release-plugin.json"));
      release.artifacts[0].entrypoint.manifest = path;
      expect(validate(release), `${path}: ${JSON.stringify(validate.errors)}`).toBe(false);
    }
  });
});
