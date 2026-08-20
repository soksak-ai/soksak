// soksak-spec-plugin v1 validation matrix — pins the all-or-nothing(§0-3) contract.
import { describe, expect, it } from "vitest";
import {
  configDefaults,
  parseManifest,
  pluginCommandName,
  resolveText,
  qualifiedViewId,
  scanHostChromeViolations,
  semverGte,
  semverSatisfies,
  SPEC_VERSION,
} from "./spec";

// Minimal valid manifest — each test mutates it to break one rule.
function base(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    spec: SPEC_VERSION,
    id: "demo",
    name: "Demo",
    version: "1.0.0",
    description: "Test fixture",
    permissions: [],
    ...overrides,
  };
}

function errorsOf(raw: unknown, dirName = "demo"): string[] {
  return parseManifest(raw, dirName).validation.errors;
}

describe("parseManifest — renamedFrom(a rename moves the data namespace)", () => {
  it("accepts a valid previous id", () => {
    const { manifest, validation } = parseManifest(
      base({ id: "soksak-plugin-terminal-xterm", renamedFrom: "soksak-plugin-terminal" }),
      "soksak-plugin-terminal-xterm",
    );
    expect(validation.ok).toBe(true);
    expect(manifest?.renamedFrom).toBe("soksak-plugin-terminal");
  });
  it("unset leaves the key absent(optional)", () => {
    expect(parseManifest(base(), "demo").manifest).not.toHaveProperty("renamedFrom");
  });
  it("rejects an id syntax violation", () => {
    expect(errorsOf(base({ renamedFrom: "Upper-Id" })).some((e) => e.includes("renamedFrom"))).toBe(true);
  });
  it("rejects a value equal to its own id(not a rename)", () => {
    expect(errorsOf(base({ id: "demo", renamedFrom: "demo" })).some((e) => e.includes("renamedFrom"))).toBe(true);
  });
});

describe("parseManifest — accept", () => {
  it("passes a minimal manifest and normalizes defaults(entry)", () => {
    const { manifest, validation } = parseManifest(base(), "demo");
    expect(validation).toEqual({ ok: true, errors: [], warnings: [] });
    expect(manifest).toMatchObject({
      id: "demo",
      entry: "main.js",
      permissions: [],
      contributes: { views: [], commands: [] },
    });
  });

  it("a view that names no surface lives beside the work", () => {
    const { manifest } = parseManifest(
      base({
        permissions: ["ui"],
        contributes: {
          views: [
            { id: "panel", title: "Panel", icon: "P" },
            {
              id: "diff",
              title: "Diff",
              icon: "D",
              surfaces: ["tab", "side"],
              decoration: true,
            },
          ],
        },
      }),
      "demo",
    );
    expect(manifest?.contributes.views[0]).toMatchObject({
      surfaces: ["side"],
    });
    expect(manifest?.contributes.views[1]).toMatchObject({
      surfaces: ["tab", "side"],
    });
  });

  it("passes a manifest with every contribution and matching permissions", () => {
    const { validation } = parseManifest(
      base({
        author: "max",
        entry: "dist/main.js",
        minAppVersion: "0.1.0",
        permissions: ["ui", "commands"],
        contributes: {
          views: [{ id: "v", title: "View", icon: "V", surfaces: ["side"] }],
          commands: [{ name: "do.it", title: "Run" }],
        },
      }),
      "demo",
    );
    expect(validation.ok).toBe(true);
  });

  it("contributes.skill — accepts and keeps a { path } declaration(no permission required)", () => {
    const { manifest, validation } = parseManifest(
      base({ contributes: { skill: { path: "skill/SKILL.md" } } }),
      "demo",
    );
    expect(validation.ok).toBe(true);
    expect(manifest?.contributes.skill).toEqual({ path: "skill/SKILL.md" });
  });

  it("contributes.skill — no declaration leaves the skill key absent(backward compatible)", () => {
    const { manifest } = parseManifest(base(), "demo");
    expect(manifest?.contributes.skill).toBeUndefined();
  });

  it("contributes.skill.path — rejects an absolute path and a .. escape", () => {
    expect(parseManifest(base({ contributes: { skill: { path: "/etc/x" } } }), "demo").validation.ok).toBe(false);
    expect(parseManifest(base({ contributes: { skill: { path: "../escape/SKILL.md" } } }), "demo").validation.ok).toBe(false);
    expect(parseManifest(base({ contributes: { skill: {} } }), "demo").validation.ok).toBe(false);
  });

  it("contributes.commands.danger — accepts destructive|inject and keeps it in the manifest", () => {
    const { manifest, validation } = parseManifest(
      base({
        permissions: ["commands", "commands:destructive"],
        contributes: {
          views: [],
          commands: [
            { name: "wipe", title: "Wipe", danger: "destructive" },
            { name: "send", title: "Send", danger: "inject" },
            { name: "list", title: "List" },
          ],
        },
      }),
      "demo",
    );
    expect(validation.ok).toBe(true);
    expect(manifest?.contributes.commands).toMatchObject([
      { name: "wipe", danger: "destructive" },
      { name: "send", danger: "inject" },
      { name: "list" },
    ]);
    expect(manifest?.contributes.commands[2]).not.toHaveProperty("danger");
  });

  it("contributes.commands.danger — rejects an unknown value", () => {
    const errs = errorsOf(
      base({
        permissions: ["commands"],
        contributes: {
          views: [],
          commands: [{ name: "x", title: "X", danger: "nuke" }],
        },
      }),
    );
    expect(errs.some((e) => e.includes("danger"))).toBe(true);
  });

  it("command stutter — rejects a dot namespace that restates the id domain(NAMING §1)", () => {
    // clip ⊂ clipboard: a truncated form is stutter too.
    expect(
      errorsOf(
        base({
          id: "soksak-plugin-clipboard",
          permissions: ["commands"],
          contributes: { commands: [{ name: "clip.list", title: "List" }] },
        }),
        "soksak-plugin-clipboard",
      ).some((e) => e.includes("NAMING")),
    ).toBe(true);
    // folder ⊂ folderpop: a truncated form is stutter too.
    expect(
      errorsOf(
        base({
          id: "soksak-plugin-folderpop",
          permissions: ["commands"],
          contributes: { commands: [{ name: "folder.open", title: "Open" }] },
        }),
        "soksak-plugin-folderpop",
      ).some((e) => e.includes("NAMING")),
    ).toBe(true);
  });

  it("command stutter — accepts a dot namespace that names the operated object(NAMING §1)", () => {
    // page restates no token of design-astryx — it names the operated object.
    const { validation } = parseManifest(
      base({
        id: "soksak-plugin-design-astryx",
        permissions: ["commands"],
        contributes: { commands: [{ name: "page.open", title: "Open" }] },
      }),
      "soksak-plugin-design-astryx",
    );
    expect(validation.ok).toBe(true);
  });

  it("command stutter — a bare name is rejected only on an exact id token match(NAMING §1)", () => {
    // bare 'play' in playbox is the verb itself — legal.
    const { validation } = parseManifest(
      base({
        id: "soksak-plugin-playbox",
        permissions: ["commands"],
        contributes: { commands: [{ name: "play", title: "Play" }] },
      }),
      "soksak-plugin-playbox",
    );
    expect(validation.ok).toBe(true);
    // bare 'create' in agents-issue-create exactly matches an id token — rejected.
    expect(
      errorsOf(
        base({
          id: "soksak-plugin-agents-issue-create",
          permissions: ["commands"],
          contributes: { commands: [{ name: "create", title: "Create" }] },
        }),
        "soksak-plugin-agents-issue-create",
      ).some((e) => e.includes("NAMING")),
    ).toBe(true);
  });

  it("keeps template:true; omitted and false are not included", () => {
    expect(parseManifest(base({ template: true }), "demo").manifest).toMatchObject(
      { template: true },
    );
    expect(parseManifest(base(), "demo").manifest).not.toHaveProperty("template");
    expect(
      parseManifest(base({ template: false }), "demo").manifest,
    ).not.toHaveProperty("template");
  });

  it("repo is owned by the owner release alone — rejected in plugin.json", () => {
    const { manifest } = parseManifest(
      base({ repo: "https://github.com/soksak-ai/soksak-plugin-shark.git" }),
      "demo",
    );
    expect(manifest).toBeNull();
  });
});


