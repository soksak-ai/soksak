import { describe, expect, it } from "vitest";
import {
  C2_ENFORCEMENT,
  C3_ENFORCEMENT,
  gateContribution,
  implementsViolations,
  missingRegistrations,
  nodeConformance,
  partitionEnforcement,
  partitionTransparency,
  viewStatusConformance,
  sidecarSpawnViolations,
  executedCommandNames,
  unresolvedCommandCalls,
} from "./conformance";

// gateContribution — the declared≡actual registration gate (unified). Replaces four find+throw
// blocks in api.ts with one. Rule: a declared id returns its declaration entry; an undeclared id
// throws fatally (undeclared-actual refused).
describe("gateContribution — refuses undeclared-actual", () => {
  const declared = [{ name: "send" }, { name: "clear" }];

  it("a declared id returns its declaration entry (the caller uses danger/title)", () => {
    const got = gateContribution({
      contributesKey: "commands",
      noun: "command",
      id: "send",
      declared,
      idOf: (c) => c.name,
    });
    expect(got).toEqual({ name: "send" });
  });

  it("an undeclared id throws — the message names contributes.<key>, <noun>, <id>", () => {
    expect(() =>
      gateContribution({
        contributesKey: "commands",
        noun: "command",
        id: "ghost",
        declared,
        idOf: (c) => c.name,
      }),
    ).toThrow(/contributes\.commands.*ghost/);
  });

  it("idOf reads the identifier per kind — views by id, commands by name", () => {
    const views = [{ id: "panel", title: "P" }];
    expect(
      gateContribution({
        contributesKey: "views",
        noun: "view",
        id: "panel",
        declared: views,
        idOf: (v) => v.id,
      }),
    ).toEqual({ id: "panel", title: "P" });
    expect(() =>
      gateContribution({
        contributesKey: "views",
        noun: "view",
        id: "missing",
        declared: views,
        idOf: (v) => v.id,
      }),
    ).toThrow(/contributes\.views.*missing/);
  });
});

// missingRegistrations — declared-but-not-actual detection (new, inventory after activate).
// Rule: returns the ids declared but not registered (an unkept promise = a plugin bug signal).
describe("missingRegistrations — declared-but-not-actual detection", () => {
  it("every declaration registered gives an empty array", () => {
    expect(
      missingRegistrations(["send", "clear"], ["send", "clear"]),
    ).toEqual([]);
  });

  it("returns only declared-but-unregistered ids, in declaration order", () => {
    expect(
      missingRegistrations(["send", "clear", "reset"], ["clear"]),
    ).toEqual(["send", "reset"]);
  });

  it("registered without a declaration is not judged here — gateContribution covers it", () => {
    expect(missingRegistrations(["send"], ["send", "extra"])).toEqual([]);
  });
});

// nodeConformance — declared≡actual for nodes. actual = data-node in the DOM (scanNodes result).
// nodes is a contribution with no register API, so both directions are reported as a *diagnosis*
// (missing/orphan) rather than a gate.
describe("nodeConformance — declaration (contributes.nodes) ≡ wiring (data-node)", () => {
  it("every declaration wired gives no missing and no orphan", () => {
    expect(nodeConformance(["send", "input"], ["send", "input"])).toEqual({
      missing: [],
      orphan: [],
    });
  });

  it("a dynamic node (id/key) matches on the base id — list rows", () => {
    expect(nodeConformance(["row"], ["row/0", "row/1"])).toEqual({
      missing: [],
      orphan: [],
    });
  });

  it("declared but not wired in the DOM → missing (declared→actual)", () => {
    expect(nodeConformance(["send", "ghost"], ["send"])).toEqual({
      missing: ["ghost"],
      orphan: [],
    });
  });

  it("wired in the DOM but undeclared → orphan (actual→declared)", () => {
    expect(nodeConformance(["send"], ["send", "extra"])).toEqual({
      missing: [],
      orphan: ["extra"],
    });
  });
});

