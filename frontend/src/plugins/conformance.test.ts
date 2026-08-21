import { describe, expect, it } from "vitest";
import {
  gateContribution,
  missingRegistrations,
  nodeConformance,
  partitionEnforcement,
  partitionTransparency,
  viewStatusConformance,
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