describe("parseManifest — reject(required fields)", () => {
  it("rejects a non-object", () => {
    expect(parseManifest("a string", "demo").manifest).toBeNull();
    expect(parseManifest(null, "demo").manifest).toBeNull();
    expect(parseManifest([], "demo").manifest).toBeNull();
  });

  it.each([
    ["spec mismatch", base({ spec: "soksak-spec-plugin@2" }), "spec"],
    ["id format violation(uppercase)", base({ id: "Demo" }), "id"],
    ["id format violation(leading hyphen)", base({ id: "-demo" }), "id"],
    ["name missing", { ...base(), name: undefined }, "name"],
    ["version not semver", base({ version: "1.0" }), "version"],
    ["description missing", { ...base(), description: undefined }, "description"],
    ["author not a string", base({ author: 3 }), "author"],
    ["repo is an unknown manifest key", base({ repo: "soksak-ai/shark" }), "manifest"],
    ["minAppVersion not semver", base({ minAppVersion: "v1" }), "minAppVersion"],
    ["template not boolean", base({ template: "yes" }), "template"],
  ])("%s → rejected", (_label, raw, field) => {
    const errors = errorsOf(raw);
    expect(errors.some((e) => e.startsWith(field))).toBe(true);
    expect(parseManifest(raw, "demo").manifest).toBeNull();
  });

  it("id ≠ install directory name → rejected", () => {
    const errors = errorsOf(base(), "other-dir");
    expect(errors.some((e) => e.startsWith("id:"))).toBe(true);
  });

  it("unknown top-level key → rejected(a typo is found early)", () => {
    expect(errorsOf(base({ permision: [] }))).toContainEqual(
      expect.stringContaining('"permision"'),
    );
  });
});

describe("parseManifest — entry discipline", () => {
  it.each([
    ["absolute path", "/etc/main.js"],
    ["windows absolute path", "C:\\main.js"],
    ["directory escape", "../evil/main.js"],
    ["escape in the middle", "dist/../../main.js"],
    ["non-ESM extension", "main.ts"],
  ])("%s → rejected", (_label, entry) => {
    expect(errorsOf(base({ entry })).some((e) => e.startsWith("entry"))).toBe(true);
  });

  it("allows a relative path inside the directory", () => {
    const { manifest } = parseManifest(base({ entry: "dist/bundle.mjs" }), "demo");
    expect(manifest?.entry).toBe("dist/bundle.mjs");
  });
});

