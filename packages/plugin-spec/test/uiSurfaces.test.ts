// Current 0.0.1 host UI surface manifest law.
// The manifest owns static placement/labels/command bindings; runtime code supplies only
// declared overlay providers and state updates. Callback/function-shaped declarations are invalid.
import { describe, expect, it } from "vitest";
import { parseManifest, SERVICE_CONTRACT_REQUIREMENT, SPEC_VERSION } from "../src/spec";

function base(
  contributes: Record<string, unknown>,
  permissions: string[] = [],
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    spec: SPEC_VERSION,
    id: "demo",
    name: "Demo",
    version: "1.0.0",
    description: "UI surface fixture",
    entry: "main.js",
    permissions,
    contributes,
    ...overrides,
  };
}

function errorsOf(raw: unknown): string[] {
  return parseManifest(raw, "demo").validation.errors;
}

const command = { name: "toggle", title: "Toggle" };

describe("0.0.1 declarative UI surfaces — valid parsing and normalization", () => {
  it("normalizes overlays/headerActions/statusItems and preserves host policy fields", () => {
    const { manifest, validation } = parseManifest(
      base(
        {
          commands: [command],
          overlays: [
            {
              id: "screen-tools",
              title: { ko: " 화면 도구 ", en: " Screen tools " },
              scope: "screen",
              capturesInput: false,
            },
            {
              id: "pane-tools",
              title: " Pane tools ",
              scope: "pane",
              capturesInput: true,
            },
          ],
          headerActions: [
            { id: "toggle-tools", title: " Toggle tools ", icon: " ⚙ ", command: "toggle" },
          ],
          statusItems: [{ id: "state", title: " State ", command: "toggle" }],
        },
        [
          "commands",
          "ui:overlay:screen",
          "ui:overlay:pane",
          "ui:titlebar",
          "ui:statusbar",
        ],
      ),
      "demo",
    );

    expect(validation.errors).toEqual([]);
    expect(manifest?.contributes.overlays).toEqual([
      {
        id: "screen-tools",
        title: { ko: "화면 도구", en: "Screen tools" },
        scope: "screen",
        capturesInput: false,
      },
      { id: "pane-tools", title: "Pane tools", scope: "pane", capturesInput: true },
    ]);
    expect(manifest?.contributes.headerActions).toEqual([
      { id: "toggle-tools", title: "Toggle tools", icon: "⚙", command: "toggle" },
    ]);
    expect(manifest?.contributes.statusItems).toEqual([
      { id: "state", title: "State", command: "toggle" },
    ]);
  });
});

describe("0.0.1 declarative UI surfaces — closed schema", () => {
  it("rejects imperative callbacks and host-owned visible/interactive state", () => {
    const errors = errorsOf(
      base(
        {
          commands: [command],
          overlays: [
            {
              id: "tools",
              title: "Tools",
              scope: "screen",
              capturesInput: false,
              visible: true,
              interactive: true,
              render: "callback-id",
            },
          ],
          headerActions: [
            {
              id: "toggle-tools",
              title: "Toggle",
              icon: "⚙",
              command: "toggle",
              onClick: "callback-id",
            },
          ],
          statusItems: [
            { id: "state", title: "State", command: "toggle", onClick: "callback-id" },
          ],
        },
        ["commands", "ui:overlay:screen", "ui:titlebar", "ui:statusbar"],
      ),
    );

    expect(errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining('contributes.overlays[0]: 알 수 없는 키 "visible"'),
        expect.stringContaining('contributes.overlays[0]: 알 수 없는 키 "interactive"'),
        expect.stringContaining('contributes.overlays[0]: 알 수 없는 키 "render"'),
        expect.stringContaining('contributes.headerActions[0]: 알 수 없는 키 "onClick"'),
        expect.stringContaining('contributes.statusItems[0]: 알 수 없는 키 "onClick"'),
      ]),
    );
  });

  it("requires flat unique ids, exact scopes, booleans, and complete fields", () => {
    const malformed = [
      { overlays: [{ id: "nested.tools", title: "Tools", scope: "screen", capturesInput: false }] },
      {
        overlays: [
          { id: "tools", title: "Tools", scope: "window", capturesInput: false },
        ],
      },
      { overlays: [{ id: "tools", title: "Tools", scope: "screen", capturesInput: "no" }] },
      { overlays: [{ id: "tools", title: "Tools", scope: "screen" }] },
      {
        overlays: [
          { id: "tools", title: "One", scope: "screen", capturesInput: false },
          { id: "tools", title: "Two", scope: "screen", capturesInput: false },
        ],
      },
      { headerActions: [{ id: "nested.action", title: "A", icon: "A", command: "toggle" }] },
      {
        headerActions: [
          { id: "action", title: "A", icon: "A", command: "toggle" },
          { id: "action", title: "B", icon: "B", command: "toggle" },
        ],
      },
      { statusItems: [{ id: "nested.item", title: "S", command: "toggle" }] },
      {
        statusItems: [
          { id: "item", title: "A", command: "toggle" },
          { id: "item", title: "B", command: "toggle" },
        ],
      },
    ];

    for (const contributes of malformed) {
      expect(
        errorsOf(base({ commands: [command], ...contributes }, [
          "commands",
          "ui:overlay:screen",
          "ui:titlebar",
          "ui:statusbar",
        ])).length,
      ).toBeGreaterThan(0);
    }
  });
});