// Unit verification of the C2 static verdicts (transparencyViolations — command-surface,
// view-nodes, content-view-status) is owned by the spec package
// (packages/plugin-spec/test/transparency.test.ts) — the verdict moved to that package and the
// core is a consumer, so no verdict matrix here (no second source of truth).

// viewStatusConformance — the pure verdict for C2 view-status (a runtime rule), declared≡reported.
// declared = contributes.views[].status (the list of reportable codes, [] = explicitly stateless);
// reported = the actual status code of a mounted instance. At activation the view is not yet
// mounted so the loader cannot judge — enforcement points are the runtime diagnosis
// (plugin.conformance) and the publish gate (doctor). Two verdict directions:
//   declared (non-empty) and not reported → unreported (view-status violation)
//   a reported code absent from the declaration (no declaration, [], or outside the list) →
//   undeclared (missing-declaration warning)
describe("viewStatusConformance — declared ≡ reported", () => {
  const decl = (status?: readonly string[]) => [{ id: "canvas", status }];

  it("reporting a declared code conforms", () => {
    expect(
      viewStatusConformance(decl(["ready", "error"]), [
        { viewId: "tab-aaaaaa", view: "canvas", code: "ready" },
      ]),
    ).toEqual({ unreported: [], undeclared: [] });
  });

  it("declared and not reported → unreported, in mount order", () => {
    expect(
      viewStatusConformance(decl(["ready"]), [
        { viewId: "tab-aaaaaa", view: "canvas", code: null },
        { viewId: "tab-bbbbbb", view: "canvas", code: "ready" },
        { viewId: "tab-cccccc", view: "canvas", code: null },
      ]),
    ).toEqual({ unreported: ["tab-aaaaaa", "tab-cccccc"], undeclared: [] });
  });

  it("stateless declaration ([]) with no report conforms — silence matches the declaration", () => {
    expect(
      viewStatusConformance(decl([]), [{ viewId: "tab-aaaaaa", view: "canvas", code: null }]),
    ).toEqual({ unreported: [], undeclared: [] });
  });

  it("reported with no declaration → undeclared — the declaration is missing, measured from the reported code", () => {
    expect(
      viewStatusConformance(decl(undefined), [
        { viewId: "tab-aaaaaa", view: "canvas", code: "idle" },
      ]),
    ).toEqual({
      unreported: [],
      undeclared: [{ viewId: "tab-aaaaaa", view: "canvas", code: "idle" }],
    });
  });

  it("stateless declaration ([]) with a report → undeclared — the declaration omits the code", () => {
    expect(
      viewStatusConformance(decl([]), [{ viewId: "tab-aaaaaa", view: "canvas", code: "busy" }]),
    ).toEqual({
      unreported: [],
      undeclared: [{ viewId: "tab-aaaaaa", view: "canvas", code: "busy" }],
    });
  });

  it("a code outside the declared list → undeclared", () => {
    expect(
      viewStatusConformance(decl(["ready"]), [
        { viewId: "tab-aaaaaa", view: "canvas", code: "wat" },
      ]),
    ).toEqual({
      unreported: [],
      undeclared: [{ viewId: "tab-aaaaaa", view: "canvas", code: "wat" }],
    });
  });

  it("no declaration and no report conforms — a missing declaration is the static content-view-status rule", () => {
    expect(
      viewStatusConformance(decl(undefined), [{ viewId: "tab-aaaaaa", view: "canvas", code: null }]),
    ).toEqual({ unreported: [], undeclared: [] });
  });
});