describe("parseManifest — permissions", () => {
  it("permissions missing → rejected(an empty array must be explicit)", () => {
    const raw = base();
    delete (raw as Record<string, unknown>).permissions;
    expect(errorsOf(raw).some((e) => e.startsWith("permissions"))).toBe(true);
  });

  it("unknown permission → rejected", () => {
    expect(
      errorsOf(base({ permissions: ["ui", "root"] })).some((e) =>
        e.includes('"root"'),
      ),
    ).toBe(true);
  });

  it("duplicate permission → rejected", () => {
    expect(
      errorsOf(base({ permissions: ["ui", "ui"] })).some((e) => e.includes("duplicate")),
    ).toBe(true);
  });
});

describe("parseManifest — permission and contribution consistency", () => {
  it('views require the "ui" permission', () => {
    const errors = errorsOf(
      base({ contributes: { views: [{ id: "v", title: "View", icon: "V" }] } }),
    );
    expect(errors.some((e) => e.includes('"ui"'))).toBe(true);
  });

  it('commands require the "commands" permission', () => {
    const errors = errorsOf(
      base({ contributes: { commands: [{ name: "go", title: "Go" }] } }),
    );
    expect(errors.some((e) => e.includes('"commands"'))).toBe(true);
  });

});

describe("parseManifest — contributes.events(published topics, informational)", () => {
  it("accepts a valid topic array(no permission required)", () => {
    const { manifest, validation } = parseManifest(
      base({ contributes: { events: ["mailbox.message", "mailbox.read"] } }),
      "demo",
    );
    expect(validation.errors).toEqual([]);
    expect(manifest?.contributes.events).toEqual(["mailbox.message", "mailbox.read"]);
  });
  it("no declaration defaults to an empty array", () => {
    const { manifest } = parseManifest(base(), "demo");
    expect(manifest?.contributes.events).toEqual([]);
  });
  it("bad topic(format, non-string) and duplicate → rejected", () => {
    expect(errorsOf(base({ contributes: { events: ["Bad Topic"] } })).length).toBeGreaterThan(0);
    expect(errorsOf(base({ contributes: { events: [123] } })).length).toBeGreaterThan(0);
    expect(
      errorsOf(base({ contributes: { events: ["a.b", "a.b"] } })).some((e) => e.includes("duplicate")),
    ).toBe(true);
  });
});

describe("parseManifest — contribution item validation", () => {
  it("duplicate view id → rejected", () => {
    const errors = errorsOf(
      base({
        permissions: ["ui"],
        contributes: {
          views: [
            { id: "v", title: "1", icon: "A" },
            { id: "v", title: "2", icon: "B" },
          ],
        },
      }),
    );
    expect(errors.some((e) => e.includes("duplicate"))).toBe(true);
  });

  it("bad view surfaces(empty array, unknown value) → rejected", () => {
    // A place — left, rail, right — is not a surface. A view that named one would be arranging
    // the window from inside the plugin, so the old vocabulary is rejected rather than mapped.
    for (const surfaces of [[], ["side", "tab", "side"], ["left"], ["right"]]) {
      const errors = errorsOf(
        base({
          permissions: ["ui"],
          contributes: { views: [{ id: "v", title: "View", icon: "V", surfaces }] },
        }),
      );
      expect(errors.some((e) => e.includes("surfaces")), JSON.stringify(surfaces)).toBe(true);
    }
  });

  it("the old placement vocabulary is refused by name, not ignored", () => {
    // `placements` and `defaultPlacement` are gone (L11c — the old path is deleted, not mapped).
    // A manifest still carrying them would otherwise parse with the key dropped and the view would
    // stand somewhere its author never chose, which reads as the host misplacing it.
    for (const key of ["placements", "defaultPlacement"]) {
      const errors = errorsOf(
        base({
          permissions: ["ui"],
          contributes: {
            views: [{ id: "v", title: "View", icon: "V", surfaces: ["side"], [key]: "left" }],
          },
        }),
      );
      expect(errors.some((e) => e.includes(key)), key).toBe(true);
    }
  });

  it("unknown key in a view item → rejected", () => {
    const errors = errorsOf(
      base({
        permissions: ["ui"],
        contributes: {
          views: [{ id: "v", title: "View", icon: "V", placment: ["content"] }],
        },
      }),
    );
    expect(errors.some((e) => e.includes('"placment"'))).toBe(true);
  });

  it("command name format violation → rejected", () => {
    for (const name of ["Do", "do..it", ".go", "go."]) {
      const errors = errorsOf(
        base({
          permissions: ["commands"],
          contributes: { commands: [{ name, title: "t" }] },
        }),
      );
      expect(errors.some((e) => e.includes("contributes.commands"))).toBe(true);
    }
  });

});

