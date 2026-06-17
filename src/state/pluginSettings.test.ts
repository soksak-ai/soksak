import { beforeEach, describe, expect, it, vi } from "vitest";

// jsdom localStorage 가 이 환경에선 비동작 스텁 → Map 기반 목으로 대체(결정적·자족).
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

describe("pluginSettings — 글로벌+프로젝트 오버라이드 해석", () => {
  it("아무것도 없으면 effective = 스키마 기본", () => {
    expect(s().effective(P, "defaultAgent", "claude")).toBe("claude");
  });
  it("글로벌 설정 → effective(root 없음)이 글로벌", () => {
    s().setGlobal(P, "defaultAgent", "codex");
    expect(s().effective(P, "defaultAgent", "claude")).toBe("codex");
  });
  it("우선순위: 프로젝트 > 글로벌 > 기본", () => {
    s().setGlobal(P, "defaultAgent", "codex");
    s().setProject(ROOT, P, "defaultAgent", "gemini");
    expect(s().effective(P, "defaultAgent", "claude", ROOT)).toBe("gemini"); // 프로젝트
    expect(s().effective(P, "defaultAgent", "claude")).toBe("codex"); // root 없음 → 글로벌
    expect(s().effective(P, "defaultAgent", "claude", "/other")).toBe("codex"); // 다른 프로젝트 → 글로벌
  });
  it("프로젝트 오버라이드만 있으면 그 프로젝트는 오버라이드, 그 외는 기본", () => {
    s().setProject(ROOT, P, "maxRounds", 9);
    expect(s().effective(P, "maxRounds", 5, ROOT)).toBe(9);
    expect(s().effective(P, "maxRounds", 5)).toBe(5);
  });
  it("resetGlobal(key) 는 그 키만, resetGlobal() 은 전체 복원", () => {
    s().setGlobal(P, "a", true);
    s().setGlobal(P, "b", 2);
    s().resetGlobal(P, "a");
    expect(s().effective(P, "a", false)).toBe(false);
    expect(s().effective(P, "b", 0)).toBe(2);
    s().resetGlobal(P);
    expect(s().effective(P, "b", 0)).toBe(0);
  });
  it("resetProject 는 프로젝트 오버라이드만 제거(글로벌 보존)", () => {
    s().setGlobal(P, "x", "g");
    s().setProject(ROOT, P, "x", "p");
    s().resetProject(ROOT, P, "x");
    expect(s().effective(P, "x", "d", ROOT)).toBe("g"); // 글로벌로 복귀
  });
  it("allEffective 는 기본맵 위에 글로벌·프로젝트 머지", () => {
    s().setGlobal(P, "defaultAgent", "codex");
    s().setProject(ROOT, P, "maxRounds", 9);
    expect(s().allEffective(P, { defaultAgent: "claude", maxRounds: 5 }, ROOT)).toEqual({
      defaultAgent: "codex",
      maxRounds: 9,
    });
  });
  it("localStorage 영속(global+byProject)", () => {
    s().setGlobal(P, "a", 1);
    s().setProject(ROOT, P, "b", 2);
    const raw = JSON.parse(localStorage.getItem("soksak.pluginSettings")!);
    expect(raw.global[P].a).toBe(1);
    expect(raw.byProject[ROOT][P].b).toBe(2);
  });
});
