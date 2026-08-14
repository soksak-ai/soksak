import { beforeEach, describe, expect, it, vi } from "vitest";

// jsdom localStorage is a no-op stub in this environment; replaced by a Map-based mock (deterministic, self-contained).
const mem = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
  clear: () => mem.clear(),
});

import { usePluginSettings } from "./pluginSettings";

const P = "soksak-plugin-acp-orchestra";
const ROOT = "/work/proj";
const s = () => usePluginSettings.getState();

beforeEach(() => {
  mem.clear();
  usePluginSettings.setState({ global: {}, byProject: {} });
});

describe("pluginSettings — global and project override resolution", () => {
  it("with nothing set, effective is the schema default", () => {
    expect(s().effective(P, "defaultAgent", "claude")).toBe("claude");
  });
  it("a global setting makes effective without a root the global value", () => {
    s().setGlobal(P, "defaultAgent", "codex");
    expect(s().effective(P, "defaultAgent", "claude")).toBe("codex");
  });
  it("precedence: project over global over default", () => {
    s().setGlobal(P, "defaultAgent", "codex");
    s().setProject(ROOT, P, "defaultAgent", "gemini");
    expect(s().effective(P, "defaultAgent", "claude", ROOT)).toBe("gemini"); // project
    expect(s().effective(P, "defaultAgent", "claude")).toBe("codex"); // no root, so global
    expect(s().effective(P, "defaultAgent", "claude", "/other")).toBe("codex"); // another project, so global
  });
  it("a project override applies to that project only, and every other project takes the default", () => {
    s().setProject(ROOT, P, "maxRounds", 9);
    expect(s().effective(P, "maxRounds", 5, ROOT)).toBe(9);
    expect(s().effective(P, "maxRounds", 5)).toBe(5);
  });
  it("resetGlobal(key) clears that key only, and resetGlobal() restores all of them", () => {
    s().setGlobal(P, "a", true);
    s().setGlobal(P, "b", 2);
    s().resetGlobal(P, "a");
    expect(s().effective(P, "a", false)).toBe(false);
    expect(s().effective(P, "b", 0)).toBe(2);
    s().resetGlobal(P);
    expect(s().effective(P, "b", 0)).toBe(0);
  });
  it("resetProject removes the project override and keeps the global one", () => {
    s().setGlobal(P, "x", "g");
    s().setProject(ROOT, P, "x", "p");
    s().resetProject(ROOT, P, "x");
    expect(s().effective(P, "x", "d", ROOT)).toBe("g"); // back to the global
  });
  it("allEffective merges global and project over the default map", () => {
    s().setGlobal(P, "defaultAgent", "codex");
    s().setProject(ROOT, P, "maxRounds", 9);
    expect(s().allEffective(P, { defaultAgent: "claude", maxRounds: 5 }, ROOT)).toEqual({
      defaultAgent: "codex",
      maxRounds: 9,
    });
  });
  it("localStorage persists global and byProject", () => {
    s().setGlobal(P, "a", 1);
    s().setProject(ROOT, P, "b", 2);
    const raw = JSON.parse(localStorage.getItem("soksak.pluginSettings")!);
    expect(raw.global[P].a).toBe(1);
    expect(raw.byProject[ROOT][P].b).toBe(2);
  });
});