describe("parseManifest — all-or-nothing(§0-3)", () => {
  it("collects every error across areas and manifest is null", () => {
    const { manifest, validation } = parseManifest(
      base({
        version: "x",
        entry: "../e.js",
        permissions: ["bogus"],
        contributes: { views: [{ id: "v", title: "View", icon: "V" }] },
      }),
      "demo",
    );
    expect(manifest).toBeNull();
    expect(validation.ok).toBe(false);
    // version + entry + permission + ui consistency = at least 4 reasons.
    expect(validation.errors.length).toBeGreaterThanOrEqual(4);
  });
});

describe("naming rules and semver helpers", () => {
  it("global key rules", () => {
    expect(qualifiedViewId("memo", "panel")).toBe("memo.panel");
    expect(pluginCommandName("memo", "clear")).toBe("plugin.memo.clear");
  });

  it("semverGte", () => {
    expect(semverGte("1.2.3", "1.2.3")).toBe(true);
    expect(semverGte("1.10.0", "1.9.9")).toBe(true);
    expect(semverGte("0.9.0", "1.0.0")).toBe(false);
    expect(semverGte("1.0.0-beta", "1.0.0")).toBe(false); // SemVer 2.0.0 precedence
    expect(semverGte("abc", "1.0.0")).toBeNull();
  });

  it("semverSatisfies — * / exact", () => {
    expect(semverSatisfies("9.9.9", "*")).toBe(true);
    expect(semverSatisfies("1.2.3", "1.2.3")).toBe(true);
    expect(semverSatisfies("1.2.4", "1.2.3")).toBe(false);
  });
  it("semverSatisfies — caret(^) npm semantics", () => {
    expect(semverSatisfies("1.5.0", "^1.2.3")).toBe(true);
    expect(semverSatisfies("2.0.0", "^1.2.3")).toBe(false); // major upper bound
    expect(semverSatisfies("1.2.2", "^1.2.3")).toBe(false); // below the lower bound
    // ^0.x — minor locked
    expect(semverSatisfies("0.1.9", "^0.1.0")).toBe(true);
    expect(semverSatisfies("0.2.0", "^0.1.0")).toBe(false);
    // ^0.0.z — patch locked
    expect(semverSatisfies("0.0.3", "^0.0.3")).toBe(true);
    expect(semverSatisfies("0.0.4", "^0.0.3")).toBe(false);
  });
  it("semverSatisfies — tilde(~)/comparator(>=)", () => {
    expect(semverSatisfies("1.2.9", "~1.2.3")).toBe(true);
    expect(semverSatisfies("1.3.0", "~1.2.3")).toBe(false);
    expect(semverSatisfies("2.0.0", ">=1.0.0")).toBe(true);
    expect(semverSatisfies("0.9.0", ">=1.0.0")).toBe(false);
  });
  it("semverSatisfies — a bad format is null", () => {
    expect(semverSatisfies("abc", "^1.0.0")).toBeNull();
    expect(semverSatisfies("1.0.0", "garbage")).toBeNull();
  });
});

describe("parseManifest — dependencies(plugin ↔ plugin)", () => {
  it("accepts valid dependencies and normalizes", () => {
    const { manifest, validation } = parseManifest(
      base({ dependencies: { "soksak-plugin-acp-core": "^0.1.0" } }),
      "demo",
    );
    expect(validation.ok).toBe(true);
    expect(manifest?.dependencies).toEqual({ "soksak-plugin-acp-core": "^0.1.0" });
  });
  it("no dependencies leaves the key absent(optional)", () => {
    expect(parseManifest(base(), "demo").manifest).not.toHaveProperty("dependencies");
  });
  it("rejects a self dependency", () => {
    expect(errorsOf(base({ dependencies: { demo: "^1.0.0" } }))).toContain(
      'dependencies: self-dependency ("demo") forbidden',
    );
  });
  it("rejects a bad key or range(all-or-nothing)", () => {
    expect(parseManifest(base({ dependencies: { "Bad_Id": "^1.0.0" } }), "demo").manifest).toBeNull();
    expect(parseManifest(base({ dependencies: { dep: "latest" } }), "demo").manifest).toBeNull();
    expect(parseManifest(base({ dependencies: [] }), "demo").manifest).toBeNull();
  });
});

describe("parseManifest — optional shared contracts", () => {
  it("preserves provider versions and consumer ranges", () => {
    const { manifest, validation } = parseManifest(
      base({
        implements: [{ id: "terminal-renderer", version: "0.0.1" }],
        consumes: [{ id: "terminal-session", range: "0.0.1" }],
      }),
      "demo",
    );
    expect(validation.ok).toBe(true);
    expect(manifest?.implements).toEqual([{ id: "terminal-renderer", version: "0.0.1" }]);
    expect(manifest?.consumes).toEqual([{ id: "terminal-session", range: "0.0.1" }]);
  });

  it("keeps an independent plugin free of contract declarations", () => {
    const { manifest, validation } = parseManifest(base(), "demo");
    expect(validation.ok).toBe(true);
    expect(manifest).not.toHaveProperty("implements");
    expect(manifest).not.toHaveProperty("consumes");
  });

  it("rejects malformed and duplicate declarations", () => {
    expect(errorsOf(base({ implements: [{ id: "Bad_Id", version: "0.0.1" }] }))).toContain(
      "implements[0].id: version-free public contract id required",
    );
    expect(
      errorsOf(base({
        consumes: [
          { id: "terminal-session", range: "^0.1.0" },
          { id: "terminal-session", range: "^0.2.0" },
        ],
      })),
    ).toContain('consumes: duplicate contract id "terminal-session"');
  });
});