// partitionTransparency — classifies violations by enforcement mode (blocking/warn). Single truth
// for the mode = C2_ENFORCEMENT. Promotion to blocking requires a measured 0 violations plus a
// re-legislation commit (C5) — editing this table forces the pin test below to be edited with it.
describe("partitionTransparency — enforcement-mode classification", () => {
  it("a violation of a warn rule is classified warn", () => {
    const v = [{ rule: "command-surface" as const, detail: "d" }];
    expect(
      partitionTransparency(v, {
        "command-surface": "warn",
        "view-status": "warn",
        "view-nodes": "warn",
        "content-view-status": "warn",
      }),
    ).toEqual({ blocking: [], warn: v });
  });

  it("a violation of a blocking rule is classified blocking — injected table", () => {
    const v = [
      { rule: "command-surface" as const, detail: "a" },
      { rule: "view-nodes" as const, detail: "b" },
    ];
    expect(
      partitionTransparency(v, {
        "command-surface": "blocking",
        "view-status": "warn",
        "view-nodes": "warn",
        "content-view-status": "warn",
      }),
    ).toEqual({ blocking: [v[0]], warn: [v[1]] });
  });

  it("pin of the current legislation table — all four blocking (view-status promoted after the momentary-unreported rule was dropped and live undeclared=0 was measured)", () => {
    expect(C2_ENFORCEMENT).toEqual({
      "command-surface": "blocking",
      "view-nodes": "blocking",
      "content-view-status": "blocking",
      "view-status": "blocking",
    });
  });
});

// implementsViolations — generic checks on the implements declaration of composition law C3
// (L2 contract-pin). Defining and verifying the surface a contract demands is the contract owner's
// (the plugin's) job — the core only checks that the declaration itself holds:
//   ① implements-shape: not an array of strings ② implements-grammar: contract id grammar
//   (NAMING §8) violated ③ implements-duplicate: the same contract declared twice.
describe("implementsViolations — generic checks on the C3 implements declaration", () => {
  it("no declaration (undefined) → no violation — the L2 contract-pin is opt-in", () => {
    expect(implementsViolations(undefined)).toEqual([]);
  });

  it("a valid declaration → no violation", () => {
    expect(
      implementsViolations([
        { id: "fixture-notes", version: "0.0.1" },
        { id: "fixture-board", version: "0.0.1" },
      ]),
    ).toEqual([]);
  });

  it("not an array → implements-shape; the other checks have no item and stay silent", () => {
    expect(implementsViolations("fixture-notes@0.0.1").map((v) => v.rule)).toEqual([
      "implements-shape",
    ]);
  });

  it("a non-object item → implements-shape, and the object items are still checked", () => {
    const v = implementsViolations([{ id: "fixture-notes", version: "0.0.1" }, 7]);
    expect(v.map((x) => x.rule)).toEqual(["implements-shape"]);
  });

  it("an item breaking the grammar → implements-grammar, listing every offending id", () => {
    // An id a name cannot be, and a version a SemVer cannot be.
    const v = implementsViolations([
      { id: "Fixture-Notes", version: "0.0.1" },
      { id: "fixture-board", version: "bad" },
    ]);
    expect(v.map((x) => x.rule)).toEqual(["implements-grammar"]);
    expect(v[0].detail).toContain("0");
    expect(v[0].detail).toContain("1");
  });

  it("a duplicate declaration → implements-duplicate", () => {
    const v = implementsViolations([
      { id: "fixture-notes", version: "0.0.1" },
      { id: "fixture-notes", version: "0.0.1" },
    ]);
    expect(v.map((x) => x.rule)).toEqual(["implements-duplicate"]);
    expect(v[0].detail).toContain("fixture-notes");
  });

  it("multiple violations are all reported — none hidden", () => {
    const v = implementsViolations([
      7,
      { id: "-bad", version: "0.0.1" },
      { id: "fixture-notes", version: "0.0.1" },
      { id: "fixture-notes", version: "0.0.1" },
    ]);
    expect(v.map((x) => x.rule)).toEqual([
      "implements-shape",
      "implements-grammar",
      "implements-duplicate",
    ]);
  });
});