describe("0.0.1 declarative UI surfaces — permission and command integrity", () => {
  it("requires the permission matching each overlay scope", () => {
    const screen = errorsOf(
      base(
        { overlays: [{ id: "tools", title: "Tools", scope: "screen", capturesInput: false }] },
        ["ui:overlay:pane"],
      ),
    );
    const pane = errorsOf(
      base(
        { overlays: [{ id: "tools", title: "Tools", scope: "pane", capturesInput: false }] },
        ["ui:overlay:screen"],
      ),
    );
    expect(screen).toEqual(expect.arrayContaining([expect.stringContaining('"ui:overlay:screen"')]));
    expect(pane).toEqual(expect.arrayContaining([expect.stringContaining('"ui:overlay:pane"')]));
  });

  it("header/status surfaces require their chrome permission and commands permission", () => {
    const header = errorsOf(
      base(
        {
          commands: [command],
          headerActions: [{ id: "toggle-tools", title: "Toggle", icon: "⚙", command: "toggle" }],
        },
        [],
      ),
    );
    const status = errorsOf(
      base(
        {
          commands: [command],
          statusItems: [{ id: "state", title: "State", command: "toggle" }],
        },
        [],
      ),
    );
    expect(header).toEqual(
      expect.arrayContaining([
        expect.stringContaining('contributes.headerActions: "ui:titlebar"'),
        expect.stringContaining('contributes.headerActions: "commands"'),
      ]),
    );
    expect(status).toEqual(
      expect.arrayContaining([
        expect.stringContaining('contributes.statusItems: "ui:statusbar"'),
        expect.stringContaining('contributes.statusItems: "commands"'),
      ]),
    );
  });

  it("header/status commands must exactly name a command declared by the same plugin", () => {
    for (const contributes of [
      {
        commands: [command],
        headerActions: [{ id: "bad", title: "Bad", icon: "!", command: "missing" }],
      },
      {
        commands: [command],
        statusItems: [{ id: "bad", title: "Bad", command: "toggle " }],
      },
    ]) {
      const errors = errorsOf(
        base(contributes, ["commands", "ui:titlebar", "ui:statusbar"]),
      );
      expect(errors.some((error) => error.includes("선언되지 않은 커맨드"))).toBe(true);
    }
  });
});

describe("entry:null service boundary", () => {
  function serviceManifest(extra: Record<string, unknown>, permissions: string[]) {
    return base(
      {
        commands: [
          {
            name: "toggle",
            title: "Toggle",
            bind: "service",
            description: "Toggle the host-declared surface.",
          },
        ],
        ...extra,
      },
      ["commands", "sidecar", "service", ...permissions],
      {
        entry: null,
        sidecars: [{
          name: "demo-svc",
          interface: { id: "soksak-spec-sidecar-demo", range: ">=0.0.1 <1.0.0" },
        }],
        service: { sidecar: "demo-svc", interface: SERVICE_CONTRACT_REQUIREMENT },
      },
    );
  }

  it("allows host-declarative header/status items backed by service commands", () => {
    const { manifest, validation } = parseManifest(
      serviceManifest(
        {
          headerActions: [{ id: "toggle-tools", title: "Toggle", icon: "⚙", command: "toggle" }],
          statusItems: [{ id: "state", title: "State", command: "toggle" }],
        },
        ["ui:titlebar", "ui:statusbar"],
      ),
      "demo",
    );
    expect(validation.errors).toEqual([]);
    expect(manifest?.entry).toBeNull();
  });

  it("rejects overlays because an overlay provider requires plugin code", () => {
    const errors = errorsOf(
      serviceManifest(
        { overlays: [{ id: "tools", title: "Tools", scope: "screen", capturesInput: false }] },
        ["ui:overlay:screen"],
      ),
    );
    expect(errors).toEqual(
      expect.arrayContaining([expect.stringContaining("entry: null"), expect.stringContaining("overlays")]),
    );
  });
});