describe("parseManifest — libraries(external CLI dependencies)", () => {
  const lib = {
    name: "@google/gemini-cli",
    bin: "gemini",
    install: { darwin: "npm i -g @google/gemini-cli@latest" },
    label: "Gemini CLI",
  };
  it("accepts valid libraries and normalizes", () => {
    const { manifest, validation } = parseManifest(base({ libraries: [lib] }), "demo");
    expect(validation.ok).toBe(true);
    expect(manifest?.libraries).toEqual([lib]);
  });
  it("no libraries leaves the key absent(optional)", () => {
    expect(parseManifest(base(), "demo").manifest).not.toHaveProperty("libraries");
  });
  it("rejects a missing name or bin(all-or-nothing)", () => {
    expect(parseManifest(base({ libraries: [{ bin: "gemini", install: { darwin: "x" } }] }), "demo").manifest).toBeNull();
    expect(parseManifest(base({ libraries: [{ name: "x", install: { darwin: "x" } }] }), "demo").manifest).toBeNull();
  });
  it("rejects a bad install platform key and an empty object", () => {
    expect(parseManifest(base({ libraries: [{ name: "x", bin: "x", install: { bad: "y" } }] }), "demo").manifest).toBeNull();
    expect(parseManifest(base({ libraries: [{ name: "x", bin: "x", install: {} }] }), "demo").manifest).toBeNull();
  });
  it("rejects a duplicate bin", () => {
    const dup = { name: "a", bin: "gemini", install: { darwin: "x" } };
    expect(parseManifest(base({ libraries: [dup, dup] }), "demo").manifest).toBeNull();
  });
  it("rejects libraries that is not an array", () => {
    expect(parseManifest(base({ libraries: {} }), "demo").manifest).toBeNull();
  });

  // 4-tuple(observe/accept/reach) — optional. Declared: format validated. Undeclared: legacy behavior.
  const ok4 = (extra: object): boolean =>
    parseManifest(base({ libraries: [{ ...lib, ...extra }] }), "demo").validation.ok;
  it("observe.probe array is valid, non-array and empty array rejected", () => {
    expect(ok4({ observe: { probe: ["gemini", "--version"] } })).toBe(true);
    expect(ok4({ observe: { probe: "gemini" } })).toBe(false);
    expect(ok4({ observe: { probe: [] } })).toBe(false);
  });
  it("accept.minVersion semver is valid, non-semver rejected", () => {
    expect(ok4({ accept: { minVersion: "1.2.3" } })).toBe(true);
    expect(ok4({ accept: { minVersion: "latest" } })).toBe(false);
  });
  it("reach vendor requires path+sha256", () => {
    expect(ok4({ reach: { vendor: { path: "bin/gemini", sha256: "abc" } } })).toBe(true);
    expect(ok4({ reach: { vendor: { path: "bin/gemini" } } })).toBe(false);
  });
  it("reach fetch/command is valid per platform", () => {
    expect(
      ok4({ reach: { fetch: { url: { darwin: "https://x" }, sha256: { darwin: "h" } } } }),
    ).toBe(true);
    expect(ok4({ reach: { command: { darwin: "npm i -g x" } } })).toBe(true);
  });
  it("reach takes exactly one variant(0 and 2 rejected)", () => {
    expect(ok4({ reach: {} })).toBe(false);
    expect(
      ok4({ reach: { vendor: { path: "p", sha256: "h" }, command: { darwin: "c" } } }),
    ).toBe(false);
  });
});

describe("parseManifest — configuration(settings schema)", () => {
  const cfg = [
    { key: "defaultAgent", type: "enum", enum: ["claude", "codex", "gemini"], default: "claude", title: "Default agent" },
    { key: "maxRounds", type: "number", default: 5, min: 1, max: 20, title: "Max rounds" },
    { key: "showGuestbook", type: "boolean", default: true, title: "Guestbook" },
  ];
  it("accepts valid configuration and normalizes", () => {
    const { manifest, validation } = parseManifest(base({ configuration: cfg }), "demo");
    expect(validation.ok).toBe(true);
    expect(manifest?.configuration).toEqual(cfg);
  });
  it("no declaration leaves the key absent(optional)", () => {
    expect(parseManifest(base(), "demo").manifest).not.toHaveProperty("configuration");
  });
  it("rejects an enum default outside the enum", () => {
    expect(parseManifest(base({ configuration: [{ key: "a", type: "enum", enum: ["x", "y"], default: "z", title: "t" }] }), "demo").manifest).toBeNull();
  });
  it("rejects a type and default mismatch", () => {
    expect(parseManifest(base({ configuration: [{ key: "a", type: "number", default: "5", title: "t" }] }), "demo").manifest).toBeNull();
    expect(parseManifest(base({ configuration: [{ key: "a", type: "boolean", default: 1, title: "t" }] }), "demo").manifest).toBeNull();
  });
  it("rejects a missing enum and an enum on a non-enum type", () => {
    expect(parseManifest(base({ configuration: [{ key: "a", type: "enum", default: "x", title: "t" }] }), "demo").manifest).toBeNull();
    expect(parseManifest(base({ configuration: [{ key: "a", type: "string", enum: ["x"], default: "x", title: "t" }] }), "demo").manifest).toBeNull();
  });
  it("rejects min>max and min or max on a non-number type", () => {
    expect(parseManifest(base({ configuration: [{ key: "a", type: "number", default: 5, min: 10, max: 1, title: "t" }] }), "demo").manifest).toBeNull();
    expect(parseManifest(base({ configuration: [{ key: "a", type: "string", default: "x", min: 1, title: "t" }] }), "demo").manifest).toBeNull();
  });
  it("rejects a bad key format and a duplicate key", () => {
    expect(parseManifest(base({ configuration: [{ key: "1bad", type: "boolean", default: true, title: "t" }] }), "demo").manifest).toBeNull();
    const dup = { key: "a", type: "boolean", default: true, title: "t" };
    expect(parseManifest(base({ configuration: [dup, dup] }), "demo").manifest).toBeNull();
  });
  it("configDefaults default map", () => {
    const { manifest } = parseManifest(base({ configuration: cfg }), "demo");
    expect(configDefaults(manifest!)).toEqual({ defaultAgent: "claude", maxRounds: 5, showGuestbook: true });
  });
});