// C3 enforcement mode — same shape as C2 (starts at warn). Promotion to blocking requires a
// sustained measured 0 violations across installed plugins after the schema lands, plus an
// explicit re-legislation commit (C4·C5). Editing this table forces the pin test below to change
// with it.
describe("C3_ENFORCEMENT·partitionEnforcement — enforcement mode", () => {
  it("pin of the current legislation table — all three blocking (promoted after installed plugins measured 0 declarations = 0 violations)", () => {
    expect(C3_ENFORCEMENT).toEqual({
      "implements-shape": "blocking",
      "implements-grammar": "blocking",
      "implements-duplicate": "blocking",
    });
  });

  it("partitionEnforcement classifies blocking/warn by the injected table", () => {
    const v = [
      { rule: "implements-grammar" as const, detail: "a" },
      { rule: "implements-duplicate" as const, detail: "b" },
    ];
    expect(
      partitionEnforcement(v, {
        "implements-shape": "warn",
        "implements-grammar": "blocking",
        "implements-duplicate": "warn",
      }),
    ).toEqual({ blocking: [v[0]], warn: [v[1]] });
  });
});

describe("single truth for unit selection — whether the bundle hardcodes the unit name", () => {
  const declared = [{ name: "terminal-alacritty" }];

  it("a bundle that reads the name from the manifest has no violation", () => {
    // No unit name as a literal — it spawns the value app.process.sidecarName (the contract) returned.
    const bundle = 'const u = app.process.sidecarName(C); proc.spawn(`sidecar:${u}`, [], {});';
    expect(sidecarSpawnViolations(bundle, declared)).toEqual([]);
  });

  it("a hardcoded name is a violation even when it is declared", () => {
    // Even when it matches the declaration, this literal turns false the moment the manifest changes — and only a crash surfaces it.
    const bundle = 'proc.spawn("sidecar:terminal-alacritty", [], {});';
    expect(sidecarSpawnViolations(bundle, declared)).toEqual([
      { unit: "terminal-alacritty", declared: true },
    ]);
  });

  it("an undeclared name is caught with declared=false", () => {
    const bundle = 'proc.spawn("sidecar:terminal-wezterm", [], {});';
    expect(sidecarSpawnViolations(bundle, declared)).toEqual([
      { unit: "terminal-wezterm", declared: false },
    ]);
  });
});

// Resolution of called names — the axis that catches dead calls (names the core dropped).
describe("command call scan — the called name is part of declared ≡ actual", () => {
  it("collects literal call names and only counts assembled calls", () => {
    const bundle = `
      app.commands.execute("browser.eval", { js });
      x.commands.execute('plugin.soksak-plugin-kanban.node.add', p);
      y.commands.execute(\`plugin.\${id}.node.get\`, q);
      z.commands.execute(\`term.write\`, r);
    `;
    const scan = executedCommandNames(bundle);
    expect(scan.literals).toEqual([
      "browser.eval",
      "plugin.soksak-plugin-kanban.node.add",
      "term.write",
    ]);
    expect(scan.dynamic).toBe(1);
  });

  // In a name built by concatenation the leading fragment is not the name — counting it as one
  // accuses a working call of being dead (measured: execute(PREFIX + name)).
  it("a call built by string concatenation is dynamic, not a literal", () => {
    const bundle = `app.commands.execute("plugin.soksak-plugin-agents-acp." + name, params);`;
    const scan = executedCommandNames(bundle);
    expect(scan.literals).toEqual([]);
    expect(scan.dynamic).toBe(1);
  });

  it("only a name declared nowhere is unresolved — a declaration on a disabled target resolves", () => {
    const known = new Set(["term.write", "plugin.soksak-plugin-kanban.node.add"]);
    expect(unresolvedCommandCalls(["browser.eval", "term.write"], known)).toEqual(["browser.eval"]);
    expect(unresolvedCommandCalls(["plugin.soksak-plugin-kanban.node.add"], known)).toEqual([]);
  });
});
