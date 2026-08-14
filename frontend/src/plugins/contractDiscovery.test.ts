import { describe, expect, it } from "vitest";
import type { ContractProviderRef, ContractRequirement, PluginManifest } from "./spec";
import {
  allContracts,
  contractsOf,
  implementersOf,
  manifestImplements,
  type ImplementsNode,
} from "./contractDiscovery";

const NOTES_001: ContractProviderRef = { id: "soksak-spec-plugin-fixture-notes", version: "0.0.1" };
const NOTES_002: ContractProviderRef = { id: "soksak-spec-plugin-fixture-notes", version: "0.0.2" };
const BOARD_001: ContractProviderRef = { id: "soksak-spec-plugin-fixture-board", version: "0.0.1" };
const NOTES_COMPAT: ContractRequirement = { id: NOTES_001.id, range: ">=0.0.1 <1.0.0" };

const nodes: ImplementsNode[] = [
  { id: "soksak-plugin-fixture-alpha", implements: [NOTES_001] },
  { id: "soksak-plugin-fixture-beta", implements: [NOTES_002, BOARD_001] },
  { id: "soksak-plugin-fixture-gamma", implements: [] },
];

describe("implementersOf — range-aware discovery", () => {
  it("finds every provider satisfying the consumer range", () => {
    expect(implementersOf(NOTES_COMPAT, nodes)).toEqual([
      "soksak-plugin-fixture-alpha",
      "soksak-plugin-fixture-beta",
    ]);
  });

  it("does not discover by exact name@version string", () => {
    expect(implementersOf({ id: NOTES_001.id, range: "=0.0.2" }, nodes)).toEqual([
      "soksak-plugin-fixture-beta",
    ]);
    expect(implementersOf({ id: NOTES_001.id, range: ">=0.0.3 <1.0.0" }, nodes)).toEqual([]);
  });

  it("never lets a same-version provider of another base id answer", () => {
    expect(implementersOf({ id: BOARD_001.id, range: "=0.0.1" }, nodes)).toEqual([
      "soksak-plugin-fixture-beta",
    ]);
  });
});

describe("provider inventory", () => {
  it("keeps exact provider evidence while grouping discovery by base id", () => {
    expect(contractsOf("soksak-plugin-fixture-beta", nodes)).toEqual([NOTES_002, BOARD_001]);
    expect(allContracts(nodes)).toEqual([
      { contract: BOARD_001, implementers: ["soksak-plugin-fixture-beta"] },
      { contract: NOTES_001, implementers: ["soksak-plugin-fixture-alpha"] },
      { contract: NOTES_002, implementers: ["soksak-plugin-fixture-beta"] },
    ]);
  });

  it("deduplicates equal provider objects by id and version", () => {
    expect(allContracts([{ id: "x", implements: [NOTES_001, { ...NOTES_001 }] }])).toEqual([
      { contract: NOTES_001, implementers: ["x"] },
    ]);
  });
});

describe("manifestImplements", () => {
  const base = { implements: [NOTES_001] } as unknown as PluginManifest;
  it("returns object declarations", () => expect(manifestImplements(base)).toEqual([NOTES_001]));
  it("returns no invalid string adapters", () => {
    const malformed = { implements: [`${NOTES_001.id}@${NOTES_001.version}`] } as unknown as PluginManifest;
    expect(manifestImplements(malformed)).toEqual([]);
  });
});