describe("parseManifest — exposed DOM nodes(contributes.nodes)", () => {
  it("nodes require the 'ui' permission", () => {
    const errs = errorsOf(
      base({ contributes: { nodes: [{ id: "submit", description: "Submit" }] } }),
    );
    // The field path and the permission name are what a translation keeps; the
    // order of the words between them is not.
    expect(errs.some((e) => e.startsWith("contributes.nodes:") && e.includes('"ui"'))).toBe(true);
  });
  it("accepts and parses with the ui permission", () => {
    const { manifest, validation } = parseManifest(
      base({
        permissions: ["ui"],
        contributes: {
          nodes: [
            { id: "submit", description: { ko: "전송 버튼", en: "Submit" } },
            { id: "msg", description: "Message row" },
            { id: "danger-node", danger: true },
          ],
        },
      }),
      "demo",
    );
    expect(validation.ok).toBe(true);
    expect(manifest?.contributes.nodes.map((n) => n.id)).toEqual(["submit", "msg", "danger-node"]);
    expect(manifest?.contributes.nodes[2].danger).toBe(true);
  });
  it("rejects an id regex violation", () => {
    const errs = errorsOf(base({ permissions: ["ui"], contributes: { nodes: [{ id: "Bad-Id" }] } }));
    expect(errs.some((e) => e.includes("contributes.nodes: id"))).toBe(true);
  });
  it("rejects a duplicate id", () => {
    const errs = errorsOf(
      base({ permissions: ["ui"], contributes: { nodes: [{ id: "x" }, { id: "x" }] } }),
    );
    expect(errs.some((e) => e.includes("contributes.nodes.id"))).toBe(true);
  });
  it("danger allows only true", () => {
    const errs = errorsOf(
      base({ permissions: ["ui"], contributes: { nodes: [{ id: "x", danger: false }] } }),
    );
    expect(errs.some((e) => e.includes("contributes.nodes.danger"))).toBe(true);
  });
  it("no nodes gives an empty array(default)", () => {
    const { manifest } = parseManifest(base(), "demo");
    expect(manifest?.contributes.nodes).toEqual([]);
  });
});

describe("parseManifest — programs contribution(§2.6)", () => {
  it("programs require the 'programs' permission", () => {
    const errs = errorsOf(
      base({
        contributes: { programs: [{ id: "claude", title: "Claude", kind: "view", view: "content" }] },
      }),
    );
    expect(errs.some((e) => e.includes('"programs"'))).toBe(true);
  });

  it("passes a valid programs contribution with a multi-level path category", () => {
    const { manifest, validation } = parseManifest(
      base({
        permissions: ["programs"],
        contributes: {
          programs: [
            { id: "claude", title: "Claude", kind: "view", view: "content", viewPlugin: "soksak-plugin-terminal-xterm", command: "claude", path: "Agents" },
            { id: "exp", title: "Experiment", kind: "view", view: "content", viewPlugin: "soksak-plugin-terminal-xterm", path: "Agents/Experiment channel" },
            { id: "web", title: "View", kind: "view", view: "content" },
          ],
        },
      }),
      "demo",
    );
    expect(validation.errors).toEqual([]);
    expect(manifest?.contributes.programs).toEqual([
      { id: "claude", title: "Claude", kind: "view", view: "content", viewPlugin: "soksak-plugin-terminal-xterm", command: "claude", path: "Agents" },
      { id: "exp", title: "Experiment", kind: "view", view: "content", viewPlugin: "soksak-plugin-terminal-xterm", path: "Agents/Experiment channel" },
      { id: "web", title: "View", kind: "view", view: "content" },
    ]);
  });

  it("kind allows only view(terminal converged — core terminal removed)", () => {
    const errs = errorsOf(
      base({
        permissions: ["programs"],
        contributes: { programs: [{ id: "claude", title: "Claude", kind: "terminal", command: "claude" }] },
      }),
    );
    expect(errs.some((e) => e.includes("kind"))).toBe(true);
  });

  it("kind=view requires view(a view id)", () => {
    const errs = errorsOf(
      base({
        permissions: ["programs"],
        contributes: { programs: [{ id: "a", title: "x", kind: "view" }] },
      }),
    );
    expect(errs.some((e) => e.includes("view"))).toBe(true);
  });

  it("viewPlugin takes the plugin id format(cross-plugin view reference)", () => {
    const errs = errorsOf(
      base({
        permissions: ["programs"],
        contributes: { programs: [{ id: "a", title: "x", kind: "view", view: "content", viewPlugin: "Bad_ID" }] },
      }),
    );
    expect(errs.some((e) => e.includes("viewPlugin"))).toBe(true);
  });


  it("viewContract contract id syntax violation → rejected(soksak-spec-<kind>-<domain>@<major>)", () => {
    const errs = errorsOf(
      base({
        permissions: ["programs"],
        contributes: { programs: [{ id: "a", title: "x", kind: "view", view: "content", viewContract: "soksak-plugin-terminal" }] },
      }),
    );
    expect(errs.some((e) => e.includes("viewContract"))).toBe(true);
  });

  it("viewPlugin+viewContract declared together → rejected(name pin and contract pin are mutually exclusive)", () => {
    const errs = errorsOf(
      base({
        permissions: ["programs"],
        contributes: {
          programs: [
            { id: "a", title: "x", kind: "view", view: "content", viewPlugin: "soksak-plugin-terminal", viewContract: { id: "soksak-spec-plugin-terminal", range: "0.0.1" } },
          ],
        },
      }),
    );
    expect(errs.some((e) => e.includes("viewPlugin") && e.includes("viewContract"))).toBe(true);
  });

  it("command/ensure may accompany kind=view for autorun and install(agent program)", () => {
    const { manifest, validation } = parseManifest(
      base({
        permissions: ["programs"],
        contributes: {
          programs: [
            {
              id: "claude",
              title: "Claude",
              kind: "view",
              view: "content",
              viewPlugin: "soksak-plugin-terminal-xterm",
              command: "claude",
              ensure: { bin: "claude", install: { darwin: "curl … | bash" } },
            },
          ],
        },
      }),
      "demo",
    );
    expect(validation.errors).toEqual([]);
    expect(manifest?.contributes.programs[0]).toMatchObject({
      command: "claude",
      ensure: { bin: "claude", install: { darwin: "curl … | bash" } },
    });
  });

  it("empty path segment → rejected", () => {
    const errs = errorsOf(
      base({
        permissions: ["programs"],
        contributes: {
          programs: [{ id: "a", title: "x", kind: "view", view: "content", path: "Agents//sub" }],
        },
      }),
    );
    expect(errs.some((e) => e.includes("path"))).toBe(true);
  });

  it("program id format violation → rejected", () => {
    const errs = errorsOf(
      base({
        permissions: ["programs"],
        contributes: { programs: [{ id: "Bad_ID", title: "x", kind: "view", view: "content" }] },
      }),
    );
    expect(errs.length).toBeGreaterThan(0);
  });

  it('no built-in concept — a plugin registers the "terminal" id too', () => {
    const { manifest, validation } = parseManifest(
      base({
        permissions: ["programs"],
        contributes: { programs: [{ id: "terminal", title: "Terminal", kind: "view", view: "content" }] },
      }),
      "demo",
    );
    expect(validation.errors).toEqual([]);
    expect(manifest?.contributes.programs[0].id).toBe("terminal");
  });

  it("duplicate program id → rejected", () => {
    const errs = errorsOf(
      base({
        permissions: ["programs"],
        contributes: {
          programs: [
            { id: "a", title: "x", kind: "view", view: "content" },
            { id: "a", title: "y", kind: "view", view: "content" },
          ],
        },
      }),
    );
    expect(errs.some((e) => e.includes("duplicate"))).toBe(true);
  });
});

describe("LocalizedText — plugin text in multiple languages(§3.5)", () => {
  it("a plain string stays valid(backward compatible)", () => {
    const { validation } = parseManifest(base(), "demo");
    expect(validation.ok).toBe(true);
  });

  it("accepts a language map on name, description, contribution title", () => {
    const { manifest, validation } = parseManifest(
      base({
        name: { ko: "터미널", en: "Terminal" },
        description: { ko: "설명", en: "Description" },
        permissions: ["programs"],
        contributes: {
          programs: [
            {
              id: "t",
              title: { ko: "터미널", en: "Terminal" },
              path: { ko: "에이전트", en: "Agents" },
              kind: "view",
              view: "content",
            },
          ],
        },
      }),
      "demo",
    );
    expect(validation.errors).toEqual([]);
    expect(manifest?.name).toEqual({ ko: "터미널", en: "Terminal" });
  });

  it("empty map, empty value, bad language key → rejected", () => {
    expect(errorsOf(base({ name: {} })).length).toBeGreaterThan(0);
    expect(errorsOf(base({ name: { ko: " " } })).length).toBeGreaterThan(0);
    expect(errorsOf(base({ name: { KOREAN: "x" } })).length).toBeGreaterThan(0);
  });

  it("resolveText: current language → first declared fallback", () => {
    expect(resolveText("터미널", "en")).toBe("터미널");
    expect(resolveText({ ko: "터미널", en: "Terminal" }, "en")).toBe("Terminal");
    expect(resolveText({ ko: "터미널", en: "Terminal" }, "ja")).toBe("터미널");
  });
});

describe("scanHostChromeViolations — host chrome standard static gate", () => {
  it("passes when only its own classes are styled(0 violations)", () => {
    const ok = `.club-feed{height:100%}.st-tab{padding:3px}.acpc-bar{display:flex}`;
    expect(scanHostChromeViolations(ok)).toEqual([]);
  });
  it("a height override on a host tab selector is a violation", () => {
    expect(scanHostChromeViolations(`.sidebar-body-tab{height:50px}`)).toContain(".sidebar-body-tab");
    expect(scanHostChromeViolations(`.content-tabs{height:60px}`)).toContain(".content-tabs");
    expect(scanHostChromeViolations(`.view-tabs{padding:0}`)).toContain(".view-tabs");
  });
  it("an assignment to a host chrome variable is a violation", () => {
    expect(scanHostChromeViolations(`:root{--chrome-row-h:99px}`)).toContain("--chrome-row-h");
    expect(scanHostChromeViolations(`.x{--header-h:10px}`)).toContain("--header-h");
  });
  it("a mention in a comment or in prose is not a false positive(0 violations)", () => {
    expect(scanHostChromeViolations(`// .sidebar-body-tabs is owned by the host`)).toEqual([]);
    expect(scanHostChromeViolations(`const note = "do not touch --chrome-row-h here"`)).toEqual([]);
  });
  it("reports every violation", () => {
    const bad = `.sidebar-body-tabs{height:40px} .ft-header{height:40px} :root{--header-h:5px}`;
    const v = scanHostChromeViolations(bad);
    expect(v).toEqual(expect.arrayContaining([".sidebar-body-tabs", ".ft-header", "--header-h"]));
  });
});

describe("parseManifest — sidecars(engine module dependency declaration)", () => {
  const sc = { name: "browser-chromium", interface: { id: "soksak-spec-sidecar-browser", range: "0.0.1" } };
  it("accepts valid sidecars(with the sidecar permission)", () => {
    const { manifest, validation } = parseManifest(
      base({ permissions: ["sidecar"], sidecars: [sc] }),
      "demo",
    );
    expect(validation.ok).toBe(true);
    expect(manifest?.sidecars).toEqual([sc]);
  });
  it("no sidecars leaves the key absent(optional)", () => {
    expect(parseManifest(base(), "demo").manifest).not.toHaveProperty("sidecars");
  });
  it("sidecars declared without the sidecar or process permission = rejected", () => {
    const { manifest, validation } = parseManifest(base({ sidecars: [sc] }), "demo");
    expect(manifest).toBeNull();
    expect(validation.errors.join()).toContain("sidecars:");
  });
  it('a service-model sidecar declares sidecars with the "process" permission(a separate process, not the engine)', () => {
    const svc = { name: "terminal-alacritty", interface: { id: "soksak-spec-sidecar-terminal", range: "0.0.1" } };
    const { manifest, validation } = parseManifest(
      base({ permissions: ["process"], sidecars: [svc] }),
      "demo",
    );
    expect(validation.ok).toBe(true);
    expect(manifest?.sidecars).toEqual([svc]);
  });
  it("rejects a name format violation(path traversal guard)", () => {
    for (const name of ["../evil", "Upper", "a/b", ""]) {
      expect(
        parseManifest(
          base({ permissions: ["sidecar"], sidecars: [{ name, interface: "x@1" }] }),
          "demo",
        ).manifest,
      ).toBeNull();
    }
  });
  it("rejects an interface format violation(id@major required)", () => {
    for (const iface of ["no-version", "x@", "x@abc", "@1"]) {
      expect(
        parseManifest(
          base({ permissions: ["sidecar"], sidecars: [{ name: "ok", interface: iface }] }),
          "demo",
        ).manifest,
      ).toBeNull();
    }
  });
  it("rejects a duplicate name", () => {
    expect(
      parseManifest(
        base({ permissions: ["sidecar"], sidecars: [sc, { ...sc, interface: "other@2" }] }),
        "demo",
      ).manifest,
    ).toBeNull();
  });
  it("rejects an unknown key(all-or-nothing)", () => {
    expect(
      parseManifest(
        base({ permissions: ["sidecar"], sidecars: [{ ...sc, extra: 1 }] }),
        "demo",
      ).manifest,
    ).toBeNull();
  });
  it("the sidecar supply location is owned by the owner release alone — reach rejected", () => {
    const reach = { fetch: { url: { darwin: "https://x/a.tar.gz" }, sha256: { darwin: "ab12" } } };
    const { manifest } = parseManifest(
      base({ permissions: ["sidecar"], sidecars: [{ ...sc, reach }] }),
      "demo",
    );
    expect(manifest).toBeNull();
  });
  it("rejects every reach variant", () => {
    for (const reach of [
      { command: { darwin: "brew install x" } },
      { vendor: { path: "v/x", sha256: "ab" } },
      { fetch: { url: { darwin: "u" }, sha256: { darwin: "s" } }, command: {} },
    ]) {
      expect(
        parseManifest(
          base({ permissions: ["sidecar"], sidecars: [{ ...sc, reach }] }),
          "demo",
        ).manifest,
      ).toBeNull();
    }
  });
});

